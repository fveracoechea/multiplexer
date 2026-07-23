import { describe, expect, test } from "bun:test";
import { FakeGitExecutor } from "../git/executor.ts";
import { DEFAULT_MERGE_RETRIES, directMerge } from "./integrate.ts";

const path = "/srv/.mux/worktrees/p/ripley";
const branch = "mux/p/ripley";
const ctx = { worktreePath: path, branch, baseBranch: "main" };

describe("directMerge", () => {
  test("happy path: resync then a literal ff-only merge and push, on the first attempt", async () => {
    const git = new FakeGitExecutor();
    const result = await directMerge({ git }, ctx);

    expect(result).toEqual({ status: "merged", attempts: 1 });
    expect(git.calls).toEqual([
      ["-C", path, "fetch", "origin", "main"],
      ["-C", path, "rebase", "FETCH_HEAD"],
      ["-C", path, "merge", "--ff-only", "FETCH_HEAD"],
      ["-C", path, "push", "origin", `${branch}:main`],
    ]);
  });

  test("a rebase conflict is returned immediately, markers left in place: no abort, no merge, no push, no retry", async () => {
    const git = new FakeGitExecutor((args) =>
      args.includes("rebase") ? { exitCode: 1 } : undefined,
    );
    const result = await directMerge({ git }, ctx);

    expect(result).toEqual({ status: "conflict", attempts: 1 });
    expect(git.calls).toEqual([
      ["-C", path, "fetch", "origin", "main"],
      ["-C", path, "rebase", "FETCH_HEAD"],
    ]);
  });

  test("a non-fast-forward push race resyncs and retries, succeeding on the second attempt", async () => {
    let pushAttempts = 0;
    const git = new FakeGitExecutor((args) => {
      if (!args.includes("push")) return undefined;
      pushAttempts += 1;
      return pushAttempts === 1 ? { exitCode: 1 } : { exitCode: 0 };
    });

    const result = await directMerge({ git }, ctx);

    expect(result).toEqual({ status: "merged", attempts: 2 });
    expect(git.calls).toEqual([
      ["-C", path, "fetch", "origin", "main"],
      ["-C", path, "rebase", "FETCH_HEAD"],
      ["-C", path, "merge", "--ff-only", "FETCH_HEAD"],
      ["-C", path, "push", "origin", `${branch}:main`],
      ["-C", path, "fetch", "origin", "main"],
      ["-C", path, "rebase", "FETCH_HEAD"],
      ["-C", path, "merge", "--ff-only", "FETCH_HEAD"],
      ["-C", path, "push", "origin", `${branch}:main`],
    ]);
  });

  test("exhausting the default retry cap without a successful push falls back to blocked", async () => {
    const git = new FakeGitExecutor((args) =>
      args.includes("push") ? { exitCode: 1 } : undefined,
    );
    const result = await directMerge({ git }, ctx);

    expect(result).toEqual({ status: "blocked", attempts: DEFAULT_MERGE_RETRIES + 1 });
    expect(git.calls.filter((args) => args.includes("push"))).toHaveLength(
      DEFAULT_MERGE_RETRIES + 1,
    );
  });

  test("a custom retry cap is honored", async () => {
    const git = new FakeGitExecutor((args) =>
      args.includes("push") ? { exitCode: 1 } : undefined,
    );
    const result = await directMerge({ git }, { ...ctx, maxRetries: 0 });

    expect(result).toEqual({ status: "blocked", attempts: 1 });
    expect(git.calls.filter((args) => args.includes("push"))).toHaveLength(1);
  });

  test("never force-pushes and never skips hooks, even across retries", async () => {
    const git = new FakeGitExecutor((args) =>
      args.includes("push") ? { exitCode: 1 } : undefined,
    );
    await directMerge({ git }, ctx);

    const forbidden = ["--force", "-f", "--no-verify", "-n"];
    for (const call of git.calls) {
      for (const flag of forbidden) {
        expect(call).not.toContain(flag);
      }
    }
  });

  test("never commits or overrides authorship: landed history stays the human Engineer's", async () => {
    const git = new FakeGitExecutor();
    await directMerge({ git }, ctx);

    for (const call of git.calls) {
      expect(call).not.toContain("commit");
      expect(call).not.toContain("--author");
      expect(
        call.some((arg) => arg.startsWith("user.name=") || arg.startsWith("user.email=")),
      ).toBe(false);
    }
  });
});
