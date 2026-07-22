import { eq } from "drizzle-orm";
import type { Adapter } from "../adapter/types.ts";
import { CREW_WINDOW_NAME, type MuxConfig } from "../config.ts";
import type { MuxDb } from "../db/index.ts";
import { assignments, crew } from "../db/schema.ts";
import { buildCrewRole, buildInitialPrompt } from "../roles.ts";
import type { TmuxExecutor } from "../tmux/executor.ts";

const DEFAULT_AGENT_TYPE = "claude";

export interface AssignDeps {
  readonly db: MuxDb;
  readonly tmux: TmuxExecutor;
  readonly adapters: ReadonlyMap<string, Adapter>;
  readonly config: MuxConfig;
}

export interface AssignInput {
  readonly name: string;
  readonly skill: string;
  readonly scope: string;
  readonly agentType?: string;
  readonly issue?: number;
}

export interface AssignResult {
  readonly crewId: number;
  readonly assignmentId: number;
  readonly name: string;
  readonly agentType: string;
  readonly paneId: string;
  readonly worktreePath: string | null;
}

/**
 * `assign_crew` core: spawn a new crew agent.
 *
 * Writes one `crew` identity row and one `assignments` row, provisions the crew
 * tmux window lazily on the first assign of a session, and launches the agent
 * CLI (role-injected, MCP-wired) into its pane. Read-only skills get no
 * worktree. Retasking an existing name and worktree provisioning for
 * file-mutating skills are handled by their own tickets.
 */
export async function assignCrew(deps: AssignDeps, input: AssignInput): Promise<AssignResult> {
  const { db, tmux, config } = deps;
  const name = input.name.trim().toLowerCase();
  const agentType = input.agentType ?? DEFAULT_AGENT_TYPE;

  const adapter = deps.adapters.get(agentType);
  if (!adapter) {
    throw new Error(`unknown agentType "${agentType}"`);
  }

  const { sessionKey } = config;
  const sessionCrew = db.select().from(crew).where(eq(crew.sessionKey, sessionKey)).all();

  if (sessionCrew.some((c) => c.name === name)) {
    throw new Error(
      `crew "${name}" already exists in this session; retasking is not yet implemented`,
    );
  }

  // No assignment provisions a worktree yet: read-only skills never need one,
  // and worktree provisioning for file-mutating skills is added in ticket #15.
  const worktreePath: string | null = null;
  const branch: string | null = null;

  // The crew window is created lazily on the first assign of a session; every
  // subsequent crew splits that window and re-tiles it.
  const paneId = await provisionPane(tmux, sessionKey, sessionCrew.length === 0);

  const launch = adapter.buildLaunchCommand({
    crewName: name,
    role: buildCrewRole(),
    initialPrompt: buildInitialPrompt(input.skill, input.scope),
    mcpServerName: config.mcpServerName,
    // Per-crew endpoint so the server can attribute this crew's reports to it
    // without trusting a spoofable tool argument (ADR-0001).
    mcpUrl: `${config.mcpUrl}/${name}`,
  });
  await tmux.run(["respawn-pane", "-k", "-t", paneId, ...launch]);

  return db.transaction((tx) => {
    const insertedCrew = tx
      .insert(crew)
      .values({ sessionKey, name, agentType, paneId, worktreePath, branch })
      .returning()
      .get();
    const insertedAssignment = tx
      .insert(assignments)
      .values({
        sessionKey,
        crewId: insertedCrew.id,
        skill: input.skill,
        scope: input.scope,
        agentType,
        issue: input.issue ?? null,
      })
      .returning()
      .get();

    return {
      crewId: insertedCrew.id,
      assignmentId: insertedAssignment.id,
      name: insertedCrew.name,
      agentType,
      paneId,
      worktreePath: insertedCrew.worktreePath,
    };
  });
}

/** Create (first assign) or split (subsequent) the crew window; return the new pane id. */
async function provisionPane(
  tmux: TmuxExecutor,
  sessionKey: string,
  isFirst: boolean,
): Promise<string> {
  const windowTarget = `${sessionKey}:${CREW_WINDOW_NAME}`;
  if (isFirst) {
    const created = await tmux.run([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      sessionKey,
      "-n",
      CREW_WINDOW_NAME,
    ]);
    return created.stdout.trim();
  }

  const split = await tmux.run([
    "split-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    windowTarget,
  ]);
  await tmux.run(["select-layout", "-t", windowTarget, "tiled"]);
  return split.stdout.trim();
}
