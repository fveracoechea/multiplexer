import { eq } from "drizzle-orm";
import type { MuxConfig } from "../config.ts";
import type { MuxDb } from "../db/index.ts";
import { assignments, type Event, events } from "../db/schema.ts";
import { findCrew, latestAssignment } from "./queries.ts";

/** The status of a crew report. `blocked` is a hard halt; `done` is terminal. */
export const REPORT_STATUSES = ["progress", "milestone", "blocked", "done"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface ReportDeps {
  readonly db: MuxDb;
  readonly config: MuxConfig;
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

/**
 * Append a crew report as an event against the crew's current assignment.
 *
 * The crew is identified by the connection, not by an argument (ADR-0001), and
 * the event is scoped to the crew's most recent assignment so that a retask's
 * fresh event trail stays separate from the prior task's. A `blocked` report
 * additionally marks the assignment halted; only a subsequent `steer_crew`
 * resumes it (spec #17).
 */
export function appendReport(deps: ReportDeps, input: ReportInput): Event {
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

  return db.transaction((tx) => {
    const event = tx
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
      tx.update(assignments).set({ status: "blocked" }).where(eq(assignments.id, current.id)).run();
    }

    return event;
  });
}
