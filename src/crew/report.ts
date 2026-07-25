import { eq } from "drizzle-orm";
import { DEFAULT_BASE_BRANCH, type MuxConfig } from "../config.ts";
import type { MuxDb } from "../db/index.ts";
import { assignments, type Event, events } from "../db/schema.ts";
import type { PrExecutor } from "../pr/executor.ts";
import type { TmuxExecutor } from "../tmux/executor.ts";
import { allSharersDone, openIntegrationPr } from "./integration.ts";
import { ASSIGNMENT_STATUS, findCrew, latestAssignment, latestEvent } from "./queries.ts";

/** The status of a crew report. `blocked` is a hard halt; `done` is terminal. */
export const REPORT_STATUSES = ["progress", "milestone", "blocked", "done"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/**
 * Statuses worth surfacing passively in the tmux status bar so the Engineer
 * notices them without polling (spec #25). `progress` is deliberately excluded
 * as too frequent; the Orchestrator's bounded `crew_status` digests cover it.
 */
const ALERT_STATUSES: ReadonlySet<ReportStatus> = new Set(["milestone", "blocked", "done"]);

export interface ReportDeps {
  readonly db: MuxDb;
  readonly config: MuxConfig;
  readonly pr: PrExecutor;
  readonly tmux: TmuxExecutor;
}

export interface ReportInput {
  /** The crew this connection belongs to (bound to the MCP connection, ADR-0001). */
  readonly connectedCrew: string;
  readonly summary: string;
  readonly status: ReportStatus;
  /** Free-form pointer to whatever artifact the skill produced, if any. */
  readonly reportPath?: string;
  readonly prUrl?: string;
}

export interface ReportResult {
  /** The appended event (its `prUrl` carries the final integration PR URL when one was opened). */
  readonly event: Event;
  /**
   * The URL of the final integration PR opened because this `done` report made
   * every sharer of the assignment's issue done; undefined otherwise.
   */
  readonly integrationPrUrl?: string;
}

/**
 * Append a crew report as an event against the crew's current assignment.
 *
 * The crew is identified by the connection, not by an argument (ADR-0001), and
 * the event is scoped to the crew's most recent assignment so that a retask's
 * fresh event trail stays separate from the prior task's. A `blocked` report
 * additionally marks the assignment halted; only a subsequent `steer_crew`
 * resumes it (spec #17).
 *
 * A `done` report whose assignment carries a shared `issue` triggers the final
 * integration PR when it makes every sharer done: one PR from the integration
 * branch to the default branch, with `Closes #<issue>` (spec #20). The PR URL
 * is recorded on the event so the Orchestrator reads it back via `crew_status`.
 */
export async function appendReport(deps: ReportDeps, input: ReportInput): Promise<ReportResult> {
  const { db, config } = deps;
  const { sessionKey } = config;

  const crewRow = findCrew(db, sessionKey, input.connectedCrew);
  if (!crewRow) {
    throw new Error(`unknown crew "${input.connectedCrew}" in this session`);
  }

  const current = latestAssignment(db, sessionKey, crewRow.id);
  if (!current) {
    throw new Error(`crew "${input.connectedCrew}" has no assignment to report against`);
  }

  const event = db.transaction((tx) => {
    const inserted = tx
      .insert(events)
      .values({
        sessionKey,
        assignmentId: current.id,
        status: input.status,
        summary: input.summary,
        reportPath: input.reportPath ?? null,
        prUrl: input.prUrl ?? null,
      })
      .returning()
      .get();

    if (input.status === "blocked") {
      tx.update(assignments)
        .set({ status: ASSIGNMENT_STATUS.blocked })
        .where(eq(assignments.id, current.id))
        .run();
    }

    return inserted;
  });

  // Real-time human alert in the tmux status bar for notable events (spec #25).
  // Independent of the pull-based `crew_status` digests - emitted at event time,
  // scoped to this session's tmux session so a session only shows its own crew.
  if (ALERT_STATUSES.has(input.status)) {
    await emitStatusBarAlert(
      deps.tmux,
      sessionKey,
      input.connectedCrew,
      input.status,
      input.summary,
    );
  }

  // A `done` on a shared issue may be the last one: open the final integration
  // PR when every sharer is now done. Best-effort - a failure to open the PR
  // does not un-record the `done` report; the Orchestrator can retry.
  if (input.status === "done" && current.issue != null) {
    const everyoneDone = allSharersDone(
      db,
      sessionKey,
      current.issue,
      (aid) => latestEvent(db, aid)?.status === "done",
    );
    if (everyoneDone) {
      const defaultBranch = config.baseBranch ?? DEFAULT_BASE_BRANCH;
      const integrationPrUrl = await openIntegrationPr(
        deps.pr,
        sessionKey,
        current.issue,
        defaultBranch,
      );
      const updated = db
        .update(events)
        .set({ prUrl: integrationPrUrl })
        .where(eq(events.id, event.id))
        .returning()
        .get();
      return { event: updated, integrationPrUrl };
    }
  }

  return { event };
}

/**
 * Surface a notable crew event in the tmux status bar via `display-message`,
 * targeted at this session's tmux session so a session only sees its own crew
 * (spec #25). The alert channel is independent of the pull-based `crew_status`
 * digests - it fires at event time, not on poll.
 */
async function emitStatusBarAlert(
  tmux: TmuxExecutor,
  sessionKey: string,
  crewName: string,
  status: ReportStatus,
  summary: string,
): Promise<void> {
  const text = `[multiplexer] ${crewName} ${status}: ${summary}`;
  await tmux.run(["display-message", "-t", sessionKey, "-d", "5000", text]);
}
