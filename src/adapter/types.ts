/**
 * The per-CLI adapter boundary (spec #11, "Adapter").
 *
 * An adapter hides how a given agent CLI is launched with a role injected and
 * the MCP server wired. Its command-building is pure - it returns argv, it does
 * not touch tmux or the process table - so it is asserted through the tmux
 * executor seam rather than needing a seam of its own.
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
  /** Streamable-HTTP URL of the mux MCP server on localhost. */
  readonly mcpUrl: string;
}

export interface Adapter {
  /** CLI identifier selected by `assign_crew`'s `agentType` (e.g. "claude"). */
  readonly agentType: string;
  /**
   * Build the argv that launches this CLI as a role-configured, MCP-wired crew
   * agent. Emitted into a tmux pane by the caller.
   */
  buildLaunchCommand(spec: LaunchSpec): string[];
}
