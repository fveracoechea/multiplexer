import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/**
 * Drizzle schema for the mux state store (source of truth, spec #11).
 *
 * Three tables, each carrying `sessionKey` for project/session isolation:
 *  - `crew`        identity; persists across retask/dismiss/session-restart.
 *  - `assignments` one row per `assign_crew` spawn-or-retask call.
 *  - `events`      append-only progress log scoped to an assignment.
 *
 * Runs on `bun:sqlite` (file in prod, `:memory:` in tests).
 */

const now = sql`(unixepoch('subsec') * 1000)`;

/**
 * Crew identity. A crew agent's name is a stable, human-readable identifier,
 * unique within a session; its worktree/branch (null for read-only skills) and
 * tmux pane survive retasking and dismissal.
 */
export const crew = sqliteTable(
  "crew",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionKey: text("session_key").notNull(),
    /** Orchestrator-chosen lowercase sci-fi name, stable across the session. */
    name: text("name").notNull(),
    agentType: text("agent_type").notNull(),
    /** tmux pane id (e.g. "%3") the agent runs in; null until first spawn. */
    paneId: text("pane_id"),
    /** Worktree path; null for read-only skills that need no worktree. */
    worktreePath: text("worktree_path"),
    /** Branch checked out in the worktree; null when there is no worktree. */
    branch: text("branch"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [unique("crew_session_name").on(t.sessionKey, t.name)],
);

/**
 * One assignment per `assign_crew` call. A retask of an existing crew name adds
 * a new assignment row (with a fresh event trail) rather than mutating the old.
 */
export const assignments = sqliteTable(
  "assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionKey: text("session_key").notNull(),
    crewId: integer("crew_id")
      .notNull()
      .references(() => crew.id),
    skill: text("skill").notNull(),
    scope: text("scope").notNull(),
    agentType: text("agent_type").notNull(),
    /** Optional PR-closing metadata; a shared issue implies a shared branch. */
    issue: integer("issue"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("assignments_crew").on(t.crewId)],
);

/**
 * Append-only progress log. Each event references an assignment; the terminal
 * `report(done)` is an assignment's last event.
 */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionKey: text("session_key").notNull(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => assignments.id),
    /** progress | milestone | blocked | done. */
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    /** Free-form pointer to whatever artifact the skill produced, if any. */
    reportPath: text("report_path"),
    prUrl: text("pr_url"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => [index("events_assignment").on(t.assignmentId)],
);

export type Crew = typeof crew.$inferSelect;
export type NewCrew = typeof crew.$inferInsert;
export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
