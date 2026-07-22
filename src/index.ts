import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { ClaudeAdapter } from "./adapter/claude.ts";
import { MCP_SERVER_NAME, type MuxConfig } from "./config.ts";
import { createDb } from "./db/index.ts";
import { startHttpServer } from "./http.ts";
import { createMuxServer } from "./server.ts";
import { RealTmuxExecutor } from "./tmux/executor.ts";

/**
 * Production entrypoint: boot the shared mux MCP server over streamable-HTTP.
 *
 * The bootstrap (`mux` CLI) owns port discovery and session lifecycle; here we
 * read the essentials from the environment with sensible defaults so the server
 * is runnable on its own. All server-owned state is rooted at the server's PWD.
 */
async function main(): Promise<void> {
  const port = Number(Bun.env.MUX_PORT ?? 4123);
  const serverPwd = process.cwd();
  const sessionKey = Bun.env.MUX_SESSION_KEY ?? basename(serverPwd);

  const stateDir = join(serverPwd, ".mux");
  mkdirSync(stateDir, { recursive: true });
  const db = createDb(join(stateDir, "mux.db"));

  const config: MuxConfig = {
    sessionKey,
    mcpUrl: `http://localhost:${port}/mcp`,
    mcpServerName: MCP_SERVER_NAME,
    serverPwd,
  };

  const tmux = new RealTmuxExecutor();
  const adapters = new Map([["claude", new ClaudeAdapter()]]);

  const http = await startHttpServer(
    (connectedCrew) => createMuxServer({ db, tmux, adapters, config, connectedCrew }),
    { port },
  );
  console.log(`mux MCP server listening on ${http.mcpUrl} (session: ${sessionKey})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
