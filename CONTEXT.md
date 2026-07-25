# Context

Ubiquitous language for the tmux-based coding-agent orchestrator. Glossary only - no implementation detail.

## Glossary

### Orchestrator

The single agent the Engineer talks to. An ordinary agent-CLI instance (Claude Code or opencode) running the **orchestrator role**, wired to the **MCP server**. Decomposes the Engineer's intent into delegated work, dispatches and steers the **crew**, relays concise results. **Pull-based**: learns crew state only when it calls a tool, otherwise always available. Never does the delegated work itself.

### Crew

The subordinate agents the Orchestrator manages - one to four at a time. Each **crew agent** is a full agent-CLI *process* (Claude Code or opencode) in its own tmux pane, persistent and steerable. Distinct from a Claude Code *subagent* (Task-tool, in-process, fire-and-return), which this project does **not** use for crew.

### Engineer

The human. Interacts only with the Orchestrator, never directly with crew.

### Role

A persona (system prompt) + tool policy defining *who* an agent is - `orchestrator` or `crew`. Shipped as portable markdown, injected into a launched CLI. Not a Claude Code subagent. Composes with a **skill**.

### Skill

A mattpocock-style instruction set for *how* to do a task (`implement`, `research`, `prototype`, `tdd`, ...), consumed as markdown by any agent CLI. The primary unit of delegation: the Orchestrator dispatches `(skill, scope)` pairs. A prose task is the escape hatch when no skill fits.

### MCP server

A single local process (bun, official MCP TypeScript SDK, streamable-HTTP on localhost) all agents connect to. Encapsulates all tmux operations and the **event bus**, exposes the `multiplexer` tool surface. Request/response: cannot push an unprompted turn into an agent's loop.

### Adapter

The per-CLI boundary that hides differences between Claude Code and opencode: spawn a process, inject a role, wire the MCP server, send input, detect idle/ready. Claude injects a role inline (`--append-system-prompt`); opencode *provisions* an agent config and references it (`--agent`). Both hide behind one adapter interface.

### Event bus

Per-crew-agent append-only log of bounded progress events, plus a terminal **report**. The Orchestrator reads bounded digests (tails), never raw pane scrollback. Source of truth for crew progress.

### Report

The deliberate, bounded end-of-task artifact a crew agent produces (status + short summary + links to artifacts). Detail lives in the linked artifacts, not in the report.

### Worktree

A dedicated git worktree + branch given to each file-mutating crew agent so parallel work cannot collide. Read-only skills (research, review) need none. Landing finished work is a direct `git merge` + push by default, or a **PR** that closes a related issue when the scope requests one - plain git either way, not a bespoke merge engine.

### Multiplexer CLI

The `bunx`-distributed bootstrap entrypoint (`bunx github:fveracoechea/multiplexer`) that ensures the MCP server is running, creates the Orchestrator window, and launches the Orchestrator pre-wired. Bootstrap only - distinct from the MCP server (tools/state) and the role prompts (behavior).
