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

No test in the regular suite needs a Jev API key: `jev.test.ts` and `spec.test.ts` exercise pure functions with injected env
objects, and `runner.test.ts` drives real headless Chromium against `data:text/html` URLs with `goto` steps only.

Run a spec, or start the MCP server (`src/cli.ts` dispatches on the first positional):

```
node dist/cli.js [--headless] [--timeout 15000] examples/login.yaml [more.yaml ...]
node dist/cli.js --headless mcp
```

Performance tracking (live sites and a Jev key; build first). `benchmark-steps.mjs` reports per-phase step overhead
(step time minus page action time) over the examples; `benchmark-mcp.mjs` times an agent-style MCP session with think
time between calls. Compare a change against a saved run; results and method in `docs/benchmarks/step-overhead.md`:

```
node scripts/benchmark-steps.mjs --runs 3 --out /tmp/new.json --compare /tmp/base.json
node scripts/benchmark-mcp.mjs --cli dist/cli.js --gap 5000 --runs 2
node scripts/benchmark-planner.mjs --runs 3          # sentence → steps planner vs scripts/planner-cases.json
node scripts/benchmark-picks.mjs --runs 3            # picks with/without goal on saved pages (scripts/pick-states/)
node scripts/benchmark-agent.mjs --runs 3            # a real claude -p agent, changed on vs off (costs Claude usage); --read both: read on vs off
node scripts/benchmark-read.mjs --runs 2 --smart     # read vs smart snapshot on saved pages (scripts/read-states/, read-cases.json)
node scripts/eval-browser-steps.mjs --variant v1     # step-time eval: examples + MCP session, overhead and same step statuses (.claude/hillclimb/, gitignored)
node scripts/benchmark-claims.mjs --runs 3           # expect judging on saved pages (scripts/claim-cases.json); false passes must stay 0
```

`--headless` hides the browser (visible by default); `--timeout` is per-action (ms); `--profile <dir>` launches a
persistent context; `--channel chrome` launches an installed browser instead of the bundled Chromium; `--cdp <url>` attaches
to a running Chrome (`openPage()` in `src/runner.ts` picks one of the three; env fallbacks `PLAINWRIGHT_PROFILE`/
`PLAINWRIGHT_CHANNEL`/`PLAINWRIGHT_CDP` are the `existingEnv` table in `parseSuiteArgs` in `src/options.ts`, with
precedence CLI, then env, then config). The browser plugin `.mcp.json` runs `${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs --headless mcp`, which installs and dispatches to the shared runtime.

Environment: `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY` (`TYPESAFE_API_KEY` wins if both set), or force one with
`JEV_PROVIDER=typesafe|gateway` (`src/jev.ts`, `selectProvider`). `src/cli.ts` loads `.env` from the cwd, then
`~/.config/plainwright/.env` (`USER_ENV_FILE` in `src/jev.ts`), via Node's native `process.loadEnvFile()` (no `dotenv`);
variables already in the environment are never overridden. The user file exists because Codex passes plugin MCP
servers no shell environment. Without a key, `runSuite` asks for the provider only when at least one spec is
selected and the CLI then exits 2; `validate`, `--list`, and an empty selection need no key, while MCP mode keeps
serving and the first Jev call returns the message as a tool error.

`dist/` is committed on purpose: `scripts/build-plugins.mjs` packs it into `plugins/*/runtime.tgz`; `action.yml`
runs `dist/cli.js` after `npm ci --omit=dev`, with no build step; the `Dockerfile` copies it; and
`.github/workflows/test.yml` checks that generated files are up to date.
`dist/**/*.test.js` is gitignored. Rebuild before committing a `src/` change so `dist/` matches it.

CI (`.github/workflows/test.yml`) greps `Dockerfile` and `docs/ci.md` for the
`mcr.microsoft.com/playwright:v<locked version>-noble` tag. A Playwright bump therefore needs both tags edited,
and the `dist/` and tgz files rebuilt.

## Architecture

