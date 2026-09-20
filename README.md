# jev-e2e

YAML-described browser E2E tests. Playwright drives the browser deterministically;
Jev (an evaluation model via the Vercel AI SDK) only answers two things: which
element a natural-language step means, and whether a natural-language
expectation holds.

Install: `npm i && npx playwright install chromium`. Env: set `TYPESAFE_API_KEY` (TypeSafe direct,
default) or `AI_GATEWAY_API_KEY` (Vercel AI Gateway) — `TYPESAFE_API_KEY` wins when both are set,
or force one with `JEV_PROVIDER=typesafe|gateway`. Either can live in a `.env` file next to where
you run the CLI (copy `.env.example`) instead of the real environment. The model is pinned to a
tested version (`jev-1.13.0` on TypeSafe) rather than following `jev-latest`, since the thresholds
below and this file's phrasing advice were tuned against it. On the TypeSafe path, the SDK's own
client handles request timeouts and retries (429/5xx, honoring `Retry-After`); the Vercel AI
Gateway path keeps its own retry loop since that SDK's backoff can't outlast a rate-limit window.
Run: `npm run build && node dist/cli.js examples/login.yaml [--headless] [--timeout 15000]` — the browser is visible by default; `--headless` hides it.
`dist/` is committed for the plugin — run `npm run build` before committing changes under `src/`.

```yaml
name: login works
url: https://the-internet.herokuapp.com
steps:
  - goto: /login                # absolute, or relative to `url`
  - fill: { target: "the username field", value: "tomsmith" }
  - click: "the login button"
  - press: Enter
  - expect: "the user is logged in and sees a success message"
```

Each step/test ends `pass`, `fail`, or `inconclusive` (Jev unsure) — shown as `✔ ✘ ?`; an exception is `error`, also `✘`.

Escape hatch: `click: "css=#submit"` / `fill.target: "css=..."` skips Jev, uses the selector directly.
`optional: true` on a step turns an inconclusive/error into `skipped` (»), e.g. a cookie banner that may not appear.

More step kinds, all accepting `optional: true` and a `css=` target like `click`/`fill`:
- `hover: <target>` — `dblclick: <target>` / `rightclick: <target>` (both may navigate, like `click`)
- `select: { target, value }` — a native `<select>`; tries the option's label, then its value
- `check: <target>` / `uncheck: <target>` — checkboxes, radios, `[role=checkbox|radio|switch]`
- `upload: { target, files: [...] }` — `input[type=file]`; paths resolve relative to the spec file
- `scroll: <target | "top" | "bottom">` — `top`/`bottom` scroll the window; anything else scrolls that element into view
- `wait: <string>` — `css=...` waits for that selector to be visible; otherwise Jev polls the natural-language
  condition every 1.5s (up to 8 times) until it holds
- `drag: { source, target }` — both resolved like `click` targets, then dragged with a manual
  hover/mouse-down/hover/hover/mouse-up sequence (works with native HTML5 drag-and-drop, unlike `dragTo()` alone)
- `mouse: { x, y }` — moves the mouse to that page position (`y` may be negative, e.g. to trigger an
  exit-intent handler past the viewport's top edge)

`dialogs: accept | dismiss` (top-level, default `accept`) sets how `alert`/`confirm`/`prompt` are handled;
each one fired is logged on the step's detail line. A popup/new tab becomes the active page for every step
after it opens (also logged on the step that opened it, with dialog/download/error capture attached to it
too) — closing the browser closes every tab.

`auth: { user, pass }` (top-level) sends HTTP credentials (`context.httpCredentials`) for Basic/Digest auth
prompts. `geolocation: { lat, lon }` (top-level) emulates a GPS position and grants the `geolocation`
permission. Either value may be `$VAR` to read `process.env.VAR` instead of a literal, so a real credential
never sits in the spec file — an error names the missing var.

File downloads are saved to `$TMPDIR/jev-e2e/downloads/<suggested filename>` and logged on the step that
triggered them. Uncaught page errors (`pageerror`) and `console.error` messages are also logged as they
happen. All of this — dialogs, popups, downloads, page/console errors — is kept as a run-level `events` list
(last 30) and handed to Jev alongside the page state on every `expect`/`wait`, so claims like "a JavaScript
error happened" or "a file was downloaded" are answerable even though neither shows up in the aria snapshot.

`expect` can be scoped: `expect: { that: "<claim>", within: "<target>" }` judges just that region's
ariaSnapshot (`main`, `dialog`, `form`, `table`, `[role=region|dialog|main|tabpanel|list]`, ...) instead of
the whole page — useful once a page has more than one thing going on.

`expect` also takes a list: `expect: [claim, claim]` (or `{ that: [claim, claim], within: ... }`) takes one
page snapshot and one Jev request for all of them, each still judged as its own claim with its own
probability — cheaper than one `expect` per claim when they all read the same state. The step fails if any
claim fails, is inconclusive if any is inconclusive (and none failed), otherwise passes.

Element picks are gated on the model's `confidence` for the chosen option when the backend returns it
(TypeSafe), falling back to the option's probability on the gateway path; detail lines show `p=` (and
`c=` when confidence is available). A `drag` step resolves both its source and target in one such request.

