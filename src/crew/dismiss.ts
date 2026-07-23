import { and, eq, ne } from "drizzle-orm";
import { DEFAULT_GRACE_WINDOW_MS, type MuxConfig } from "../config.ts";
import type { MuxDb } from "../db/index.ts";
import { assignments, type Crew, crew, type Event, events } from "../db/schema.ts";
import type { GitExecutor } from "../git/executor.ts";
import { buildDismissPrompt } from "../roles.ts";
import type { TmuxExecutor } from "../tmux/executor.ts";
import { ASSIGNMENT_STATUS, findCrew, latestAssignment, latestEvent } from "./queries.ts";

export interface DismissDeps {
  readonly db: MuxDb;
  readonly tmux: TmuxExecutor;
  readonly git: GitExecutor;
  readonly config: MuxConfig;
}

export interface DismissInput {
  /** Crew to dismiss; omit to dismiss every crew in the session. */
  readonly name?: string;
  /** Stop immediately (no wrap-up message, no grace window). */
  readonly force?: boolean;
  /** Also delete the crew's worktree - the "start from scratch" op. */
  readonly wipe?: boolean;
}

export interface DismissedCrew {
  readonly crewId: number;
  readonly name: string;
  readonly assignmentId: number | null;
  readonly eventId: number | null;
  /** True when the server synthesized the terminal report itself. */
  readonly synthesized: boolean;
  readonly wiped: boolean;
  /**
   * True when the grace window is still running in the background: the
   * terminal `done` event, event collapse, and any `wipe` land once it
   * elapses, not in this response. `dismiss_crew` stays non-blocking on the
   * graceful path (spec #11, "all five tools are non-blocking") - the
   * Orchestrator observes the outcome later via `crew_status`.
   */
  readonly pending: boolean;
}

export interface DismissResult {
  readonly dismissed: DismissedCrew[];
}

/**
 * `dismiss_crew` core: wind down one crew agent, or every crew in the session.
 *
 * Graceful by default: a wrap-up message is delivered to the pane (the same
 * send-keys mechanism as `steer_crew`), then a small grace window gives the
 * agent a chance to call `report(done)` itself before the server synthesizes
 * one on its behalf - guaranteeing every assignment ends terminal even if the
 * crew never cooperates. That window runs in the background (a scheduled
 * timer, not an awaited sleep) so the tool call itself returns immediately;
 * `force` skips the message and window entirely and stops the pane right away
 * instead.
 *
 * Cleanup piggybacks on completion, with no separate retention job: once an
 * assignment's terminal event is known, every other event on that assignment
 * is deleted, collapsing its trail down to just the terminal report. `wipe`
 * additionally deletes the crew's worktree and clears it from the identity
 * row; the row itself (name, pane, branch) is untouched so the name can still
 * be retasked afterward.
 */
export async function dismissCrew(deps: DismissDeps, input: DismissInput): Promise<DismissResult> {
  const { db, config } = deps;
  const { sessionKey } = config;

  let targets: Crew[];
  if (input.name) {
    const name = input.name.trim().toLowerCase();
    const crewRow = findCrew(db, sessionKey, name);
    if (!crewRow) {
      throw new Error(`unknown crew "${name}" in this session`);
    }
    targets = [crewRow];
  } else {
    targets = db.select().from(crew).where(eq(crew.sessionKey, sessionKey)).orderBy(crew.id).all();
  }

  const dismissed: DismissedCrew[] = [];
  for (const crewRow of targets) {
    dismissed.push(await dismissOne(deps, crewRow, input));
  }
  return { dismissed };
}

