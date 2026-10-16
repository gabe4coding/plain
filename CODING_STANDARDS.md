# Coding standards

Read this before you change code: `src/`, `scripts/`, `bin/`, `plugins/`, `mods/`, `e2e/`, `examples/` or
`package.json`.

## Code

- One job per module, in the folder of its area. Names say what things do. One statement per line. Named
  constants, not magic numbers.
- Reuse the shared helpers (`errorMessage`, `isFailure`, `decideAll`, `DUMP_DIR`, the enum lists); search before
  you add one.
- Comments give only non-obvious reasons: no history ("before", "now", "new"), no restated code. When a module
  changes, its comments describe its current behavior.
- No dead code: no unused export, file or branch (strict `tsc` catches unused locals only).
- Match the idiom and comment density of the code around it.

## Tests

The evidence that counts: integration tests at a real boundary, the live e2e suite, evals and real agent runs.
Each change carries its own proof; choose the strongest that fits:

| Change | Required evidence |
|---|---|
| New or changed browser behavior a user sees | A spec in `e2e/` (page in `e2e/site.mjs`); a negative case tagged `expect-fail` when a false pass is possible |
| Jev-facing input (candidates, snapshot, prompts, thresholds) | A case in the matching eval data (`scripts/*-cases.json`, saved states) |
| MCP tool, result shape or browser skill | A `scripts/eval-agent.mjs` task when no task covers it |
| A route or a rule an agent must find in an agent note | A case in `scripts/routing-cases.json` |
| Suite, reporters, config, CLI flags | An integration test that runs the CLI or `runSuite` on real files |
| Desktop or mobile engine | A test with the injected adapter, and the native smoke when you can run it |
| Pure logic with edge cases | A unit test is fine here, and only here |

- Prefer real Chromium on `data:` URLs or the local site, the MCP server over stdio, and the Appium HTTP fixture
  over mocks. Do not add a test that only restates the implementation.
- A check with live Jev needs a page from the local site (`e2e/site.mjs`), not a `data:` URL: Jev sees the page
  URL, and a `data:` URL holds the whole page.
- `e2e/` uses no remote site, so a failure there is plain's or Jev's. Phrase its targets and claims so one clear
  answer exists; when Jev misses on such a page, suspect the product (what Jev is shown) before the wording.
- Never weaken a gate to get green (thresholds, expected statuses, `optional`, skipped tests, eval checks).
  `scripts/gates.test.mjs` enforces it: no e2e step marked `optional`, no skipped test except a listed platform skip,
  the Jev thresholds, and exact floors for the e2e specs, `expect-fail` tags and eval cases. Add a spec or case:
  raise its floor there. Remove one: lower the floor and say why in the pull request.

## Docs that follow the code

- A change to step kinds, spec keys, CLI flags, config keys, defaults, thresholds, statuses, exit codes, MCP tools
  or arguments, env loading, or plugin install steps lands in its owner doc in the same change. Owner of each
  topic: `.claude/skills/writing-docs/SKILL.md`, "Doc owners".
- Thresholds and tool names also go in the plugin skills (`plugins/*/skills/`); for desktop and mobile, also the
  supported steps.
- Remove a fact from the docs when the code drops it.
- Agent notes follow too: this file and the engine notes (`src/{native,computer,mobile}/CLAUDE.md`) when the
  layout or a cross-module rule changes, `CLAUDE.md` when a command or a route in its table changes. Follow the
  `writing-agent-notes` skill.

## Runtime: model, lock files, MCP output, desktop and mobile

- The TypeSafe provider pins the Jev model version (`MODEL_BY_PROVIDER` in `src/jev/provider.ts`): thresholds and
  phrasing advice were tuned against it.
- When the recorded locator format (`src/browser/record-locator.ts`) or the claim state hash (`stateHash` in
  `src/browser/judge-page.ts`) changes, bump `LOCK_VERSION` in `src/core/lock.ts`, so old lock files are ignored.
- MCP servers use stdout as the JSON-RPC channel: all logging goes to `console.error`.
- Desktop and mobile: Appium and platform drivers are host prerequisites; never auto-install apps or reset app
  data. Browser-only steps must fail explicitly on desktop and mobile.

## Plugins and packaging

- One root `package.json` and lockfile own all dependencies and all CLI binaries. Never add per-plugin package
  manifests, symlinks or parent-directory runtime imports.
- The plugins hold no runtime code: their MCP configs run the npm release through `plugins/*/bin/npx.mjs` (source:
  `scripts/plugin-npx.mjs`), also in a clone. Layout: `docs/development.mdx`, "Plugin packaging".
- Never edit the files `npm run build` generates in `plugins/*/` (`scripts/build-plugins.mjs`): the MCP configs,
  `bin/npx.mjs`, versions, `@gabe4coding/plain@<version>` in the skills, `LICENSE` and `hooks/`. Edit their
  sources (that script, `scripts/plugin-npx.mjs`, `package.json`, `mods/session-pane/`), then commit the generated
  files with them.
- Session pane mod (`mods/session-pane/hooks/session-pane/`): `model.ts` (pure state), `view.ts` (pure tree),
  `register.ts` (the only mods API user). `npm test` does not run its tests: run `npm run test:mods` (needs the
  `claude` CLI).

## Source layout

Most tests sit next to their module. Code that several callers share is often tested through them: before you add
a test, search the `*.test.ts` files for the exports you changed. Details live in each module's comments.

- `src/cli.ts`, `src/computer/cli.ts`, `src/mobile/cli.ts` — the `plain`, `plain-computer` and `plain-mobile` CLIs.
- `src/core/` — engine-independent: spec schemas and loading, what every engine shows Jev (`automation.ts`;
  `candidate.ts` imports nothing from `src/`, so `src/jev/` can use it), the run contract between the suite and
  each engine (`run-contract.ts`, `observe.ts`, `spec-deadline.ts`), results, hooks, run modes and lock files, the
  parts all MCP servers share (`save`, `read`, `changed`, snapshot views), spatial evidence and layout text.
- `src/jev/` — the model: providers and keys, the one request path (`ask.ts`), picks, judgments, thresholds
  (`decide.ts`), snapshot classification.
- `src/browser/` — the Playwright engine: session, runner, step handlers, settling, targets (`locate.ts`: replay,
  heal, record; tested in `lock.test.ts`), claims, snapshots, the browser MCP server (`mcp.ts`).
- `src/native/` — the core desktop and mobile share; `src/computer/` and `src/mobile/` — each platform on top of it.
- `src/suite/` — what the three CLIs share for spec suites: options, config, selection, scheduling and retries,
  `validate`, reporters, artifacts, the desktop and mobile CLI (`native-cli.ts`). Of the engine folders, only the
  desktop and mobile CLIs import from it, outside tests.

`npm run check:deps` fails on an import that crosses these folders the wrong way or closes a cycle, type-only
imports included. Before you add an import between two folders, read the allowed graph in `.dependency-cruiser.cjs`.
