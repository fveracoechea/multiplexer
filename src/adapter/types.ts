/**
 * The per-CLI adapter boundary (spec #11, "Adapter").
 *
 * An adapter hides how a given agent CLI is launched with a role injected and
 * the MCP server wired. Its command-building is pure or near-pure - it returns
 * argv and an optional launch CWD, and may write per-CLI config files as a side
 * effect (opencode provisions an agent file + `opencode.json`) - but it never
 * touches tmux or the process table, so it is asserted through the tmux
 * executor seam (and the filesystem, for the files it writes) rather than
 * needing a seam of its own.
 */
export interface LaunchSpec {
  /** Stable crew name (also used to namespace any per-agent config files). */
  readonly crewName: string;
  /** Role system prompt injected into the launched CLI. */
  readonly role: string;
  /** The task prompt handed to the agent on launch (skill + scope). */
  readonly initialPrompt: string;
  /** MCP server name the CLI registers the connection under. */
  readonly mcpServerName: string;
  /** Streamable-HTTP URL of the mux MCP server on localhost (per-crew). */
  readonly mcpUrl: string;
  /**
   * Worktree path the crew works in, or null for a read-only skill that
   * provisions no worktree. Adapters that need a launch CWD use this when set.
   */
  readonly worktreePath: string | null;
  /**
   * The server's own working directory; roots server-owned state (e.g. the
   * per-crew opencode config dir for read-only crews).
   */
  readonly serverPwd: string;
  /** Project/session isolation key. */
  readonly sessionKey: string;
}

export interface LaunchPlan {
  /** Argv emitted into a tmux pane to launch this CLI. */
  readonly argv: string[];
  /**
   * CWD to launch the CLI in. When omitted, the caller launches in the
   * worktree (file-mutating) or the pane default (read-only). An adapter that
   * writes its config into a per-crew dir returns that dir here so the CLI
   * finds its config.
   */
  readonly cwd?: string;
}

export interface Adapter {
  /** CLI identifier selected by `assign_crew`'s `agentType` (e.g. "claude"). */
  readonly agentType: string;
  /**
   * Build the launch plan - argv and optional CWD - for this CLI as a
   * role-configured, MCP-wired crew agent. May write per-CLI config files as a
   * side effect (opencode). The caller emits the argv into a tmux pane.
   */
  prepare(spec: LaunchSpec): LaunchPlan;
}
