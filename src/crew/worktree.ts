import { join } from "node:path";
import type { GitExecutor } from "../git/executor.ts";
import { isReadOnlySkill } from "../skills.ts";

export interface WorktreeDeps {
  readonly git: GitExecutor;
  readonly serverPwd: string;
  readonly baseBranch: string;
}

export interface WorktreeContext {
  readonly sessionKey: string;
  readonly crewName: string;
  readonly skill: string;
  /**
   * The crew's existing worktree path when retasking, if any. Present means the
   * worktree is reused and re-synced; absent means it is created fresh.
   */
  readonly existingWorktree?: string;
}

/** A provisioned worktree's location and branch, recorded on the crew row. */
export interface WorktreePlan {
  readonly path: string;
  readonly branch: string;
}

/**
 * Provision the git worktree for an assignment, or `null` for a read-only skill
 * that needs none.
 *
 * File-mutating skills get a dedicated worktree + branch rooted under the
 * server's PWD (inside the gitignored `.mux/`), so parallel crew never collide
 * on the working tree. A fresh crew's worktree is created; an existing crew's
 * worktree is re-synced against its base branch immediately before the new task
 * (spec #15). Worktrees persist by default - deletion is the dismiss `wipe` path.
 */
export async function provisionWorktree(
  deps: WorktreeDeps,
  ctx: WorktreeContext,
): Promise<WorktreePlan | null> {
  if (isReadOnlySkill(ctx.skill)) {
    return null;
  }

  const path = ctx.existingWorktree ?? worktreePath(deps.serverPwd, ctx.sessionKey, ctx.crewName);
  const branch = worktreeBranch(ctx.sessionKey, ctx.crewName);

  if (ctx.existingWorktree) {
    // Re-sync the reused worktree against its base branch before the new task:
    // fetch the base tip, then rebase onto exactly what was fetched (FETCH_HEAD)
    // rather than a possibly-stale local branch.
    await deps.git.run(["-C", path, "fetch", "origin", deps.baseBranch]);
    await deps.git.run(["-C", path, "rebase", "FETCH_HEAD"]);
  } else {
    await deps.git.run(["worktree", "add", "-b", branch, path, deps.baseBranch]);
  }

  return { path, branch };
}

/** `<serverPwd>/.mux/worktrees/<sessionKey>/<crewName>` - gitignored via `.mux/`. */
export function worktreePath(serverPwd: string, sessionKey: string, crewName: string): string {
  return join(serverPwd, ".mux", "worktrees", sessionKey, crewName);
}

/** Stable per-crew branch name, namespaced by session. */
export function worktreeBranch(sessionKey: string, crewName: string): string {
  return `mux/${sessionKey}/${crewName}`;
}
