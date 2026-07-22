import { and, desc, eq } from "drizzle-orm";
import type { MuxDb } from "../db/index.ts";
import { type Assignment, assignments, type Crew, crew, type Event, events } from "../db/schema.ts";

/**
 * Shared read helpers over crew state, scoped by session key. Kept in one place
 * so reporting and status readback resolve crew and assignments identically.
 */

/**
 * `assignments.status` values outside the append-only event log: `active` is
 * the default; `blocked` is the hard halt `report(blocked)` sets and only
 * `steer_crew` clears (spec #17).
 */
export const ASSIGNMENT_STATUS = { active: "active", blocked: "blocked" } as const;

/** The crew with `name` in `sessionKey`, or undefined. Name is matched as stored. */
export function findCrew(db: MuxDb, sessionKey: string, name: string): Crew | undefined {
  return db
    .select()
    .from(crew)
    .where(and(eq(crew.sessionKey, sessionKey), eq(crew.name, name)))
    .get();
}

/** A crew's most recent assignment (its "current" task), or undefined. */
export function latestAssignment(
  db: MuxDb,
  sessionKey: string,
  crewId: number,
): Assignment | undefined {
  return db
    .select()
    .from(assignments)
    .where(and(eq(assignments.sessionKey, sessionKey), eq(assignments.crewId, crewId)))
    .orderBy(desc(assignments.id))
    .limit(1)
    .get();
}

/** The most recent event of an assignment, or undefined. */
export function latestEvent(db: MuxDb, assignmentId: number): Event | undefined {
  return db
    .select()
    .from(events)
    .where(eq(events.assignmentId, assignmentId))
    .orderBy(desc(events.id))
    .limit(1)
    .get();
}
