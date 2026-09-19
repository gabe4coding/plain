# jev-e2e

YAML-described browser E2E tests. Playwright drives the browser deterministically;
Jev (an evaluation model via the Vercel AI SDK) only answers two things: which
element a natural-language step means, and whether a natural-language
expectation holds.

Install: `npm i && npx playwright install chromium`. Env: set `TYPESAFE_API_KEY` (TypeSafe direct,
default) or `AI_GATEWAY_API_KEY` (Vercel AI Gateway) — `TYPESAFE_API_KEY` wins when both are set,
or force one with `JEV_PROVIDER=typesafe|gateway`. Either can live in a `.env` file next to where
you run the CLI (copy `.env.example`) instead of the real environment.
Run: `npm run build && node dist/cli.js examples/login.yaml [--headless] [--timeout 15000]` — the browser is visible by default; `--headless` hides it.

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
"restaurant page AND date AND time"; name things the way the accessibility tree does ("a heading with the text
'name: user1'" scored 0.97 where "a caption …" scored 0.86). When a step is `?`, the report lists the top-3 candidates and dumps what
Jev saw to `$TMPDIR/jev-e2e/*.json`; fix the wording against that, then rerun. See `examples/thefork-identita-golose.yaml`.
`npm run example` runs 3 specs; `login-fails.yaml` is meant to fail, so its exit code 1 is expected.
