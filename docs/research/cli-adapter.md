# CLI Adapter Facts: Claude Code & opencode

Research for wayfinder ticket #3. Goal: nail the per-CLI facts needed to launch a
role-configured, MCP-wired agent process inside a tmux pane, for both Claude Code
and opencode.

Every claim below carries the primary source that owns it. Anything that could not
be confirmed against primary docs is called out in the "Unknown / could not verify"
section at the bottom.

Date: 2026-07-20.

---

## 1. opencode agent config: format + on-disk location

opencode supports two declarative ways to define an agent, so it can be provisioned
idempotently by writing a file (no interactive `opencode agent create` required).

### Option A - Markdown file (one file per agent)

- Global: `~/.config/opencode/agents/<name>.md`
- Per-project: `.opencode/agents/<name>.md`
- The filename becomes the agent id; a nested path becomes a namespaced id
  (`.opencode/agents/team/reviewer.md` defines the agent `team/reviewer`).
- Directory name is **plural** `agents/` (preferred). Singular `agent/` is also
  accepted for backwards compatibility.
- Frontmatter holds config; the markdown body is the system prompt.

Minimal example (`~/.config/opencode/agents/wayfinder.md`):

```markdown
---
description: Wayfinder role agent
mode: primary
model: anthropic/claude-sonnet-4-5
temperature: 0.1
---
You are the wayfinder role agent. <role instructions here.>
```

Sources:
- https://opencode.ai/docs/agents/ (markdown agent files in `~/.config/opencode/agents/`
  or `.opencode/agents/`; filename = agent name/id; frontmatter + body-as-prompt)
- https://opencode.ai/docs/config/ (subdirectories use plural names -
  `agents/`, `commands/`, `modes/`, `plugins/`, `skills/`, `tools/`, `themes/`;
  "Singular names (e.g., `agent/`) are also supported for backwards compatibility")

### Option B - JSON block in `opencode.json`

Declare agents under the `agent` key of the config file.

- Global config file: `~/.config/opencode/opencode.json`
- Project config file: `opencode.json` in project root (JSON or JSONC)
- Schema: `https://opencode.ai/config.json`

Minimal example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "wayfinder": {
      "description": "Wayfinder role agent",
      "mode": "primary",
      "model": "anthropic/claude-sonnet-4-5",
      "prompt": "You are the wayfinder role agent. <role instructions here.>"
    }
  }
}
```

Key frontmatter/JSON fields: `description` (documented as required), `mode`
(`primary` or `subagent`), `model`, `prompt` (JSON) or markdown body (file form),
plus optional `temperature`, `permission`, etc.

Sources:
- https://opencode.ai/docs/agents/ (JSON `agent` section; fields `description`,
  `mode`, `model`, `prompt`; `description` documented as required)
- https://opencode.ai/docs/config/ (`~/.config/opencode/opencode.json` global,
  `opencode.json` in project root, JSON/JSONC, schema URL)

### Launching the configured agent

`opencode --agent <name>` selects which agent to run.

Source: https://opencode.ai/docs/cli/ (`--agent` selects the agent to use)

---

## 2. opencode MCP config: format + location (LOCAL streamable-HTTP server)

MCP servers are declared under the `mcp` key of `opencode.json` (project) or
`~/.config/opencode/opencode.json` (global); JSONC allowed.

Two connection types:
- `"type": "local"` - opencode **spawns a command** and talks to it over stdio.
  Uses a `command` array.
- `"type": "remote"` - opencode **connects to a URL** over HTTP.
  Uses a `url` string.

Key point for our case: a **streamable-HTTP** server, even when it listens on
localhost, is reached by URL, so it is configured as `"type": "remote"` (not
`"local"`). `local` is reserved for stdio child processes.

Minimal example - local streamable-HTTP server on localhost:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "wayfinder": {
      "type": "remote",
      "url": "http://localhost:4123/mcp",
      "enabled": true
    }
  }
}
```

`remote` required keys: `type`, `url`. Optional: `enabled`, `headers`, `oauth`,
`timeout`.

For reference, a stdio (command-spawned) server would instead look like:

```json
{
  "mcp": {
    "example": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-everything"],
      "enabled": true
    }
  }
}
```

