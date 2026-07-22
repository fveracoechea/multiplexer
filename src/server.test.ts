import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { ClaudeAdapter } from "./adapter/claude.ts";
import type { MuxConfig } from "./config.ts";
import { createDb, type MuxDb } from "./db/index.ts";
import { assignments, crew } from "./db/schema.ts";
import { FakeGitExecutor } from "./git/executor.ts";
import { createMuxServer } from "./server.ts";
import { FakeTmuxExecutor } from "./tmux/executor.ts";

const MCP_URL = "http://localhost:4123/mcp";

function makeConfig(sessionKey: string): MuxConfig {
  return {
    sessionKey,
    mcpUrl: MCP_URL,
    mcpServerName: "mux",
    serverPwd: "/tmp/mux",
  };
}

/** Connect a real MCP client to a real mux server over the in-process transport. */
async function connect(deps: {
  db: MuxDb;
  tmux: FakeTmuxExecutor;
  config: MuxConfig;
}): Promise<Client> {
  const server = createMuxServer({
    db: deps.db,
    tmux: deps.tmux,
    git: new FakeGitExecutor(),
    adapters: new Map([["claude", new ClaudeAdapter()]]),
    config: deps.config,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-orchestrator", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Pull the JSON payload the assign_crew tool returns as its second content block. */
function toolJson(result: { content: Array<{ type: string; text?: string }> }): {
  crewId: number;
  assignmentId: number;
  name: string;
  paneId: string;
  worktreePath: string | null;
} {
  const json = result.content.find((c) => c.type === "text" && c.text?.startsWith("{"));
  if (!json?.text) throw new Error("no JSON content block in tool result");
  return JSON.parse(json.text);
}

describe("assign_crew tool surface", () => {
  let db: MuxDb;
  let tmux: FakeTmuxExecutor;

  beforeEach(() => {
    db = createDb();
    tmux = new FakeTmuxExecutor();
  });

  test("exposes assign_crew over the tool surface", async () => {
    const client = await connect({ db, tmux, config: makeConfig("proj-a") });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("assign_crew");
  });

  test("spawn of a new name writes one crew row and one assignment row", async () => {
    const client = await connect({ db, tmux, config: makeConfig("proj-a") });

    const result = await client.callTool({
      name: "assign_crew",
      arguments: { name: "Ripley", skill: "research", scope: "survey the auth flow" },
    });
    const payload = toolJson(result as never);

    const crewRows = db.select().from(crew).all();
    const assignmentRows = db.select().from(assignments).all();

    expect(crewRows).toHaveLength(1);
    expect(assignmentRows).toHaveLength(1);

    const [crewRow] = crewRows;
    const [assignmentRow] = assignmentRows;
    // Name is stored as a stable lowercase identifier.
    expect(crewRow?.name).toBe("ripley");
    expect(crewRow?.sessionKey).toBe("proj-a");
    expect(crewRow?.agentType).toBe("claude");
    expect(crewRow?.paneId).toBe("%1");
    // Read-only skill provisions no worktree.
    expect(crewRow?.worktreePath).toBeNull();
    expect(crewRow?.branch).toBeNull();

    expect(assignmentRow?.crewId).toBe(crewRow?.id as number);
    expect(assignmentRow?.skill).toBe("research");
    expect(assignmentRow?.scope).toBe("survey the auth flow");
    expect(assignmentRow?.issue).toBeNull();

    expect(payload.crewId).toBe(crewRow?.id as number);
    expect(payload.worktreePath).toBeNull();
  });

  test("first assign lazily creates the crew window and launches Claude with the right flags", async () => {
    const client = await connect({ db, tmux, config: makeConfig("proj-a") });
    await client.callTool({
      name: "assign_crew",
      arguments: { name: "bishop", skill: "research", scope: "map the event bus" },
    });

    // Crew window created lazily on first assign, in its own window.
    const created = tmux.callsOf("new-window");
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "proj-a",
      "-n",
      "crew",
    ]);
    // No split on the first assign.
    expect(tmux.callsOf("split-window")).toHaveLength(0);

    // Agent launched into the created pane via respawn-pane -k.
    const [respawn] = tmux.callsOf("respawn-pane");
    if (!respawn) throw new Error("expected a respawn-pane call");
    expect(respawn.slice(0, 4)).toEqual(["respawn-pane", "-k", "-t", "%1"]);

    // The Claude spawn command carries the role and MCP wiring flags.
    expect(respawn).toContain("claude");
    expect(respawn).toContain("--append-system-prompt");
    expect(respawn).toContain("--strict-mcp-config");

    const mcpConfigIndex = respawn.indexOf("--mcp-config");
    expect(mcpConfigIndex).toBeGreaterThan(-1);
    const mcpConfig = JSON.parse(respawn[mcpConfigIndex + 1] as string);
    // Crew connects to its own per-crew endpoint so reports are attributable (ADR-0001).
    expect(mcpConfig).toEqual({
      mcpServers: { mux: { type: "http", url: `${MCP_URL}/bishop` } },
    });
  });

  test("issue and agentType are recorded when provided", async () => {
    const client = await connect({ db, tmux, config: makeConfig("proj-a") });
    await client.callTool({
      name: "assign_crew",
      arguments: {
        name: "hicks",
        skill: "implement",
        scope: "build settings page",
        agentType: "claude",
        issue: 42,
      },
    });

    const [assignmentRow] = db.select().from(assignments).all();
    expect(assignmentRow?.issue).toBe(42);
    expect(assignmentRow?.agentType).toBe("claude");
  });

  test("a second crew in the same session splits and re-tiles the crew window", async () => {
    const client = await connect({ db, tmux, config: makeConfig("proj-a") });
    await client.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "research", scope: "one" },
    });
    await client.callTool({
      name: "assign_crew",
      arguments: { name: "bishop", skill: "research", scope: "two" },
    });

    expect(tmux.callsOf("new-window")).toHaveLength(1);
    const [split] = tmux.callsOf("split-window");
    expect(split).toEqual(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "proj-a:crew"]);
    expect(tmux.callsOf("select-layout")).toEqual([
      ["select-layout", "-t", "proj-a:crew", "tiled"],
    ]);

    const crewRows = db.select().from(crew).all();
    expect(crewRows).toHaveLength(2);
    expect(crewRows.map((c) => c.paneId)).toEqual(["%1", "%2"]);
  });

  test("re-assigning an existing crew name is rejected (retask not yet implemented)", async () => {
    const client = await connect({ db, tmux, config: makeConfig("proj-a") });
    await client.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "research", scope: "one" },
    });
    const result = await client.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "research", scope: "two" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(db.select().from(crew).all()).toHaveLength(1);
  });

  test("session key isolates two project sessions on one server", async () => {
    const clientA = await connect({ db, tmux, config: makeConfig("proj-a") });
    const clientB = await connect({ db, tmux, config: makeConfig("proj-b") });

    await clientA.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "research", scope: "a-work" },
    });
    await clientB.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "research", scope: "b-work" },
    });

    // Same name in two sessions coexists; rows are partitioned by session key.
    expect(db.select().from(crew).where(eq(crew.sessionKey, "proj-a")).all()).toHaveLength(1);
    expect(db.select().from(crew).where(eq(crew.sessionKey, "proj-b")).all()).toHaveLength(1);
    // Each session created its own crew window (first-assign each).
    expect(tmux.callsOf("new-window").map((c) => c[6])).toEqual(["proj-a", "proj-b"]);
  });
});
