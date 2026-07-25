import { and, eq } from "drizzle-orm";
import type { MuxDb } from "../db/index.ts";
import { assignments } from "../db/schema.ts";
import type { GitExecutor } from "../git/executor.ts";
import type { PrExecutor } from "../pr/executor.ts";

/**
 * Shared-issue integration branch provisioning and the final PR (spec #20).
 *
 * When multiple crew share an `issue` number, they merge into a single
 * Orchestrator-provisioned integration branch used as their shared base; once
 * all sharers report `done`, one PR is opened from that integration branch to
 * the real default branch (carrying `Closes #<n>`). A single crew with an issue
 * targets the default branch directly - the integration branch only exists
 * when sharing is in play.
 */

/**
 * The integration branch name: `multiplexer/integration/<sessionKey>/<issue>`. Stable
 * per (session, issue) pair so concurrent sessions with the same issue don't
 * collide, and a sharer's base is computable from its own assignment.
 */
export function integrationBranchName(sessionKey: string, issue: number): string {
  return `multiplexer/integration/${sessionKey}/${issue}`;
}

/** The assignments in a session sharing the given issue. */
function sharers(db: MuxDb, sessionKey: string, issue: number) {
  return db
    .select()
    .from(assignments)
    .where(and(eq(assignments.sessionKey, sessionKey), eq(assignments.issue, issue)))
    .all();
}

/** Count assignments in a session sharing the given issue. */
export function sharerCount(db: MuxDb, sessionKey: string, issue: number): number {
  return sharers(db, sessionKey, issue).length;
}

/**
 * The base a crew with `issue` should land into: the integration branch when
 * the issue is shared (2+ assignments carry it), else the default branch. A
 * single crew with an issue targets the default directly - no integration
 * branch is provisioned unless sharing is in play.
 */
export function baseForIssue(
  db: MuxDb,
  sessionKey: string,
  issue: number | null | undefined,
  defaultBranch: string,
): string {
  if (issue == null) return defaultBranch;
  // Sharing is in play only from the 2nd assignment carrying the issue; a
  // single crew with an issue targets the default branch directly.
  return sharerCount(db, sessionKey, issue) >= 2
    ? integrationBranchName(sessionKey, issue)
    : defaultBranch;
}

/**
 * Provision the integration branch locally from the default branch, if it
 * doesn't already exist. Called when sharing starts (the 2nd assign carrying
 * a given issue). The branch only needs to exist locally so the 2nd crew's
 * worktree can branch from it; the crews' own direct-merges push to the remote
 * integration branch, creating it there.
 */
export async function provisionIntegrationBranch(
  git: GitExecutor,
  name: string,
  baseBranch: string,
): Promise<void> {
  await git.run(["branch", name, baseBranch]);
}

/**
 * Has every assignment sharing `issue` in the session reported `done`?
 * "Done" means the latest event on the assignment is a terminal `done` report
 * (the crew's own or a synthesized one from dismiss). Used to decide whether
 * the final integration PR should be opened.
 */
export function allSharersDone(
  db: MuxDb,
  sessionKey: string,
  issue: number,
  isDone: (assignmentId: number) => boolean,
): boolean {
  const rows = sharers(db, sessionKey, issue);
  // The final integration PR is only for shared issues (2+ sharers); a single
  // crew with an issue PRs directly to the default with `Closes #<n>`.
  return rows.length >= 2 && rows.every((a) => isDone(a.id));
}

/**
 * Open the final integration PR from the integration branch to the default
 * branch, with `Closes #<issue>` in the body. Returns the PR URL.
 *
 * The remote integration branch already carries the sharers' work (their
 * direct-merges pushed to it); the server just opens the reviewable PR that
 * lands the feature as one unit.
 */
export async function openIntegrationPr(
  pr: PrExecutor,
  sessionKey: string,
  issue: number,
  defaultBranch: string,
): Promise<string> {
  const head = integrationBranchName(sessionKey, issue);
  const title = `Integration: #${issue}`;
  const body = `Consolidates the work of the crew sharing issue #${issue} into one reviewable PR.\n\nCloses #${issue}`;
  const result = await pr.run([
    "pr",
    "create",
    "--base",
    defaultBranch,
    "--head",
    head,
    "--title",
    title,
    "--body",
    body,
  ]);
  return result.stdout.trim();
}
