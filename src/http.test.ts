import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClaudeAdapter } from "./adapter/claude.ts";
import type { MuxConfig } from "./config.ts";
import { createDb } from "./db/index.ts";
import { crew } from "./db/schema.ts";
import { FakeGitExecutor } from "./git/executor.ts";
import { type HttpServer, startHttpServer } from "./http.ts";
import { FakePrExecutor } from "./pr/executor.ts";
import { createMuxServer } from "./server.ts";
import { FakeTmuxExecutor } from "./tmux/executor.ts";

describe("streamable-HTTP transport", () => {
  let http: HttpServer | undefined;

  afterEach(async () => {
    await http?.close();
    http = undefined;
  });

  test("serves the tool surface over streamable-HTTP on localhost", async () => {
    const db = createDb();
    const tmux = new FakeTmuxExecutor();
    const config: MuxConfig = {
      sessionKey: "proj-http",
      mcpUrl: "http://localhost:0/mcp",
      mcpServerName: "multiplexer",
      serverPwd: "/tmp/multiplexer",
    };
    const git = new FakeGitExecutor();
    const pr = new FakePrExecutor();
    const adapters = new Map([["claude", new ClaudeAdapter()]]);
    const createServer = (connection: { sessionKey: string; crewName?: string }) =>
      createMuxServer({
        db,
        tmux,
        git,
        pr,
        adapters,
        config: { ...config, sessionKey: connection.sessionKey },
        connectedCrew: connection.crewName,
      });

    http = await startHttpServer(createServer, { port: 0 });
    expect(http.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(http.mcpUrl).toBe(`${http.url}/mcp`);

    // The orchestrator connects at /mcp/<sessionKey> (ADR-0002).
    const client = new Client({ name: "test-orchestrator", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${http.mcpUrl}/proj-http`)));

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("assign_crew");

    // Driving a real tool call over HTTP writes through to the real DB.
    await client.callTool({
      name: "assign_crew",
      arguments: { name: "newt", skill: "research", scope: "over the wire" },
    });
    expect(db.select().from(crew).all()).toHaveLength(1);

    await client.close();
  });

  test("a crew connects at /mcp/<sessionKey>/<crewName> and is attributed to that crew", async () => {
    const db = createDb();
    const tmux = new FakeTmuxExecutor();
    const git = new FakeGitExecutor();
    const pr = new FakePrExecutor();
    const adapters = new Map([["claude", new ClaudeAdapter()]]);
    const config: MuxConfig = {
      sessionKey: "proj-http",
      mcpUrl: "http://localhost:0/mcp",
      mcpServerName: "multiplexer",
      serverPwd: "/tmp/multiplexer",
    };
    const createServer = (connection: { sessionKey: string; crewName?: string }) =>
      createMuxServer({
        db,
        tmux,
        git,
        pr,
        adapters,
        config: { ...config, sessionKey: connection.sessionKey },
        connectedCrew: connection.crewName,
      });

    http = await startHttpServer(createServer, { port: 0 });

    // Assign a crew first (as the orchestrator).
    const orchestrator = new Client({ name: "test-orchestrator", version: "0.0.0" });
    await orchestrator.connect(
      new StreamableHTTPClientTransport(new URL(`${http.mcpUrl}/proj-http`)),
    );
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "research", scope: "x" },
    });

    // The crew connects at /mcp/<sessionKey>/<crewName> and can report.
    const crewClient = new Client({ name: "test-crew", version: "0.0.0" });
    await crewClient.connect(
      new StreamableHTTPClientTransport(new URL(`${http.mcpUrl}/proj-http/ripley`)),
    );
    await crewClient.callTool({
      name: "report",
      arguments: { summary: "over the wire from crew", status: "progress" },
    });

    // The report landed on ripley's assignment.
    const status = await orchestrator.callTool({
      name: "crew_status",
      arguments: { name: "ripley" },
    });
    const text = (status as { content: Array<{ type: string; text: string }> }).content.find((c) =>
      c.text.startsWith("{"),
    )?.text;
    const detail = JSON.parse(text ?? "{}") as { events: Array<{ summary: string }> };
    expect(detail.events[0]?.summary).toBe("over the wire from crew");

    await orchestrator.close();
    await crewClient.close();
  });

  test("the session key in the URL isolates two concurrent project sessions on one server", async () => {
    const db = createDb();
    const tmux = new FakeTmuxExecutor();
    const git = new FakeGitExecutor();
    const pr = new FakePrExecutor();
    const adapters = new Map([["claude", new ClaudeAdapter()]]);
    const baseConfig: MuxConfig = {
      sessionKey: "",
      mcpUrl: "http://localhost:0/mcp",
      mcpServerName: "multiplexer",
      serverPwd: "/tmp/multiplexer",
    };
    const createServer = (connection: { sessionKey: string; crewName?: string }) =>
      createMuxServer({
        db,
        tmux,
        git,
        pr,
        adapters,
        config: { ...baseConfig, sessionKey: connection.sessionKey },
        connectedCrew: connection.crewName,
      });

    http = await startHttpServer(createServer, { port: 0 });

    const clientA = new Client({ name: "a", version: "0.0.0" });
    await clientA.connect(new StreamableHTTPClientTransport(new URL(`${http.mcpUrl}/proj-a`)));
    const clientB = new Client({ name: "b", version: "0.0.0" });
    await clientB.connect(new StreamableHTTPClientTransport(new URL(`${http.mcpUrl}/proj-b`)));

    await clientA.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "research", scope: "a" },
    });
    await clientB.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "research", scope: "b" },
    });

    // Same name in two sessions coexists; rows are partitioned by session key.
    expect(db.select().from(crew).all()).toHaveLength(2);

    await clientA.close();
    await clientB.close();
  });
});
