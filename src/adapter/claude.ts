import type { Adapter, LaunchSpec } from "./types.ts";

/**
 * Claude Code adapter.
 *
 * Injects the role inline via `--append-system-prompt` and wires the MCP server
 * via `--mcp-config` with an HTTP entry (`type: "http"`, localhost `url`), plus
 * `--strict-mcp-config` for a hermetic launch that ignores ambient MCP config.
 *
 * Per the adapter research (docs/research/cli-adapter.md): a URL entry with no
 * `type` is a configuration error in Claude Code, so `type` is always set.
 */
export class ClaudeAdapter implements Adapter {
  readonly agentType = "claude";

  buildLaunchCommand(spec: LaunchSpec): string[] {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        [spec.mcpServerName]: { type: "http", url: spec.mcpUrl },
      },
    });

    return [
      "claude",
      spec.initialPrompt,
      "--append-system-prompt",
      spec.role,
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfig,
    ];
  }
}