Playwright performs actions; Jev (TypeSafe's model, via `@typesafe-ai/sdk` or the Vercel AI SDK gateway) is the
only decision maker. It picks the element a natural-language target describes (Choice) and judges whether a
natural-language claim holds (Noul) against the page's accessibility tree. Specs have no CSS selectors except a
`css=` escape hatch.

- `src/spec.ts` — `loadSpec()` parses a YAML file into a `Spec` (`name`, `url`, `dialogs`, optional `auth`,
  `geolocation`, `env`, `hooks`, plus `steps`). `$VAR` leaves in `auth`/`env` resolve from `process.env` at load
  time. `interpolate()` replaces `${env.*}`/`${hooks.*}` in any string; any other namespace, or an unresolved
  leaf, is an error.
- `src/candidates.ts` — candidate collection (`candidates()`, selector + shadow-DOM walk per step kind, with
  cursor-pointer/tabindex extras for `click`/`hover`; for `check` also `aria-pressed` toggles and labels of
  sizeless checkboxes). Candidates are ordered in layers before the cap: dialog content, then the page, then
  nav/footer, so a cookie banner appended at the end of the body is never cut.
- `src/page.ts` — accessibility snapshot (`snapshot()`/`snapshotRegion()`, 60k-char cap; an unchecked
  checkable control gets `[checked=false]`, `markUnchecked`) and DOM-quiet waiting
  (`settle()`). Re-exports the candidate helpers from `src/candidates.ts`. `page.ts` (snapshot sections)
  and `candidates.ts` (candidate prefixes) both label iframes with `frameLabel()` (`src/frames.ts`).
- `src/jev.ts` — provider selection and the `ask()` call to either backend; `pickElements()` (one Choice per
  target; ≤254 candidates per request, more are split into equal chunks asked in parallel and merged by
  `mergePicks()`; a request over the token limit (`isTooLong`, 400 or 422 `max_tokens_exceeded`) is halved the same way, which splits the score when two chunks disagree; ceiling `MAX_CANDIDATES` = 1016); `judge()` (one Noul per claim); `decide()`: a claim passes at p ≥ 0.9, fails at
  p ≤ 0.1, else `inconclusive`; a pick is accepted when (`confidence` if TypeSafe returned one, else
  `probability`) ≥ 0.5 and the answer isn't `none`. A rejected pick or non-passing claim dumps the exact state
  to `$TMPDIR/plainwright/*.json` (`dumpDebug` in `src/steps.ts`). A pick's state carries the flow's `goal`
  (spec `goal:` or MCP `open {goal}`, browser, desktop and mobile) when there is one, never in the question; claims never see it. The model is pinned (`MODEL_BY_PROVIDER`), not `jev-latest`:
  thresholds and phrasing advice were tuned against it. The TypeSafe SDK client handles timeouts and retries
  (429/5xx, `Retry-After`); the gateway path keeps its own retry loop because the AI SDK's backoff cannot outlast
  a rate-limit window. A global undici keep-alive dispatcher keeps API connections open between calls (Node's default
  drops them after 4 s, and the first model call on a new connection costs ~350 ms more); `warmUp()` sends two tiny
  Jev calls at CLI/MCP start so the first steps find warm connections.
- `src/steps.ts` — one handler per step kind (`goto`, `fill`, `click`, `hover`, `dblclick`, `rightclick`,
  `select`, `check`, `uncheck`, `upload`, `scroll`, `wait`, `press`, `drag`, `mouse`, `expect`), each accepting
  `optional: true`. An action step is snapshot candidates → Jev picks while the page settles → Playwright acts;
  `expect`/`wait` are snapshot → Jev judges while the page settles (`settledAsk`: the early answer is kept only if
  the main document did not mutate after the look, via `mark()`/`unchangedSince()`, or a second look is identical;
  otherwise the settled state is asked again and `ms.reasked` counts it). `settlePage()` = DOM quiet 150 ms (mutations before the load event do not count) plus no
  xhr/fetch younger than 2 s in flight, 3 s cap; observers ignore the scan's own `data-jev-id` writes. A click's 200 ms
  hold and `fill`'s 500 ms debounce hold (`mayNavigate` `holdMs`; clicks watch only 50 ms themselves), and a loading
  popup (`holdActivity` in the runner's popup handler), are waited by the next step's settle, or by `waitHold` in `runStep` for steps
  that do not settle first (`settlesFirst`). Several `expect` claims share one Jev call; fail beats inconclusive beats
  pass across them. `check`/`uncheck` read the state (a control's `checked`, following a label, or
  aria-checked/aria-pressed) and click only when it must change (`setChecked`); `scroll: top|bottom` (and spoken
  forms, `scrollEdge`) scrolls `document.scrollingElement` and reports the distance. A scan with no candidates is
  retried for up to 2 s (`APPEAR_MS`, a page still redirecting after `open`). `wait: {that, within}` picks the region
  once and polls only its tree (`judgeRegion`).
- `src/runner.ts` — `runSpec()`: fork the hooks child first (fails fast, before the browser opens) → open a
  session → `setup()` → interpolate `url`/`steps` with `{env, hooks: data}` → run steps → `teardown()` in
  `finally` → close the child → close the session. `Status` is `pass | fail | inconclusive | error | skipped`.
  A setup error yields a single `setup` step and `error`, with no teardown; a teardown error always makes the
  run `error`. Steps go through `runStepSafely` (`src/steps.ts`), shared with `src/mcp.ts`: errors become results, optional misses become `skipped`.
- Hooks contract: an ES module next to the spec (`hooks:`, resolved relative to the spec file) with optional
  `setup({spec})` (its return becomes `${hooks.*}`) and `teardown({spec, data, result})`, run in its own child
  process (`src/hooks-child.ts`, forked by `startHooks`) — one per spec run, so module-level state never leaks
  between specs and `--workers` can't make hooks interfere. Only JSON crosses the IPC channel. Dataset shape is
  not imposed. See `examples/login-dataset.yaml` + `examples/hooks/login-dataset.mjs`.
- `src/mcp.ts` — MCP server over stdio with one persistent browser session; tools `open`, `step`, `find`,
  `snapshot` (whole page or `within` a region), `ask` (yes/no claims, `askPage` in `src/steps.ts`), `read` (a question answered with
  the page's own lines: Jev picks the first and last line, `src/read.ts`; `PLAINWRIGHT_READ=0` hides it), `evaluate` (a JS expression's JSON value), `save`. `snapshot`, `ask`, `read` and
  `evaluate` read without acting and are not recorded. `step`/`batch` results carry `changed` (title/url if changed,
  new aria lines capped at 1,500 chars, removed count; `src/aria-changes.ts`, after a settle; `PLAINWRIGHT_CHANGES=0`
  turns it off). `save` writes a YAML spec with `${hooks.*}` placeholders kept and `hooks:` relative to the
  saved file. `${env.*}` is not available in an MCP session, only `${hooks.*}`. stdout is the JSON-RPC channel,
  so all logging (here and in `src/cli.ts`/`src/steps.ts`) goes to `console.error`.
- Console noise (`isConsoleNoise` in `src/runner.ts`): CSP/blocked/failed-resource errors and errors from another
  site's script never reach `events` (Jev) and are counted in one note per drain; the page's own errors stay listed.
- `src/cli.ts` — entry point: loads `.env`, then dispatches to `mcp` or to running each spec file in order.
- Plugins live at `plugins/plainwright/` (browser), `plugins/plainwright-computer/` (desktop), and
  `plugins/plainwright-mobile/` (mobile), each
  with portable `plugin.json`/`mcp.json`, `.claude-plugin/plugin.json`/`.mcp.json`, a Codex compatibility
  manifest, its skill, and a generated `runtime.tgz`. Both root marketplaces point at these directories.
  Keep identity/version/description aligned across each plugin's manifests. Browser skill lives at
  `plugins/plainwright/skills/using-plainwright/` (SKILL.md, browsing.md, authoring.md).
- One root `package.json` and lockfile own all dependencies and all CLI binaries. `scripts/build-plugins.mjs`
  packages compiled runtime plus the root manifest/lockfile into the same archive for all plugins.
  `scripts/plugin-launcher.mjs` is copied into each plugin and caches the installed runtime by archive hash.
  Never add per-plugin package manifests, symlinks or parent-directory runtime imports.
- Docs: `README.md` is the quick start; `docs/spec-reference.md`, `docs/phrasing.md`, `docs/hooks.md`,
  `docs/agent-mode.md`, `docs/computer-use.md` and `docs/mobile-use.md` are the reference. A change to step kinds, thresholds, MCP tools, env loading or plugin
  install steps lands in the matching doc too (and in the skill, for thresholds and tool names).

## Constraints

- This repo is site-agnostic. Site-specific skills, environment facts, and regression specs belong in downstream
  plugins that depend on plainwright, not here.
- Specs never hold literal credentials: put them in the spec's `env` block as `$VAR` references, used in steps as
  `${env.*}`.
- `examples/*.yaml` run against public demo sites; `examples/fixtures/` and `examples/hooks/` back the
  `login-dataset.yaml` example.
- Per `plugins/plainwright/skills/using-plainwright/SKILL.md`: test environments only, stop before the last irreversible step
  (payment, booking, sending), never bypass bot protection.

## Computer use

- `src/automation.ts` is the shared generic target adapter, candidate/snapshot types, pick acceptance and judgment retry logic. Browser, desktop and mobile paths use it. `src/results.ts` shares labels/status/debug output.
- `src/hooks.ts` owns the generic isolated hook runner (`startHooks`) and `placeholderPaths`, used by all three MCP servers.
- `src/native.ts` is the shared desktop/mobile core: `NativeSession` (Jev targeting via `askSettled`, expect/wait polling, phase timing; subclasses implement only `act`), `runNativeSpec` (hooks → open → steps → teardown → close) and `nativeCli`. `src/native-mcp.ts` (`createNativeServer`, `serveNative`) holds the shared step/find/snapshot/ask/read/screenshot/save/close tools; each platform registers its own open and discovery tools first. As in the browser: `step` results carry `changed` (diffed against the step's own first whole-screen capture, `NativeSession.firstSnapshot`; press/swipe/mouse capture first), picks see `goal` (`open {goal}`, spec `goal:`), and `read` answers with tree lines.
- `src/computer-adapter.ts` implements `ComputerAdapter` using pinned xa11y (`@crowecawcaw/xa11y` 0.15.0). Native import is lazy; use the CommonJS default export (Node does not synthesize all named exports). `captureTree` (unit-tested with fake nodes) skips control parts (text, groups, images, table cells) inside a candidate, names unnamed candidates by their inner text, drops the single-window/application context and shortens long values; `click` inside a `web_area` is a pointer click, elsewhere the accessibility press when the element offers one (else a pointer click).
- `src/computer-spec.ts`, `computer.ts`, `computer-mcp.ts`, `computer-cli.ts` provide desktop parsing, actions, the `apps`/`open` tools (ten serialized MCP tools in all), and sequential batch replay, on top of `native.ts`/`native-mcp.ts`. Desktop specs have `app`, not `url`.
- `src/planner.ts` turns one sentence into plan items (code proposes splits/actions/word spans, Jev picks, arguments are copied verbatim); `plainwright-computer plan|do "<sentence>"` in `src/computer-cli.ts`. Change it only when `scripts/benchmark-planner.mjs` improves; results in `docs/benchmarks/planner.md`.
- `plugins/plainwright-computer/` is a separate portable/Codex/Claude plugin. `npm run build` regenerates all plugin runtime archives via `scripts/build-plugins.mjs`; never edit generated files directly. The root package and lockfile are the only dependency sources.
- Keep desktop tool names, thresholds and step support synchronized in `docs/computer-use.md` and the plugin's `skills/using-plainwright-computer/SKILL.md`. Browser-only steps must fail explicitly on desktop.
- `npm run test:computer:mac` is an opt-in native smoke against a disposable Cocoa fixture (Accessibility/Screen Recording permissions required); regular `npm test` uses injected desktop adapters and no model keys. Windows/Linux native parity requires testing on those platforms.

## Mobile use

- `src/mobile-adapter.ts` provides injectable `MobileAdapter` and lazy WebdriverIO `AppiumAdapter`. Appium and platform drivers are external host prerequisites; never auto-install apps or reset app data. Explicit `platform`, `device` (UDID/ADB serial) and installed `app` are required.
- `src/mobile-tree.ts` normalizes native XCUITest/UiAutomator2 XML into shared candidates/snapshots. `roleMarker()`, applied in `mobileFrame()`, drops a Jetpack Compose role-marker child from candidates when its clickable attribute is false, it is not long-clickable, it has no text or content-desc, and its bounds are set and match its clickable parent; the child stays in the snapshot. Native paths stay inside the adapter; Jev remains the sole target decision maker. Revalidate captured identity before native actions.
- `mobile-spec.ts`, `mobile.ts`, `mobile-mcp.ts`, `mobile-cli.ts` provide mobile parsing, actions, the discovery/`open` tools (eleven serialized tools in all), and sequential replay, on top of `native.ts`/`native-mcp.ts`.
- iOS tree reads are dominated by XCUITest's `visible` attribute. `AppiumAdapter` revalidates targets from the lookup response (`IOS_FOUND_ATTRIBUTES`, incl. `attribute/visible`), and with `fastTargets` (set by `mobile-cli.ts` and `mobile-mcp.ts`; MCP `find` calls `preferExact`, and `changed` never diffs against an approximate frame: `firstSnapshot` skips them, the previous step's after capture stands in) picks targets from a source without `visible` (`parseMobileTree` `boundsVisibility`, frame `approximate`); `MobileSession.act` keeps such a pick when accepted (>= 0.5, like any pick) and visible, else re-picks from an exact capture (`ms.retargeted`); fast and exact trees picked the same element in 24/24 recorded Calendar asks, with lower confidence on sheets. Claim `within` regions are also picked from the approximate tree (containers only, `NativeSession.region(within, true)`); the first exact look must show a visible node or `HiddenTargetError` re-picks. Reads exclude `accessible` except for click candidates; iOS lookups use class chains (`MobileNode.chain`). Measure with `examples/mobile/ios-calendar.yaml`.
- `NativeSession.settled()` uses `askSettled` (`automation.ts`): within 1 s of the previous step (or `noteActivity()` after open), Android reads a quick tree (`AppiumAdapter.captureEarly`, `waitForIdleTimeout` 0 for one read, then restored) and Jev works on it while the idle-waiting `capture()` runs; the answer is kept only if both frames are identical, else re-asked (`ms.reasked`). iOS returns null (no gain measured). The pre-action identity revalidation is unchanged.
- `mobile-discovery.ts` implements session-free local `list_devices`/`list_apps` through ADB and simctl/plutil, with injected commands for tests. Discovery targets the MCP host, not remote Appium; physical iPhone discovery is not supported. Keep discovery scope, pagination and setup diagnostics synchronized in the mobile docs/skill.
- The mobile plugin follows the same portable/Codex/Claude layout, root dependency ownership, generated runtime and marketplace conventions. Keep tool names, supported steps and thresholds aligned in `docs/mobile-use.md` and its skill.
- Mobile adds tap/longpress/swipe and supports selected shared steps; reject browser/desktop-only vocabulary explicitly. Android Back/Enter do not have generic iOS equivalents. Native context only; no webview switching.
- Regular tests use injected intelligence and a local Appium HTTP fixture with real WebdriverIO. `npm run test:mobile` is an opt-in device tree/PNG smoke using PLAINWRIGHT_MOBILE_PLATFORM/DEVICE/APP and optional PLAINWRIGHT_APPIUM_URL/CAPABILITIES. Native actions and record/replay need validation on both real platforms before claiming parity.
- `npm run test:mobile:android` builds a disposable offline Java fixture with SDK Platform 36 and Build-Tools 36.0.0, installs it on PLAINWRIGHT_MOBILE_DEVICE, validates actions/MCP authoring/saved replay and uninstalls it. Requires ANDROID_HOME, JAVA_HOME and Appium. `-- --live-jev` uses the configured model; default targeting is deterministic. Artifacts stay in a temporary results directory, not the repository.
- `npm run test:mobile:ios` builds a disposable UIKit fixture with Xcode's simulator SDK, installs it on the booted simulator identified by PLAINWRIGHT_MOBILE_DEVICE, validates actions/MCP recording/replay and uninstalls it. Requires macOS, Xcode, an iOS runtime and Appium with XCUITest. Supports `-- --live-jev` and PLAINWRIGHT_APPIUM_URL; no developer account is needed for this simulator-only test.
- Runnable mobile YAML lives in `examples/mobile/` so the top-level browser glob remains valid. Its `examples/hooks/mobile-fixture.mjs` hook and both native smoke scripts share `scripts/mobile-fixture.mjs` for fixture installation/cleanup. Example device IDs come from PLAINWRIGHT_MOBILE_DEVICE, never checked-in personal UDIDs.
