import { desc, eq } from "drizzle-orm";
import type { MuxConfig } from "../config.ts";
import type { MuxDb } from "../db/index.ts";
import { crew, type Event, events } from "../db/schema.ts";
import { findCrew, latestAssignment, latestEvent } from "./queries.ts";

/** A crew detail view is capped to this many of the most recent events. */
export const MAX_DETAIL_EVENTS = 15;

export interface StatusDeps {
  readonly db: MuxDb;
  readonly config: MuxConfig;
}

/** One bounded line per crew for the fleet overview. */
export interface CrewOverviewItem {
  readonly name: string;
  readonly agentType: string;
  readonly skill: string | null;
  readonly scope: string | null;
  /** Latest reported status, or the assignment status if nothing reported yet. */
  readonly status: string | null;
  readonly lastSummary: string | null;
  readonly hasWorktree: boolean;
}

/** One crew's detail, capped to its last {@link MAX_DETAIL_EVENTS} events. */
export interface CrewDetail {
  readonly name: string;
  readonly agentType: string;
  readonly skill: string | null;
  readonly scope: string | null;
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly events: Event[];
}

/**
 * Bounded overview of every crew in the session: identity plus a one-line digest
 * of the current assignment and latest report. Deliberately omits event history
 * so the Orchestrator's context stays lean (spec #11).
 */
export function crewOverview(deps: StatusDeps): CrewOverviewItem[] {
  const { db, config } = deps;
  const crewRows = db
    .select()
    .from(crew)
    .where(eq(crew.sessionKey, config.sessionKey))
    .orderBy(crew.id)
    .all();

  return crewRows.map((crewRow) => {
    const current = latestAssignment(db, config.sessionKey, crewRow.id);
    const lastEvent = current ? latestEvent(db, current.id) : undefined;
    return {
      name: crewRow.name,
      agentType: crewRow.agentType,
      skill: current?.skill ?? null,
      scope: current?.scope ?? null,
      status: lastEvent?.status ?? current?.status ?? null,
      lastSummary: lastEvent?.summary ?? null,
      hasWorktree: crewRow.worktreePath !== null,
    };
  });
}

/**
 * One crew's detail: identity, current assignment, and its most recent events in
 * chronological order, capped to {@link MAX_DETAIL_EVENTS}. Returns null when no
 * such crew exists in the session.
 */
export function crewDetail(deps: StatusDeps, name: string): CrewDetail | null {
  const { db, config } = deps;
  const crewRow = findCrew(db, config.sessionKey, name.trim().toLowerCase());
  if (!crewRow) {
    return null;
  }

  const current = latestAssignment(db, config.sessionKey, crewRow.id);
  const recent = current
    ? db
        .select()
        .from(events)
        .where(eq(events.assignmentId, current.id))
        .orderBy(desc(events.id))
        .limit(MAX_DETAIL_EVENTS)
        .all()
        .reverse()
    : [];

  return {
    name: crewRow.name,
    agentType: crewRow.agentType,
    skill: current?.skill ?? null,
    scope: current?.scope ?? null,
    worktreePath: crewRow.worktreePath,
    branch: crewRow.branch,
    events: recent,
  };
}
