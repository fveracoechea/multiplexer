import { spawnCapture } from "../exec.ts";

/**
 * The git executor boundary.
 *
 * The server provisions and re-syncs crew worktrees by running git itself
 * (before launching an agent into the worktree). Like the tmux executor, git
 * runs behind one narrow seam so tests can substitute a recording fake and
 * assert the exact argv emitted for worktree creation and resync (spec #15).
 */
export interface GitResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export interface GitExecutor {
  /** Run `git <args...>` and return its output. Argv is passed verbatim. */
  run(args: string[]): Promise<GitResult>;
}

/** Runs real `git` via `Bun.spawn`. Never exercised in tests. */
export class RealGitExecutor implements GitExecutor {
  run(args: string[]): Promise<GitResult> {
    return spawnCapture("git", args);
  }
}

/** Optional per-call override for the fake, keyed by git subcommand. */
export type GitResponder = (args: string[]) => Partial<GitResult> | undefined;

/** Recording fake used in tests. Captures the exact argv of every git call. */
export class FakeGitExecutor implements GitExecutor {
  readonly calls: string[][] = [];

  constructor(private readonly responder?: GitResponder) {}

  async run(args: string[]): Promise<GitResult> {
    this.calls.push(args);
    const scripted = this.responder?.(args);
    return { stdout: scripted?.stdout ?? "", exitCode: scripted?.exitCode ?? 0 };
  }

  /** All recorded calls whose git subcommand equals `subcommand`. */
  callsOf(subcommand: string): string[][] {
    return this.calls.filter((args) => args[0] === subcommand);
  }
}
