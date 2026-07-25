import type { GitExecutor } from "../git/executor.ts";
import type { PrExecutor } from "../pr/executor.ts";

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
 * The shared resync/resolve-or-blocked step (spec #20): fetch the base tip and
 * rebase the crew's work onto exactly what was fetched (FETCH_HEAD) rather than
 * a possibly-stale local branch. Returns `"conflict"` when the rebase fails -
 * the conflict is left exactly as git leaves it (markers in place, no auto-abort)
 * so a self-resolvable conflict is the crew's to fix and retry, while a
 * genuinely unsafe one is its cue to escalate via `report(blocked)`.
 *
 * Both the direct-merge and the requested-PR landing paths run this step; only
 * what they do after differs (merge+push vs. push+open-PR).
 */
export async function resyncAgainstBase(
  git: GitExecutor,
  worktreePath: string,
  baseBranch: string,
): Promise<"ok" | "conflict"> {
  await git.run(["-C", worktreePath, "fetch", "origin", baseBranch]);
  const rebase = await git.run(["-C", worktreePath, "rebase", "FETCH_HEAD"]);
  return rebase.exitCode === 0 ? "ok" : "conflict";
}

/**
 * Direct-merge integration: the default landing path for a file-mutating crew
 * agent when a scope is silent on merge-vs-PR (spec #19).
 *
 * Each attempt runs the shared {@link resyncAgainstBase} step, then lands with
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
    const resync = await resyncAgainstBase(git, worktreePath, baseBranch);
    if (resync === "conflict") {
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

export interface PrMergeDeps {
  readonly git: GitExecutor;
  readonly pr: PrExecutor;
}

export interface PrMergeContext {
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseBranch: string;
  /** PR title; the caller crafts it from the repo's PR guidelines (spec #20). */
  readonly title: string;
  /** PR body; the caller crafts it from the repo's PR guidelines (spec #20). */
  readonly body: string;
  /** Optional issue number; when present, `Closes #<n>` is appended to the body. */
  readonly issue?: number;
}

export type PrMergeResult =
  | { readonly status: "pr-opened"; readonly prUrl: string }
  | { readonly status: "conflict" };

/**
 * Requested-PR integration (spec #20): the crew agent pushes its branch and
 * opens a PR instead of direct-merging. Shares the {@link resyncAgainstBase}
 * step with {@link directMerge}; only the final action differs (push + open-PR
 * vs. merge+push). There is no retry cap - a push race surfaces as a rejected
 * push and the crew's cue to retry the resync, but the PR path does not loop
 * internally the way direct-merge does.
 *
 * `Closes #<n>` is appended to the PR body only when an issue number is given,
 * so PRs link to issues exactly when intended and stay unlinked otherwise. The
 * title and body come from the caller, who is expected to follow the repo's
 * own git/PR guidelines when present (else agent judgment).
 */
export async function prMerge(deps: PrMergeDeps, ctx: PrMergeContext): Promise<PrMergeResult> {
  const { git, pr } = deps;
  const { worktreePath, branch, baseBranch, title, body, issue } = ctx;

  const resync = await resyncAgainstBase(git, worktreePath, baseBranch);
  if (resync === "conflict") {
    return { status: "conflict" };
  }

  await git.run(["-C", worktreePath, "push", "origin", branch]);

  const prBody = issue ? `${body}\n\nCloses #${issue}` : body;
  const result = await pr.run([
    "pr",
    "create",
    "--base",
    baseBranch,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    prBody,
  ]);
  return { status: "pr-opened", prUrl: result.stdout.trim() };
}
