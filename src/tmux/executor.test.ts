import { describe, expect, test } from "bun:test";
import { FakeTmuxExecutor } from "./executor.ts";

describe("FakeTmuxExecutor", () => {
  test("records the exact argv of every call", async () => {
    const tmux = new FakeTmuxExecutor();
    await tmux.run(["send-keys", "-t", "%1", "hello", "Enter"]);
    await tmux.run(["kill-pane", "-t", "%1"]);

    expect(tmux.calls).toEqual([
      ["send-keys", "-t", "%1", "hello", "Enter"],
      ["kill-pane", "-t", "%1"],
    ]);
  });

  test("emulates -P by returning a fresh pane id per print command", async () => {
    const tmux = new FakeTmuxExecutor();
    const first = await tmux.run(["new-window", "-P", "-F", "#{pane_id}"]);
    const second = await tmux.run(["split-window", "-P", "-F", "#{pane_id}"]);

    expect(first.stdout).toBe("%1");
    expect(second.stdout).toBe("%2");
  });

  test("returns empty success for non-print commands", async () => {
    const tmux = new FakeTmuxExecutor();
    const result = await tmux.run(["respawn-pane", "-k", "-t", "%1", "claude"]);
    expect(result).toEqual({ stdout: "", exitCode: 0 });
  });

  test("a responder can script canned output (e.g. capture-pane text)", async () => {
    const tmux = new FakeTmuxExecutor((args) =>
      args[0] === "capture-pane" ? { stdout: "waiting for input" } : undefined,
    );
    const captured = await tmux.run(["capture-pane", "-p", "-t", "%1"]);
    expect(captured.stdout).toBe("waiting for input");
    // Unmatched commands fall through to default behaviour.
    expect((await tmux.run(["new-window", "-P"])).stdout).toBe("%1");
  });

  test("callsOf filters by tmux subcommand", async () => {
    const tmux = new FakeTmuxExecutor();
    await tmux.run(["new-window", "-t", "s"]);
    await tmux.run(["split-window", "-t", "s:crew"]);
    await tmux.run(["split-window", "-t", "s:crew"]);

    expect(tmux.callsOf("split-window")).toHaveLength(2);
    expect(tmux.callsOf("new-window")).toHaveLength(1);
  });
});
