import { describe, expect, test } from "bun:test";
import { FakeGitExecutor } from "./executor.ts";

describe("FakeGitExecutor", () => {
  test("records the exact argv of every call", async () => {
    const git = new FakeGitExecutor();
    await git.run(["worktree", "add", "-b", "mux/p/ripley", "/srv/wt", "main"]);
    await git.run(["-C", "/srv/wt", "rebase", "main"]);

    expect(git.calls).toEqual([
      ["worktree", "add", "-b", "mux/p/ripley", "/srv/wt", "main"],
      ["-C", "/srv/wt", "rebase", "main"],
    ]);
  });

  test("defaults to empty success and supports scripted responses", async () => {
    const git = new FakeGitExecutor((args) =>
      args.includes("rev-parse") ? { stdout: "main" } : undefined,
    );
    expect(await git.run(["rev-parse", "--abbrev-ref", "HEAD"])).toEqual({
      stdout: "main",
      exitCode: 0,
    });
    expect(await git.run(["worktree", "add"])).toEqual({ stdout: "", exitCode: 0 });
  });

  test("callsOf filters by git subcommand", async () => {
    const git = new FakeGitExecutor();
    await git.run(["worktree", "add", "/a"]);
    await git.run(["worktree", "add", "/b"]);
    await git.run(["fetch", "origin"]);

    expect(git.callsOf("worktree")).toHaveLength(2);
    expect(git.callsOf("fetch")).toHaveLength(1);
  });
});