The candidate list Jev picks from also includes the outermost element with a `cursor: pointer` style (React-style
clickable cards), `[tabindex]`/`[contenteditable]`/`summary`/`label`/`[draggable=true]`, `img`/`svg`/`figure`
for `hover`, anything inside an open shadow root, and everything inside same-page iframes (prefixed
`[iframe ...]`). Identical
descriptions get `#1`, `#2`… in DOM order so "the first …" has one answer. Hard ceiling: a Jev Choice takes at
most 255 options, so the list is capped at 254 — real controls first, pointer extras last; past that, use `css=`.
Dense pages whose aria exceeds the model's token limit are halved automatically (a warning says so) — scope with
`within` when precision matters.

Phrasing that Jev answers well (the lever is wording, never the thresholds): give each step **one** answer —
"the earliest day after today", not "an available day" (5 valid options split the probability to ~0.45);
name the sibling to exclude ("the cuisine input, not the where field"); keep `expect` atomic — one claim, not
"restaurant page AND date AND time" (use the list form above for several atomic claims against the same
state); name things the way the accessibility tree does ("a heading with the text
'name: user1'" scored 0.97 where "a caption …" scored 0.86). When a step is `?`, the report lists the top-3 candidates and dumps what
Jev saw to `$TMPDIR/jev-e2e/*.json`; fix the wording against that, then rerun. See `examples/thefork-identita-golose.yaml`.
`npm run example` runs 3 specs; `login-fails.yaml` is meant to fail, so its exit code 1 is expected.

## Setup and teardown

`env` (top-level mapping) holds static data for the spec — arbitrarily nested, e.g. `env: { path: /login, user: { name: tomsmith } }`.
A leaf string starting with `$` is an OS-environment reference, resolved like `auth`/`geolocation`'s `$VAR` (from the
real environment, `~/.claude/settings.json`'s `env`, a shell profile, wherever the process got it) — never a literal credential.

`hooks` (top-level string, a path relative to the spec file) points at an ES module with two optional exports:

```yaml
env:
  path: /login
hooks: ./hooks/login-dataset.mjs
steps:
  - goto: "${env.path}"
  - fill: { target: the username textbox, value: "${hooks.user.name}" }
  - fill: { target: the password textbox, value: "${hooks.user.pass}" }
  - click: the Login button
  - expect: a heading with the text "Secure Area" is shown
```

- `setup({ spec, page })` runs once, before the first step, and may return an object (or nothing). What it returns
  becomes `${hooks.*}` in every step's strings and the `url`, and is handed to `teardown` as `data`.
- `teardown({ spec, page, data, result })` always runs after a successful `setup` — whether the steps passed,
  failed, or errored — so cleanup (releasing a leased row, closing a ticket) isn't skipped on failure. `result` is
  `{ status, steps }` for the run so far.

Where the dataset itself comes from — a checked-in file (as in the example above), a remote test-data service, a
database lease — is entirely up to the hooks module; jev-e2e only calls `setup`/`teardown` and passes data through.

`${env.*}`/`${hooks.*}` placeholders work in `url` and any step string (`fill.value`, `click`, `expect`, ...).
Failure semantics: a `setup` error skips every step and `teardown` (nothing was leased, so there's nothing to
release) — the run is `error` with a single `setup` step. A `teardown` error always makes the run `error`, even if
every step passed. An unresolved placeholder fails the run before the first step, listing the exact `${...}` text.

See `examples/login-dataset.yaml`, `examples/hooks/login-dataset.mjs` and `examples/fixtures/users.json`.

## Agent mode (MCP)

`node dist/cli.js mcp [--headless] [--timeout <ms>]` serves the same engine as an MCP server over stdio, so an
agent can drive **one persistent browser session** step by step instead of writing a spec up front. Jev still does
every pick and every judgment, so the agent never has to read the accessibility tree itself (5–20k tokens per page)
— it sends one sentence per step and gets one line back. Register it in Claude Code from the repo directory
(the CLI reads `.env` from its cwd):

```
claude mcp add jev-e2e -- node /path/to/jev-e2e/dist/cli.js --headless mcp
```

Tools: `open {url}` starts the browser (first call) or navigates; `step {step}` runs one YAML-shaped step
(`{click: "the Login button"}`, `{fill: {target, value}}`, `{expect: [...]}`, …, same vocabulary and phrasing rules
as above, returned with `status`, `detail`, `notes`, `url`, `jevTokens`); `find {kind, target}` is a dry run of a
pick; `snapshot {maxChars}` returns the aria tree as an escape hatch when rephrasing does not help; `save {path,
name}` writes everything run so far as a spec the batch runner replays. Rejected picks come back `inconclusive`
with the top guesses in `detail`, so the agent can rephrase and retry.

`open` also takes an optional `hooks` path (relative to the server's working directory), the same setup/teardown
module a spec's `hooks` key points at. Setup runs before the navigation, so it can set cookies or lease dataset
rows first; its result is available to every `step`/`find` as `${hooks.*}`, listed by path (never by value) in
`open`'s response. `save` keeps the placeholders as written and writes `hooks:` as a path relative to the saved
file, so the resulting spec stays dataset-driven. Teardown runs when the session ends, or right away if `open` is
called again with a new `hooks` module.

### Install as a Claude Code plugin

This repo is also a Claude Code plugin: it ships the MCP server (root `.mcp.json`) and the
`authoring-jev-e2e-specs` skill. The built CLI is committed, and on first start the plugin installs its own npm
dependencies and Chromium (progress on stderr). That first MCP connection can take a minute or two; if it times
out, `/mcp` reconnects once the install is done.

The API key must reach the MCP server: export `TYPESAFE_API_KEY` (or `AI_GATEWAY_API_KEY`) in your shell profile,
put it in the `env` block of `~/.claude/settings.json`, or write it to `~/.config/jev-e2e/.env`, which every mode
reads after the current directory's `.env` (variables already set in the environment win). Without a key the MCP
server still starts, and the first `step` or `find` returns the missing-key message as a tool error.

Install with `/plugin marketplace add /path/to/jev-e2e` then `/plugin install jev-e2e@jev-e2e-marketplace` (a
git URL works the same once the repo has a remote). To try a clone without installing, run
`claude --plugin-dir /path/to/jev-e2e` from any directory other than the clone itself: inside the clone, Claude
Code also loads the same `.mcp.json` as a project server, where `${CLAUDE_PLUGIN_ROOT}` is undefined, and that
duplicate fails. If you registered the server by hand with `claude mcp add jev-e2e …`, remove it: a manual
server with the same name silently replaces the plugin's.

### Install as a Codex plugin

The same clone is a Codex plugin in the [Agent Plugins](https://agent-plugins.org) portable format: root
`plugin.json`, `mcp.json` (the same launcher, started with `cwd` set to the plugin root) and the marketplace
file `.agents/plugins/marketplace.json`. Skills are picked up from `skills/` by both clients. `AGENTS.md` is a
symlink to `CLAUDE.md`, so Codex reads the same repo guidance.

Install with `codex plugin marketplace add /path/to/jev-e2e` then `codex plugin add jev-e2e@jev-e2e-marketplace`
(`<owner>/<repo>` works the same once the repo has a remote). Codex copies the whole clone, untracked files
included, into `~/.codex/plugins/cache/`, so remove any `.env` from the clone first or install from a git source.
Codex does not pass your shell environment to plugin MCP servers (checked with codex-cli 0.154: the server gets only
`PLUGIN_ROOT` and `PLUGIN_DATA`, and the `env`/`env_vars` overrides in `config.toml` had no effect), so put the key
in `~/.config/jev-e2e/.env` and start a new Codex session. Plugin tools need approval; in a non-interactive run
(`codex exec`) pass `--approve-for-me`, or every call fails with "approval policy is never". Uninstall with
`codex plugin remove jev-e2e@jev-e2e-marketplace`, then `codex plugin marketplace remove jev-e2e-marketplace`.