`opencode mcp add` exists as an interactive command that "guides users through
adding either a local or remote MCP server." The primary docs do **not** state
which file/scope it writes to (see Unknowns); the declarative equivalent is the
`mcp` block above, which we can write directly.

Sources:
- https://opencode.ai/docs/mcp-servers/ (`mcp` section; `type: local` +
  `command` array vs `type: remote` + `url`; remote optional keys `enabled`,
  `headers`, `oauth`, `timeout`; local = spawn command/stdio, remote = connect to URL)
- https://opencode.ai/docs/cli/ (`opencode mcp add` guides through adding a
  local or remote server)

---

## 3. Claude Code: system-prompt + MCP launch flags (current)

### (a) Appending / setting the system prompt

- `--append-system-prompt "<text>"` - append inline text to the default system prompt.
  Example: `claude --append-system-prompt "Always use TypeScript"`
- `--append-system-prompt-file <path>` - append text loaded from a file.
- `--system-prompt "<text>"` - replace the entire system prompt.
- `--system-prompt-file <path>` - replace from a file.

For a role-configured agent, `--append-system-prompt` (inline role text) is the
match; use `--append-system-prompt-file` to keep the role in a file.

Source: https://code.claude.com/docs/en/cli-reference (all four flags, with the
`--append-system-prompt "Always use TypeScript"` example)

### (b) Supplying an MCP server config at launch

- `--mcp-config <files-or-strings>` - load MCP servers from JSON files or JSON
  strings (space-separated). Example: `claude --mcp-config ./mcp.json`
- `--strict-mcp-config` - use ONLY servers from `--mcp-config`, ignoring
  `.mcp.json`, `~/.claude.json`, and all other sources. Recommended for a
  hermetic launch. Example: `claude --strict-mcp-config --mcp-config ./mcp.json`

MCP JSON format expected by `--mcp-config` (standard `mcpServers` schema). For an
HTTP / streamable-HTTP server:

```json
{
  "mcpServers": {
    "wayfinder": {
      "type": "http",
      "url": "http://localhost:4123/mcp"
    }
  }
}
```

Notes on the schema (from the MCP reference page):
- `type` accepts `"streamable-http"` as an alias for `"http"`, so configs copied
  from server docs work unchanged.
- An entry with a `url` but no `type` is a configuration error - Claude Code treats
  a typeless entry as stdio and skips it. Always set `type` for URL servers.
- stdio servers use `command` / `args` / `env` instead of `url`.
- Env-var expansion (`${VAR}`, `${VAR:-default}`) is supported in `url`, `headers`,
  `command`, `args`, `env`.

Full launch example:

```bash
claude \
  --append-system-prompt-file ./role.txt \
  --strict-mcp-config --mcp-config ./mcp.json
```

Sources:
- https://code.claude.com/docs/en/cli-reference (`--mcp-config`, `--strict-mcp-config`)
- https://code.claude.com/docs/en/mcp (`streamable-http` alias for `http`;
  typeless-`url` is an error and is skipped; `mcpServers` schema with `type`/`url`/
  `headers` for HTTP and `command`/`args`/`env` for stdio; env-var expansion)

---

## 4. Idle/ready vs busy detection (interactive, in a pane)

Short answer: **when either CLI runs as its interactive TUI in a pane, there is no
documented machine-readable "waiting for input" vs "working" signal.** A supervisor
would fall back to pane-text heuristics (e.g. `tmux capture-pane -p` and pattern
matching on the prompt/spinner). Structured state is only available if you step out
of the interactive TUI into a headless/server mode.

### Claude Code
- Interactive TUI: no primary-docs-documented ready/busy signal. Pane-text scraping only.
- Machine-readable alternative (not the interactive TUI): headless mode
  `claude -p "<task>" --output-format stream-json` emits discrete JSON events per
  message/tool/result. This is one-shot / non-interactive, not the persistent TUI.
- Claude Code also writes JSONL transcripts under `~/.claude/projects/` (every
  message, tool call, result as a JSON object) - readable as a side channel, but it
  is a transcript log, not an explicit idle/busy flag.

