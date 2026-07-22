import { eq } from "drizzle-orm";
import type { Adapter } from "../adapter/types.ts";
import { CREW_WINDOW_NAME, DEFAULT_BASE_BRANCH, type MuxConfig } from "../config.ts";
import type { MuxDb } from "../db/index.ts";
import { assignments, type Crew, crew } from "../db/schema.ts";
import type { GitExecutor } from "../git/executor.ts";
import { buildCrewRole, buildInitialPrompt } from "../roles.ts";
import type { TmuxExecutor } from "../tmux/executor.ts";
import { findCrew } from "./queries.ts";
import { provisionWorktree } from "./worktree.ts";

const DEFAULT_AGENT_TYPE = "claude";

type MuxTx = Parameters<Parameters<MuxDb["transaction"]>[0]>[0];

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
 * `assign_crew` core: spawn a new crew agent, or retask an existing one.
 *
 * A fresh name writes one `crew` identity row and one `assignments` row,
 * provisions the crew tmux window lazily on the first assign of a session,
 * provisions a git worktree for file-mutating skills (read-only skills get
 * none), and launches the agent CLI (role-injected, MCP-wired) into its pane.
 *
 * An existing name retasks instead: the same pane and worktree are reused via
 * `tmux respawn-pane -k` (a genuinely fresh process, not a carried-over
 * conversation), a worktree the crew already holds is re-synced against base
 * first, and only a new `assignments` row is written - the `crew` identity
 * row's name never changes, and its worktree/branch change only once, the
 * first time a previously worktree-less crew is retasked with a
 * file-mutating skill. The new assignment starts with an empty event trail
 * since events are scoped per-assignment.
 */
export async function assignCrew(deps: AssignDeps, input: AssignInput): Promise<AssignResult> {
  const { db, config } = deps;
  const name = input.name.trim().toLowerCase();
  const agentType = input.agentType ?? DEFAULT_AGENT_TYPE;

  const adapter = deps.adapters.get(agentType);
  if (!adapter) {
    throw new Error(`unknown agentType "${agentType}"`);
  }

  const existingCrew = findCrew(db, config.sessionKey, name);
  if (existingCrew) {
    return retaskCrew(deps, existingCrew, agentType, adapter, input);
  }
  return spawnCrew(deps, name, agentType, adapter, input);
}

async function spawnCrew(
  deps: AssignDeps,
  name: string,
  agentType: string,
  adapter: Adapter,
  input: AssignInput,
): Promise<AssignResult> {
  const { db, tmux, config } = deps;
  const { sessionKey } = config;
  const isFirstCrew =
    db.select().from(crew).where(eq(crew.sessionKey, sessionKey)).all().length === 0;

  // File-mutating skills get a dedicated worktree + branch; read-only skills
  // get none. A fresh crew's worktree is created here.
  const worktree = await provisionWorktree(worktreeDeps(deps), {
    sessionKey,
    crewName: name,
    skill: input.skill,
  });
  const worktreePath = worktree?.path ?? null;
  const branch = worktree?.branch ?? null;

  // The crew window is created lazily on the first assign of a session; every
  // subsequent crew splits that window and re-tiles it.
  const paneId = await provisionPane(tmux, sessionKey, isFirstCrew);
  await launchAgent(deps, adapter, { crewName: name, paneId, worktreePath }, input);

  return db.transaction((tx) => {
    const insertedCrew = tx
      .insert(crew)
      .values({ sessionKey, name, agentType, paneId, worktreePath, branch })
      .returning()
      .get();
    return writeAssignment(tx, input, agentType, {
      crewId: insertedCrew.id,
      name: insertedCrew.name,
      sessionKey,
      paneId,
      worktreePath: insertedCrew.worktreePath,
    });
  });
}

