# Multiplexer

Orchestrate a crew of coding agents from one conversation. One **Orchestrator** agent you talk to manages 1-4 subordinate agent-CLI processes (Claude Code or opencode) in parallel tmux panes via a local **MCP server**. You state intent; Multiplexer owns spawn, isolation, steering, and reporting.

> Pre-v1. Spec: [#11](https://github.com/fveracoechea/multiplexer/issues/11). Design trail: [Map #1](https://github.com/fveracoechea/multiplexer/issues/1).

## Why

One agent at a time doesn't scale. Running several in parallel means manually juggling terminals, worktrees, branches, and progress across panes - the coordination overhead beats the parallelism past one or two agents. Multiplexer exists so you can say *"prototype the auth flow, and separately implement the settings page"* and have the fan-out, isolation, and digests handled for you.

## How it works

Three separate parts:

1. **`multiplexer` CLI** - `bunx`-distributed bootstrap. Ensures the MCP server is running, creates the Orchestrator window in your tmux session, launches the Orchestrator pre-wired.
2. **MCP server** - one local bun process (official MCP TS SDK, streamable-HTTP on `127.0.0.1`) that encapsulates all tmux ops + the event bus and exposes the 5-tool surface. Source of truth and the single test seam.
3. **Role prompts** - `orchestrator` and `crew` behavior as portable markdown in [`roles/`](roles/), injected per-CLI via an **adapter**.

You talk **only** to the Orchestrator. It decomposes intent into `(skill, scope)` assignments, dispatches each to a named crew agent in its own tmux pane + git worktree, steers as intent evolves, and relays bounded digests. It is **pull-based**: learns crew state only via `crew_status`, otherwise always available. Crew never talk to you directly.

Two research findings anchor the design ([#2](https://github.com/fveracoechea/multiplexer/issues/2), [#3](https://github.com/fveracoechea/multiplexer/issues/3)): no MCP notification produces a model turn (must be pull-based), and neither TUI exposes an idle/busy signal (steering leans on pane-text heuristics).

## Quick start

**Prereqs:** [Bun](https://bun.sh) 1.3.x, [tmux](https://github.com/tmux/tmux) already running, and one of [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (`claude`) or [opencode](https://opencode.ai) (`opencode`) on your PATH.

From inside your project, in a tmux session:

```sh
bunx github:fveracoechea/multiplexer
```

1. Health-checks `http://localhost:4123/mcp`. Reuses a healthy server (confirmed via PID file), else starts one in its own tmux session (`multiplexer-server`).
2. Creates an `orchestrator` window in your current tmux session and launches the Orchestrator pre-wired to `http://localhost:4123/mcp/<sessionKey>`.

A second project session reuses the same server; isolation is by **session key** (your tmux session name by default), carried in the connection URL - see [ADR-0002](docs/adr/0002-session-key-in-connection-url.md).

**Env:**

| Variable | Default | Purpose |
| --- | --- | --- |
| `MULTIPLEXER_PORT` | `4123` | Port the shared server is discovered on. |
| `MULTIPLEXER_SESSION_KEY` | tmux session name (`#S`) | Project/session isolation key. |
| `MULTIPLEXER_AGENT_TYPE` | `claude` | CLI the Orchestrator runs as. |

### A conversation

```
You:   Implement the settings page from #42, and separately prototype
       the auth flow so we can sanity-check the shape.

Orch:  assign_crew("ripley", "implement", "Settings page per #42", issue: 42)
       assign_crew("bishop", "prototype", "Auth flow shape sanity-check")

You:   What's ripley up to?
Orch:  crew_status("ripley")  -> milestone: "form wired, saving next"

You:   Tell ripley to also persist the draft flag.
Orch:  steer_crew("ripley", "Also persist the draft flag.")

You:   [status bar flashes "bishop: done"] How did bishop land?
Orch:  crew_status("bishop")  -> done; reportPath: ./docs/auth.md
```

Typing directly into a crew pane is a sanctioned escape hatch - the crew can't tell it apart from an Orchestrator-mediated `steer_crew` (both arrive as `send-keys` input); only difference is the direct path isn't logged via MCP.

## MCP tool surface

Five tools, all non-blocking. Deliberately **no `wait_for_crew`** and **no raw-scrollback tool** - context stays lean by construction.

**Orchestrator-facing:**

| Tool | Behavior |
| --- | --- |
| `assign_crew(name, skill, scope, agentType?, issue?)` | Spawn-or-retask. New name spawns; existing name retasks via `tmux respawn-pane -k` (fresh context, same pane + worktree). `issue?` is PR-closing metadata only, never a dispatch precondition; shared `issue` implies a shared integration branch. |
| `crew_status(name?)` | No name: fleet overview. With name: that crew's detail, capped to last ~15 events. |
| `steer_crew(name, message)` | Fire-and-forget; valid at any status; resumes a `blocked` crew. |
| `dismiss_crew(name?, force?, wipe?)` | No name: dismiss all. Graceful by default (always ends in `report(done)`); `force` stops immediately; `wipe` also deletes the worktree. |

**Crew-facing:**

| Tool | Behavior |
| --- | --- |
| `report(summary, status, reportPath?, prUrl?)` | `status`: `progress` \| `milestone` \| `blocked` (hard halt) \| `done` (terminal). Only callable by a crew connection - identity is bound to the MCP connection ([ADR-0001](docs/adr/0001-crew-identity-bound-to-mcp-connection.md)), not an argument. |

## Architecture

### tmux layout

```
your tmux session
├── <your windows>
├── orchestrator        <- Orchestrator agent (bootstrap)
└── crew                <- created lazily on first assign_crew, tiled panes
        ├── ripley
        └── bishop

multiplexer-server (dedicated tmux session)
└── the shared MCP server process
```

- Server lives in its own non-project tmux session, survives across project sessions.
- Crew window is created lazily on first `assign_crew` (tiled); chat-only sessions spawn nothing.
- Real-time alerts (milestone / blocked / done) surface in the **tmux status bar**, session-scoped.
- Steering and direct pane input both arrive crew-side as `send-keys` and are indistinguishable.

### Connection URLs

Session key + crew identity ride in the URL path:

- `http://localhost:4123/mcp/<sessionKey>` - Orchestrator connection
- `http://localhost:4123/mcp/<sessionKey>/<crewName>` - crew connection

A single shared server attributes every DB row and tmux target to the right session/crew without per-connection env vars ([ADR-0001](docs/adr/0001-crew-identity-bound-to-mcp-connection.md), [ADR-0002](docs/adr/0002-session-key-in-connection-url.md)). Identity chosen at spawn time and fixed to the connection can't be spoofed by agent output.

### State

`bun:sqlite` + [Drizzle](https://orm.drizzle.team) is the source of truth. All server state is rooted at the server's PWD under `.multiplexer/` (gitignored). Three tables, each carrying `sessionKey`:

| Table | Role |
| --- | --- |
| `crew` | Identity - name, agent type, pane id, worktree, branch. Persists across retask / dismiss / restart. |
| `assignments` | One row per `assign_crew` (a retask adds a new row with a fresh event trail). |
| `events` | Append-only progress log per assignment; terminal `report(done)` is the last event. |

State is just files, so crash/orphan recovery is free - a restarted server reads existing state. No retention job: `dismiss_crew` completion collapses an assignment's events to just its terminal report. Worktrees persist by default; `dismiss_crew(..., wipe: true)` deletes them.

### Adapters

One interface ([`src/adapter/types.ts`](src/adapter/types.ts)) hides per-CLI differences: spawn, role injection, MCP wiring, idle detection. Command-building is pure, asserted through the same tmux-executor seam - no separate adapter seam.

| CLI | Role injection | MCP wiring |
| --- | --- | --- |
| **Claude Code** | `--append-system-prompt` (inline) | `--mcp-config` + `--strict-mcp-config`, HTTP entry with explicit `type` |
| **opencode** | agent file under `.multiplexer/opencode/agents/<name>.md`, launched with `--agent <name>` | `mcp` block in `opencode.json` as `type: "remote"` + `url` |

v1 supports exactly these two. A third CLI is a new adapter, not a redesign.

### Roles

- **[`orchestrator`](roles/orchestrator.md)** - conditional decomposition (dispatch direct when clear; grill + `/to-tickets`/`/to-spec` in-context when fuzzy, never as a crew dispatch); non-sequential grilling (may fire exploratory crew mid-grill); conversational steering (resolves target, calls `steer_crew` itself); pull-based observability (bounded digests only, never raw scrollback).
- **[`crew`](roles/crew.md)** - reporting contract (frequent `progress`/`milestone`; `blocked` halts; every assignment ends `done`); PR contract (direct merge default, re-sync before, never force-push/skip hooks; `Closes #<n>` only if issue given; shared-issue crew merge into an integration branch); interjection classification (answer-to-blocked / redirect / wrap-up-dismiss / new-info); guardrails (never inspect another crew's worktree/branch/pane; never impersonate; commits always authored by the human).

## Development

[Bun](https://bun.sh) 1.3.x. `bun install`.

```sh
bun run check    # typecheck + biome + tests (gate)
bun run typecheck
bun run lint
bun run format   # write
bun run fix      # biome autofix
bun run start    # MCP server (src/index.ts)
bun run multiplexer  # bootstrap CLI (src/cli.ts)
bun run db:generate  # drizzle migrations
```

Tests are `bun:test`, co-located (`*.test.ts`). The system is tested through a **single seam** - the MCP tool surface: drive the five tools against a real server + real in-memory `bun:sqlite`/Drizzle, assert on DB rows and exact tmux argv from a recording fake. DB is real, not mocked; only the tmux/git/PR executors are faked. 110 tests across 17 files.

See [`AGENTS.md`](AGENTS.md) for engineering conventions (issue tracker, triage labels, domain docs).

## Project layout

```
src/
├── cli.ts              # bootstrap entrypoint (bin)
├── index.ts            # MCP server entrypoint
├── bootstrap.ts        # server discovery + Orchestrator launch
├── server.ts           # createMuxServer - 5-tool surface
├── http.ts             # streamable-HTTP transport + URL parsing
├── config.ts           # shared config + constants
├── roles.ts            # role prompt assembly
├── adapter/            # claude, opencode + types
├── crew/               # assign/steer/dismiss/report/status/integrate/worktree
├── db/                 # drizzle schema + createDb
├── git/ pr/ tmux/      # executors
roles/                  # orchestrator.md, crew.md (portable markdown)
docs/                   # adr/, agents/, research/
CONTEXT.md              # ubiquitous language
AGENTS.md               # agent conventions
```

## Further reading

- [Map #1](https://github.com/fveracoechea/multiplexer/issues/1) - design trail.
- [Spec #11](https://github.com/fveracoechea/multiplexer/issues/11) - the spec this implements.
- [`CONTEXT.md`](CONTEXT.md) - ubiquitous language.
- [`docs/adr/`](docs/adr/) - architecture decisions.
- [`docs/research/`](docs/research/) - findings that anchor the architecture.

## Out of scope

v1 deliberately does not pursue: additional agent CLIs (adapter #3+); autonomous/unattended crew management (human stays in the loop); host-specific reactivity (Claude *Channels*, opencode SDK push - core stays pull-based); Claude-only hook enhancements; a bespoke merge engine (plain git); a machine-readable idle/busy API (pane-text heuristics only).
