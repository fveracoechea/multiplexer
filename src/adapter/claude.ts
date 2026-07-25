import type { Adapter, LaunchPlan, LaunchSpec } from "./types.ts";

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
  readonly agentType: string = "claude";

  prepare(spec: LaunchSpec): LaunchPlan {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        [spec.mcpServerName]: { type: "http", url: spec.mcpUrl },
      },
    });

    return {
      argv: [
        "claude",
        spec.initialPrompt,
        "--append-system-prompt",
        spec.role,
        "--strict-mcp-config",
        "--mcp-config",
        mcpConfig,
      ],
    };
  }

  /**
   * Claude Code's interactive TUI is idle when its prompt line is the last
   * non-blank line. The prompt ends with `>` (the input cursor); a busy agent
   * shows a spinner or working text instead. This is a heuristic - there is no
   * machine-readable signal (docs/research/cli-adapter.md).
   */
  isIdle(paneText: string): boolean {
    const lines = paneText.trimEnd().split("\n");
    const last = lines[lines.length - 1]?.trim() ?? "";
    return />\s*$/.test(last);
  }
}