async function dismissOne(
  deps: DismissDeps,
  crewRow: Crew,
  input: DismissInput,
): Promise<DismissedCrew> {
  const { db, tmux, config } = deps;
  const { sessionKey } = config;
  const force = input.force ?? false;

  const current = latestAssignment(db, sessionKey, crewRow.id);
  if (!current) {
    const wiped = await maybeWipe(deps, crewRow, input);
    return {
      crewId: crewRow.id,
      name: crewRow.name,
      assignmentId: null,
      eventId: null,
      synthesized: false,
      wiped,
      pending: false,
    };
  }

  const latest = latestEvent(db, current.id);
  if (latest?.status === "done") {
    const { eventId } = completeAssignment(db, sessionKey, current.id, latest, "");
    const wiped = await maybeWipe(deps, crewRow, input);
    return {
      crewId: crewRow.id,
      name: crewRow.name,
      assignmentId: current.id,
      eventId,
      synthesized: false,
      wiped,
      pending: false,
    };
  }

  if (force) {
    if (crewRow.paneId) {
      await tmux.run(["send-keys", "-t", crewRow.paneId, "C-c"]);
    }
    const { eventId } = completeAssignment(
      db,
      sessionKey,
      current.id,
      undefined,
      "Force-dismissed.",
    );
    const wiped = await maybeWipe(deps, crewRow, input);
    return {
      crewId: crewRow.id,
      name: crewRow.name,
      assignmentId: current.id,
      eventId,
      synthesized: true,
      wiped,
      pending: false,
    };
  }

  // Graceful default: deliver the wrap-up message now (bounded pane input,
  // same as steer_crew), then let the grace window elapse in the background
  // so this call itself stays non-blocking.
  if (crewRow.paneId) {
    await tmux.run(["send-keys", "-t", crewRow.paneId, "-l", buildDismissPrompt()]);
    await tmux.run(["send-keys", "-t", crewRow.paneId, "Enter"]);
  }
  const graceWindowMs = config.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
  setTimeout(() => {
    try {
      const stillLatest = latestEvent(db, current.id);
      completeAssignment(
        db,
        sessionKey,
        current.id,
        stillLatest?.status === "done" ? stillLatest : undefined,
        "Dismissed after the grace window; no self-report.",
      );
      void maybeWipe(deps, crewRow, input);
    } catch (err) {
      console.error(`dismiss_crew: grace-window finalize failed for "${crewRow.name}"`, err);
    }
  }, graceWindowMs);

  return {
    crewId: crewRow.id,
    name: crewRow.name,
    assignmentId: current.id,
    eventId: null,
    synthesized: false,
    wiped: false,
    pending: true,
  };
}

/**
 * Mark an assignment done and collapse its event trail down to one terminal
 * event - `existingDoneEvent` when the crew already self-reported, otherwise a
 * synthesized one. One transaction, matching the write pattern `report.ts`
 * and `assign.ts` use for their own multi-statement writes.
 */
function completeAssignment(
  db: MuxDb,
  sessionKey: string,
  assignmentId: number,
  existingDoneEvent: Event | undefined,
  synthesizedSummary: string,
): { eventId: number } {
  return db.transaction((tx) => {
    const eventId = existingDoneEvent
      ? existingDoneEvent.id
      : tx
          .insert(events)
          .values({ sessionKey, assignmentId, status: "done", summary: synthesizedSummary })
          .returning()
          .get().id;

    tx.update(assignments)
      .set({ status: ASSIGNMENT_STATUS.done })
      .where(eq(assignments.id, assignmentId))
      .run();
    tx.delete(events)
      .where(and(eq(events.assignmentId, assignmentId), ne(events.id, eventId)))
      .run();

    return { eventId };
  });
}

async function maybeWipe(deps: DismissDeps, crewRow: Crew, input: DismissInput): Promise<boolean> {
  if (!input.wipe || !crewRow.worktreePath) {
    return false;
  }
  await deps.git.run(["worktree", "remove", crewRow.worktreePath, "--force"]);
  deps.db
    .update(crew)
    .set({ worktreePath: null, branch: null })
    .where(eq(crew.id, crewRow.id))
    .run();
  return true;
}
