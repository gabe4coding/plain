---
name: using-plain-mobile
description: Drive and inspect native iOS and Android apps through the plain-mobile MCP tools, or record and replay mobile YAML tests. The mobile engine is beta. Requires Appium and a connected device, simulator or emulator.
---

# Plain Mobile

Appium performs native actions through XCUITest (iOS) or UiAutomator2 (Android). Jev selects
controls and judges claims using the native UI tree. Use this plugin in test environments.
Stop before the final irreversible action (payment, booking, sending); never bypass bot protection.

## Open and inspect

This file names the tools by their short names (`list_devices`, `open`, `step`). Call each tool by the full name
your tool list gives it, server prefix included (`mcp__<server>__step`, never a bare `step`).

A tool error (`isError: true` with a text message) means the call itself failed. A step that ran and
failed is a normal result with `status: "error"`. `screenshot` returns a PNG image block.

Start with `list_devices {platform?}` to discover Android devices/emulators and iOS simulators
on the MCP host. Use the intended device's exact ID and check `ready`; never substitute another
device when it is offline, unauthorized or shut down. Per-platform `errors` report missing SDKs
without hiding results from the other platform. Then call `list_apps {platform, device}` and
copy a returned `app` ID into `open`. Neither discovery tool needs an Appium session or Jev key.

`list_apps` supports case-insensitive `query` matching ID/name, `include_system` (default true),
`limit` (default 100, max 500), and `offset` (default 0). Pass a non-null `nextOffset` as the next
offset. iOS returns display names; Android returns installed package IDs, some of which have
no launchable UI. Discovery returns `scope: "local"` even with a remote Appium URL: it cannot
enumerate a remote host or physical iPhones. For those, obtain explicit IDs through the host's
tools and use `open`. Discovery does not launch apps, boot devices or alter recordings.

Use `open` with `platform: ios|android`, an explicit `device` UDID/ADB serial, and `app` bundle
ID/package name. The app must already be installed and the device booted/connected. Appium must
already be running with its platform driver. Do not substitute arbitrary connected devices.
Optional vendor-prefixed `capabilities` supply signing/activity settings; Plain owns app,
device, driver, reset, launch and native-context settings. Optional `hooks` runs setup first.
For faster Android runs, `capabilities: {"appium:disableWindowAnimation": true}` turns animations off
for the session (contacts flow: ~1-2 s less out of ~14 s). Opt-in only: it changes device animation
settings and hides transition bugs, so ask before using it on a device that is not a disposable test
device. iOS `appium:reduceMotion` gave no measurable gain and stays on after the session: do not suggest it for speed.

```json
{"platform":"android","device":"emulator-5554","app":"com.example.fixture"}
```

`open` launches/activates the app without clearing data. Every open starts a new recording and
releases the previous session/hooks lease. One automation session per device; do not drive the
same device from another server concurrently. `close` runs teardown and deletes the Appium
session without uninstalling or clearing the app.

`snapshot` reads the native UI tree; `within` selects a region with Jev. `maxChars` defaults to
20,000 in default `mode:"raw"`, or 6,000 in `compact`/`smart`, with a maximum of 60,000.
Compact returns exact `observed.aria`, `coverage` omission counts, timings and `jevTokens`
without classification. Smart adds advisory `inferred` state in one Jev request; optional
smart-only `intent` filters UI regions at relevance p >= 0.5, plus recognized alerts/dialogs
and necessary context. Unused space is not filled. `inferred.selection` reports `focused`,
`no-confident-match`, or an unfiltered `fallback`. Check `coverage.filteredLines` and
`unassessedRegions` (up to 64 assessed regions). Without intent, smart returns a compact overview.
Screen classification
requires confidence >= 0.9 (probability fallback); signals are present at p >= 0.9, absent at
p <= 0.1, otherwise inconclusive. Source truncation prevents absence claims. Failed
classification returns compact evidence with unavailable inference. Omitted content is not
absent; expand with `within` or raw mode. To read a value, use `read`, not a snapshot. Known
actions need no snapshot first.
`screenshot` returns the device PNG for inspection. Neither
reading is recorded. Jev uses text, not screenshots. A tappable parent with no name of its own
gets the text of its children. The plugin does not inspect framework internals or switch to
webview contexts. Inaccessible canvas controls require app accessibility support.
On iOS, snapshots retain explicitly visible descendants of invisible layout containers. If a
visible form is missing from the snapshot, report a possible adapter/accessibility mismatch;
do not assume the app exposes no controls or repeatedly tap unrelated navigation controls.

