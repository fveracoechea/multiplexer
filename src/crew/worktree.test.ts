import { describe, expect, test } from "bun:test";
import { FakeGitExecutor } from "../git/executor.ts";
import { provisionWorktree, worktreeBranch, worktreePath } from "./worktree.ts";

const deps = (git: FakeGitExecutor) => ({ git, serverPwd: "/srv", baseBranch: "main" });

describe("provisionWorktree", () => {
  test("a read-only skill provisions no worktree and runs no git", async () => {
    const git = new FakeGitExecutor();
    const plan = await provisionWorktree(deps(git), {
      sessionKey: "p",
      crewName: "ripley",
      skill: "research",
    });
    expect(plan).toBeNull();
    expect(git.calls).toHaveLength(0);
  });

  test("a file-mutating skill creates a dedicated worktree + branch under .mux/", async () => {
    const git = new FakeGitExecutor();
    const plan = await provisionWorktree(deps(git), {
      sessionKey: "p",
      crewName: "ripley",
      skill: "implement",
    });

    expect(plan).toEqual({
      path: "/srv/.mux/worktrees/p/ripley",
      branch: "mux/p/ripley",
    });
    expect(git.calls).toEqual([
      ["worktree", "add", "-b", "mux/p/ripley", "/srv/.mux/worktrees/p/ripley", "main"],
    ]);
  });

  test("an existing worktree is re-synced against its base branch before the task", async () => {
    const git = new FakeGitExecutor();
    const existing = "/srv/.mux/worktrees/p/ripley";
    const plan = await provisionWorktree(deps(git), {
      sessionKey: "p",
      crewName: "ripley",
      skill: "implement",
      existingWorktree: existing,
    });

    // Reuse, not recreate: no `worktree add`, and a fetch + rebase-onto-fetched
    // resync (rebase FETCH_HEAD, not the stale local branch).
    expect(git.callsOf("worktree")).toHaveLength(0);
    expect(git.calls).toEqual([
      ["-C", existing, "fetch", "origin", "main"],
      ["-C", existing, "rebase", "FETCH_HEAD"],
    ]);
    expect(plan).toEqual({ path: existing, branch: "mux/p/ripley" });
  });

  test("path and branch are stable and session-namespaced", () => {
    expect(worktreePath("/srv", "p", "ripley")).toBe("/srv/.mux/worktrees/p/ripley");
    expect(worktreeBranch("p", "ripley")).toBe("mux/p/ripley");
  });
});
