# Reproducing CLI issues

For AI agents (and humans) investigating a reported multiplexer bug. Tells you
where the tested seams end, and how to reproduce a CLI-level failure against
real tmux.

## Current testing story

The repo is tested through a single seam - the MCP tool surface. 110 unit /
seam tests across 17 files drive the five tools against a real in-memory
bun:sqlite/Drizzle, assert on DB rows + exact tmux argv from recording fakes.

What is real in tests:
- The DB (in-memory `bun:sqlite`).
- The MCP SDK + streamable-HTTP transport (`src/http.test.ts` binds a real
  socket and runs a real MCP client/server handshake).

What is faked at the boundary:
- `FakeTmuxExecutor` (`src/tmux/executor.ts`) - records argv, returns scripted
  responses.
- `FakeGitExecutor` (`src/git/executor.ts`).
- `FakePrExecutor` (`src/pr/executor.ts`).
- `defaultHealthCheck` is injected in `src/bootstrap.test.ts` so no real
  HTTP probe happens.

What is **never exercised by any test**:
- The CLI entrypoint `src/cli.ts` (no test imports it).
- The bootstrap PID/health-check flow (`bootstrap.ts:87-133`).
- `RealTmuxExecutor`, `RealGitExecutor`, `RealPrExecutor` - explicitly marked
  "never exercised in tests" (`src/tmux/executor.ts:25`, `src/git/executor.ts:21`,
  `src/pr/executor.ts:24`).
- The real adapters' `prepare()` output driving a live tmux `respawn-pane`.

So: a bug in how `bootstrap()` reads the PID file, or how the orchestrator
window is created, or how the agent argv gets passed to `tmux respawn-pane`,
will not be caught by `bun test`. Reproduce against real tmux to find them.

## Known gap: `MULTIPLEXER_PORT` is server-only

`src/index.ts:28` reads `MULTIPLEXER_PORT` for the server bind. The CLI at
`src/cli.ts:20-21` never reads it - `bootstrap()` always probes the default
`DEFAULT_PORT = 4123` (`src/bootstrap.ts:24`). So running the server on a
non-default port breaks reuse detection. Reproduce with
`MULTIPLEXER_PORT=4124 bun run src/cli.ts` and observe the bootstrap starting a
second server instead of reusing.

## Repro procedure (manual, against real tmux)

Multiplexer is a tmux citizen. Reproduce in tmux, not in a bare shell.

1. Confirm prereqs: `bun --version` (>=1.3), `tmux -V`, `which claude` or
   `which opencode`. All three on PATH.
2. Start a tmux session if not already in one: `tmux new -d -s repro &&
   tmux attach -t repro`.
3. From a clean checkout, `bun install`.
4. Run the CLI directly (not via bunx): `bun run src/cli.ts`. Watch stdout for
   `multiplexer: started MCP server in tmux session multiplexer-server` and
   `multiplexer: orchestrator launched in <session>:orchestrator`.
5. Inspect state:
   - `tmux ls` - should show `multiplexer-server` plus your session.
   - `cat ~/.multiplexer/server.pid` - the PID file (`bootstrap.ts:27-29`).
   - `curl -s http://localhost:4123/mcp` - should return 404 (the health check
     treats 404 as healthy, `src/cli.ts:48-52`).
6. Reproduce the reported scenario. For an agent-CLI bug, switch adapter with
   `MULTIPLEXER_AGENT_TYPE=opencode bun run src/cli.ts`. For multi-project
   isolation, run from two different CWDs in two tmux sessions and watch
   `MULTIPLEXER_SESSION_KEY` isolate rows in the server's SQLite DB at
   `~/.multiplexer/server/db.sqlite`.
7. Reset between runs: `tmux kill-session -t multiplexer-server`, delete
   `~/.multiplexer/`, re-run.

### Inspecting server-owned state while reproducing

- DB: `bunx sqlite3 ~/.multiplexer/server/db.sqlite '.tables'` then
  `.schema crew` / `assignments` / `events`.
- Server logs: stdout/stderr of the `multiplexer-server` tmux session
  (attach with `tmux attach -t multiplexer-server`).
- Per-crew opencode config dir: `~/.multiplexer/<session>/<crew>/`.

### Reproducing from a specific version / ref

- Latest merged code: `bunx github:fveracoechea/multiplexer#latest`.
- A pinned release: `bunx github:fveracoechea/multiplexer#v0.1.0`.
- A local checkout at a specific commit: `git checkout <sha> && bun install &&
  bun run src/cli.ts`.

Useful for confirming "this worked on v0.1.0 but broke on latest" - bisect
between tags with `bun run src/cli.ts` at each step.

## What an AI agent debugging here should do

1. Read the reported symptom and map it to one of the untested seams above
   (bootstrap PID flow, orchestrator launch, adapter argv). Most reported
   CLI bugs live there, not in the tested tool surface.
2. Follow the repro procedure against real tmux in a sandbox. Capture
   `tmux ls`, the PID file contents, and the server tmux session's stdout.
3. If reproducible, add a `*.test.ts` that pins the broken behaviour at the
   fake seam first (cheap regression), then add an e2e test that drives the
   real executor for that path.
4. If not reproducible, the bug may be environment-specific (agent-CLI
   version, tmux version). Ask the reporter for `tmux -V`, `claude --version`
   or `opencode --version`, and the exact `bunx` invocation.

## Gaps and recommendations

1. **No e2e test harness.** Add a `bun run test:e2e` script that drives
   `RealTmuxExecutor` against a real tmux server in CI, exercising
   `bootstrap()` + `assign_crew` + `dismiss_crew` end-to-end with a stub
   agent CLI that exits immediately. Covers the PID/health-check/launch
   paths the fakes can't reach.
2. **CLI never reads `MULTIPLEXER_PORT`.** Fix `src/cli.ts:20-21` to pass
   `port: Bun.env.MULTIPLEXER_PORT` into `BootstrapConfig` (`bootstrap.ts:44`
   already accepts it). One-line fix, but a real repro blocker.
3. **No `--dry-run` flag.** An agent debugging launch argv has to read the
   adapters. A `multiplexer dry-run` subcommand that prints the orchestrator
   argv + tmux commands without spawning would let agents reproduce launch
   issues without needing a real agent CLI on PATH.
4. **No structured log file.** Server stdout goes to the tmux pane only.
   Mirroring to `~/.multiplexer/server.log` would let agents grep instead of
   attaching.
