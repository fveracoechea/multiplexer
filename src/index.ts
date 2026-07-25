import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAdapter } from "./adapter/claude.ts";
import { OpencodeAdapter } from "./adapter/opencode.ts";
import type { Adapter } from "./adapter/types.ts";
import { pidFilePath } from "./bootstrap.ts";
import { MCP_SERVER_NAME, type MuxConfig } from "./config.ts";
import { createDb } from "./db/index.ts";
import { RealGitExecutor } from "./git/executor.ts";
import { startHttpServer } from "./http.ts";
import { RealPrExecutor } from "./pr/executor.ts";
import { createMuxServer } from "./server.ts";
import { RealTmuxExecutor } from "./tmux/executor.ts";

/**
 * Production entrypoint: boot the shared multiplexer MCP server over streamable-HTTP.
 *
 * The bootstrap (`multiplexer` CLI) owns port discovery and session lifecycle; here we
 * read the essentials from the environment with sensible defaults so the server
 * is runnable on its own. All server-owned state is rooted at the server's PWD.
 *
 * A single server instance serves every project session concurrently; the
 * session key is carried in the connection URL (`/mcp/<sessionKey>`) and used
 * to build a per-connection config, so each project's crew, assignments, and
 * events are isolated by its own key (spec #22, ADR-0002).
 */
async function main(): Promise<void> {
  const port = Number(Bun.env.MULTIPLEXER_PORT ?? 4123);
  const serverPwd = process.cwd();

  const stateDir = join(serverPwd, ".multiplexer");
  mkdirSync(stateDir, { recursive: true });
  const db = createDb(join(stateDir, "multiplexer.db"));

  // Record our PID so the bootstrap can confirm a healthy server is ours.
  const pidFile = pidFilePath();
  mkdirSync(join(pidFile, ".."), { recursive: true });
  writeFileSync(pidFile, String(process.pid));

  const tmux = new RealTmuxExecutor();
  const git = new RealGitExecutor();
  const pr = new RealPrExecutor();
  const adapters: Map<string, Adapter> = new Map([
    ["claude", new ClaudeAdapter()],
    ["opencode", new OpencodeAdapter()],
  ]);

  const http = await startHttpServer(
    (connection) => {
      const config: MuxConfig = {
        sessionKey: connection.sessionKey,
        mcpUrl: `http://localhost:${port}/mcp`,
        mcpServerName: MCP_SERVER_NAME,
        serverPwd,
      };
      return createMuxServer({
        db,
        tmux,
        git,
        pr,
        adapters,
        config,
        connectedCrew: connection.crewName,
      });
    },
    { port },
  );
  console.log(`multiplexer MCP server listening on ${http.mcpUrl} (PID ${process.pid})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
