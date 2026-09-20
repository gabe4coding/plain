<p align="center">
  <img src="docs/banner.jpg" alt="plainwright: end-to-end browser tests written in plain English. A YAML step, click: the login button, goes through a semantic decision model that reads the page's accessibility tree and clicks the Login button." width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node 22 or newer">
  <img src="https://img.shields.io/badge/browser-Playwright-45ba4b.svg" alt="Driven by Playwright">
</p>

End-to-end browser tests written in plain English.

```yaml
name: login works
url: https://the-internet.herokuapp.com
steps:
  - goto: /login
  - fill: { target: the username field, value: tomsmith }
  - fill: { target: the password field, value: SuperSecretPassword! }
  - click: the login button
  - expect: a heading with the text "Secure Area" is shown
```

No selectors. [Playwright](https://playwright.dev) drives the browser; [Jev](https://typesafe.ai), a
small decision model, answers two questions per step: *which element does this sentence mean?* and
*does this claim hold on the current page?* It reads the page's accessibility tree, not screenshots.

The same engine runs as an MCP server, so a coding agent (Claude Code, Codex) can drive a real browser
one sentence at a time and save the session as a replayable spec.

## Quick start

Requirements: Node 22+, a [TypeSafe](https://typesafe.ai) API key.

```sh
git clone https://github.com/gabe4coding/plainwright.git && cd plainwright
mkdir -p ~/.config/plainwright && echo 'TYPESAFE_API_KEY=<your key>' > ~/.config/plainwright/.env
node bin/plainwright.mjs examples/todo.yaml
```

The first run installs npm dependencies and Chromium, then opens a visible browser and prints one line
per step:

```
plainwright: Jev via typesafe (jev-1.13.0)
✔ add a todo  (2 Jev calls, 1059 tokens)
  ✔ goto /
  ✔ fill "the new todo input" → input placeholder="What needs to be done?" (p=0.99 c=0.98)
  ✔ press Enter
  ✔ expect "a todo item named 'buy milk' is listed" p=0.99 @ https://demo.playwright.dev/todomvc/#/
```

`✔` pass, `✘` fail or error, `?` inconclusive (Jev was not sure), `»` skipped (an `optional` step that
did not land). The exit code is 0 only when every spec passes.

```sh
node bin/plainwright.mjs --headless spec.yaml other.yaml   # hide the browser, run several specs
node bin/plainwright.mjs --timeout 30000 spec.yaml         # per-action timeout in ms, default 15000
node bin/plainwright.mjs --timing spec.yaml                # print per-step/spec/run phase timings (settle, jev, action, ...)
node bin/plainwright.mjs --workers 4 a.yaml b.yaml c.yaml  # run several specs concurrently, up to 4 at a time
node bin/plainwright.mjs --profile ~/.plainwright spec.yaml   # persistent profile: log in once, stay logged in
node bin/plainwright.mjs --profile ~/.plainwright --channel chrome spec.yaml   # same, in your installed Google Chrome
node bin/plainwright.mjs --cdp http://127.0.0.1:9222 spec.yaml   # drive a Chrome you already have open
```

See [your real browser](docs/agent-mode.md#your-real-browser) for what each one gives you.

`--workers` needs the default launch mode (no `--profile`, no `--cdp`): each spec then gets its own
browser context and its own empty downloads directory, so concurrent specs never see each other's files.

## Configuration

| Variable | Meaning |
|---|---|
| `TYPESAFE_API_KEY` | TypeSafe direct, the default backend. |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway instead. `TYPESAFE_API_KEY` wins when both are set. |
| `JEV_PROVIDER` | `typesafe` or `gateway`, to force a backend. |
| `PLAINWRIGHT_PROFILE` | Same as `--profile`. |
| `PLAINWRIGHT_CDP` | Same as `--cdp`. |
| `PLAINWRIGHT_CHANNEL` | Same as `--channel`. The three are read so a plugin install, whose arguments are fixed, can be pointed at your browser. |

Read from the shell environment, then a `.env` in the current directory (see `.env.example`), then
`~/.config/plainwright/.env`.
A variable already set is never overridden. The model is pinned to a tested version (`jev-1.13.0` on
TypeSafe) rather than following `jev-latest`, because the decision thresholds and the phrasing advice
were tuned against it.

## Write a spec

Every step is one action or one check, described the way the page's accessibility tree names things:
a role and its visible text.

```yaml
- click: the Login button
- fill: { target: the "Where from?" combobox (not the "Where to?" one), value: Paris }
- select: { target: the dropdown list, value: Option 2 }
- check: the first checkbox, not the second
- wait: a heading with the text "Top departing flights" is shown
- expect:
    - the "Departure" textbox shows Tue, Dec 15
    - the "Return" textbox shows Tue, Dec 22
- click: the Accept all button      # a cookie banner that may not appear
  optional: true
- click: css=[role=dialog] button[aria-label^="Done."]   # escape hatch: plain selector, no Jev
```

- [Spec reference](docs/spec-reference.md): every step kind and top-level key (`dialogs`, `auth`,
  `geolocation`, `env`, `hooks`).
- [Phrasing guide](docs/phrasing.md): how Jev decides, how to word a target or a claim so it gets one
  clear answer, and what to do when a step comes back `?`.
- [Setup and teardown hooks](docs/hooks.md): lease test data before a run, release it after, and use it
  in steps as `${hooks.*}`.

`examples/` holds specs against public demo sites. `examples/login-fails.yaml` is meant to fail.

## Let an agent drive the browser

`plainwright mcp` serves the engine as an MCP server with one persistent browser session and six tools:
`open`, `step`, `find`, `snapshot`, `evaluate`, `save`. The agent never reads the accessibility tree; it sends one
sentence and gets one line back, then saves the flow as a spec.

Install as a plugin (the plugin also ships a skill that teaches the agent the phrasing rules):

```sh
# Claude Code
/plugin marketplace add gabe4coding/plainwright
/plugin install plainwright@plainwright-marketplace

# Codex
codex plugin marketplace add gabe4coding/plainwright
codex plugin add plainwright@plainwright-marketplace
```

Both read the key from `~/.config/plainwright/.env`. Details, alternatives and known pitfalls are in
[docs/agent-mode.md](docs/agent-mode.md).

## Rules

- Test environments only. Stop before the last irreversible step: payment, booking, sending.
- No literal credentials in a spec. Put `$VAR` references in the `env` block and use `${env.*}` in steps.
- Never use it to bypass bot protection.

## Develop

```sh
npm install && npx playwright install chromium
npm test          # build + node --test, no API key needed
npm run build     # src/ → dist/; dist/ is committed because the plugins run it directly
```

`CLAUDE.md` describes the code layout.

## License

[MIT](LICENSE)
