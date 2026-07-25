import { ClaudeAdapter } from "./adapter/claude.ts";
import { OpencodeAdapter } from "./adapter/opencode.ts";
import { type BootstrapConfig, bootstrap } from "./bootstrap.ts";
import { spawnCapture } from "./exec.ts";
import { RealTmuxExecutor } from "./tmux/executor.ts";

/**
 * `multiplexer` CLI: the bootstrap entrypoint distributed via `bunx github:fveracoechea/multiplexer`
 * (spec #22). Ensures the shared MCP server is running, creates the Orchestrator
 * window in the user's current tmux session, and launches the Orchestrator
 * agent pre-wired to the server.
 *
 * Assumes tmux is already running and only creates what's missing.
 */
async function main(): Promise<void> {
  const projectPwd = process.cwd();
  const tmuxSession = await currentTmuxSession();
  // The session key is the tmux session name: the crew window and status-bar
  // alerts both target the tmux session by this name, so the two must match.
  const sessionKey = Bun.env.MULTIPLEXER_SESSION_KEY ?? tmuxSession;
  const agentType = Bun.env.MULTIPLEXER_AGENT_TYPE ?? "claude";

  const config: BootstrapConfig = { projectPwd, tmuxSession, sessionKey, agentType };

  const deps = {
    tmux: new RealTmuxExecutor(),
    adapters: new Map([
      ["claude", new ClaudeAdapter()],
      ["opencode", new OpencodeAdapter()],
    ]),
    isHealthy: defaultHealthCheck,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  };

  await bootstrap(deps, config);
}

/** Discover the user's current tmux session name (`tmux display-message -p '#S'`). */
async function currentTmuxSession(): Promise<string> {
  const result = await spawnCapture("tmux", ["display-message", "-p", "#S"]);
  return result.stdout.trim();
}

/** Default health check: a GET to the server root returns a response (not a connection error). */
async function defaultHealthCheck(mcpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(mcpUrl, { method: "GET" });
    return response.status === 404 || response.ok;
  } catch {
    return false;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
