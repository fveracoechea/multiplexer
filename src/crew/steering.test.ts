import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { ClaudeAdapter } from "../adapter/claude.ts";
import type { MuxConfig } from "../config.ts";
import { createDb, type MuxDb } from "../db/index.ts";
import { assignments } from "../db/schema.ts";
import { FakeGitExecutor } from "../git/executor.ts";
import { createMuxServer } from "../server.ts";
import { FakeTmuxExecutor } from "../tmux/executor.ts";

interface SteerResult {
  crewId: number;
  paneId: string;
  resumed: boolean;
}

function makeConfig(sessionKey: string): MuxConfig {
  return {
    sessionKey,
    mcpUrl: "http://localhost:4123/mcp",
    mcpServerName: "mux",
    serverPwd: "/tmp/mux",
  };
}

describe("steer_crew tool surface", () => {
  let db: MuxDb;
  let tmux: FakeTmuxExecutor;
  let git: FakeGitExecutor;
  const adapters = new Map([["claude", new ClaudeAdapter()]]);

  async function connect(config: MuxConfig, connectedCrew?: string): Promise<Client> {
    const server = createMuxServer({ db, tmux, git, adapters, config, connectedCrew });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  function parse<T>(result: unknown): T {
    const { content } = result as { content: Array<{ type: string; text: string }> };
    const json = content.find((c) => c.type === "text" && c.text.startsWith("{"));
    if (!json) throw new Error("no JSON content in result");
    return JSON.parse(json.text) as T;
  }

  function assignmentStatus(sessionKey: string): string | undefined {
    return db
      .select()
      .from(assignments)
      .where(eq(assignments.sessionKey, sessionKey))
      .orderBy(assignments.id)
      .all()
      .at(-1)?.status;
  }

  beforeEach(() => {
    db = createDb();
    tmux = new FakeTmuxExecutor();
    git = new FakeGitExecutor();
  });

  test("steering emits fire-and-forget send-keys pane input and returns immediately", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "research", scope: "survey the auth flow" },
    });

    const result = await orchestrator.callTool({
      name: "steer_crew",
      arguments: { name: "ripley", message: "focus on the login flow first" },
    });
    const payload = parse<SteerResult>(result);

    expect(payload.resumed).toBe(false);
    expect(payload.paneId).toBe("%1");

    // Literal text keys, then a separate Enter keypress.
    const sendKeys = tmux.callsOf("send-keys");
    expect(sendKeys).toEqual([
      ["send-keys", "-t", "%1", "-l", "focus on the login flow first"],
      ["send-keys", "-t", "%1", "Enter"],
    ]);
  });

  test("steering is accepted regardless of the crew's current status", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "research", scope: "survey" },
    });

    const ripley = await connect(config, "ripley");
    await ripley.callTool({
      name: "report",
      arguments: { summary: "on it", status: "progress" },
    });

    const result = await orchestrator.callTool({
      name: "steer_crew",
      arguments: { name: "ripley", message: "also check the signup flow" },
    });
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  test("report(blocked) halts the assignment; a subsequent steer_crew resumes it", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build settings page" },
    });

    const ripley = await connect(config, "ripley");
    await ripley.callTool({
      name: "report",
      arguments: { summary: "need a decision on the schema", status: "blocked" },
    });
    expect(assignmentStatus("p")).toBe("blocked");

    const result = await orchestrator.callTool({
      name: "steer_crew",
      arguments: { name: "ripley", message: "use the existing users table" },
    });
    const payload = parse<SteerResult>(result);

    expect(payload.resumed).toBe(true);
    expect(assignmentStatus("p")).toBe("active");
  });

  test("steering an unknown crew is rejected", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    const result = await orchestrator.callTool({
      name: "steer_crew",
      arguments: { name: "nobody", message: "hello" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
