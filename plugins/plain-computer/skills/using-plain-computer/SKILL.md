---
name: using-plain-computer
description: Drive and inspect native desktop applications through the plain-computer MCP tools, or record and replay desktop YAML tests. Use for computer use on macOS, Windows, or Linux; use the browser plugin for web pages.
---

# Plain Computer

xa11y performs native desktop actions. Jev selects accessibility elements and judges claims;
do not replace Jev with your own coordinate guesses. Use this plugin in test environments.
Stop before the final irreversible action (payment, booking, sending), and never bypass bot protection.

## Attach and act

This file names the tools by their short names (`open`, `step`, `snapshot`). Call each tool by the full name
your tool list gives it, server prefix included (`mcp__<server>__step`, never a bare `step`).

A tool error (`isError: true` with a text message) means the call itself failed. A step that ran and
failed is a normal result with `status: "error"`. `screenshot` returns a PNG image block. `apps`
returns `{ apps: [...] }` (a bare array when your client reads only text content).

Snapshot modes: `raw` (default, 20,000 chars), `compact` (6,000, no classification call), and
`smart` (6,000, Jev classifications). `maxChars` allows 1–60,000; smart-only `intent` supplies
literal task context to filter UI regions at relevance p >= 0.5, plus recognized alerts/dialogs
and necessary context. Unused space is not filled. `inferred.selection` reports `focused`,
`no-confident-match`, or an unfiltered `fallback`. Check `coverage.filteredLines` and
`unassessedRegions` (up to 64 assessed regions). Without intent, smart returns a compact overview.
Compact/smart return exact `observed.aria`,
`coverage` omission counts, timings and `jevTokens`; smart adds advisory `inferred` state.
Screen classification requires confidence >= 0.9 (probability fallback). Signals are present
at p >= 0.9, absent at p <= 0.1, otherwise inconclusive; source truncation prevents absence
claims. Classification failure returns compact evidence with unavailable inference. Missing
excerpt content is not absent; expand with `within` or raw mode. To read a value, use `read`, not a
snapshot. Known actions need no snapshot first. Unscoped raw/compact reads need no model key; smart classification uses one.

- `apps` lists running applications and their pids without focusing them. `open` attaches by exact
  `app` name or `pid`, never both. It does not launch an app. `activate: true` (default) brings a
  window forward; use `activate: false` for reading without activation.
- `step` accepts one YAML-style action as a JSON object. Describe one unambiguous element using
  accessibility names. `find` is a dry run of Jev targeting, useful when a target is unclear.
- To read a value, call `read {question, within?}` first: it returns the exact tree lines that answer the
  question, copied verbatim with their ancestors ("the file size in the Info panel"). Several facts about
  one item fit in one question; add `within` on a large window. On `found: false`, rephrase once with the
  words of `guesses` or scope with `within`. A snapshot is for seeing structure, not for reading values.
- `snapshot` reads the app tree; `within` selects a region. `screenshot` returns a window PNG for
  inspection. Neither reading is recorded. Jev uses accessibility text, not screenshots; a canvas
  with no accessible controls needs application accessibility support, not invented targets.
- `ask {claims, within?}` answers yes/no questions about the current state without acting or
  recording: 1–16 claims in one Jev call, each `yes` (p >= 0.9), `no` (p <= 0.1) or `unsure`. When a
  step fails or is inconclusive, ask one claim per possible cause ("An error message is shown",
  "The Save button is disabled", "A dialog covers the window") instead of reading the whole tree.
  It cannot explain in free text. Use `expect` only for assertions that belong in the test.
  To get a sure answer instead of `unsure`: name the exact thing (its text, role and place), not
  a vague "an error is shown"; for absence, ask the positive claim and read a sure `no` ("The field
  contains any text" → no, where "The field is empty" stays unsure: an empty field has no value in
  the tree); scope with `within` to cut noise. `unsure` is not evidence either way: rephrase or split.
- Each `step` result carries `changed`: the tree lines the step added (capped) and how many it removed.
  Read it before a snapshot or `ask`: it often holds the new window content or the answer itself.
- Pass `goal` to `open` (what the whole flow is for, one sentence): picks use it to settle a vague
  target toward the flow; the target's words still win, and claims never see it.
- Name controls as the accessibility tree does, not by how they look: an icon-only toolbar button
  is named by its accessibility description, a tab by its title. Read a `snapshot` when unsure.
- On `inconclusive`, rephrase the target (the detail's top guesses show the tree's names; reuse the
  right one) or split the claim. After an error, inspect current state
  before retrying an action: a native action can take effect before its error is reported.
- Rows that offer no accessibility press (Fork's sidebar and commit list) also get a pointer click.
- In Electron apps and web views (Slack, Notion), `click` is a real pointer click, so it needs the app in
  front like keys do. If a click passes but nothing changes, prefer the app's keyboard route (Slack: Cmd+K,
  type the name with single-key `press` steps, Enter): `fill` sets a value without key events.
