## Commands

Build (TypeScript, ESM, `src/` → `dist/`, `tsc` per `tsconfig.json`):

```
npm run build
```

Test (`node:test`; specs live in `src/*.test.ts`, compiled to `dist/*.test.js`):

```
npm test                                                    # build + node --test 'dist/**/*.test.js'
node --test dist/runner.test.js                             # one file, after a build
node --test --test-name-pattern "<name>" dist/jev.test.js   # one test case
```

No test needs a Jev API key: `jev.test.ts` and `spec.test.ts` exercise pure functions with injected env
objects, and `runner.test.ts` drives real headless Chromium against `data:text/html` URLs with `goto` steps only.

Run a spec, or start the MCP server (`src/cli.ts` dispatches on the first positional):

```
node dist/cli.js [--headless] [--timeout 15000] examples/login.yaml [more.yaml ...]
node dist/cli.js --headless mcp
```

`--headless` hides the browser (visible by default); `--timeout` is per-action (ms). `.mcp.json` runs the same
entry via `${CLAUDE_PLUGIN_ROOT}/bin/jev-e2e.mjs --headless mcp`.

Environment: `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` (`TYPESAFE_API_KEY` wins if both set), or force one with
`JEV_PROVIDER=typesafe|gateway` (`src/jev.ts`, `selectProvider`). `src/cli.ts` loads `.env` from the cwd, then
`~/.config/jev-e2e/.env` (`USER_ENV_FILE` in `src/jev.ts`), via Node's native `process.loadEnvFile()` (no `dotenv`);
variables already in the environment are never overridden. The user file exists because Codex passes plugin MCP
servers no shell environment. Without a key the CLI exits at startup; MCP mode keeps serving and the first Jev
call returns the message as a tool error.

`dist/` is committed on purpose — this repo is also a Claude Code plugin and ships its built output
(`bin/jev-e2e.mjs` runs `dist/cli.js` directly; on first run it also lazy-installs npm deps and Chromium).
`dist/**/*.test.js` is gitignored. Rebuild before committing a `src/` change so `dist/` matches it.

## Architecture

Playwright performs actions; Jev (TypeSafe's model, via `@typesafe-ai/sdk` or the Vercel AI SDK gateway) is the
only decision maker. It picks the element a natural-language target describes (Choice) and judges whether a
natural-language claim holds (Noul) against the page's accessibility tree. Specs have no CSS selectors except a
`css=` escape hatch.

- `src/spec.ts` — `loadSpec()` parses a YAML file into a `Spec` (`name`, `url`, `dialogs`, optional `auth`,
  `geolocation`, `env`, `hooks`, plus `steps`). `$VAR` leaves in `auth`/`env` resolve from `process.env` at load
  time. `interpolate()` replaces `${env.*}`/`${hooks.*}` in any string; any other namespace, or an unresolved
  leaf, is an error.
- `src/page.ts` — candidate collection (`candidates()`, selector + shadow-DOM walk per step kind, with
  cursor-pointer/tabindex extras for `click`/`hover`), the accessibility snapshot (`snapshot()`/`snapshotRegion()`,
  60k-char cap), and DOM-quiet waiting (`settle()`).
- `src/jev.ts` — provider selection and the `ask()` call to either backend; `pickElements()` (one Choice per
  target, ≤254 candidates); `judge()` (one Noul per claim); `decide()`: a claim passes at p ≥ 0.9, fails at
  p ≤ 0.1, else `inconclusive`; a pick is accepted when (`confidence` if TypeSafe returned one, else
  `probability`) ≥ 0.5 and the answer isn't `none`. A rejected pick or non-passing claim dumps the exact state
  to `$TMPDIR/jev-e2e/*.json` (`dumpDebug` in `src/steps.ts`). The model is pinned (`MODEL_BY_PROVIDER`), not `jev-latest`:
  thresholds and phrasing advice were tuned against it. The TypeSafe SDK client handles timeouts and retries
  (429/5xx, `Retry-After`); the gateway path keeps its own retry loop because the AI SDK's backoff cannot outlast
  a rate-limit window.
- `src/steps.ts` — one handler per step kind (`goto`, `fill`, `click`, `hover`, `dblclick`, `rightclick`,
  `select`, `check`, `uncheck`, `upload`, `scroll`, `wait`, `press`, `drag`, `mouse`, `expect`), each accepting
  `optional: true`. An action step is settle → snapshot candidates → Jev picks → Playwright acts; `expect`/`wait`
  are settle → snapshot → Jev judges. Several `expect` claims share one Jev call; fail beats inconclusive beats
  pass across them.
- `src/runner.ts` — `runSpec()`: import the hooks module first (fails fast, before the browser opens) → open a
  session → `setup()` → interpolate `url`/`steps` with `{env, hooks: data}` → run steps → `teardown()` in
  `finally` → close. `Status` is `pass | fail | inconclusive | error | skipped`. A setup error yields a single
  `setup` step and `error`, with no teardown; a teardown error always makes the run `error`. Exports
  `HooksModule`, `loadHooks`, `runSetup` for reuse by `src/mcp.ts`.
- Hooks contract: an ES module next to the spec (`hooks:`, resolved relative to the spec file) with optional
  `setup({spec, page})` (its return becomes `${hooks.*}`) and `teardown({spec, page, data, result})`. Dataset
  shape is not imposed. See `examples/login-dataset.yaml` + `examples/hooks/login-dataset.mjs`.
- `src/mcp.ts` — MCP server over stdio with one persistent browser session; tools `open`, `step`, `find`,
  `snapshot`, `save`. `save` writes a YAML spec with `${hooks.*}` placeholders kept and `hooks:` relative to the
  saved file. `${env.*}` is not available in an MCP session, only `${hooks.*}`. stdout is the JSON-RPC channel,
  so all logging (here and in `src/cli.ts`/`src/steps.ts`) goes to `console.error`.
- `src/cli.ts` — entry point: loads `.env`, then dispatches to `mcp` or to running each spec file in order.
- Claude Code plugin: `.claude-plugin/{plugin.json,marketplace.json}` + root `.mcp.json` +
  `skills/authoring-jev-e2e-specs/SKILL.md`. Keep the skill's thresholds and tool names in sync with `src/jev.ts`
  and `src/mcp.ts` when either changes.
- Codex plugin (Agent Plugins portable format): root `plugin.json` + `mcp.json` + `.agents/plugins/marketplace.json`.
  They mirror the Claude Code files above; change name, version and description in both sets. `mcp.json` runs
  the same launcher with `cwd: ${PLUGIN_ROOT}`. `AGENTS.md` is a symlink to this file.
- Docs: `README.md` is the quick start; `docs/spec-reference.md`, `docs/phrasing.md`, `docs/hooks.md` and
  `docs/agent-mode.md` are the reference. A change to step kinds, thresholds, MCP tools, env loading or plugin
  install steps lands in the matching doc too (and in the skill, for thresholds and tool names).

## Constraints

- This repo is site-agnostic. Site-specific skills, environment facts, and regression specs belong in downstream
  plugins that depend on jev-e2e, not here.
- Specs never hold literal credentials: put them in the spec's `env` block as `$VAR` references, used in steps as
  `${env.*}`.
- `examples/*.yaml` run against public demo sites; `examples/fixtures/` and `examples/hooks/` back the
  `login-dataset.yaml` example.
- Per `skills/authoring-jev-e2e-specs/SKILL.md`: test environments only, stop before the last irreversible step
  (payment, booking, sending), never bypass bot protection.
