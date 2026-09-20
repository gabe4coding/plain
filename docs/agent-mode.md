# Agent mode

`plainwright mcp` serves the engine as an [MCP](https://modelcontextprotocol.io) server over stdio with
one persistent browser session. An agent explores a flow one sentence at a time, then saves it as a
spec that the batch runner replays. Jev still makes every pick and every judgment, so the agent never
reads the accessibility tree (5 to 20k tokens per page): one sentence in, one line out.

```sh
node bin/plainwright.mjs [--headless] [--timeout <ms>] mcp
```

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `open` | `url`, optional `hooks` | Starts the browser (first call) or navigates. `hooks` is a setup/teardown module path, relative to the server's working directory. Setup runs before the navigation and its result is available as `${hooks.*}`, listed by path (never by value) in the response. Teardown runs when the session ends, or right away when `open` is called again with a new `hooks`. |
| `step` | `step` | Runs one YAML-shaped step: `{click: "the Login button"}`, `{fill: {target, value}}`, `{expect: [...]}`, any kind from the [spec reference](spec-reference.md). Returns `status`, `detail`, `notes`, `url` and `jevTokens`. |
| `find` | `kind`, `target` | Dry run of a pick: what Jev would choose, without acting. `kind` is `click`, `hover`, `fill`, `select`, `check`, `upload` or `region`. |
| `snapshot` | optional `maxChars` | The accessibility tree. An escape hatch for when rephrasing does not help. |
| `save` | `path`, optional `name` | Writes everything run so far as a spec. Only steps that passed are kept. `${hooks.*}` placeholders stay as written and `hooks:` is written relative to the saved file. |

A rejected pick comes back `inconclusive` with the top guesses in `detail`, so the agent rephrases and
retries. `${env.*}` is not available in a session, only `${hooks.*}`.

The plugin's skill, `skills/authoring-plainwright-specs/SKILL.md`, teaches the agent the workflow and the
[phrasing rules](phrasing.md).

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

A local clone path works in place of `gabe4coding/plainwright`. The plugin ships the MCP server (root
`.mcp.json`), the skill and the built CLI. On first start it installs its own npm dependencies and
Chromium, with progress on stderr. That first connection can take a minute or two; if it times out,
`/mcp` reconnects once the install is done.

Key alternatives: export it in your shell profile, or put it in the `env` block of
`~/.claude/settings.json`.

Pitfalls:

- To try a clone without installing, run `claude --plugin-dir /path/to/plainwright` from any directory
  other than the clone itself. Inside the clone, Claude Code also loads the repo's `.mcp.json` as a
  project server, where `${CLAUDE_PLUGIN_ROOT}` is undefined, and that duplicate fails.
- A server registered by hand with `claude mcp add plainwright ...` silently replaces the plugin's server
  of the same name. Remove it.

Without the plugin, register the server directly:

```sh
claude mcp add plainwright -- node /path/to/plainwright/bin/plainwright.mjs --headless mcp
```

## Codex

The same clone is a Codex plugin in the [Agent Plugins](https://agent-plugins.org) portable format:
root `plugin.json`, `mcp.json` and `.agents/plugins/marketplace.json`. Skills are picked up from
`skills/`. `AGENTS.md` is a symlink to `CLAUDE.md`, so Codex reads the same repo guidance.

```sh
codex plugin marketplace add gabe4coding/plainwright   # or a local clone path
codex plugin add plainwright@plainwright-marketplace
```

Then put the key in `~/.config/plainwright/.env` and start a new Codex session.

Pitfalls, checked with codex-cli 0.154:

- Codex copies the whole clone, untracked files included, into `~/.codex/plugins/cache/`. Remove any
  `.env` from the clone first, or install from a git source.
- Plugin MCP servers get only `PLUGIN_ROOT` and `PLUGIN_DATA` in their environment. The `env` and
  `env_vars` overrides in `config.toml` had no effect. `~/.config/plainwright/.env` is the way in.
- Plugin tools need approval. In a non-interactive run (`codex exec`) pass `--approve-for-me`, or every
  call fails with "approval policy is never".

Uninstall:

```sh
codex plugin remove plainwright@plainwright-marketplace
codex plugin marketplace remove plainwright-marketplace
```
