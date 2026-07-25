import type { GitExecutor } from "../git/executor.ts";

/** Retry cap for a non-fast-forward push race before falling back to blocked. */
export const DEFAULT_MERGE_RETRIES = 2;

export interface DirectMergeDeps {
  readonly git: GitExecutor;
}

export interface DirectMergeContext {
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseBranch: string;
  /** Retry cap for a non-fast-forward push race. Defaults to {@link DEFAULT_MERGE_RETRIES}. */
  readonly maxRetries?: number;
}

export type DirectMergeResult =
  | { readonly status: "merged"; readonly attempts: number }
  | { readonly status: "conflict"; readonly attempts: number }
  | { readonly status: "blocked"; readonly attempts: number };

/**
 * Direct-merge integration: the default landing path for a file-mutating crew
 * agent when a scope is silent on merge-vs-PR (spec #19).
 *
 * Each attempt re-syncs (fetch + rebase) against base immediately before
 * landing, exactly like the pre-task resync in `worktree.ts` - then lands with
 * a literal `git merge --ff-only` (a deliberate no-op safety check; the rebase
 * already made the branch a fast-forward descendant of base) and a plain
 * `git push`. Concurrent direct-merges need no Orchestrator-side lock: a push
 * that loses the race is rejected by git as non-fast-forward, so the whole
 * resync-merge-push cycle simply retries up to a small cap. Never force-pushes
 * and never skips hooks - retrying is the only recovery.
 *
 * A rebase conflict is returned exactly as git leaves it - conflict markers
 * intact, no auto-abort, no retry - so a self-resolvable conflict is the
 * calling agent's to fix and retry, while a genuinely unsafe one is its cue to
 * escalate via `report(blocked)` instead of calling this again.
 *
 * No step here ever commits, so authorship of the landed history stays
 * whatever the crew's own worktree commits already carry - the human
 * Engineer's, never this function's.
 */
export async function directMerge(
  deps: DirectMergeDeps,
  ctx: DirectMergeContext,
): Promise<DirectMergeResult> {
  const { git } = deps;
  const { worktreePath, branch, baseBranch } = ctx;
  const maxAttempts = (ctx.maxRetries ?? DEFAULT_MERGE_RETRIES) + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await git.run(["-C", worktreePath, "fetch", "origin", baseBranch]);
    const rebase = await git.run(["-C", worktreePath, "rebase", "FETCH_HEAD"]);
    if (rebase.exitCode !== 0) {
      return { status: "conflict", attempts: attempt };
    }

    const merge = await git.run(["-C", worktreePath, "merge", "--ff-only", "FETCH_HEAD"]);
    if (merge.exitCode !== 0) {
      throw new Error(
        `git merge --ff-only failed unexpectedly right after a successful rebase onto the same FETCH_HEAD`,
      );
    }

    const push = await git.run(["-C", worktreePath, "push", "origin", `${branch}:${baseBranch}`]);
    if (push.exitCode === 0) {
      return { status: "merged", attempts: attempt };
    }
  }

  return { status: "blocked", attempts: maxAttempts };
}
