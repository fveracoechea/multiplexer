import { describe, expect, test } from "bun:test";
import { FakeGitExecutor } from "../git/executor.ts";
import { FakePrExecutor } from "../pr/executor.ts";
import { DEFAULT_MERGE_RETRIES, directMerge, prMerge } from "./integrate.ts";

const path = "/srv/.multiplexer/worktrees/p/ripley";
const branch = "multiplexer/p/ripley";
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

describe("prMerge", () => {
  const path = "/srv/.multiplexer/worktrees/p/ripley";
  const branch = "multiplexer/p/ripley";
  const baseCtx = {
    worktreePath: path,
    branch,
    baseBranch: "main",
    title: "Add the settings page",
    body: "Implements the settings page per the spec.",
  };

  test("resyncs, pushes the crew branch, and opens a PR to the base branch", async () => {
    const git = new FakeGitExecutor();
    const pr = new FakePrExecutor((args) =>
      args.includes("create")
        ? { stdout: "https://github.com/org/repo/pull/7", exitCode: 0 }
        : undefined,
    );

    const result = await prMerge({ git, pr }, baseCtx);

    expect(result).toEqual({ status: "pr-opened", prUrl: "https://github.com/org/repo/pull/7" });
    expect(git.calls).toEqual([
      ["-C", path, "fetch", "origin", "main"],
      ["-C", path, "rebase", "FETCH_HEAD"],
      ["-C", path, "push", "origin", branch],
    ]);
    expect(pr.calls).toEqual([
      [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        baseCtx.title,
        "--body",
        baseCtx.body,
      ],
    ]);
  });

  test("appends `Closes #<n>` to the PR body only when an issue number is supplied", async () => {
    const git = new FakeGitExecutor();
    const pr = new FakePrExecutor();

    await prMerge({ git, pr }, { ...baseCtx, issue: 42 });

    const [createCall] = pr.calls;
    if (!createCall) throw new Error("expected a pr create call");
    const bodyIdx = createCall.indexOf("--body");
    expect(createCall[bodyIdx + 1]).toBe(`${baseCtx.body}\n\nCloses #42`);
  });

  test("omits `Closes` entirely when no issue number is supplied", async () => {
    const git = new FakeGitExecutor();
    const pr = new FakePrExecutor();

    await prMerge({ git, pr }, baseCtx);

    const [createCall] = pr.calls;
    if (!createCall) throw new Error("expected a pr create call");
    const bodyIdx = createCall.indexOf("--body");
    expect(createCall[bodyIdx + 1]).toBe(baseCtx.body);
  });

  test("a rebase conflict returns immediately, no push, no PR: same resolve-or-blocked step as direct-merge", async () => {
    const git = new FakeGitExecutor((args) =>
      args.includes("rebase") ? { exitCode: 1 } : undefined,
    );
    const pr = new FakePrExecutor();

    const result = await prMerge({ git, pr }, baseCtx);

    expect(result).toEqual({ status: "conflict" });
    expect(git.calls).toEqual([
      ["-C", path, "fetch", "origin", "main"],
      ["-C", path, "rebase", "FETCH_HEAD"],
    ]);
    expect(pr.calls).toHaveLength(0);
  });

  test("does not retry on a push race (no retry cap on the PR path)", async () => {
    const git = new FakeGitExecutor((args) =>
      args.includes("push") ? { exitCode: 1 } : undefined,
    );
    const pr = new FakePrExecutor();

    const result = await prMerge({ git, pr }, baseCtx);

    expect(result).toEqual({ status: "pr-opened", prUrl: "" });
    expect(git.calls.filter((c) => c.includes("push"))).toHaveLength(1);
    expect(pr.calls).toHaveLength(1);
  });
});