async function retaskCrew(
  deps: AssignDeps,
  existingCrew: Crew,
  agentType: string,
  adapter: Adapter,
  input: AssignInput,
): Promise<AssignResult> {
  const { db, config } = deps;
  const { sessionKey } = config;
  const paneId = existingCrew.paneId;
  if (!paneId) {
    throw new Error(`crew "${existingCrew.name}" has no pane to retask`);
  }

  // Re-sync the reused worktree against base before the new task; a crew that
  // had none (a prior read-only skill) gets one freshly provisioned instead.
  // A read-only retask needs no worktree of its own, but a worktree the crew
  // already holds is left in place - untouched, not recreated - for whenever
  // it's next retasked with a file-mutating skill.
  const worktree = await provisionWorktree(worktreeDeps(deps), {
    sessionKey,
    crewName: existingCrew.name,
    skill: input.skill,
    existingWorktree: existingCrew.worktreePath ?? undefined,
  });
  // What this launch runs in: the freshly (re)provisioned worktree, or none.
  const launchWorktreePath = worktree?.path ?? null;
  // What the crew identity row records: unchanged unless this call is the one
  // that gives a previously worktree-less crew its first worktree.
  const identityWorktreePath = worktree?.path ?? existingCrew.worktreePath;
  const identityBranch = worktree?.branch ?? existingCrew.branch;

  await launchAgent(
    deps,
    adapter,
    { crewName: existingCrew.name, paneId, worktreePath: launchWorktreePath },
    input,
  );

  return db.transaction((tx) => {
    if (worktree) {
      tx.update(crew)
        .set({ worktreePath: identityWorktreePath, branch: identityBranch })
        .where(eq(crew.id, existingCrew.id))
        .run();
    }
    return writeAssignment(tx, input, agentType, {
      crewId: existingCrew.id,
      name: existingCrew.name,
      sessionKey,
      paneId,
      worktreePath: identityWorktreePath,
    });
  });
}

/** Insert the new `assignments` row and build the tool result common to spawn and retask. */
function writeAssignment(
  tx: MuxTx,
  input: AssignInput,
  agentType: string,
  target: {
    crewId: number;
    name: string;
    sessionKey: string;
    paneId: string;
    worktreePath: string | null;
  },
): AssignResult {
  const insertedAssignment = tx
    .insert(assignments)
    .values({
      sessionKey: target.sessionKey,
      crewId: target.crewId,
      skill: input.skill,
      scope: input.scope,
      agentType,
      issue: input.issue ?? null,
    })
    .returning()
    .get();

  return {
    crewId: target.crewId,
    assignmentId: insertedAssignment.id,
    name: target.name,
    agentType,
    paneId: target.paneId,
    worktreePath: target.worktreePath,
  };
}

function worktreeDeps(deps: AssignDeps) {
  return {
    git: deps.git,
    serverPwd: deps.config.serverPwd,
    baseBranch: deps.config.baseBranch ?? DEFAULT_BASE_BRANCH,
  };
}

/** Launch the agent CLI into `paneId` via `respawn-pane -k`, in its worktree when it has one. */
async function launchAgent(
  deps: AssignDeps,
  adapter: Adapter,
  target: { crewName: string; paneId: string; worktreePath: string | null },
  input: AssignInput,
): Promise<void> {
  const { config } = deps;
  const launch = adapter.buildLaunchCommand({
    crewName: target.crewName,
    role: buildCrewRole(),
    initialPrompt: buildInitialPrompt(input.skill, input.scope),
    mcpServerName: config.mcpServerName,
    // Per-crew endpoint so the server can attribute this crew's reports to it
    // without trusting a spoofable tool argument (ADR-0001).
    mcpUrl: `${config.mcpUrl}/${target.crewName}`,
  });
  // Launch the agent in its worktree when it has one, so file-mutating work
  // happens on the isolated checkout.
  const startDir = target.worktreePath ? ["-c", target.worktreePath] : [];
  await deps.tmux.run(["respawn-pane", "-k", ...startDir, "-t", target.paneId, ...launch]);
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
