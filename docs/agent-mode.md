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

## The API key

The server reads `TYPESAFE_API_KEY` (or `AI_GATEWAY_API_KEY`) from, in order: the process environment,
a `.env` in its working directory, `~/.config/plainwright/.env`. A value already set is never overridden.
`~/.config/plainwright/.env` is the one place that works for the CLI and for both plugin hosts, because
Codex passes plugin servers no shell environment at all.

Without a key the server still starts. The first `step` or `find` returns the missing-key message as a
tool error, where the agent can read it.

## Claude Code

```
/plugin marketplace add /path/to/plainwright
/plugin install plainwright@plainwright-marketplace
```

A git URL works the same once the repo has a remote. The plugin ships the MCP server (root
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
codex plugin marketplace add /path/to/plainwright     # or <owner>/<repo> once the repo has a remote
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
