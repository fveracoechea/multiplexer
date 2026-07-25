import { beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { ClaudeAdapter } from "../adapter/claude.ts";
import type { MuxConfig } from "../config.ts";
import { createDb, type MuxDb } from "../db/index.ts";
import { assignments, crew } from "../db/schema.ts";
import { FakeGitExecutor } from "../git/executor.ts";
import { FakePrExecutor } from "../pr/executor.ts";
import { createMuxServer } from "../server.ts";
import { FakeTmuxExecutor } from "../tmux/executor.ts";
import { integrationBranchName } from "./integration.ts";

interface CrewDetail {
  name: string;
  baseBranch: string;
  events: Array<{ status: string; prUrl: string | null }>;
}

function makeConfig(sessionKey: string): MuxConfig {
  return {
    sessionKey,
    mcpUrl: "http://localhost:4123/mcp",
    mcpServerName: "multiplexer",
    serverPwd: "/srv",
    baseBranch: "main",
  };
}

describe("shared-issue integration branch (tool surface)", () => {
  let db: MuxDb;
  let tmux: FakeTmuxExecutor;
  let git: FakeGitExecutor;
  let pr: FakePrExecutor;
  const adapters = new Map([["claude", new ClaudeAdapter()]]);

  async function connect(config: MuxConfig, connectedCrew?: string): Promise<Client> {
    const server = createMuxServer({ db, tmux, git, pr, adapters, config, connectedCrew });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  function parse<T>(result: unknown): T {
    const { content } = result as { content: Array<{ type: string; text: string }> };
    const text = content.find((c) => c.type === "text" && /^[{[]/.test(c.text))?.text;
    if (!text) throw new Error("no JSON content in result");
    return JSON.parse(text) as T;
  }

  beforeEach(() => {
    db = createDb();
    tmux = new FakeTmuxExecutor();
    git = new FakeGitExecutor();
    pr = new FakePrExecutor((args) =>
      args.includes("create")
        ? { stdout: "https://github.com/org/repo/pull/99", exitCode: 0 }
        : undefined,
    );
  });

  test("a single crew with an issue targets the default branch; no integration branch is provisioned", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "build it", issue: 42 },
    });

    // No `git branch <integration>` call - the integration branch is only for sharing.
    expect(git.callsOf("branch")).toHaveLength(0);

    // The worktree branches from the default, not an integration branch.
    expect(git.callsOf("worktree")[0]).toEqual([
      "worktree",
      "add",
      "-b",
      "multiplexer/p/ripley",
      "/srv/.multiplexer/worktrees/p/ripley",
      "main",
    ]);

    // crew_status detail reports the default branch as the base.
    const detail = parse<CrewDetail>(
      await orchestrator.callTool({ name: "crew_status", arguments: { name: "ripley" } }),
    );
    expect(detail.baseBranch).toBe("main");
  });

  test("a second assign carrying the same issue provisions one integration branch, and both sharers target it", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "part A", issue: 42 },
    });
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "bishop", skill: "implement", scope: "part B", issue: 42 },
    });

    // Exactly one `git branch multiplexer/integration/p/42 main` - provisioned once, on sharing start.
    expect(git.callsOf("branch")).toEqual([["branch", integrationBranchName("p", 42), "main"]]);

    // The 2nd crew's worktree branches from the integration branch.
    expect(git.callsOf("worktree").at(-1)).toEqual([
      "worktree",
      "add",
      "-b",
      "multiplexer/p/bishop",
      "/srv/.multiplexer/worktrees/p/bishop",
      integrationBranchName("p", 42),
    ]);

    // Both sharers' crew_status detail reports the integration branch as base,
    // including the 1st crew (retroactively retargeted).
    const ripley = parse<CrewDetail>(
      await orchestrator.callTool({ name: "crew_status", arguments: { name: "ripley" } }),
    );
    const bishop = parse<CrewDetail>(
      await orchestrator.callTool({ name: "crew_status", arguments: { name: "bishop" } }),
    );
    expect(ripley.baseBranch).toBe(integrationBranchName("p", 42));
    expect(bishop.baseBranch).toBe(integrationBranchName("p", 42));
  });

  test("when all sharers report done, one PR is opened from the integration branch to the default branch", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "ripley", skill: "implement", scope: "part A", issue: 42 },
    });
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "bishop", skill: "implement", scope: "part B", issue: 42 },
    });

    const ripley = await connect(config, "ripley");
    const bishop = await connect(config, "bishop");

    // The first done does not open the PR yet - not all sharers are done.
    await ripley.callTool({
      name: "report",
      arguments: { summary: "part A done", status: "done" },
    });
    expect(pr.calls).toHaveLength(0);

    // The second done triggers the final integration PR.
    await bishop.callTool({
      name: "report",
      arguments: { summary: "part B done", status: "done" },
    });

    expect(pr.callsOf("pr")).toEqual([
      [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        integrationBranchName("p", 42),
        "--title",
        "Integration: #42",
        "--body",
        expect.stringContaining("Closes #42"),
      ],
    ]);

    // The PR URL is recorded on the done event that triggered it.
    const detail = parse<CrewDetail>(
      await orchestrator.callTool({ name: "crew_status", arguments: { name: "bishop" } }),
    );
    expect(detail.events.at(-1)?.prUrl).toBe("https://github.com/org/repo/pull/99");
  });

  test("a done on a non-shared issue does not open an integration PR", async () => {
    const config = makeConfig("p");
    const orchestrator = await connect(config);
    await orchestrator.callTool({
      name: "assign_crew",
      arguments: { name: "hicks", skill: "implement", scope: "solo", issue: 7 },
    });

    const hicks = await connect(config, "hicks");
    await hicks.callTool({
      name: "report",
      arguments: { summary: "done", status: "done" },
    });

    expect(pr.calls).toHaveLength(0);
    expect(git.callsOf("branch")).toHaveLength(0);
  });

  test("the integration branch is scoped per session; two sessions with the same issue provision separately", async () => {
    const configA = makeConfig("proj-a");
    const configB = makeConfig("proj-b");
    const orchA = await connect(configA);
    const orchB = await connect(configB);

    for (const orch of [orchA, orchB]) {
      await orch.callTool({
        name: "assign_crew",
        arguments: { name: "ripley", skill: "implement", scope: "A", issue: 42 },
      });
      await orch.callTool({
        name: "assign_crew",
        arguments: { name: "bishop", skill: "implement", scope: "B", issue: 42 },
      });
    }

    expect(git.callsOf("branch")).toEqual([
      ["branch", integrationBranchName("proj-a", 42), "main"],
      ["branch", integrationBranchName("proj-b", 42), "main"],
    ]);

    // Each session has its own two sharers, isolated by session key.
    expect(
      db.select().from(assignments).where(eq(assignments.sessionKey, "proj-a")).all(),
    ).toHaveLength(2);
    expect(
      db.select().from(assignments).where(eq(assignments.sessionKey, "proj-b")).all(),
    ).toHaveLength(2);
    expect(db.select().from(crew).all()).toHaveLength(4);
  });
});
