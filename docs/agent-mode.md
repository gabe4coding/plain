# Agent mode

For native desktop applications, use the separate [plainwright-computer plugin](computer-use.md).
The browser server and its tool names below are unchanged.

`plainwright mcp` serves the engine as an [MCP](https://modelcontextprotocol.io) server over stdio with
one persistent browser session. An agent explores a flow one sentence at a time, then saves it as a
spec that the batch runner replays. Jev still makes every pick and every judgment, so the agent never
reads the accessibility tree (5 to 20k tokens per page) unless it asks for a piece of it: one sentence
in, one line out.

```sh
node bin/plainwright.mjs [--headless] [--timeout <ms>] mcp
```

## Tools

JSON tool results are available in MCP `structuredContent`, with the existing serialized JSON
also kept in `content` text blocks for older clients. Prefer `structuredContent` when available.
MCP tool errors use `isError: true` and a text message; action outcomes (including
`status: "error"`) remain structured results.

| Tool | Arguments | What it does |
|---|---|---|
| `open` | `url`, optional `hooks`, `headed`, `goal` | Starts the browser (first call) or navigates. `goal` is what the whole flow is for, in one sentence (`read the discussion about F-Droid 2.0`): every later pick sees it, so a vague target such as `the comments link` picks the element the flow is about, while the target's words still win when they disagree. Claims never see it. It is kept until an `open` passes another goal, and `save` writes it into the spec ([pick benchmark](benchmarks/picks.md)). `headed: true` shows the window, `false` hides it; the default is the server's `--headless` flag, and changing it later relaunches the browser (session cookies are lost; ignored with `--cdp`). `hooks` is a setup/teardown module path, relative to the server's working directory. Setup runs before the navigation and its result is available as `${hooks.*}`, listed by path (never by value) in the response. Teardown runs when the session ends, or right away when `open` is called again with a new `hooks`. |
| `step` | `step` | Runs one YAML-shaped step: `{click: "the Login button"}`, `{fill: {target, value}}`, `{expect: [...]}`, any kind from the [spec reference](spec-reference.md). Returns `status`, `detail`, `notes`, `url`, `jevTokens` and `changed` (see below). |
| `batch` | `steps` | Runs 1–16 known step objects sequentially with fresh target resolution for each action. Validates every step and hook placeholder before acting; stops on the first non-pass, including `skipped`. Returns indexed `results`, `status`, `completed`, `remaining`, zero-based `stoppedAt` (or `null`), final `url`, total `jevTokens` and `changed` for the whole batch. |
| `find` | `kind`, `target` | Dry run of a pick: what Jev would choose, without acting. `kind` is `click`, `hover`, `fill`, `select`, `check`, `upload` or `region`. |
| `snapshot` | optional `within`, `maxChars`, `mode`, `intent` | Raw accessibility tree by default; `compact` selects exact excerpts and `smart` adds Jev classifications. `intent` is smart-only. Scope with `within` (`the results list`, `css=main`) to read data. See [snapshot views](snapshots.md). |
| `ask` | `claims`, optional `within` | Yes/no questions about the page, without acting: 1–16 claims in one Jev call, each answered `yes` (p ≥ 0.9), `no` (p ≤ 0.1) or `unsure`, with its `p`. Not recorded by `save` and never changes the session status (use an `expect` step for a test assertion). `within` scopes it to a region (`css=` works). Use it to test hypotheses when a step fails or comes back inconclusive. |
| `read` | `question`, optional `within` | Reads data: answers the question with the exact accessibility-tree lines that hold the answer, copied verbatim (`answer`), plus their ancestors (`context`) and `confidence`. Jev picks the first and last line; it never writes text. `found: false` with `guesses` when no line answers. `within` scopes it to a region (`css=` works) and costs fewer Jev tokens. Not recorded. |
| `evaluate` | `js` | Runs a JavaScript expression in the page and returns its JSON value. The raw way to pull data once the flow got there. |
| `save` | `path`, optional `name` | Writes everything run so far as a spec, with the session's `goal`. Only steps that passed are kept. `${hooks.*}` placeholders stay as written and `hooks:` is written relative to the saved file. |

`changed` is what the action did to the page, so the agent can read the outcome without a `snapshot` or
`ask`: `title` and `url` when they changed, `added` (the new accessibility-tree lines in page order, up to
1,500 characters; `addedOmitted` counts the rest) and `removed` (how many lines are gone). After a navigation
`added` is the top of the new page. It costs one settle and one tree read after the action and no Jev call.
Measured with a Sonnet agent on six tasks: tool calls -30%, agent cost -20%, same answers
([agent benchmark](benchmarks/agent-changes.md)). `PLAINWRIGHT_CHANGES=0` turns it off. `PLAINWRIGHT_READ=0` hides `read`.

A rejected pick comes back `inconclusive` with the top guesses in `detail`, so the agent rephrases and
retries. `${env.*}` is not available in a session, only `${hooks.*}`.
As in YAML replay, `optional: true` converts an inconclusive result or runtime error to `skipped`;
it does not suppress a failed expectation. Skipped actions are not recorded.

## Batching known actions

Use `batch` when the next actions and values are already known, for example filling a form and
submitting it. Each entry uses the same shape as `step`:

```json
{"steps":[
  {"fill":{"target":"the Full name field","value":"Alex Morgan"}},
  {"fill":{"target":"the Email field","value":"alex@example.test"}},
  {"click":"the Save contact button"}
]}
```

Actions run in order; each uses the current page and resolves its own target through Jev.
`batch` reduces agent round trips, not the number of Jev decisions per action. End the batch
when the next action depends on discovering or reading new information, then inspect the result.
Passing actions are recorded individually, so `save` writes ordinary replayable YAML steps with
hook placeholders preserved. There is no new YAML step kind.

All syntax and placeholders are validated before any action. Runtime failures may leave a passing
prefix applied; there is no rollback. A non-pass (`fail`, `inconclusive`, `error`, or `skipped`)
stops execution, and later entries are not attempted. `completed` counts passing entries;
`remaining` counts unattempted entries. Each result includes its zero-based index, status, detail,
URL, notes and Jev token usage. Inspect these before deciding how to recover. Browser tools share
a queue, so snapshots, navigation, saves and other actions cannot interleave with a running batch.
Canceling a batch prevents later entries from starting; an action already in flight may finish.

## Reading data

Steps act; three tools read. `read` answers a question with the page's own lines:

```
read { question: 'the titles and prices of the first three books' }
→ { found: true, answer: '- heading "A Light in the ..." ...\n- paragraph: £51.77 ...', context: [...], confidence: 0.97 }
```

Code numbers the lines that carry text (not `/url:` lines, bare containers, or a line repeating its parent's
text), Jev picks the first and the last line of the answer in one request, and the lines in between are copied.
The answer is always page text. Each offered line costs Jev ~22 tokens per question, so a whole large page costs
20–50k Jev tokens and a region (`within`) a few thousand; results in `docs/benchmarks/read.md`.

`snapshot` with `within` returns the accessibility tree of one region, so a
results table arrives as rows and cells instead of the whole page. `evaluate` runs a JavaScript
expression in the page and returns its value as JSON, for when the data should arrive already shaped:

```
evaluate { js: '[...document.querySelectorAll("article")].map(a => a.querySelector("h3").innerText)' }
```

None is a step: `save` does not record them and a spec has no equivalent. They are for the agent's own
reading, after plainwright's steps got the page there.

The plugin's skill, `plugins/plainwright/skills/using-plainwright/`, teaches the agent the [phrasing rules](phrasing.md) in
`SKILL.md`, then one of two workflows: `browsing.md` to do or read something on a site (nothing is saved),
`authoring.md` to save, edit and replay a spec.

## Your real browser

By default every session is a fresh Chromium with an empty profile: no cookies, no logins. Three flags
change that. They work for the CLI and for `mcp`, and as `PLAINWRIGHT_PROFILE`, `PLAINWRIGHT_CHANNEL`
and `PLAINWRIGHT_CDP` in `~/.config/plainwright/.env` for a plugin install, whose arguments you cannot
change. None of them has a default: without them every run gets the bundled Chromium and a throwaway
profile, which keeps tests independent of each other. A leading `~` in the profile path is expanded.

**`--profile <dir>`: a browser that remembers.** The browser is launched with a persistent user-data
directory. Log in once, and the next session is still logged in. Use a directory plainwright owns,
such as `~/.plainwright`. Copying your Google Chrome profile there does not carry your cookies over,
since Chrome encrypts them per application.

**`--channel chrome`: your installed Google Chrome instead of the bundled Chromium.** Combined with
`--profile`, this is the recommended way to a signed-in browser that plainwright starts and stops
itself:

```sh
node bin/plainwright.mjs --profile ~/.plainwright-chrome --channel chrome mcp
```

The first time, sign in to your Google account in that window and turn on sync: passwords and
extensions arrive, then log in to the sites you need once. From then on every run is signed in.
Other channels work too (`chrome-beta`, `msedge`); the browser must be installed.

**`--cdp <url>`: the Chrome you are looking at.** plainwright attaches to a running Chrome over the
DevTools protocol, opens its own tab there and drives it with your live sessions, extensions and
saved passwords. Start Chrome with a debugging port first:

```sh
# macOS; on Linux the binary is google-chrome
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.plainwright-chrome"
node bin/plainwright.mjs --cdp http://127.0.0.1:9222 mcp
```

Chrome 136 and later refuses remote debugging on your default profile directory, hence the separate
`--user-data-dir`. That Chrome is a real Chrome with its own profile, so it starts signed out. Sign in
to your Google account there and turn on sync to bring passwords and extensions over, then log in to
the sites you need once. The profile dir keeps it all. Rules of the attached mode:

- plainwright works in a tab it opens and closes that tab when the session ends. Disconnecting never
  closes your Chrome.
- `auth` and `geolocation` in a spec are rejected: they configure a new browser context, and the point
  here is to reuse yours.
- When `--cdp` is given, `--profile` and `--channel` are ignored. There is nothing to launch.
- Anything the agent does happens in your real accounts. Read the [rules](../README.md#rules) again.

## The API key

The server reads `TYPESAFE_API_KEY` (or `AI_GATEWAY_API_KEY`) from, in order: the process environment,
a `.env` in its working directory, `~/.config/plainwright/.env`. A value already set is never overridden.
`~/.config/plainwright/.env` is the one place that works for the CLI and for both plugin hosts, because
Codex passes plugin servers no shell environment at all.

Without a key the server still starts. The first `step` or `find` returns the missing-key message as a
tool error, where the agent can read it.

## Claude Code

```
/plugin marketplace add gabe4coding/plainwright
/plugin install plainwright@plainwright-marketplace
```

A local clone path works in place of `gabe4coding/plainwright`. The plugin lives in `plugins/plainwright/` and ships its MCP configurations, skill, and generated
shared runtime archive. On first start it installs its own npm dependencies and
Chromium, with progress on stderr. That first connection can take a minute or two; if it times out,
`/mcp` reconnects once the install is done.

Key alternatives: export it in your shell profile, or put it in the `env` block of
`~/.claude/settings.json`.

Pitfalls:

- To try the browser plugin from a clone without installing it, run
  `claude --plugin-dir /path/to/plainwright/plugins/plainwright`. The repository root holds the
  shared npm package and marketplaces; plugin manifests live in `plugins/plainwright/`,
  `plugins/plainwright-computer/`, and `plugins/plainwright-mobile/`.
- A server registered by hand with `claude mcp add plainwright ...` silently replaces the plugin's server
  of the same name. Remove it.

Without the plugin, register the server directly:

```sh
claude mcp add plainwright -- node /path/to/plainwright/bin/plainwright.mjs --headless mcp
```

## Codex

The same clone is a Codex plugin in the [Agent Plugins](https://agent-plugins.org) portable format:
`plugins/plainwright/plugin.json`, `plugins/plainwright/mcp.json` and the root `.agents/plugins/marketplace.json`. Skills are picked up from each plugin’s `skills/` directory. `AGENTS.md` is a symlink to `CLAUDE.md`, so Codex reads the same repo guidance.

```sh
codex plugin marketplace add gabe4coding/plainwright   # or a local clone path
codex plugin add plainwright@plainwright-marketplace
```

Then put the key in `~/.config/plainwright/.env` and start a new Codex session.

Pitfalls, checked with codex-cli 0.154:

- Codex installs the selected plugin directory into `~/.codex/plugins/cache/`. Keep `.env` files
  and `.runtime/` development caches out of plugin distribution directories. The generated archive
  contains only the package manifest/shrinkwrap, compiled runtime, CLI launchers and license.
- Plugin MCP servers get only `PLUGIN_ROOT` and `PLUGIN_DATA` in their environment. The `env` and
  `env_vars` overrides in `config.toml` had no effect. `~/.config/plainwright/.env` is the way in.
- Plugin tools need approval. In a non-interactive run (`codex exec`) pass `--approve-for-me`, or every
  call fails with "approval policy is never".

Uninstall:

```sh
codex plugin remove plainwright@plainwright-marketplace
codex plugin marketplace remove plainwright-marketplace
```
