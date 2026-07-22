import { eq } from "drizzle-orm";
import type { Adapter } from "../adapter/types.ts";
import { CREW_WINDOW_NAME, DEFAULT_BASE_BRANCH, type MuxConfig } from "../config.ts";
import type { MuxDb } from "../db/index.ts";
import { assignments, crew } from "../db/schema.ts";
import type { GitExecutor } from "../git/executor.ts";
import { buildCrewRole, buildInitialPrompt } from "../roles.ts";
import type { TmuxExecutor } from "../tmux/executor.ts";
import { provisionWorktree } from "./worktree.ts";

const DEFAULT_AGENT_TYPE = "claude";

export interface AssignDeps {
  readonly db: MuxDb;
  readonly tmux: TmuxExecutor;
  readonly git: GitExecutor;
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
 * tmux window lazily on the first assign of a session, provisions a git worktree
 * for file-mutating skills (read-only skills get none), and launches the agent
 * CLI (role-injected, MCP-wired) into its pane - in its worktree when it has one.
 * Retasking an existing name is handled by its own ticket.
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

  // File-mutating skills get a dedicated worktree + branch; read-only skills
  // get none. A fresh crew's worktree is created here.
  const worktree = await provisionWorktree(
    {
      git: deps.git,
      serverPwd: config.serverPwd,
      baseBranch: config.baseBranch ?? DEFAULT_BASE_BRANCH,
    },
    { sessionKey, crewName: name, skill: input.skill },
  );
  const worktreePath = worktree?.path ?? null;
  const branch = worktree?.branch ?? null;

  // The crew window is created lazily on the first assign of a session; every
  // subsequent crew splits that window and re-tiles it.
  const paneId = await provisionPane(tmux, sessionKey, sessionCrew.length === 0);

  const launch = adapter.buildLaunchCommand({
    crewName: name,
    role: buildCrewRole(),
    initialPrompt: buildInitialPrompt(input.skill, input.scope),
    mcpServerName: config.mcpServerName,
    mcpUrl: config.mcpUrl,
  });
  // Launch the agent in its worktree when it has one, so file-mutating work
  // happens on the isolated checkout.
  const startDir = worktreePath ? ["-c", worktreePath] : [];
  await tmux.run(["respawn-pane", "-k", ...startDir, "-t", paneId, ...launch]);

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
