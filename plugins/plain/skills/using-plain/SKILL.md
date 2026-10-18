---
name: using-plain
description: Use when driving a website through the plain MCP tools (open, step, batch, find, snapshot, ask, read, evaluate, save) — for a browser task, for reading data off a page, or for writing, debugging or replaying a plain YAML end-to-end test — including when a step comes back inconclusive.
---

# Using plain

## Overview

These files name the tools by their short names (`open`, `step`, `batch`). Call each tool by the full name
your tool list gives it, server prefix included (`mcp__<server>__batch`, never a bare `batch`).

A tool error (`isError: true` with a text message) means the call itself failed. A step that ran and
failed is a normal result with `status: "error"`.

Playwright acts, the Jev model decides: it picks the element your words describe and judges whether your
claim holds against the page's accessibility tree. You never see the page. You write words Jev can answer
with one clear yes. The lever is wording, not thresholds.

In Claude Code the plugin also draws a session pane (`/plain-pane`) with each step's status and Jev tokens; it does not change any tool result.

## Two modes, pick one first

**REQUIRED: before the first tool call, Read the file for your mode** (it sits next to this file):

- The user wants something **done or read** on a site (search, compare, extract, check a page):
  `browsing.md`. Nothing is saved in this mode.
- The user wants a **test**: a spec, a regression check, or a saved spec fails on replay:
  `authoring.md`.

The rules below apply to both.

## How outcomes are decided

- A pick is accepted when Jev's confidence is ≥ 0.5 and the answer is not `none`. Otherwise the step is
  `inconclusive` and `detail` lists the top guesses with their probabilities.
- Picks below 0.9 confidence (probability fallback) are recorded as marginal: no-judge replays them, auto-healing asks Jev again next run.
- A claim passes at p ≥ 0.9, fails at p ≤ 0.1, and is `inconclusive` in between. `optional: true` turns an
  inconclusive or error step into `skipped`.
- `ask {claims, within?}` judges 1–16 claims in one Jev call without acting or recording: each is `yes`
  (p ≥ 0.9), `no` (p ≤ 0.1) or `unsure`. When a step fails or is inconclusive, ask one claim per possible
  cause ("An error message is shown", "The Submit button is disabled", "A cookie banner covers the form")
  before reading a snapshot. It cannot explain in free text. Use `expect` only for assertions that belong
  in the test: `ask` never changes the session status and `save` never records it.
  To get a sure answer instead of `unsure`:
  - Name the exact thing: its text, role and place. Jev also sees the page's own console errors (not ads' or
    blocked resources', which notes only count), dialogs and downloads,
    so "An error message is shown" is unsure on a page with a console error, or whose instructions mention
    errors. "The form shows a message saying the username is invalid" gets a clear `no`.
  - Empty text fields are marked `[empty]` and read-only ones `[readonly]`, so "The Password textbox is
    empty" gets a sure answer.
  - Scope with `within` to cut noise; `css=` regions never miss, but must
    match exactly one element (several matches return `found: false` with the count). Ask "The browser console reported an
    error" on its own when console errors matter.
  - Use explicit spatial relations: "the button B is left of the button A". Browser targets and claims that
    need layout get rendered bounds in main viewport coordinates, including iframe controls and plain boxes
    with text. "First" alone does not distinguish list order from visual order; say "leftmost" or "topmost".
    Spatial picks also get reference geometry: "the field immediately below the Shipping heading" can refer
    to a heading outside the fill candidates. Reference captures and spatial claims collect at most 254 elements.
    If claim layout is truncated, scope with `within`.
    Bounds do not prove color or image appearance. `snapshot` still returns the accessibility tree.
    Specs and MCP batches classify their known targets and claims together in one request. Plain English
    prompts without a word that can name a position or a size, such as left, below, first, next or larger,
    are semantic, and a lowercase relation word ("left of", "below") is spatial, without a request.
    Repeated prompt groups reuse the classification; new interactive prompts need another request.
    A request over the model limit splits into smaller requests.
  - `unsure` is not evidence either way: rephrase or split, as for `expect`.
