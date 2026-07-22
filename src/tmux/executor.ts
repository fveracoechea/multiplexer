/**
 * The tmux executor boundary.
 *
 * Every tmux interaction in the system funnels through this one narrow seam so
 * that tests can substitute a recording fake and assert the exact argv emitted
 * (spec #11, "One faked boundary: the tmux executor"). Nothing above this
 * interface knows whether tmux is real.
 */
export interface TmuxResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export interface TmuxExecutor {
  /**
   * Run `tmux <args...>` and return its output. Argv is passed verbatim; when
   * more than one trailing command argument is given tmux execs it directly
   * (no shell), so callers can pass a launch command as discrete argv.
   */
  run(args: string[]): Promise<TmuxResult>;
}

/** Runs real `tmux` via `Bun.spawn`. Never exercised in tests. */
export class RealTmuxExecutor implements TmuxExecutor {
  async run(args: string[]): Promise<TmuxResult> {
    const proc = Bun.spawn(["tmux", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tmux ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    return { stdout: stdout.trim(), exitCode };
  }
}

/** Optional per-call override for the fake, keyed by tmux subcommand. */
export type TmuxResponder = (args: string[]) => Partial<TmuxResult> | undefined;

/**
 * Recording fake used in tests. Captures the exact argv of every call and
 * emulates the one tmux behaviour the orchestration logic depends on:
 * `-P` (print) commands report the id of the newly created pane. A `responder`
 * can script other output (e.g. canned `capture-pane` text) deterministically.
 */
export class FakeTmuxExecutor implements TmuxExecutor {
  readonly calls: string[][] = [];
  private paneCounter = 0;

  constructor(private readonly responder?: TmuxResponder) {}

  async run(args: string[]): Promise<TmuxResult> {
    this.calls.push(args);

    const scripted = this.responder?.(args);
    if (scripted) {
      return { stdout: scripted.stdout ?? "", exitCode: scripted.exitCode ?? 0 };
    }

    // Emulate `tmux ... -P -F '#{pane_id}'`, which prints the new pane id.
    if (args.includes("-P")) {
      this.paneCounter += 1;
      return { stdout: `%${this.paneCounter}`, exitCode: 0 };
    }

    return { stdout: "", exitCode: 0 };
  }

  /** All recorded calls whose tmux subcommand equals `subcommand`. */
  callsOf(subcommand: string): string[][] {
    return this.calls.filter((args) => args[0] === subcommand);
  }
}
