import { eq } from "drizzle-orm";
import type { MuxConfig } from "../config.ts";
import type { MuxDb } from "../db/index.ts";
import { assignments } from "../db/schema.ts";
import type { TmuxExecutor } from "../tmux/executor.ts";
import { ASSIGNMENT_STATUS, findCrew, latestAssignment } from "./queries.ts";

export interface SteerDeps {
  readonly db: MuxDb;
  readonly tmux: TmuxExecutor;
  readonly config: MuxConfig;
}

export interface SteerInput {
  readonly name: string;
  readonly message: string;
}

export interface SteerResult {
  readonly crewId: number;
  readonly paneId: string;
  /** True when this steer resumed a crew halted by `report(blocked)`. */
  readonly resumed: boolean;
}

/**
 * Deliver a steering message to a crew's pane as `send-keys` pane input -
 * fire-and-forget, valid at any crew status. The message is sent as literal
 * keys (so it can't be misread as tmux key names), followed by a separate
 * Enter keypress. A direct human pane interjection is indistinguishable
 * crew-side from a steered message (both are pane input); it's simply not
 * logged via MCP.
 *
 * If the crew's current assignment was halted by `report(blocked)`, this is
 * what resumes it.
 */
export async function steerCrew(deps: SteerDeps, input: SteerInput): Promise<SteerResult> {
  const { db, tmux, config } = deps;
  const { sessionKey } = config;
  const name = input.name.trim().toLowerCase();

  const crewRow = findCrew(db, sessionKey, name);
  if (!crewRow) {
    throw new Error(`unknown crew "${name}" in this session`);
  }
  const { paneId } = crewRow;
  if (!paneId) {
    throw new Error(`crew "${name}" has no pane to steer`);
  }

  await tmux.run(["send-keys", "-t", paneId, "-l", input.message]);
  await tmux.run(["send-keys", "-t", paneId, "Enter"]);

  const current = latestAssignment(db, sessionKey, crewRow.id);
  const resumed = current?.status === ASSIGNMENT_STATUS.blocked;
  if (current?.status === ASSIGNMENT_STATUS.blocked) {
    db.update(assignments)
      .set({ status: ASSIGNMENT_STATUS.active })
      .where(eq(assignments.id, current.id))
      .run();
  }

  return { crewId: crewRow.id, paneId, resumed };
}
