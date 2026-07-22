import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq } from "drizzle-orm";
import { ClaudeAdapter } from "../adapter/claude.ts";
import type { MuxConfig } from "../config.ts";
import { createDb, type MuxDb } from "../db/index.ts";
import { crew, events } from "../db/schema.ts";
import { FakeGitExecutor } from "../git/executor.ts";
import { createMuxServer } from "../server.ts";
import { FakeTmuxExecutor } from "../tmux/executor.ts";

interface DismissedCrew {
  crewId: number;
  name: string;
  assignmentId: number | null;
  eventId: number | null;
  synthesized: boolean;
  wiped: boolean;
  pending: boolean;
}
interface DismissResult {
  dismissed: DismissedCrew[];
}

function makeConfig(sessionKey: string): MuxConfig {
  return {
    sessionKey,
    mcpUrl: "http://localhost:4123/mcp",
    mcpServerName: "mux",
    serverPwd: "/srv",
    baseBranch: "main",
    // Fast + deterministic in tests; production defaults to a real grace window.
    graceWindowMs: 0,
  };
}

/** Let a `graceWindowMs: 0` background finalize timer run before asserting on it. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("dismiss_crew tool surface", () => {
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

  function crewRow(sessionKey: string, name: string) {
    return db
      .select()
      .from(crew)
      .where(and(eq(crew.sessionKey, sessionKey), eq(crew.name, name)))
      .get();
  }

  function eventsFor(assignmentId: number) {
    return db.select().from(events).where(eq(events.assignmentId, assignmentId)).all();
  }

  beforeEach(() => {
    db = createDb();
    tmux = new FakeTmuxExecutor();
    git = new FakeGitExecutor();
  });

  test("graceful dismiss sends a wrap-up message, stays non-blocking, then synthesizes report(done) once the grace window elapses", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build settings page" },
    });

    const result = parse<DismissResult>(
      await orchestrator.callTool({ name: "dismiss_crew", arguments: { name: "ripley" } }),
    );

    expect(result.dismissed).toHaveLength(1);
    const [dismissed] = result.dismissed;
    // The tool call itself returns immediately - the grace window runs in the
    // background, so nothing is finalized yet in this response.
    expect(dismissed?.pending).toBe(true);
    expect(dismissed?.eventId).toBeNull();

    // Wrap-up delivered as literal-text send-keys, then a separate Enter - same
    // shape as steer_crew, no C-c (that's the force path only).
    const sendKeys = tmux.callsOf("send-keys");
    expect(sendKeys).toEqual([
      ["send-keys", "-t", "%1", "-l", expect.stringContaining("dismissed")],
      ["send-keys", "-t", "%1", "Enter"],
    ]);

    const assignmentId = dismissed?.assignmentId;
    if (!assignmentId) throw new Error("expected an assignment id");

    await flush();
    const rows = eventsFor(assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("done");
  });

  test("graceful dismiss collapses a crew's prior events down to just the terminal report", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build settings page" },
    });

    const ripley = await connect(config, "ripley");
    await ripley.callTool({ name: "report", arguments: { summary: "step 1", status: "progress" } });
    await ripley.callTool({
      name: "report",
      arguments: { summary: "step 2", status: "milestone" },
    });

    const result = parse<DismissResult>(
      await orchestrator.callTool({ name: "dismiss_crew", arguments: { name: "ripley" } }),
    );
    const assignmentId = result.dismissed[0]?.assignmentId;
    if (!assignmentId) throw new Error("expected an assignment id");

    await flush();
    const rows = eventsFor(assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("done");
  });

  test("dismissing a crew that already self-reported done collapses immediately, without a duplicate synthesized event", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build settings page" },
    });

    const ripley = await connect(config, "ripley");
    await ripley.callTool({ name: "report", arguments: { summary: "step 1", status: "progress" } });
    await ripley.callTool({ name: "report", arguments: { summary: "all done", status: "done" } });

    const result = parse<DismissResult>(
      await orchestrator.callTool({ name: "dismiss_crew", arguments: { name: "ripley" } }),
    );
    const dismissed = result.dismissed[0];
    // Already terminal - resolved synchronously, no background wait needed.
    expect(dismissed?.pending).toBe(false);
    expect(dismissed?.synthesized).toBe(false);

    // No wrap-up message needed - the crew had already reported done itself.
    expect(tmux.callsOf("send-keys")).toHaveLength(0);

    const assignmentId = dismissed?.assignmentId;
    if (!assignmentId) throw new Error("expected an assignment id");
    const rows = eventsFor(assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("all done");
  });

  test("force dismiss stops the pane immediately (C-c), skipping the wrap-up message and grace wait", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build settings page" },
    });

    const result = parse<DismissResult>(
      await orchestrator.callTool({
        name: "dismiss_crew",
        arguments: { name: "ripley", force: true },
      }),
    );

    expect(tmux.callsOf("send-keys")).toEqual([["send-keys", "-t", "%1", "C-c"]]);

    const dismissed = result.dismissed[0];
    expect(dismissed?.pending).toBe(false);
    expect(dismissed?.synthesized).toBe(true);
    const assignmentId = dismissed?.assignmentId;
    if (!assignmentId) throw new Error("expected an assignment id");
    const rows = eventsFor(assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("done");
  });

  test("wipe:true deletes the crew's worktree and clears it from the identity row once the grace window elapses", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build settings page" },
    });

    const before = crewRow("p", "ripley");
    expect(before?.worktreePath).toBe("/srv/.mux/worktrees/p/ripley");

    await orchestrator.callTool({
      name: "dismiss_crew",
      arguments: { name: "ripley", wipe: true },
    });
    await flush();

    expect(git.callsOf("worktree")).toEqual([
      ["worktree", "add", "-b", "mux/p/ripley", "/srv/.mux/worktrees/p/ripley", "main"],
      ["worktree", "remove", "/srv/.mux/worktrees/p/ripley", "--force"],
    ]);

    const after = crewRow("p", "ripley");
    expect(after?.worktreePath).toBeNull();
    expect(after?.branch).toBeNull();
  });

  test("force + wipe deletes the worktree immediately, no grace wait needed", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build settings page" },
    });

    const result = parse<DismissResult>(
      await orchestrator.callTool({
        name: "dismiss_crew",
        arguments: { name: "ripley", force: true, wipe: true },
      }),
    );
    expect(result.dismissed[0]?.wiped).toBe(true);
    expect(git.callsOf("worktree")).toEqual([
      ["worktree", "add", "-b", "mux/p/ripley", "/srv/.mux/worktrees/p/ripley", "main"],
      ["worktree", "remove", "/srv/.mux/worktrees/p/ripley", "--force"],
    ]);
  });

  test("without wipe, the worktree persists and the crew identity row survives dismissal", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build settings page" },
    });

    await orchestrator.callTool({ name: "dismiss_crew", arguments: { name: "ripley" } });
    await flush();

    expect(git.callsOf("worktree")).toHaveLength(1); // only the initial `worktree add`
    const row = crewRow("p", "ripley");
    expect(row).toBeTruthy();
    expect(row?.worktreePath).toBe("/srv/.mux/worktrees/p/ripley");
    expect(row?.branch).toBe("mux/p/ripley");
  });

  test("dismiss_crew() with no name dismisses every crew in the session", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "research", scope: "one" },
    });
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "hicks", skill: "research", scope: "two" },
    });

    const result = parse<DismissResult>(
      await orchestrator.callTool({ name: "dismiss_crew", arguments: {} }),
    );

    expect(result.dismissed.map((d) => d.name)).toEqual(["ripley", "hicks"]);
    await flush();
    for (const dismissed of result.dismissed) {
      if (!dismissed.assignmentId) throw new Error("expected an assignment id");
      expect(eventsFor(dismissed.assignmentId)).toHaveLength(1);
    }
  });

  test("dismissing an unknown crew is rejected", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    const result = await orchestrator.callTool({
      name: "dismiss_crew",
      arguments: { name: "nobody" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