In Claude Code the plugin also draws a session pane (`/plain-mobile-pane`) with each step's status and Jev tokens; it does not change any tool result.

## Act and verify

`step` accepts one YAML-style action as JSON. Describe an unambiguous native control. `find`
dry-runs target selection using kinds `click`, `fill`, `check`, `region`, or `scroll`; use `click`
for taps/long presses. The eleven tools are `list_devices`, `list_apps`, `open`, `step`, `find`,
`snapshot`, `ask`, `read`, `screenshot`, `save`, and `close`. All requests are serialized.

Pass `goal` to `open` (what the whole flow is for, one sentence): picks use it to settle a
vague target toward the flow; the target's words still win, and claims never see it. Each `step`
result carries `changed`: the tree lines the step added (capped) and how many it removed. Read it
before a snapshot or `ask`: it often holds the new screen or the answer itself.

To read a value, call `read {question, within?}` first: it returns the exact tree lines that answer
the question ("the iOS version on the About screen"), copied verbatim with their ancestors. Several
facts about one item fit in one question; add `within` on a large screen. On `found: false`,
rephrase once with the words of `guesses` or scope with `within`. A snapshot is for seeing
structure while debugging, not for reading values.

`ask {claims, within?}` answers yes/no questions about the current screen without acting or
recording: 1-16 claims in one Jev call, each `yes` (p >= 0.9), `no` (p <= 0.1) or `unsure`. When a
step fails or is inconclusive, ask one claim per possible cause ("An error alert is shown", "The
keyboard covers the button", "The Save button is disabled") instead of reading the whole tree. It
cannot explain in free text. Use `expect` only for assertions that belong in the replayed test.
To get a sure answer instead of `unsure`: name the exact thing (its text, role and place), not
a vague "an error is shown"; for absence, ask the positive claim and read a sure `no` ("The field
contains any text" → no, where "The field is empty" stays unsure: an empty field has no value in
the tree); scope with `within` to cut noise. `unsure` is not evidence either way: rephrase or split.

Each line below is a separate step:

```yaml
tap: "the Preview button" # click is an alias
fill: {target: "the Message text field", value: "${hooks.message}"}
fill: {target: "the hour picker wheel", value: "14"} # iOS native wheel value; inspect afterward
check: "the Enable preview switch"
uncheck: "the Enable preview switch"
longpress: "the first row" # one second
dblclick: "the image" # double tap
scroll: "down: the results list" # up/left/right also supported; one gesture
swipe: left # finger movement, not content scrolling direction
swipe: {direction: up, within: "the carousel"}
press: HideKeyboard # Home also works on both platforms
press: Back # Android only; Enter is Android only too
expect: ["The preview says hello", "The preview switch is checked"]
expect: {that: "The preview says hello", within: "the preview panel"}
wait: "The results are visible"
wait: {that: "The results are visible", within: "the results list"} # polls only that region
```

Name controls as the native tree does, not by their visual role; read a `snapshot` first when
unsure. Tab bar items are buttons ("the Workout button", not "the Workout tab"). The iOS back
button carries the previous screen's title ("the Summary button in the Step Count navigation
bar", not "the Back button"). Segmented controls expose full names ("the Week segment", not "W").
On inconclusive, the detail's top guesses show the tree's names: reuse the right one.

iOS has no generic Back/Enter step: tap the visible navigation or keyboard control. On iOS, `fill`
and a tap on a text field return once the keyboard is on screen (at most 3 s), so the next step can
tap a key; the return key is often labeled "done" even when drawn as a checkmark. `check`/
`uncheck` read boolean checked state and tap only when it differs; unknown/mixed states error.
`fill` also selects iOS picker-wheel values without clearing the control. Inspect the native
value/format first, then verify the resulting value; date/time formats depend on the app/locale.
Browser/desktop `goto`, `select`, `upload`, `hover`, `rightclick`, `mouse`, `drag`, and `css=` are
unsupported. Operate menus/pickers through their native controls. Never invent coordinates.

Picks need confidence >= 0.5 (probability fallback). Claims pass at p >= 0.9, fail at p <= 0.1,
otherwise are inconclusive. On inconclusive, rephrase or split the claim. Captures cap at 1,016
candidates, 5,000 nodes / 32 levels and 60,000 text characters. Use scoped reads when truncated.
`wait` makes at most eight model calls; native/model requests can outlast the polling deadline.
Use explicit spatial relations ("the left button of the pair", "A is above B"): targets and claims that
need layout get bounds (Android pixels, iOS points) and measured neighbors (at most 254 named elements).
Specs classify their known prompts in one request; tree order is not visual order.
On iOS, steps (spec replay and MCP) pick action targets from a faster tree that also lists covered elements (confidence
there runs lower); a rejected pick, or one confirmed covered, is picked again from the exact tree (`ms.retargeted`).

After an error, inspect current state before retrying: an input may already have taken effect.
The adapter checks target identity before acting and errors if the captured node changed.
`optional: true` converts only errors/inconclusive to skipped, never a definite failed assertion.

## Record and replay

Use `${hooks.*}` from `open` setup for dynamic data, especially credentials. MCP has no
`${env.*}` namespace. `save {path, name?}` writes only passing steps and preserves placeholders
in target settings and steps; hooks paths become relative to the saved file. Reads and
failed/inconclusive/skipped steps are omitted. A new open clears the recording.
A value typed into a password field (iOS `XCUIElementTypeSecureTextField`, Android
`password="true"`) is never saved: the step gets `${env.password}`, the spec
`env: {password: $PASSWORD}` (`password2`/`$PASSWORD_2` for a second value; a later fill of the
same value gets the same placeholder), and the `save` result lists that block. Set the variables
before replay.

For file replay, add an `env` block with `$VAR` references:

```yaml
name: Mobile preview
platform: android
device: "${env.device}"
app: "${env.app}"
env:
  device: $TEST_DEVICE
  app: $TEST_APP
  message: $TEST_MESSAGE
steps:
  - fill: {target: "the Message text field", value: "${env.message}"}
  - tap: "the Preview button"
  - expect: "The preview contains the test message"
```

Run `npx -y -p @gabe4coding/plain@3.1.0 plain-mobile <spec.yaml>` (the MCP server's package version).
Files run sequentially. On iOS use `platform: ios` and its UDID/bundle ID. Equivalent flows can
share steps, but verify accessibility and navigation on each platform. Optional hooks use the
shared isolated setup/teardown contract, with setup before opening and cleanup on failure.
Never record literal credentials in specs or tool arguments. App data is preserved between
runs; prepare starting state in explicit steps or hooks.

For YAML suites, add `tags: [smoke]` and share steps with
`include: ./flows/login.yaml` (a steps-only file; placeholders use root env/hooks).
Keep flows outside spec input globs. Run `npx -y -p @gabe4coding/plain@3.1.0 plain-mobile validate spec.yaml`
before replay; missing secrets are warnings and no session/model key is needed.
For CI, use `--reporter jsonl --reporter junit:out/junit.xml --artifacts plain-results`.
Passing spec runs and `save` write a lock file (`*.lock.json` next to each spec and flow): commit it.
`--mode auto-healing` (default) replays it and lets Jev repair changed steps; `--mode no-judge` replays it with
no Jev call and no API key; `--mode judge` asks Jev for everything. Picks below 0.9 confidence are recorded as
marginal: no-judge replays them, auto-healing asks Jev again.
Runs stay sequential; screenshots are supported, browser traces are unavailable.
`include` is expanded by the file loader, so it cannot be sent to MCP `step`.

## Setup errors

Use `--server` or `PLAIN_APPIUM_URL` to select Appium (default
`http://127.0.0.1:4723`). The endpoint may include a base path but not credentials/query/fragment.
Authentication for remote device clouds is not implemented. Missing driver/device/app errors
need setup correction, not retries against another device.

Android needs its SDK, Java, ADB and UiAutomator2. iOS needs an Xcode/macOS automation host and
XCUITest; physical iPhones need signed/provisioned WebDriverAgent. Local discovery resolves ADB
from `ANDROID_HOME`/`ANDROID_SDK_ROOT`, conventional SDK paths or `PATH`; iOS discovery needs
Xcode's `xcrun simctl` and macOS `plutil`. ADB may start its host daemon when queried. Device IDs
can also be inspected using `adb devices -l`, `xcrun simctl list devices booted`, or Xcode Devices. The plugin does not
install these tools, start emulators, install apps or alter device settings automatically.

Provider keys are `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`, optionally `JEV_PROVIDER`.
The CLI loads cwd `.env`, then `~/.config/plain/.env`; existing variables win. Tool
discovery, list_devices, list_apps, open, unscoped raw/compact snapshots, screenshots and close require no Jev key. Smart classification uses a key. Native parity
must be verified on each target device; protocol tests alone are not real-device validation.
