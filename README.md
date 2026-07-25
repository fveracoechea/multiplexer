# Agent Multiplexer (`mux`)

A tmux-based orchestration layer for coding agents. One **Orchestrator** agent you talk to manages a **crew** of one to four subordinate agent-CLI processes (Claude Code or opencode) running in parallel tmux panes, communicating through a local **MCP server**. You stay in one conversation and think in terms of intent; `mux` owns the mechanics of spawning, isolating, steering, and reporting back.

> Status: pre-v1. The full spec is implemented across [tickets #12-#25](https://github.com/fveracoechea/multiplexer/issues/1); the design trail is captured in [Map #1](https://github.com/fveracoechea/multiplexer/issues/1) and [Spec #11](https://github.com/fveracoechea/multiplexer/issues/11).

---

## Why

Driving one coding agent at a time doesn't scale. To run several in parallel - one researching, one prototyping, two implementing - you have to manually open terminals, launch each CLI, remember what each is doing, babysit their worktrees and branches, and mentally aggregate progress. Context-switching between panes becomes the Engineer's job, and it overwhelms the parallelism past one or two agents.

`mux` exists so the Engineer can say *"prototype the auth flow, and separately start implementing the settings page"* and have something else own the fan-out, the isolation, the course-correction, and the digest.

## How it works

Three parts, kept separate:

1. **mux CLI** - the `bunx`-distributed bootstrap entrypoint. Ensures the MCP server is running, creates the Orchestrator window in your current tmux session, and launches the Orchestrator pre-wired.
2. **MCP server** - a single local bun process (official MCP TypeScript SDK, streamable-HTTP on `127.0.0.1`) that encapsulates all tmux operations and the event bus, and exposes the 5-tool `mux` surface. It is the source of truth and the single seam the whole system is tested through.
3. **Role prompts** - `orchestrator` and `crew` behavior shipped as portable markdown in [`roles/`](roles/), injected per-CLI through an **adapter**.

The Engineer converses **only** with the Orchestrator. The Orchestrator decomposes intent into `(skill, scope)` assignments, dispatches each to a named crew agent in its own tmux pane and git worktree, steers them as intent evolves, and relays back bounded digests. It is **pull-based**: it learns crew state only when it calls `crew_status`, and is otherwise always available to the Engineer. Crew never talk to the Engineer directly.

Two load-bearing research findings anchor the architecture (see [#2](https://github.com/fveracoechea/multiplexer/issues/2), [#3](https://github.com/fveracoechea/multiplexer/issues/3)):

- No standard MCP notification produces a model-visible turn in either CLI, so the Orchestrator **must** be pull-based.
- Neither interactive TUI exposes a machine-readable idle/busy signal, so steering **must** lean on pane-text heuristics.

## Quick start

### Prerequisites

- [Bun](https://bun.sh) 1.3.x
- [tmux](https://github.com/tmux/tmux) already running (bootstrap assumes an existing session and only creates what's missing)
- One of the supported crew CLIs on your PATH:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (`claude`)
  - [opencode](https://opencode.ai) (`opencode`)

### Bootstrap

From inside your project, in a tmux session:

```sh
bunx github:fveracoechea/multiplexer
```

What this does:

1. Health-checks `http://localhost:4123/mcp`. If a healthy `mux` server is already running (confirmed via PID file), it reuses it; otherwise it starts one in its own dedicated tmux session (`mux-server`).
2. Creates an `orchestrator` window in your current tmux session and launches the Orchestrator agent there, pre-wired to `http://localhost:4123/mcp/<sessionKey>`.

A second project session reuses the same shared server; isolation is by the **session key** (your tmux session name by default), carried in the connection URL - see [ADR-0002](docs/adr/0002-session-key-in-connection-url.md).

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `MUX_PORT` | `4123` | Port the shared server is discovered on. |
| `MUX_SESSION_KEY` | current tmux session name (`#S`) | Project/session isolation key. |
| `MUX_AGENT_TYPE` | `claude` | CLI the Orchestrator runs as (`claude` \| `opencode`). |

### A conversation

You talk to the Orchestrator in natural language; it calls the `mux` tools for you.

```
You:      Implement the settings page from issue #42, and separately
          prototype the auth flow so we can sanity-check the shape.

Orch:     [grills you briefly on the settings scope, then]
          assign_crew(name: "ripley", skill: "implement",
                      scope: "Settings page per #42", issue: 42)
          assign_crew(name: "bishop", skill: "prototype",
                      scope: "Auth flow shape sanity-check")

You:      What's ripley up to?

Orch:     crew_status(name: "ripley")  -> milestone: "form wired, saving next"

You:      Tell ripley to also persist the draft flag.

Orch:     steer_crew(name: "ripley", message: "Also persist the draft flag.")

You:      [notices the tmux status bar flash "bishop: done"]
          How did bishop's prototype land?

Orch:     crew_status(name: "bishop")  -> done; reportPath: ./docs/auth.md
```

You can also type directly into a crew pane yourself - a sanctioned escape hatch. The crew agent can't tell that apart from an Orchestrator-mediated `steer_crew` (both arrive as `send-keys` pane input); the only difference is the direct path isn't logged via MCP, and the Orchestrator learns of it later through `report` / `crew_status`.

## MCP tool surface

Five tools, aggressively collapsed for token efficiency. All non-blocking - there is deliberately **no `wait_for_crew`** and **no raw-scrollback tool** (context stays lean by construction, not by length cap).

### Orchestrator-facing

| Tool | Behavior |
| --- | --- |
| `assign_crew(name, skill, scope, agentType?, issue?)` | Unified **spawn-or-retask**. New name: spawn a crew agent. Existing name: retask via `tmux respawn-pane -k` (fresh context, same pane + worktree). `agentType` selects the CLI; `issue?` is purely PR-closing metadata, never a dispatch precondition. A shared `issue` across calls implies a shared integration branch. |
| `crew_status(name?)` | Unified **poll-or-detail**. No name: bounded fleet overview. With name: that crew's detail, capped to its last ~15 events. |
| `steer_crew(name, message)` | **Fire-and-forget** steering, valid at any status. Resumes an assignment halted by `report(blocked)`. |
| `dismiss_crew(name?, force?, wipe?)` | **Bulk-or-single** wind-down. No name: dismiss all. Graceful by default (small grace window, always ends in `report(done)`); `force` stops immediately; `wipe` also deletes the worktree. |

### Crew-facing

| Tool | Behavior |
| --- | --- |
| `report(summary, status, reportPath?, prUrl?)` | Unified reporting. `status` is `progress` \| `milestone` \| `blocked` (hard halt awaiting steer) \| `done` (terminal). Only callable by a crew connection - identity is bound to the MCP connection ([ADR-0001](docs/adr/0001-crew-identity-bound-to-mcp-connection.md)), not passed as an argument. |

## Architecture

### tmux layout

```
your tmux session
├── <your existing windows>
└── orchestrator        <- the Orchestrator agent (created by bootstrap)
└── mux-crew            <- created lazily on first assign_crew, tiled panes
        ├── pane: ripley
        ├── pane: bishop
        └── ...

mux-server (separate, dedicated tmux session)
└── the shared MCP server process
```

- The **server** lives in its own non-project tmux session, survives across project sessions, and never clutters your working windows.
- The **crew window** is created lazily on the first `assign_crew` and uses a tiled layout; a session where you only chat with the Orchestrator never spawns empty panes.
- Real-time human alerts (milestone / blocked / done) surface in the **tmux status bar**, session-scoped, independent of `crew_status`.
- Steering and direct pane interjection both arrive crew-side as `send-keys` input and are **indistinguishable** to the crew.

### Connection URLs

The session key and crew identity are carried in the MCP connection URL path:

- `http://localhost:4123/mcp/<sessionKey>` - an Orchestrator connection for that session
- `http://localhost:4123/mcp/<sessionKey>/<crewName>` - a crew connection for that session

This is how a single shared server attributes every DB row and every tmux target to the right project session and the right crew, without per-connection env vars (see [ADR-0001](docs/adr/0001-crew-identity-bound-to-mcp-connection.md) and [ADR-0002](docs/adr/0002-session-key-in-connection-url.md)). Identity chosen by the server at spawn time and fixed to the connection cannot be spoofed by an agent's own output.

### State / persistence

`bun:sqlite` + [Drizzle](https://orm.drizzle.team) is the source of truth (not files, not pure in-memory). All server-owned state is rooted at the server's own PWD (a local clone of `multiplexer`) under `.mux/`, which is gitignored. Three tables, each carrying `sessionKey` for isolation:

| Table | Role |
| --- | --- |
| `crew` | Identity - name, agent type, pane id, worktree path, branch. Persists across retask / dismiss / session restart. |
| `assignments` | One row per `assign_crew` spawn-or-retask call. A retask adds a new row with a fresh event trail rather than mutating the old. |
| `events` | Append-only progress log scoped to an assignment; the terminal `report(done)` is the last event. |

Because state is just files, crash / orphan recovery falls out for free - a restarted server reads existing state. There is no separate retention job: `dismiss_crew` completion collapses an assignment's events down to just its terminal report. Worktrees persist indefinitely by default; `dismiss_crew(..., wipe: true)` opts into deletion.

### Adapters

One adapter interface ([`src/adapter/types.ts`](src/adapter/types.ts)) hides per-CLI differences: how to spawn a process, inject a role, wire the MCP server, and detect an idle/ready state from pane text. The adapter's command-building is pure and is asserted through the same tmux-executor seam as everything else - no separate adapter seam.

| CLI | Role injection | MCP wiring | Idle detection |
| --- | --- | --- | --- |
| **Claude Code** | `--append-system-prompt` (inline) | `--mcp-config` + `--strict-mcp-config`, HTTP server entry with explicit `type` | pane-text heuristic |
| **opencode** | declarative agent file under `.mux/opencode/agents/<name>.md`, launched with `--agent <name>` | `mcp` block in `opencode.json` as `type: "remote"` + `url` | pane-text heuristic |

v1 supports exactly these two CLIs. A third CLI is a new adapter, not a redesign - see [Out of scope](#out-of-scope).

### Crew behavior

Crew agents run the [`crew` role](roles/crew.md), which codifies:

- **Reporting contract** - frequent judgment-based `progress` / `milestone` pings; `blocked` is a hard halt; every assignment ends in `report(done)`; reports stay short with free-form artifact pointers.
- **PR / landing contract** - direct `git merge` + push is the default (re-sync/rebase immediately before, never force-push, never skip hooks); a requested PR includes `Closes #<n>` only when an issue was given; PR content follows the repo's own guidelines when present. Crew sharing an issue merge into an Orchestrator-provisioned integration branch; the Orchestrator opens the single final PR once all sharers report `done`.
- **Interjection classification** - the crew's own loop classifies each `steer_crew` message as answer-to-blocked / redirect / wrap-up-dismiss / new-info, each with a distinct reaction.
- **Guardrails** - never inspect another crew's worktree / branch / pane by any means; never impersonate another crew or the Orchestrator; commits and PRs are always authored by the human Engineer, never the agent.

### Orchestrator behavior

The Orchestrator runs the [`orchestrator` role](roles/orchestrator.md), which codifies:

- **Conditional decomposition** - a well-understood ask is dispatched directly from an inline prose `scope`; a fuzzy ask is sharpened first in the Orchestrator's own context (grill the Engineer, then run `/to-tickets` / `/to-spec` on itself). Decomposition is **never** a dedicated crew dispatch - crew never talk to the Engineer.
- **Non-sequential grilling** - the Orchestrator may fire an exploratory `research` / `prototype` crew mid-grill to raise the fidelity of the still-ongoing conversation.
- **Conversational steering** - the Engineer describes intent; the Orchestrator resolves the target crew name and calls `steer_crew` itself. Ambiguous targets get an ordinary clarifying question.
- **Pull-based observability** - reads only bounded `crew_status` digests, never raw pane scrollback; never blocks a tool call waiting on a crew.

## Configuration

Per-crew config the adapters write at runtime lives under `.mux/` (gitignored):

```
.mux/
├── mux.db                     # the SQLite state store
└── opencode/                  # per-crew opencode agent configs
    └── agents/<name>.md
```

The `.mux/opencode/opencode.json` written by the opencode adapter points the `mcp` block at `http://localhost:4123/mcp/<sessionKey>/<crewName>`. Claude Code needs no on-disk config - its role and MCP wiring are inline launch flags.

## Development

Runtime is [Bun](https://bun.sh) 1.3.x. Install deps with `bun install`.

One command gates every change:

```sh
bun run check
```

It runs, in order: typecheck (`tsc --noEmit`), Biome (`biome check` - formatting + linting + import organization), and the test suite (`bun test`). It exits non-zero on any failure - run it before committing.

Other scripts:

| Script | Purpose |
| --- | --- |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | `biome lint` |
| `bun run format` | `biome format --write` |
| `bun run fix` | `biome check --write` (autofix) |
| `bun run start` | run the MCP server directly (`src/index.ts`) |
| `bun run mux` | run the bootstrap CLI directly (`src/cli.ts`) |
| `bun run db:generate` | regenerate Drizzle migrations |

### Tests

Tests are `bun:test`, co-located beside the module they cover (`*.test.ts`). The whole system is tested through a **single seam** - the MCP tool surface: tests drive the five tools against a real MCP server + real in-memory `bun:sqlite` / Drizzle, and assert on resulting DB rows and the exact tmux argv emitted by a recording fake tmux executor. The DB is real, not mocked; the only faked boundary is the tmux (and git / PR) executor. External behavior is what's asserted - never what a real spawned agent "does."

```sh
bun test            # 110 tests across 17 files
```

See [`AGENTS.md`](AGENTS.md) for the engineering conventions (issue tracker, triage labels, domain docs) agents follow in this repo.

## Project layout

```
src/
├── cli.ts                 # `mux` bootstrap entrypoint (bin)
├── index.ts               # MCP server entrypoint (`bun run start`)
├── bootstrap.ts           # server discovery + Orchestrator window launch
├── server.ts              # createMuxServer - registers the 5-tool surface
├── http.ts                # streamable-HTTP transport + connection-URL parsing
├── config.ts              # shared config types
├── roles.ts               # role prompt assembly
├── skills.ts              # skill catalog
├── exec.ts                # spawnCapture helper
├── adapter/               # per-CLI adapters (claude, opencode) + types
├── crew/                  # assign / steer / dismiss / report / status / integrate / worktree / queries
├── db/                    # Drizzle schema + createDb
├── git/                   # git executor
├── pr/                    # PR executor (gh)
└── tmux/                  # tmux executor
roles/
├── orchestrator.md        # orchestrator role prompt (portable markdown)
└── crew.md                # crew role prompt (portable markdown)
docs/
├── adr/                   # architecture decision records
├── agents/                # agent workflow docs (issue tracker, triage, domain)
└── research/              # research findings backing the spec
drizzle/                   # generated migrations
CONTEXT.md                 # ubiquitous language (glossary)
AGENTS.md                  # engineering conventions for agents in this repo
```

## Further reading

- [**Map #1**](https://github.com/fveracoechea/multiplexer/issues/1) - the wayfinder map; the design trail from fog to spec.
- [**Spec #11**](https://github.com/fveracoechea/multiplexer/issues/11) - the complete spec this implementation follows.
- [`CONTEXT.md`](CONTEXT.md) - the ubiquitous language (Orchestrator, Crew, Engineer, Role, Skill, MCP server, Adapter, Event bus, Report, Worktree, mux CLI).
- [`docs/adr/`](docs/adr/) - architecture decision records.
- [`docs/research/`](docs/research/) - the research findings that anchor the architecture.
- [`roles/orchestrator.md`](roles/orchestrator.md) and [`roles/crew.md`](roles/crew.md) - the role prompts shipped with the package.

## Out of scope

v1 deliberately does not pursue:

- **Additional agent CLIs** (adapter #3+). v1 is Claude Code + opencode; further CLIs are "write another adapter," not a redesign.
- **Autonomous / unattended crew management** - a daemon acting on crew events without the Engineer in the loop. v1 keeps the human in the loop.
- **Host-specific reactivity** - Claude Code *Channels* and opencode SDK push would let the Orchestrator react without a pull, but are host-specific, non-portable, and work only while the process is alive. The core stays pull-based.
- **Claude-only hook enhancements** (e.g. zero-context progress emission via `PostToolUse` / `Stop` hooks). Portable MCP-tool reporting is the core; hooks are a later Claude-only optimization.
- **A bespoke merge engine.** Integration is plain git (direct merge or PR) driven by the crew agent.
- **A machine-readable idle/busy API.** Research established none exists in either interactive TUI; the system relies on pane-text heuristics.
