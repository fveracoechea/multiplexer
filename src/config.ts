/**
 * Server-wide configuration for a mux MCP server instance.
 *
 * The `sessionKey` is the project/session isolation boundary: it is stamped on
 * every DB row and every tmux target string so that one project session's crew,
 * assignments, and events never leak into another sharing the same server
 * process (see spec #11, "Singleton, shared, session-aware").
 */
export interface MuxConfig {
  /** Project/session isolation key. Present on every DB row and tmux target. */
  readonly sessionKey: string;
  /** Streamable-HTTP URL crew agents use to reach this MCP server. */
  readonly mcpUrl: string;
  /** MCP server name crew CLIs register the connection under. */
  readonly mcpServerName: string;
  /**
   * The server's own working directory. All server-owned state (DB, logs,
   * worktrees) is rooted here and is gitignored (spec #11).
   */
  readonly serverPwd: string;
}

/** The name of the MCP server as seen by connecting agent CLIs. */
export const MCP_SERVER_NAME = "mux";

/** The tmux window that hosts crew panes, created lazily on first assign. */
export const CREW_WINDOW_NAME = "crew";
