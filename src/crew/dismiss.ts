import { and, eq, ne } from "drizzle-orm";
import { DEFAULT_GRACE_WINDOW_MS, type MuxConfig } from "../config.ts";
import type { MuxDb } from "../db/index.ts";
import { assignments, type Crew, crew, events } from "../db/schema.ts";
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
}

export interface DismissResult {
  readonly dismissed: DismissedCrew[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `dismiss_crew` core: wind down one crew agent, or every crew in the session.
 *
 * Graceful by default: a wrap-up message is delivered to the pane (the same
 * send-keys mechanism as `steer_crew`), then a small grace window gives the
 * agent a chance to call `report(done)` itself. `force` skips both - it
 * interrupts the pane immediately instead. Either way completion is
 * guaranteed: if the crew hasn't produced a `done` event by the time dismissal
 * proceeds, the server synthesizes one so an assignment always ends terminal
 * (spec #18).
 *
 * Cleanup piggybacks on this same call, with no separate retention job: once
 * an assignment's terminal event is known, every other event on that
 * assignment is deleted, collapsing its trail down to just the terminal
 * report. `wipe` additionally deletes the crew's worktree and clears it from
 * the identity row; the row itself (name, pane, branch survive) is untouched
 * so the name can still be retasked afterward.
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
  const { db, tmux, git, config } = deps;
  const { sessionKey } = config;
  const force = input.force ?? false;

  const current = latestAssignment(db, sessionKey, crewRow.id);
  let assignmentId: number | null = null;
  let eventId: number | null = null;
  let synthesized = false;

  if (current) {
    assignmentId = current.id;
    const initialLatest = latestEvent(db, current.id);
    const alreadyDone = initialLatest?.status === "done";

    if (!alreadyDone && crewRow.paneId) {
      if (force) {
        await tmux.run(["send-keys", "-t", crewRow.paneId, "C-c"]);
      } else {
        await tmux.run(["send-keys", "-t", crewRow.paneId, "-l", buildDismissPrompt()]);
        await tmux.run(["send-keys", "-t", crewRow.paneId, "Enter"]);
        await sleep(config.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS);
      }
    }

    const latest = alreadyDone ? initialLatest : latestEvent(db, current.id);
    if (latest?.status === "done") {
      eventId = latest.id;
    } else {
      synthesized = true;
      const inserted = db
        .insert(events)
        .values({
          sessionKey,
          assignmentId: current.id,
          status: "done",
          summary: force ? "Force-dismissed." : "Dismissed after the grace window; no self-report.",
        })
        .returning()
        .get();
      eventId = inserted.id;
    }

    db.update(assignments)
      .set({ status: ASSIGNMENT_STATUS.done })
      .where(eq(assignments.id, current.id))
      .run();
    // Cleanup piggybacks on dismissal: collapse the trail to just the terminal event.
    db.delete(events)
      .where(and(eq(events.assignmentId, current.id), ne(events.id, eventId)))
      .run();
  }

  let wiped = false;
  if (input.wipe && crewRow.worktreePath) {
    await git.run(["worktree", "remove", crewRow.worktreePath, "--force"]);
    db.update(crew).set({ worktreePath: null, branch: null }).where(eq(crew.id, crewRow.id)).run();
    wiped = true;
  }

  return { crewId: crewRow.id, name: crewRow.name, assignmentId, eventId, synthesized, wiped };
}
