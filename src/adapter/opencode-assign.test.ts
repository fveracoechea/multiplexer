import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import type { MuxConfig } from "../config.ts";
import { createDb, type MuxDb } from "../db/index.ts";
import { crew } from "../db/schema.ts";
import { FakeGitExecutor } from "../git/executor.ts";
import { createMuxServer } from "../server.ts";
import { FakeTmuxExecutor } from "../tmux/executor.ts";
import { ClaudeAdapter } from "./claude.ts";
import { OpencodeAdapter, opencodeConfigDir } from "./opencode.ts";
import type { Adapter } from "./types.ts";

/**
 * Tool-surface integration for the opencode adapter: `assign_crew` with
 * `agentType: "opencode"` must write the per-crew opencode config files and
 * emit an `--agent <name>` launch, all through the same single seam used for
 * Claude (spec #21).
 */
describe("assign_crew opencode adapter (tool surface)", () => {
  let db: MuxDb;
  let tmux: FakeTmuxExecutor;
  let git: FakeGitExecutor;
  let serverPwd: string;
  let config: MuxConfig;

  beforeEach(() => {
    db = createDb();
    tmux = new FakeTmuxExecutor();
    git = new FakeGitExecutor();
    serverPwd = mkdtempSync(join(tmpdir(), "mux-opencode-surface-"));
    config = {
      sessionKey: "proj-a",
      mcpUrl: "http://localhost:4123/mcp",
      mcpServerName: "mux",
      serverPwd,
    };
  });

  afterEach(() => {
    rmSync(serverPwd, { recursive: true, force: true });
  });

  async function connect(): Promise<Client> {
    const server = createMuxServer({
      db,
      tmux,
      git,
      adapters: new Map<string, Adapter>([
        ["claude", new ClaudeAdapter()],
        ["opencode", new OpencodeAdapter()],
      ]),
      config,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-orchestrator", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  test("agentType=opencode records the agent type on the crew row and launches opencode", async () => {
    const client = await connect();
    await client.callTool({
      name: "assign_crew",
      arguments: {
        name: "ripley",
        skill: "research",
        scope: "survey the auth flow",
        agentType: "opencode",
      },
    });

    const row = db.select().from(crew).where(eq(crew.sessionKey, "proj-a")).get();
    expect(row?.agentType).toBe("opencode");

    const [respawn] = tmux.callsOf("respawn-pane");
    if (!respawn) throw new Error("expected respawn-pane");
    expect(respawn[0]).toBe("respawn-pane");
    expect(respawn[1]).toBe("-k");
    // Launch CWD is the per-crew opencode config dir.
    expect(respawn).toContain("-c");
    expect(respawn).toContain(opencodeConfigDir(serverPwd, "proj-a", "ripley"));
    // The launch command is opencode with --agent <crewName>.
    expect(respawn).toContain("opencode");
    const agentIdx = respawn.indexOf("--agent");
    expect(agentIdx).toBeGreaterThan(-1);
    expect(respawn[agentIdx + 1]).toBe("ripley");
  });

  test("the opencode config files are written under the server-owned .mux/ dir", async () => {
    const client = await connect();
    await client.callTool({
      name: "assign_crew",
      arguments: {
        name: "bishop",
        skill: "research",
        scope: "map the event bus",
        agentType: "opencode",
      },
    });

    const configDir = opencodeConfigDir(serverPwd, "proj-a", "bishop");
    expect(existsSync(join(configDir, "opencode.json"))).toBe(true);
    expect(existsSync(join(configDir, ".opencode", "agents", "bishop.md"))).toBe(true);

    const opencodeJson = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8"));
    expect(opencodeJson).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        mux: { type: "remote", url: "http://localhost:4123/mcp/bishop", enabled: true },
      },
    });

    const agentFile = readFileSync(join(configDir, ".opencode", "agents", "bishop.md"), "utf8");
    expect(agentFile).toContain("mode: primary");
    expect(agentFile).toContain("mux crew agent bishop");
  });

  test("a file-mutating opencode crew still launches with the per-crew config dir as cwd", async () => {
    const client = await connect();
    await client.callTool({
      name: "assign_crew",
      arguments: {
        name: "hicks",
        skill: "implement",
        scope: "build settings page",
        agentType: "opencode",
      },
    });

    // The worktree is provisioned as for Claude.
    expect(git.callsOf("worktree")).toEqual([
      [
        "worktree",
        "add",
        "-b",
        "mux/proj-a/hicks",
        `${serverPwd}/.mux/worktrees/proj-a/hicks`,
        "main",
      ],
    ]);

    const [respawn] = tmux.callsOf("respawn-pane");
    if (!respawn) throw new Error("expected respawn-pane");
    // opencode's config dir wins as the launch cwd (it holds opencode.json),
    // not the worktree.
    const cIdx = respawn.indexOf("-c");
    expect(cIdx).toBeGreaterThan(-1);
    expect(respawn[cIdx + 1]).toBe(opencodeConfigDir(serverPwd, "proj-a", "hicks"));
  });

  test("an unknown agentType is rejected before any tmux or filesystem side effect", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "assign_crew",
      arguments: {
        name: "vasquez",
        skill: "research",
        scope: "x",
        agentType: "cursor",
      },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(tmux.callsOf("respawn-pane")).toHaveLength(0);
  });
});