- Simulated keys/pointer actions require the attached app to be foreground. If focus changed,
  `open` it again only when the user's task calls for activation. Opening starts a new recording.
- `close` detaches and runs teardown; it leaves the app running.

In Claude Code the plugin also draws a session pane (`/plain-computer-pane`) with each step's status and Jev tokens; it does not change any tool result.

```yaml
fill: {target: "the Message text field", value: "hello"}
# Other individual step objects:
click: "the Preview button"
check: "the Enable preview checkbox"
uncheck: "the Enable preview checkbox"
hover: "the help icon"
dblclick: "the document icon"
rightclick: "the first row"
scroll: "down: the results list" # up:, left:, right: also supported; one wheel movement, not scroll-to-end
press: "Control+a" # use Meta for Command on macOS; native key names are platform dependent
drag: {source: "the first row", target: "the destination folder"}
expect: ["The preview says hello", "The preview checkbox is checked"]
expect: {that: "The preview says hello", within: "the preview panel"}
wait: "The results are visible"
wait: {that: "The results are visible", within: "the results list"} # polls only that region
```

`mouse: {x: 100, y: 100}` uses logical desktop coordinates, only when the user supplies them or
an observed accessibility bound establishes them. Browser `css=`, `goto`, `select`, and `upload`
are unavailable. Operate native menus and file dialogs through their accessible controls.
A pick passes at confidence >= 0.5 (probability when confidence is absent); a claim passes at
p >= 0.9, fails at p <= 0.1, otherwise is inconclusive. `wait` polls up to eight Jev calls within
the configured polling deadline. An in-flight model/native call may outlast that deadline.
Use explicit spatial relations ("the button left of Cancel", "A is above B"): targets and claims that
need layout get accessibility bounds in desktop screen coordinates and measured neighbors (at most 254
named elements). Specs classify their known prompts in one request; tree order is not visual order.

## Record and replay

`open` may receive a `hooks` path. Setup runs before attachment and exposes `${hooks.*}` names;
use those placeholders, especially for credentials. `save` writes only passing steps, preserving
placeholders and a relative hooks path. Failed/inconclusive/skipped attempts are omitted. No
`${env.*}` namespace exists in MCP; add an `env` block to a saved YAML spec for batch replay.
A value typed into a macOS secure text field is never saved: the step gets `${env.password}`, the
spec `env: {password: $PASSWORD}` (`password2`/`$PASSWORD_2` for a second value; a later fill of
the same value gets the same placeholder), and the `save` result lists that block. Set the
variables before replay. On Windows and Linux, passwords are saved as typed: use `${hooks.*}`.

```yaml
name: Desktop preview
app: Desktop Test Fixture
env:
  message: $TEST_MESSAGE
steps:
  - fill: {target: "the Message text field", value: "${env.message}"}
  - click: "the Preview button"
  - expect: "The preview contains the test message"
```

Run `npx -y -p @gabe4coding/plain@3.1.0 plain-computer <spec.yaml>` (the same package version as
the MCP server). Desktop specs run sequentially.
Hooks use the same isolated setup/teardown child contract as plain. Explicit assertion
failures are never skipped by `optional: true`; only errors/inconclusive results can be skipped.
Never put literal credentials into specs, hook recordings, or tool arguments.

Outside an agent session (voice front ends, scripts), `plain-computer plan "<sentence>"` returns Jev's
plan of one sentence as JSON items, and `plain-computer do [--app NAME] [--yes] "<sentence>"` runs it
in a running app. Inside an agent session, plan the steps yourself and use the tools: you see the
results between steps.

For YAML suites, add `tags: [smoke]` and share steps with
`include: ./flows/login.yaml` (a steps-only file; placeholders use root env/hooks).
Keep flows outside spec input globs. Run `npx -y -p @gabe4coding/plain@3.1.0 plain-computer validate spec.yaml`
before replay; missing secrets are warnings and no session/model key is needed.
For CI, use `--reporter jsonl --reporter junit:out/junit.xml --artifacts plain-results`.
Passing spec runs and `save` write a lock file (`*.lock.json` next to each spec and flow): commit it.
`--mode auto-healing` (default) replays it and lets Jev repair changed steps; `--mode no-judge` replays it with
no Jev call and no API key; `--mode judge` asks Jev for everything. Picks below 0.9 confidence are recorded as
marginal: no-judge replays them, auto-healing asks Jev again.
Runs stay sequential; screenshots are supported, browser traces are unavailable.
`include` is expanded by the file loader, so it cannot be sent to MCP `step`.

## Setup failures

The shared API key settings are `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`, optionally
`JEV_PROVIDER=typesafe|gateway`, loaded from cwd `.env` then `~/.config/plain/.env`.
MCP can list its tools and read the desktop without a Jev key.
macOS requires the executing host's Accessibility permission and may require Screen Recording
for window content/screenshots. Linux requires an AT-SPI2 desktop; input/screenshot capabilities
vary with the display server. A permission error is actionable setup information: tell the user
which permission the native backend requests. Do not attempt to change OS privacy settings.
