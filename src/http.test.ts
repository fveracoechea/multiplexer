import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClaudeAdapter } from "./adapter/claude.ts";
import type { MuxConfig } from "./config.ts";
import { createDb } from "./db/index.ts";
import { crew } from "./db/schema.ts";
import { type HttpServer, startHttpServer } from "./http.ts";
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
      mcpServerName: "mux",
      serverPwd: "/tmp/mux",
    };
    const adapters = new Map([["claude", new ClaudeAdapter()]]);
    const createServer = (connectedCrew?: string) =>
      createMuxServer({ db, tmux, adapters, config, connectedCrew });

    http = await startHttpServer(createServer, { port: 0 });
    expect(http.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(http.mcpUrl).toBe(`${http.url}/mcp`);

    const client = new Client({ name: "test-orchestrator", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.mcpUrl)));

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
});
