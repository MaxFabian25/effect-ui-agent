# effect-ui-agent

Production end-user agent bridge and WebMCP (`document.modelContext`) layer for `@effect/ui`.

## Reference docs

Before editing Effect 4 or Effect UI code in this package, read:

- `node_modules/effect/AGENTS.md`
- `node_modules/@effect/ui/AGENTS.md`

## Verification

Run commands with Bun (`bun@1.4.5`):

- `bun run check` — type-check with `effect-tsgo tsc --noEmit`
- `bun run lint` — type-aware Oxlint + `@effect/tsgo` + anti-slop rules
- `bun run build` — emit declaration and JS files into `dist/`
- `bun test` — run unit and DOM tests under `bun:test`
