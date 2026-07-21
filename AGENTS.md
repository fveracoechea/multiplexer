## Development

Runtime is [Bun](https://bun.sh) (1.3.x). Install deps with `bun install`.

One command gates every change:

```sh
bun run check
```

It runs, in order: typecheck (`tsc --noEmit`), Biome (`biome check` - formatting + linting + import organization), and the test suite (`bun test`). It exits non-zero on any failure. Run it before committing.

Other scripts: `bun run typecheck`, `bun run lint`, `bun run format` (write), `bun run fix` (Biome autofix). Tests are `bun:test`; co-locate `*.test.ts` beside the module it covers. `src/example.ts` + `src/example.test.ts` are a scaffolding demo of the red-green loop - delete them once real modules exist.

## Agent skills

### Issue tracker

Issues live as GitHub issues; use `gh` CLI for all operations. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, each label string equals its name (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context - one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
