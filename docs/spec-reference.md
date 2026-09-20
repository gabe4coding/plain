# Spec reference

A spec is one YAML file: a name, a start URL, optional settings, and a list of steps run in order.

Specs are validated with Zod when loaded. Invalid fields report the source file and, for steps,
the zero-based step index. Mapping fields must be objects, and coordinates must be finite numbers.

```yaml
name: login works                        # label in the report
url: https://the-internet.herokuapp.com  # base for relative `goto`
dialogs: accept                          # accept | dismiss, default accept
auth: { user: $BASIC_USER, pass: $BASIC_PASS }
geolocation: { lat: 48.85, lon: 2.35 }
env: { path: /login }
hooks: ./hooks/dataset.mjs
steps:
  - goto: "${env.path}"
  - click: the Login button
```

## Top-level keys

| Key | Meaning |
|---|---|
| `name` | Label in the report. |
| `url` | Start URL. Relative `goto` paths resolve against it. May contain `${env.*}` and `${hooks.*}`. |
| `dialogs` | How `alert`, `confirm` and `prompt` are answered: `accept` (default) or `dismiss`. Each dialog is logged on the step that fired it. |
| `auth` | `{ user, pass }` HTTP credentials for Basic or Digest prompts. |
| `geolocation` | `{ lat, lon }` emulates a GPS position and grants the `geolocation` permission. |
| `env` | Static data for the spec, nested as you like. Used in steps as `${env.*}`. |
| `hooks` | Path, relative to the spec file, of a setup/teardown module. See [hooks.md](hooks.md). |
| `steps` | The steps, run in order. |

**`$VAR` values.** A leaf string starting with `$` in `auth`, `geolocation` or `env` is replaced by
`process.env.VAR` when the spec loads. A missing variable is an error that names it. This is how a
credential stays out of the file.

## Steps

A step is a mapping with one key, the step kind, plus an optional `optional: true`. Every action kind
takes a **target**: a sentence Jev resolves to one element, or `css=<selector>` to skip Jev and use
the selector directly.

### Actions

| Step | Form | Notes |
|---|---|---|
| `goto` | `goto: /path` or a full URL | Relative paths resolve against `url`. |
| `click` | `click: <target>` | May navigate or open a popup. |
| `dblclick`, `rightclick` | `dblclick: <target>` | Same rules as `click`. |
| `fill` | `fill: { target, value }` | Types into the field. |
| `press` | `press: Enter` | A Playwright key name, sent to the focused element. |
| `hover` | `hover: <target>` | Candidates also include `img`, `svg` and `figure`. |
| `select` | `select: { target, value }` | Native `<select>`. Tries the option's label, then its value. |
| `check`, `uncheck` | `check: <target>` | Makes the target selected, or not. Checkboxes and radios (through their label when the input has no size), `role=checkbox|radio|switch|menuitemcheckbox`, and toggle buttons with `aria-pressed`. The state is read first: a no-op when already right, an error when the click did not change it. A chip with no state is a `click`. |
| `upload` | `upload: { target, files: [...] }` | An `input[type=file]`. Paths resolve relative to the spec file. |
| `scroll` | `scroll: <target>`, `top` or `bottom` | `top` and `bottom` (also written `the bottom of the page`) scroll the document and report the distance in `detail`. `did not move` means the content scrolls inside an element: scroll that element instead. Anything else scrolls that element into view. |
| `drag` | `drag: { source, target }` | Both resolved like `click` targets in one Jev request, then dragged with a manual hover, mouse down, hover, mouse up sequence so native HTML5 drag-and-drop works. |
| `mouse` | `mouse: { x, y }` | Moves the mouse to a page position. `y` may be negative, for example to trigger an exit-intent handler above the viewport. |

### Checks

| Step | Form | Notes |
|---|---|---|
| `expect` | `expect: <claim>` | Judged against a snapshot of the settled page. |
| | `expect: [claim, claim]` | Several claims, one snapshot, one Jev request. The step fails if any claim fails, is inconclusive if any is inconclusive and none failed, otherwise passes. |
| | `expect: { that: <claim or list>, within: <target> }` | Judges only that region's accessibility tree (`main`, `dialog`, `form`, `table`, `[role=region]`...). Useful once a page has more than one thing going on. |
| `wait` | `wait: <claim>` | Asks the claim every 1.5 s, up to 8 times, until it holds or the step timeout runs out. |
| | `wait: css=<selector>` | Waits until the selector is visible. |

### `optional: true`

Turns an `inconclusive` or `error` result into `skipped` and the run continues. Use it for things that
may or may not appear, like a cookie banner.

## Outcomes

| Status | Symbol | Meaning |
|---|---|---|
| `pass` | `✔` | |
| `fail` | `✘` | Jev is confident the claim does not hold. |
| `inconclusive` | `?` | Jev is not sure: a pick below the acceptance threshold, or a claim in the grey zone. `detail` lists the top guesses and the path of a JSON dump of what Jev saw. |
| `error` | `✘` | An exception: a timeout, a `css=` target that matched nothing, a navigation failure. |
| `skipped` | `»` | An `optional` step that was inconclusive or errored. |

A run's status is the worst of its steps. The CLI exits 0 only when every spec passed. The thresholds
behind `pass`, `fail` and `inconclusive` are in the [phrasing guide](phrasing.md#how-jev-decides).

## What Jev can see

Jev gets the page's accessibility tree (capped at 60k characters; a larger tree is halved, with a
warning) and, for `expect` and `wait`, a run-level `events` list (the last 30) covering things the tree
never shows:

- dialogs, and how they were answered
- popups and new tabs. A new tab becomes the active page for every following step, with dialog,
  download and error capture attached to it. Closing the browser closes every tab.
- downloads, saved to a fresh per-session directory under `$TMPDIR/plainwright-downloads-*/<suggested filename>`
- uncaught page errors and `console.error` messages

So `expect: a file was downloaded` and `expect: a JavaScript error happened` are answerable.

## Placeholders

`${env.*}` and `${hooks.*}` are replaced in `url` and in every step string (`fill.value`, `click`,
`expect`, ...). An unresolved placeholder, or any other namespace, fails the run before the first step
and names the exact `${...}` text.