Sources:
- https://code.claude.com/docs/en/headless (headless `-p` / `--output-format
  stream-json`) - PRIMARY, general behavior of headless output
- Transcript-JSONL and stream-json-not-line-delimited caveats are community-reported
  (see Unknowns), not primary docs.

### opencode
- Interactive TUI in a pane: no primary-docs idle/busy signal; pane-text scraping only.
- Server mode alternative: `opencode serve` starts a headless server; its SSE event
  stream (`/event`, and a global `/global/event`) is reported to broadcast
  `session.status` events carrying idle/busy state, plus `session.updated`,
  `message.updated`, `part.updated`. This is the closest thing to a machine-readable
  ready/busy signal, but it requires running the server instead of (or alongside)
  the interactive TUI, and the SSE endpoints have several open bug reports.

Sources:
- https://opencode.ai/docs/cli/ (`opencode serve` starts a headless server for API
  access without the TUI) - PRIMARY
- opencode issue tracker (session.status idle/busy over SSE; `/event` and
  `/global/event`; `/session/status`): NOT primary docs - from GitHub issues, e.g.
  https://github.com/anomalyco/opencode/issues/12860 and
  https://github.com/anomalyco/opencode/issues/13416 . Endpoint has open bugs
  (e.g. https://github.com/anomalyco/opencode/issues/26697).

---

## 5. Launching cleanly inside a tmux pane / non-login TTY

Both tools are terminal TUIs and require a TTY. A tmux pane provides a normal
PTY, so both launch as they would in any terminal. For non-TTY contexts
(pipes, systemd, CI) each has a headless mode.

- Claude Code: standard interactive TUI in any terminal; widely run inside tmux
  panes in practice (multiple panes, one agent each). Headless mode (`claude -p`)
  covers non-interactive/non-TTY use. Claude Code additionally has tmux awareness
  (it knows tmux subcommands to read/scroll pane contents when referenced).
- opencode: "AI coding agent built for the terminal"; runs as a TUI in any
  terminal incl. tmux panes. Headless via `opencode run` / `opencode serve` for
  non-TTY use.

Note: the "runs cleanly in a tmux pane" claim is confirmed by heavy community
usage and by both tools being standard TTY TUIs; the primary docs do not contain
an explicit "supported in tmux" statement (see Unknowns).

Sources:
- https://opencode.ai/docs/ ("AI coding agent built for the terminal")
- https://code.claude.com/docs/en/headless (headless mode for non-interactive use)
- tmux-in-a-pane usage is community-documented, e.g.
  https://hboon.com/using-tmux-with-claude-code/ and
  https://clawtab.cc/ (tmux control plane for Claude Code, Codex & opencode) - NOT primary.

---

## Unknown / could not verify (not in primary docs)

1. **What file/scope `opencode mcp add` and `opencode agent create` write to.**
   opencode primary docs describe them only as interactive guides; they do not
   state whether output lands in the project `opencode.json`, the global
   `~/.config/opencode/opencode.json`, or a markdown file. (Workaround: write the
   declarative `mcp` / `agent` blocks or the markdown file ourselves - documented
   above - instead of relying on the interactive command.)
2. **A machine-readable idle/busy signal for opencode's interactive TUI.** Only the
   `opencode serve` SSE `session.status` path is known, and that detail comes from
   the GitHub issue tracker, not primary docs; the SSE endpoints have open bugs.
   Whether the interactive TUI exposes any structured state is unverified.
3. **A machine-readable "waiting for input" signal for Claude Code's interactive
   TUI.** Not found in primary docs. Only headless `stream-json` (non-interactive)
   and the `~/.claude/projects/` transcript logs are structured, and the transcript
   angle is community-reported.
4. **Explicit primary-doc certification that either CLI is "supported in tmux."**
   Confirmed only by community usage and by both being standard TTY TUIs; no
   first-party "runs in tmux" statement was located.
5. **opencode `run --attach` / `serve` relationship to our MCP server.** Noted per
   ticket: `opencode serve` + `opencode run --attach http://localhost:4096` are
   about attaching an opencode client to a running opencode server to avoid cold
   boot - unrelated to, and not to be conflated with, our own MCP server.
   Source: https://opencode.ai/docs/cli/
