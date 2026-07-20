# Context

Ubiquitous language for the tmux-based coding-agent orchestrator. Glossary only - no implementation detail.

## Glossary

### Orchestrator

The single agent the Engineer talks to. An ordinary agent-CLI instance (Claude Code or opencode) running the **orchestrator role**, wired to the **MCP server**. It decomposes the Engineer's intent into delegated work, dispatches and steers the **crew**, and relays back concise results. It is **pull-based**: it learns crew state only when it calls a tool, and is otherwise always available to the Engineer. It never does the delegated work itself.

### Crew

The set of subordinate agents the Orchestrator manages - one to four at a time. Each **crew agent** is a full agent-CLI *process* (Claude Code or opencode) running in its own tmux pane, persistent and steerable. Distinct from a Claude Code *subagent* (a Task-tool, in-process, fire-and-return construct), which this project does **not** use for crew.

### Engineer

The human. Interacts only with the Orchestrator, never directly with crew agents.

### Role

A persona (system prompt) + tool policy defining *who* an agent is - `orchestrator` or `crew`. Shipped as portable markdown in the package and injected into a launched CLI process. Not a Claude Code subagent. Composes with a **skill**.

### Skill

A mattpocock-style instruction set for *how* to do a task (`implement`, `research`, `prototype`, `tdd`, ...), consumed as markdown by any agent CLI. The **primary unit of delegation**: the Orchestrator dispatches `(skill, scope)` pairs. A prose task is the escape hatch when no skill fits.

### MCP server

A single local process (bun, official MCP TypeScript SDK, streamable-HTTP on localhost) that all agents connect to. Encapsulates all tmux operations and the **event bus**, and exposes the `mux` tool surface. The communication layer between Orchestrator and crew. Request/response: it cannot push an unprompted turn into an agent's loop.

### Adapter

The per-CLI boundary that hides differences between Claude Code and opencode: how to spawn a process, inject a role, wire the MCP server, send input, and detect an idle/ready state. Claude injects a role inline (`--append-system-prompt`); opencode *provisions* an agent config and references it (`--agent`). Both hide behind one adapter interface.

### Event bus

Per-crew-agent append-only log of bounded progress events, plus a terminal **report**. The Orchestrator reads bounded digests (tails), never a crew agent's raw pane scrollback. The source of truth for crew progress.

### Report

The deliberate, bounded end-of-task artifact a crew agent produces (status + short summary + links to artifacts). Detail lives in the linked artifacts, not in the report.

### Worktree

A dedicated git worktree + branch given to each file-mutating crew agent so parallel work cannot collide. Read-only skills (research, review) need none. Integration happens by the crew agent opening a **PR** that closes a related issue - not by a bespoke merge engine.

### mux CLI

The bunx-distributed bootstrap entrypoint (`bunx github:fveracoechea/multiplexer`) that ensures the MCP server is running, creates the Orchestrator window, and launches the Orchestrator agent pre-wired. Bootstrap only - distinct from the MCP server (tools/state) and the role prompts (behavior).
