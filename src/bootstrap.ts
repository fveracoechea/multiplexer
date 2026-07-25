import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter } from "./adapter/types.ts";
import { MCP_SERVER_NAME } from "./config.ts";
import { buildOrchestratorRole } from "./roles.ts";
import type { TmuxExecutor } from "./tmux/executor.ts";

/** The multiplexer package root (where src/ + node_modules/ live). */
function packageRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

/** Absolute path to the server entrypoint (resilient to CWD). */
function serverEntryPath(): string {
  return join(packageRoot(), "src", "index.ts");
}

/** The tmux session the shared server runs in, separate from any project. */
export const SERVER_TMUX_SESSION = "multiplexer-server";
/** The tmux window the Orchestrator runs in, inside the user's project session. */
export const ORCHESTRATOR_WINDOW = "orchestrator";
/** Default fixed port the server is discovered on (spec #22). */
export const DEFAULT_PORT = 4123;

/** Where the PID file lives; the bootstrap confirms a healthy server is ours. */
export function pidFilePath(): string {
  return join(process.env.HOME ?? "/tmp", ".multiplexer", "server.pid");
}

/** Where the server's state (DB, logs) is rooted; the bootstrap passes this to the server. */
export function serverStatePath(): string {
  return join(process.env.HOME ?? "/tmp", ".multiplexer", "server");
}

export interface BootstrapConfig {
  /** The user's project directory; the Orchestrator runs here. */
  readonly projectPwd: string;
  /** Tmux session the Orchestrator window is created in (the user's current one). */
  readonly tmuxSession: string;
  /** The session key isolating this project's crew/assignments/events. */
  readonly sessionKey: string;
  /** Port the server is discovered on. Defaults to {@link DEFAULT_PORT}. */
  readonly port?: number;
  /** Agent CLI for the Orchestrator; defaults to claude. */
  readonly agentType?: string;
}

export interface BootstrapDeps {
  readonly tmux: TmuxExecutor;
  readonly adapters: ReadonlyMap<string, Adapter>;
  /** Injectable health check so tests don't need a real server. */
  readonly isHealthy: (mcpUrl: string) => Promise<boolean>;
  /** Injectable sleep for the wait-for-healthy poll. */
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Bootstrap the multiplexer system: ensure the shared MCP server is running (reusing a
 * healthy one, starting one otherwise), then create the Orchestrator window in
 * the user's tmux session and launch the Orchestrator agent pre-wired to the
 * server (spec #22).
 *
 * Bootstrap assumes tmux is already running and only creates what's missing.
 * The server runs in its own dedicated, non-project tmux session and is
 * discovered via a fixed port + health-check + PID file; a second project
 * session reuses the same server, isolated by the session key in its
 * connection URL (ADR-0002).
 */
export async function bootstrap(deps: BootstrapDeps, config: BootstrapConfig): Promise<void> {
  const port = config.port ?? DEFAULT_PORT;
  const mcpUrl = `http://localhost:${port}/mcp`;
  const orchestratorMcpUrl = `${mcpUrl}/${config.sessionKey}`;

  const reused = await discoverOrStartServer(deps, mcpUrl);
  if (reused) {
    console.log(`multiplexer: reused existing MCP server at ${mcpUrl}`);
  } else {
    console.log(`multiplexer: started MCP server in tmux session ${SERVER_TMUX_SESSION}`);
  }

  await launchOrchestrator(deps, config, orchestratorMcpUrl);
  console.log(`multiplexer: orchestrator launched in ${config.tmuxSession}:${ORCHESTRATOR_WINDOW}`);
}

/** Return true when a healthy server is already running at `mcpUrl` and is ours. */
async function discoverOrStartServer(deps: BootstrapDeps, mcpUrl: string): Promise<boolean> {
  if ((await deps.isHealthy(mcpUrl)) && isOurServerAlive()) {
    return true;
  }
  await startServerInTmux(deps.tmux);
  await waitForHealthy(deps, mcpUrl);
  return false;
}

/** Confirm the healthy server is ours via the PID file. */
function isOurServerAlive(): boolean {
  const pidFile = pidFilePath();
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start the server in its own dedicated tmux session from the server state dir. */
async function startServerInTmux(tmux: TmuxExecutor): Promise<void> {
  const statePath = serverStatePath();
  mkdirSync(statePath, { recursive: true });
  await tmux.run([
    "new-session",
    "-d",
    "-s",
    SERVER_TMUX_SESSION,
    "-c",
    statePath,
    "bun",
    serverEntryPath(),
  ]);
}

/** Poll the health check until the server is up (or a small timeout). */
async function waitForHealthy(deps: BootstrapDeps, mcpUrl: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await deps.isHealthy(mcpUrl)) return;
    await deps.sleep(100);
  }
  throw new Error(`multiplexer server did not become healthy at ${mcpUrl}`);
}

/** Create the Orchestrator window and launch the agent pre-wired to the server. */
async function launchOrchestrator(
  deps: BootstrapDeps,
  config: BootstrapConfig,
  orchestratorMcpUrl: string,
): Promise<void> {
  const adapter = deps.adapters.get(config.agentType ?? "claude");
  if (!adapter) {
    throw new Error(`unknown agentType "${config.agentType}"`);
  }

  // Create the Orchestrator window in the user's current tmux session.
  const created = await deps.tmux.run([
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    config.tmuxSession,
    "-n",
    ORCHESTRATOR_WINDOW,
    "-c",
    config.projectPwd,
  ]);
  const paneId = created.stdout.trim();

  // Launch the Orchestrator with the orchestrator role (portable markdown,
  // spec #23) and the MCP server wired to its session endpoint.
  const role = buildOrchestratorRole();
  const plan = adapter.prepare({
    crewName: "orchestrator",
    role,
    initialPrompt: `You are the orchestrator for the "${config.sessionKey}" project session.`,
    mcpServerName: MCP_SERVER_NAME,
    mcpUrl: orchestratorMcpUrl,
    worktreePath: null,
    serverPwd: serverStatePath(),
    sessionKey: config.sessionKey,
  });

  const startDir = plan.cwd ? ["-c", plan.cwd] : ["-c", config.projectPwd];
  await deps.tmux.run(["respawn-pane", "-k", ...startDir, "-t", paneId, ...plan.argv]);
}

/** Derive the session key from the project directory name (the default). */
export function sessionKeyFromProject(projectPwd: string): string {
  return basename(projectPwd);
}
