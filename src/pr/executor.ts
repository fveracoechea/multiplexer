import { spawnCapture } from "../exec.ts";

/**
 * The PR executor boundary.
 *
 * `prMerge` (the crew-side "requested PR" path) and the server-side "open the
 * final integration PR" path both open pull requests via `gh`. As with the git
 * and tmux executors, `gh` runs behind one narrow seam so tests substitute a
 * recording fake and assert the exact argv emitted (spec #20).
 */
export interface PrResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export interface PrExecutor {
  /**
   * Run `gh <args...>` and return its output. `gh pr create` prints the new PR
   * URL on stdout; argv is passed verbatim.
   */
  run(args: string[]): Promise<PrResult>;
}

/** Runs real `gh` via `Bun.spawn`. Never exercised in tests. */
export class RealPrExecutor implements PrExecutor {
  run(args: string[]): Promise<PrResult> {
    return spawnCapture("gh", args);
  }
}

/** Optional per-call override for the fake. */
export type PrResponder = (args: string[]) => Partial<PrResult> | undefined;

/** Recording fake used in tests. Captures the exact argv of every call. */
export class FakePrExecutor implements PrExecutor {
  readonly calls: string[][] = [];

  constructor(private readonly responder?: PrResponder) {}

  async run(args: string[]): Promise<PrResult> {
    this.calls.push(args);
    const scripted = this.responder?.(args);
    return { stdout: scripted?.stdout ?? "", exitCode: scripted?.exitCode ?? 0 };
  }

  /** All recorded calls whose gh subcommand equals `subcommand`. */
  callsOf(subcommand: string): string[][] {
    return this.calls.filter((args) => args[0] === subcommand);
  }
}
