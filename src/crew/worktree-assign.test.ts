import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq } from "drizzle-orm";
import { ClaudeAdapter } from "../adapter/claude.ts";
import type { MuxConfig } from "../config.ts";
import { createDb, type MuxDb } from "../db/index.ts";
import { crew } from "../db/schema.ts";
import { FakeGitExecutor } from "../git/executor.ts";
import { createMuxServer } from "../server.ts";
import { FakeTmuxExecutor } from "../tmux/executor.ts";

const config: MuxConfig = {
  sessionKey: "proj-a",
  mcpUrl: "http://localhost:4123/mcp",
  mcpServerName: "mux",
  serverPwd: "/srv",
  baseBranch: "main",
};

describe("assign_crew worktree provisioning (tool surface)", () => {
  let db: MuxDb;
  let tmux: FakeTmuxExecutor;
  let git: FakeGitExecutor;

  async function connect(): Promise<Client> {
    const server = createMuxServer({
      db,
      tmux,
      git,
      adapters: new Map([["claude", new ClaudeAdapter()]]),
      config,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  function crewRow(name: string) {
    return db
      .select()
      .from(crew)
      .where(and(eq(crew.sessionKey, config.sessionKey), eq(crew.name, name)))
      .get();
  }

  beforeEach(() => {
    db = createDb();
    tmux = new FakeTmuxExecutor();
    git = new FakeGitExecutor();
  });

  test("a file-mutating skill provisions a worktree + branch recorded on the crew row", async () => {
    const client = await connect();
    await client.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build settings page" },
    });

    const row = crewRow("ripley");
    expect(row?.worktreePath).toBe("/srv/.mux/worktrees/proj-a/ripley");
    expect(row?.branch).toBe("mux/proj-a/ripley");

    // git worktree add was emitted through the fake executor.
    expect(git.callsOf("worktree")).toEqual([
      ["worktree", "add", "-b", "mux/proj-a/ripley", "/srv/.mux/worktrees/proj-a/ripley", "main"],
    ]);

    // The agent is launched in its worktree via respawn-pane -c.
    const [respawn] = tmux.callsOf("respawn-pane");
    if (!respawn) throw new Error("expected respawn-pane");
    const cIndex = respawn.indexOf("-c");
    expect(cIndex).toBeGreaterThan(-1);
    expect(respawn[cIndex + 1]).toBe("/srv/.mux/worktrees/proj-a/ripley");
  });

  test("a read-only skill provisions no worktree and launches with no start dir", async () => {
    const client = await connect();
    await client.callTool({
      name: "assign_crew",
      arguments: { name: "bishop", skill: "research", scope: "survey the auth flow" },
    });

    const row = crewRow("bishop");
    expect(row?.worktreePath).toBeNull();
    expect(row?.branch).toBeNull();
    expect(git.calls).toHaveLength(0);

    const [respawn] = tmux.callsOf("respawn-pane");
    expect(respawn).not.toContain("-c");
  });

  test("retasking an existing crew re-syncs its worktree instead of recreating it", async () => {
    const client = await connect();
    await client.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build settings page" },
    });

    await client.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build the next page" },
    });

    const row = crewRow("ripley");
    // Identity (worktree path + branch) is unchanged across the retask.
    expect(row?.worktreePath).toBe("/srv/.mux/worktrees/proj-a/ripley");
    expect(row?.branch).toBe("mux/proj-a/ripley");

    // Only one `worktree add`; the retask re-syncs (fetch + rebase) instead.
    expect(git.callsOf("worktree")).toEqual([
      ["worktree", "add", "-b", "mux/proj-a/ripley", "/srv/.mux/worktrees/proj-a/ripley", "main"],
    ]);
    expect(git.calls).toEqual([
      ["worktree", "add", "-b", "mux/proj-a/ripley", "/srv/.mux/worktrees/proj-a/ripley", "main"],
      ["-C", "/srv/.mux/worktrees/proj-a/ripley", "fetch", "origin", "main"],
      ["-C", "/srv/.mux/worktrees/proj-a/ripley", "rebase", "FETCH_HEAD"],
    ]);

    // Both launches land in the same worktree; only one pane was ever created.
    const respawns = tmux.callsOf("respawn-pane");
    expect(respawns).toHaveLength(2);
    for (const respawn of respawns) {
      const cIndex = respawn.indexOf("-c");
      expect(respawn[cIndex + 1]).toBe("/srv/.mux/worktrees/proj-a/ripley");
    }
    expect(tmux.callsOf("new-window")).toHaveLength(1);
    expect(tmux.callsOf("split-window")).toHaveLength(0);
  });
});