- Rejected picks and non-passing claims dump the exact state Jev saw to `$TMPDIR/plain/*.json`; the path
  is in `detail`.

## Reading a value

`read {question, within?}` is the way to get data off the page: it returns the exact lines that answer the
question, copied verbatim, never written by the model. Use it before `snapshot` or `evaluate`, and read
`changed` first after a step: it often holds the answer already. `evaluate` is for many rows as JSON; a
`snapshot` is for seeing structure while debugging, not for reading values.

A link target that ends in `…` was over 200 characters (ad and tracking links) and is cut in every tree you
get: `snapshot`, `read`, `changed`. To follow it, click the link by its text; for the full URL, `evaluate`
its `href`.

## Writing a target (click, fill, hover, select, check, scroll)

One element, one true answer, named the way the accessibility tree names it: role, visible text, and what
sets it apart from its siblings. The `goal` given to `open` (or a spec's `goal:`) settles a target that still
fits several elements toward the one the flow is about; it never overrides the target's words.

- `the Login button`, `the username textbox`, `the edit link in the 5th table row`
- `the cuisine search input (not the location field)`
- `the Edit button for Account 32`: browser candidates retain bounded surrounding row/card context,
  including headings and visible text. Duplicate-button ordinals still work. Context is rebuilt per
  action, but can be omitted or truncated in deeply nested or unlabeled layouts.
- `the earliest available day`, never `an available day`: several valid answers split the probability
- `check` and `uncheck` mean "make it selected, or not". They work on checkboxes, radios, switches, and filter
  chips or toggle buttons that expose their state, and do nothing when the state is already right. A chip with
  no state to read is a `click`.
- `scroll: bottom` and `scroll: top` scroll the page and report the distance in `detail`. `did not move` means
  the content scrolls inside an element: `scroll: the results list` instead.
- A dialog that opened by itself (a calendar after picking a place, a menu after a hover) is already there:
  do not click its trigger again, that closes it.

## Writing a claim (expect, wait)

A claim is one fact about something that is visible when the condition holds. `expect` and `wait` are steps:
`step {wait: "the results list is visible"}`, or an entry in a `batch`.

- Presence, not absence: `the message "It's gone!" is shown`, not `the checkbox is no longer visible`.
  Absence is hard to prove from a snapshot.
- Prove state by acting: to check an input is enabled, `fill` it, then assert the typed value is shown. Type a
  value that shares no words with the page: `hello` passed at 0.98 where `enabled-check` stalled at 0.8.
- One fact per string. Several facts: `expect: [fact 1, fact 2]`, one snapshot and one Jev call.
- Name things as the tree does: `a heading with the text "Secure Area"`, not `a title`.
- Quote the exact visible text rather than a page area the tree does not label: `the text "2 items left!"
  is shown` (0.98), where `the footer says 2 items left` stayed at 0.47 (TodoMVC's footer is plain text).
  Name the element that shows the text (`the counter shows 2 items left`) when the tree splits it across lines.
- A failed browser check can add `screenshot:` (what the whole viewport shows) and `hint:` (the tree split a text
  or count phrase). Neither line changes pass or fail. A check with `within` does not add `screenshot:`. A spatial
  claim does not add `hint:`. A page cut at 60k characters is judged again on a longer tree, capped at 400k
  characters, once per check. That answer is the verdict unless the page changes while it settles. If the image
  call or the retry fails, the first result stays.
- Nondeterministic pages: claim what is stable (`a notification bar is shown at the top`), not the random text.
- `wait` when the thing appears after a delay or animation; `expect` for a settled page.
- On a large page, scope a wait to where the thing will appear: `step {wait: {that: "a price is shown", within:
  "the results list"}}`. Every poll then reads that region only. Whole-page waits on a page that keeps changing (ads,
  carousels) re-ask on every poll and can cost 100k+ tokens.

## Snapshot views

For a sequence of actions you can write now, use `batch {steps:[...]}` with 1–16 ordinary step objects.
It validates the whole request before acting and stops on the first non-pass, including `skipped`.
Each target resolves when its action runs, so a target may name an element that an earlier action in the
batch adds, moves or reveals (the field under a heading that moved, a button in the dialog a click opens).
Read the indexed results and `stoppedAt` before recovery; earlier actions are not rolled back. Only passing
actions are saved, as individual YAML steps. End the batch only when choosing the next action or its value
needs a result you have not read yet.

Known actions need no preliminary snapshot; `step` finds its own targets. For discovery,
`snapshot {mode:"compact"}` returns exact excerpts without a classification call;
`snapshot {mode:"smart",intent:"the task"}` adds Jev screen/error/loading/dialog classifications
and filters to relevant UI regions at p >= 0.5, plus recognized alerts/dialogs and necessary
context. It does not fill spare space with unrelated content. `inferred.selection` reports
`focused`, `no-confident-match`, or an unfiltered `fallback` if classification fails. Check
`coverage.filteredLines` and `unassessedRegions` (up to 64 regions are assessed).
Without intent, smart returns a compact overview. Raw remains the default. `maxChars` defaults to 20,000
for raw and 6,000 for compact/smart (maximum 60,000). `intent` is smart-only, literal text.
Compact/smart return `observed.aria`, omission counts in `coverage`, timings and `jevTokens`.
Smart `inferred` is advisory: screen confidence must reach 0.9 (probability fallback), signals
are present at p >= 0.9, absent at p <= 0.1, otherwise inconclusive; truncated captures cannot
establish absence. Failed classification returns compact evidence with unavailable inference.
Omitted content is not absent. Expand using `within` or raw mode when reading exact data;
do not infer total row counts from excerpts. Classification adds a model call and may cost more
on small trees; action targeting and assertion thresholds are unchanged.

## After a miss

Read `detail` first: the top guesses say what Jev thought you meant.

1. First miss: rephrase with the words of the top guess and name the sibling to exclude.
2. Second miss on the same fact: the fact is the problem, not the words. Assert a different visible effect,
   use a different test value, prove it by acting, or scope with `expect: {that, within}`.
3. Third miss: `snapshot` with `within` or a small `maxChars` to see the tree, then `css=` as the last resort,
   with a comment saying why.

A third rephrasing of the same fact is never the next move.

## Common mistakes

| Mistake | Fix |
|---|---|
| `expect: "the secure area is shown with a success message"` | Two facts: use the list form |
| `wait: "the checkbox is gone"` | Absence: `wait: the message "It's gone!" is shown` |
| `expect` to check a guess while debugging | `ask`: not recorded, does not fail the session |
| `snapshot` or `evaluate` to read a value or a few rows | `read {question}`, with `within` on a large page |
| `click: the "P3" option or the first option` | One answer only: `the first option in the Filter by label dialog` |
| Region not found: `the daily forecast` | Name it by its heading (`the list under the "Day by day forecast" heading`), or find it with `snapshot {mode:"smart", intent}` |
| `check: the Hotels chip` on a plain button | `click` it; `check` needs a state to read |
| Reading the tool's source to learn the thresholds | They are listed above |

## Spec replay

For saved tests, add `tags` and use `include: ./flows/login.yaml` for shared
steps-only flows; included steps use the root spec’s env/hooks. Run
`npx -y -p @gabe4coding/plain@3.1.0 plain validate spec.yaml` before replay. For CI, add
`--reporter junit:out/junit.xml --artifacts plain-results` (and
`--reporter text` to keep console results). These are YAML/CLI features; MCP
`step`/`batch` cannot execute an `include`. Passing spec runs and `save` write a
lock file (`*.lock.json` next to each spec and flow): commit it with the specs.
`--mode auto-healing` (default) replays it and lets Jev repair changed steps;
`--mode no-judge` replays it with no Jev call and no API key; `--mode judge`
asks Jev for everything (https://github.com/gabe4coding/plain/blob/main/docs/running.mdx#run-modes).

## Safety

Test environments for tests; the user's own accounts only when they asked for it. Stop before the last
irreversible step: payment, booking, sending, posting, deleting. Credentials go in a spec's `env` block as `$VAR`
environment references and are used as `${env.*}` in steps, never as literals. Never bypass bot protection: if a
site blocks the browser, say so.
