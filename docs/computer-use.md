# Computer use

`plainwright-computer` drives native desktop applications with
[xa11y](https://github.com/xa11y/xa11y). Jev makes the same natural-language target choices and
assertion judgments as the browser engine. The existing `plainwright` plugin continues to use
Playwright; desktop automation is a separate plugin and CLI entrypoint.

## Backend choice

The requirement is accessible controls plus native actions, not just moving a mouse. xa11y's
TypeScript API exposes native accessibility on macOS (AXUIElement), Windows (UI Automation),
and Linux (AT-SPI2), with MIT-licensed source and platform binaries. We pin
`@crowecawcaw/xa11y` to `0.15.0` and isolate it behind `ComputerAdapter`. It is a newer library,
so platform quirks and upstream API changes need validation before upgrading.

Alternatives evaluated on 2026-09-20:

| Backend | Fit for this project |
|---|---|
| [xa11y](https://xa11y.dev/api/javascript/) | Chosen: native accessibility, actions, keyboard/pointer simulation and screenshots in one Node API across desktop platforms. |
| [Appium Mac2](https://appium.github.io/appium-mac2-driver/v4/getting-started/) | Established macOS automation, but requires an Appium server, Xcode and a separate driver stack. Desktop portability needs other drivers. |
| [nut.js](https://nutjs.dev/) | Strong keyboard/mouse/screen automation. Packaged accessibility tooling and prebuilt distributions involve commercial tiers; adds distribution requirements to this MIT repository. |
| [Computer Use Protocol TypeScript SDK](https://github.com/computeruseprotocol/typescript-sdk) | Similar accessibility approach, but its repository was archived on April 30, 2026. |

Jev sees accessibility text, not screenshots. Apps with inaccessible canvas controls are outside
natural-language targeting's current coverage. This is not a vision-based agent.

## Install and start

Requirements: Node 22+, npm, a running desktop session, and a Jev provider key for targeting/assertions.
Browser dependencies do not need native permissions. xa11y is optional in the root package and
loaded only for desktop operations; the desktop plugin reports an actionable error if the optional native package is unavailable.
Keep optional platform packages enabled when installing xa11y.

From a clone:

```sh
npm ci
npm run build
node bin/plainwright-computer.mjs mcp
node bin/plainwright-computer.mjs --timeout 15000 path/to/desktop.yaml
```

The plugin directory is `plugins/plainwright-computer/`, alongside the browser plugin at
`plugins/plainwright/`. One root `package.json` and lockfile own browser, desktop and mobile engines. Each plugin includes
the same generated `runtime.tgz`; its launcher installs that shared package into an ignored
`.runtime/` cache on first use, with install progress on stderr. Starting the desktop plugin does
not install Chromium or require a neighboring browser-plugin installation:

```sh
node plugins/plainwright-computer/bin/launch.mjs mcp
```

Both repository marketplaces list `plainwright-computer`. With this checkout added as your
marketplace, select that plugin in your host. Claude Code can also load the directory directly:

```sh
claude --plugin-dir /absolute/path/to/plainwright/plugins/plainwright-computer
```

The repository's portable `plugin.json` / `mcp.json`, Codex compatibility manifest, and Claude
manifest/config all name the same server, `plainwright-computer`. The portable configuration
uses `${PLUGIN_ROOT}` as cwd; Claude uses `${CLAUDE_PLUGIN_ROOT}` in its launcher path. The
plugin does not install itself into your personal plugin cache during a repository build.

Environment lookup is shared with plainwright: process environment, cwd `.env`, then
`~/.config/plainwright/.env` (or the equivalent under `XDG_CONFIG_HOME`). Existing variables win.
Use `TYPESAFE_API_KEY`, or `AI_GATEWAY_API_KEY`; `JEV_PROVIDER` can force the provider. MCP discovery,
`apps`, unscoped raw/compact `snapshot`, and `screenshot` do not require a Jev key. Smart snapshots
use Jev for classification; if unavailable they return compact evidence with an explicit fallback.

## Platform setup

- **macOS:** grant the host executing Node Accessibility permission. Depending on macOS version,
  System Settings labels it Accessibility or Device Control and Data Access. Screen Recording
  permission may also be needed for window contents and screenshots. Restart the host if macOS
  requires it. The library reports permission errors; the plugin does not change privacy settings.
- **Windows:** use an interactive UI Automation desktop. Apps at a different integrity/elevation
  level may not expose the same controls or accept input.
- **Linux:** use an AT-SPI2-enabled desktop. Pointer, keyboard and screenshot support depends on the
  desktop/display server; accessibility availability does not imply unrestricted Wayland input.

Read the upstream [installation](https://xa11y.dev/how-to/install/) and
[platform documentation](https://xa11y.dev/reference/platforms/) for native prerequisites.
The cross-platform API is implemented; native verification in this repository currently targets macOS.

## Agent tools

JSON tool results are available in MCP `structuredContent`, with the existing serialized JSON
also kept in `content` text blocks for older clients. Prefer `structuredContent` when available.
MCP tool errors use `isError: true` and a text message; action outcomes (including
`status: "error"`) remain structured results.
Screenshots remain PNG image content blocks.
`apps` exposes `{ apps: [...] }` in `structuredContent`; its legacy text remains a bare array.

| Tool | Purpose |
|---|---|
| `apps {}` | List running accessible app names/pids; no focus change. |
| `open {app}` or `open {pid}` | Attach to exactly one running app. `activate` defaults to true; false leaves focus alone. Optional `hooks` runs setup before attachment. Optional `goal` (what the whole flow is for, one sentence; spec key `goal:`) is given to every pick, so a vague target picks the control the flow is about; the target's words win, and claims never see it. |
| `step {step}` | Execute one natural-language action/assertion and return status, detail, timings, token count and `changed`. |
| `find {kind, target}` | Dry-run a target with Jev. Kinds: click, fill, check, hover, region, scroll. |
| `snapshot {within?, maxChars?, mode?, intent?}` | Raw text by default (20,000 chars); `compact`/`smart` default to 6,000. Maximum 60,000. `within` resolves a region with Jev. Smart-only `intent` filters to relevant UI regions plus critical messages. See [snapshot views](snapshots.md). |
| `ask {claims, within?}` | Yes/no questions about the current state, without acting: 1–16 claims in one Jev call, each answered `yes` (p ≥ 0.9), `no` (p ≤ 0.1) or `unsure`, with its `p`. Not recorded and never changes the session status. Use it to test hypotheses when a step fails ("An error message is shown", "The Save button is disabled"). |
| `read {question, within?}` | Read data: the exact tree lines that answer the question, copied verbatim (`answer`), with their ancestors (`context`) and `confidence`. Jev picks the first and last line and never writes text; `found: false` with `guesses` when no line answers. `within` scopes it to a region and costs fewer Jev tokens. Not recorded. Same as the browser's `read`. |
| `screenshot {}` | Return a PNG of an attached app window. Not supplied to Jev. |
| `save {path, name?}` | Save successful steps as desktop YAML. Rejects an empty recording. |
| `close {}` | Detach and run teardown; leave the application running. |

`step` results carry `changed`, the same diff as the browser's: the title if it changed, the tree lines the step added (`added`, in tree order, capped at 1,500 characters, `addedOmitted` past that) and how many it `removed`. Read it before a snapshot or `ask`. A step that picks a target diffs against its own pre-action capture; `press` and `mouse` take one extra capture before acting. `PLAINWRIGHT_CHANGES=0` turns it off. `PLAINWRIGHT_READ=0` hides `read`.

`open` attaches; it does not launch arbitrary programs. Applications must already be running,
which keeps batch setup in the user's environment or hooks. Every `open` starts a new recording
and releases the previous hook lease. `save` uses the app name, not an ephemeral pid, for replay.
All requests in a server are serialized, including reads. Different server processes still share
one physical desktop: do not run multiple desktop sessions in parallel.

Native accessibility actions operate on captured handles. Simulated keyboard/pointer actions also
check that the attached app's pid is currently foreground. A focus change returns an error;
it does not silently activate an unrelated window. OS focus can still change between that check
and an input event, so use a dedicated test desktop for unattended runs.

Targets match best when they use accessibility names rather than visual descriptions: an icon-only
toolbar button is named by its accessibility description. An inconclusive pick lists its top
guesses with the tree's names, so the right wording is usually one of them.

## Desktop specs

```yaml
name: Preview a message
app: Desktop Test Fixture
env:
  message: $TEST_MESSAGE
hooks: ./hooks/fixture.mjs # optional; use setup to prepare the test application/data
goal: Preview a message before sending it # optional; every pick sees it, claims never do
steps:
  - fill: {target: "the Message text field", value: "${env.message}"}
  - check: "the Enable preview checkbox"
  - click: "the Preview button"
  - expect: "The preview contains the test message"
```

Top-level keys are `name`, `app`, optional `env`, `hooks`, and `goal`, and a nonempty `steps` list.
Unknown top-level keys are rejected so browser settings cannot be silently ignored. Environment
references and `${env.*}` / `${hooks.*}` interpolation are the browser engine's existing logic.
Store credentials as `$VAR` references in `env`, or return them from hooks; never record literals.
MCP supports `${hooks.*}` only and preserves placeholders in `save`.

Supported steps reuse the browser schema:

| Step | Desktop behavior |
|---|---|
| `click`, `fill` | Invoke the accessible control (a pointer click inside web content); replace its text value. |
| `check`, `uncheck` | Toggle only if the exposed checked state differs. Mixed states error instead of guessing. |
| `hover`, `dblclick`, `rightclick` | Simulated pointer action on the control's bounds. |
| `scroll: "down: the list"` / `"up: the list"` | One wheel movement at a resolved region. Does not claim to reach the end. |
| `press: "Control+a"` | Key or modifier+key chord. Use `Meta` for Command on macOS. |
| `mouse: {x, y}` | Pointer move in logical desktop coordinates. |
| `drag: {source, target}` | Resolve both endpoints in one Jev batch, then simulate a drag. |
| `expect: [...]` | Judge multiple atomic claims in one request; can scope with `{that, within}`. |
| `wait: "claim"` | Poll accessibility state, with up to eight Jev calls; avoid rejudging unchanged definite failures. |
| `wait: {that, within}` | The same, polling only the region picked once by `within`. |

Browser `goto`, `select`, `upload`, `css=`, and browser scroll-to-edge syntax are rejected.
Use accessible native menus and file-dialog controls instead. `optional: true` changes only
inconclusive/error to skipped; a definite failed expectation still fails the run.

The shared thresholds apply: picks need confidence >= 0.5 (probability fallback); claims pass at
p >= 0.9, fail at p <= 0.1, otherwise are inconclusive. Rejections dump state to the same
`$TMPDIR/plainwright/` debug directory. Candidate lists cap at 1,016; captures limit text to
60,000 characters, traversal to 5,000 nodes/32 levels, and prioritize modal siblings. `truncated`
reports caps; use a scoped snapshot for dense apps. The timeout bounds app lookup and capture/wait
polling budgets; an individual native call or Jev request/retry can outlast the polling deadline.

Batch specs run sequentially. Exit 0 means all passed, 1 means a spec failed/errored/was inconclusive,
2 means invalid CLI usage or missing provider configuration. Hooks share the isolated child-process
contract described in [hooks](hooks.md), with a desktop spec's `app` replacing the browser's `url`.
Teardown runs after a successful setup even when attachment, interpolation, or a step fails. A
setup failure skips teardown; a teardown failure makes the run error. Detach never quits the app.

## Candidates in Electron and web views

Electron apps (Slack, Notion) and web views list a control's own label as a separate static text with
actions: the tab "Files & links" and, inside it, the text "Files & links". Offered as two candidates they
split Jev's confidence (p=0.90 for the tab, rejected at c=0.45). Text, groups and images inside a
candidate are therefore not candidates themselves (a real control inside one, such as a row's button,
still is), and an unnamed candidate is described by the text inside it (`tab "" value="0"
text="Activity"`). On a live Slack window, 10 of 10 spoken targets resolved against 6 of 10 before
("Activity", "Activity Button", "the DMs tab", "Files and links", "the Files tab in the sidebar").

Web content also ignores the accessibility press on many elements: a Slack tab "clicked" and reported
`pass` while the view never changed. `click` on a candidate inside a `web_area` is therefore a real
pointer click at the element (the app must be in front, as for hover); native controls keep the press,
which needs no focus. A native control that does not offer a press (Fork's sidebar and commit rows
offer only `show_default_u_i`) gets the pointer click too.

Native tables repeat themselves the same way: Fork lists each commit as a row plus its five cells, and
names every candidate `in window "plainwright"`. So a table cell inside a candidate row is a part too
(the row is named by its cells' text, up to 160 characters: message, author, hash, date), the context
leaves out the window when the app has only one and the application always, and a candidate shows only
the first 100 characters of a long value (the snapshot keeps it whole). On Fork's commit view: 537 → 225
candidates, 59k → 19k characters, about 50k → 18k Jev tokens per pick, and 8 → 10 of 10 targets
("the most recent commit" needs the date from the cells). Slack and Notes picks were unchanged or better.
Capture itself stays about 1 s for Fork's ~1,000 nodes: macOS answers one element at a time, and neither
parallel reads nor xa11y's `tree()` are faster.

A pick over a busy web view can exceed Jev's request limit (TypeSafe answers 400
`max_tokens_exceeded`) with far fewer than 254 candidates, because every message row carries its
text. The request is halved and the answers merged, like a list over 254.

## One sentence: plan and do

```
plainwright-computer plan "open TextEdit, then type salt and pepper in the text area and press command S"
plainwright-computer do [--app NAME] [--yes] "open TextEdit, then type salt and pepper in the text area. Does it contain salt and pepper?"
```

`plan` prints the steps Jev makes of one spoken or typed sentence, as JSON items (`open`, `step`,
`ask`, `stop`, `unknown` with a reason). `do` runs them as a desktop spec: the app named first (or
`--app`), then the steps in order, stopping at the first that does not pass; questions become `expect`
steps. Nothing runs when a part is not understood, or when a step is hard to undo without `--yes`.
Like `open`, `do` attaches to a running app; it never launches one.

Jev never writes the steps (`src/planner.ts`). Code splits at sentence ends and at then/after that/
next/finally; for every "and" or comma it lists the possible readings of the piece and Jev picks one
(one Choice), so "type salt and pepper in the box and press enter" keeps the text whole. A second
request picks each piece's action and, speculatively, the exact words for its target, text, app and
keys, plus whether it is hard to undo. Arguments are copied verbatim from the sentence. Two requests,
about 3k tokens for a one-step sentence and 10–13k for four steps.

`node scripts/benchmark-planner.mjs --runs 3` measures the plan against `scripts/planner-cases.json`
(57 sentences, 16 of them from live voice sessions): 97.4% on 2026-09-24. Change the planner only when that rate goes up; results and the
changes that did and did not help are in [the planner benchmark](benchmarks/planner.md).

A step right after a key or click that opens a window can capture before the window exists. When a
capture has no candidates of the needed kind, the session captures again every 150 ms for up to 2 s.
When an older window of the app is still open, the capture is not empty and can act on that window:
wait for the new one (`wait: "a window named Untitled 2 is shown"`) before acting in it.

## Implementation and verification

`automation.ts` owns the generic target adapter, candidate/snapshot data, accepted-pick mapping,
assertion retry logic, and injectable intelligence. Both Playwright's `resolveLocators` and
`ComputerSession.find` use it. `results.ts`, `spec.ts` and `hooks.ts` supply shared status/labels,
parsing/interpolation, and hook lifecycle. Browser-specific settling/navigation stays in the browser
adapter; desktop capture/actions live in `computer-adapter.ts`. Desktop steps do not wait for the UI
to settle: a step is capture, then Jev, then the action, and its `ms` reports `capture`, `jev`, `act`
and `idle` (between `wait` polls). The Jev call is almost all of a step's time, so there is no wait
to overlap it with, unlike the browser and Android.

`npm run build` compiles TypeScript, then `scripts/build-plugins.mjs` creates the same committed
`runtime.tgz` in all plugin folders from the root package, compiled files, CLI binaries, and license.
The root lockfile becomes an npm shrinkwrap inside the archive, so plugin installs use the locked
dependency graph. There are no plugin-specific package manifests or lockfiles. The launcher
caches by archive hash, so a rebuilt archive gets a fresh runtime installation.

```sh
npm test                    # browser regression + desktop adapter/protocol tests, no API key
npm run test:computer:mac    # opt-in: creates a disposable Cocoa app, needs native permissions
```

The native smoke test injects deterministic model choices and asserts actual application state.
It covers attachment, tree capture, fill/click, idempotent check/uncheck, keyboard input, hover,
and PNG capture. The fixture is closed and removed afterward. It does not require a model key.
Windows and Linux need equivalent native smoke runs on their own hosts before claiming native parity.
