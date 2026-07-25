import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, LaunchPlan, LaunchSpec } from "./types.ts";

/**
 * opencode adapter.
 *
 * Unlike Claude's inline launch flags, opencode is configured declaratively:
 * the role is injected by writing a per-crew agent config file
 * (`.opencode/agents/<crewName>.md` - frontmatter + body-as-prompt) referenced
 * with `--agent <crewName>`, and the MCP server is wired via an `opencode.json`
 * `mcp` entry with `type: "remote"` + `url` (a localhost streamable-HTTP
 * server is reached by URL, so `remote`, not `local`).
 *
 * Both files are written into a per-crew config dir rooted under the server's
 * `.multiplexer/` (gitignored), so concurrent crews never collide on opencode config
 * and the user's project `opencode.json` is never overwritten. The CLI is
 * launched with that config dir as its CWD; a file-mutating crew's worktree
 * path is folded into the role so the agent navigates to its worktree by
 * absolute path (opencode's own project root would otherwise be the empty
 * config dir).
 *
 * Per the adapter research (docs/research/cli-adapter.md).
 */
export class OpencodeAdapter implements Adapter {
  readonly agentType: string = "opencode";

  prepare(spec: LaunchSpec): LaunchPlan {
    const configDir = opencodeConfigDir(spec.serverPwd, spec.sessionKey, spec.crewName);

    const agentDir = join(configDir, ".opencode", "agents");
    mkdirSync(agentDir, { recursive: true });

    const role = withWorktreePreamble(spec.role, spec.worktreePath, spec.serverPwd);
    writeFileSync(join(agentDir, `${spec.crewName}.md`), agentFile(spec.crewName, role));

    writeFileSync(join(configDir, "opencode.json"), opencodeJson(spec.mcpServerName, spec.mcpUrl));

    return {
      argv: ["opencode", "--agent", spec.crewName, "--prompt", spec.initialPrompt],
      cwd: configDir,
    };
  }

  /**
   * opencode's interactive TUI is idle when its prompt line is the last
   * non-blank line. The prompt ends with `>` or `❯`; a busy agent shows a
   * spinner or working text instead. Heuristic only (docs/research/cli-adapter.md).
   */
  isIdle(paneText: string): boolean {
    const lines = paneText.trimEnd().split("\n");
    const last = lines[lines.length - 1]?.trim() ?? "";
    return /[>❯]\s*$/.test(last);
  }
}

/**
 * The per-crew opencode config dir: `<serverPwd>/.multiplexer/opencode/<sessionKey>/<crewName>`.
 * Lives under the gitignored `.multiplexer/` so it never reaches the repo.
 */
export function opencodeConfigDir(serverPwd: string, sessionKey: string, crewName: string): string {
  return join(serverPwd, ".multiplexer", "opencode", sessionKey, crewName);
}

/** Prepend a worktree preamble to the role so the agent navigates to its project. */
function withWorktreePreamble(
  role: string,
  worktreePath: string | null,
  serverPwd: string,
): string {
  const projectRoot = worktreePath ?? serverPwd;
  const where = worktreePath
    ? `Your project worktree is at ${worktreePath}. Do all file operations there by absolute path.`
    : `Your project root is ${projectRoot}. Do all file operations there by absolute path.`;
  return `${where}\n\n${role}`;
}

/** opencode agent file: frontmatter + body-as-prompt (docs/research/cli-adapter.md). */
function agentFile(crewName: string, role: string): string {
  return [
    "---",
    `description: multiplexer crew agent ${crewName}`,
    "mode: primary",
    "---",
    "",
    role,
    "",
  ].join("\n");
}

/** opencode.json `mcp` entry for a localhost streamable-HTTP server (remote, not local). */
function opencodeJson(mcpServerName: string, mcpUrl: string): string {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        [mcpServerName]: { type: "remote", url: mcpUrl, enabled: true },
      },
    },
    null,
    2,
  );
}
