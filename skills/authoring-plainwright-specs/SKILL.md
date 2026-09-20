---
name: authoring-plainwright-specs
description: Use when writing, exploring or debugging a plainwright YAML end-to-end test, or when driving a website through the plainwright MCP tools (open, step, find, snapshot, evaluate, save) — including when a step comes back inconclusive, when reading results off a page the flow reached, or when a saved spec fails on replay.
---

# Authoring plainwright specs

## Overview

Playwright acts, the Jev model decides: it picks the element your words describe and judges whether your
claim holds against the page's accessibility tree. You never see the page. You write words Jev can answer
with one clear yes. The lever is wording, not thresholds.

## How outcomes are decided

- A pick is accepted when Jev's confidence is ≥ 0.5 and the answer is not `none`. Otherwise the step is
  `inconclusive` and `detail` lists the top guesses with their probabilities.
- A claim passes at p ≥ 0.9, fails at p ≤ 0.1, and is `inconclusive` in between. `optional: true` turns an
  inconclusive or error step into `skipped`.
- Rejected picks and non-passing claims dump the exact state Jev saw to `$TMPDIR/plainwright/*.json`; the path
  is in `detail`.

## Workflow

1. `open` the start URL. Do not `snapshot` first: `step` and `find` do the looking. Pass `headed: true` when the
   user wants to watch the browser (default is headless). Pass `hooks: ./path.mjs`
   when the flow needs leased or generated data; the response lists the `${hooks.*}` placeholders to use in
   steps, and `save` keeps them.
2. Drive the flow with `step`, one action or one check per call. Read `status`, `detail`, `notes` and `url`
   after every call.
3. `save` when the flow is complete. Only steps that passed are saved.
4. Edit the YAML: `optional: true` where the page is nondeterministic, a `#` comment where a phrasing is
   non-obvious, a `wait` before anything that appears after a delay.
5. Replay headless: `node <plainwright dir>/dist/cli.js --headless spec.yaml` (the plugin dir is
   `${CLAUDE_PLUGIN_ROOT}`). Run it twice. Green twice is done. Anything else goes back to step 2 with the
   dump file.

## Reading data from the page

Steps act; to read results, do not `snapshot` the whole page (tens of thousands of characters).

- `snapshot` with `within: "the results list"` (or `css=...`) returns only that region's tree. A table comes as
  rows and cells you can read directly.
- `evaluate` with a JavaScript expression returns clean JSON: `[...document.querySelectorAll('article')].map(a => a.innerText)`.

Neither is recorded by `save`.

## Writing a target (click, fill, hover, select, check)

One element, one true answer, named the way the accessibility tree names it: role, visible text, and what
sets it apart from its siblings.

- `the Login button`, `the username textbox`, `the edit link in the 5th table row`
- `the cuisine search input (not the location field)`
- `the earliest available day`, never `an available day`: several valid answers split the probability
- `check` and `uncheck` mean "make it selected, or not". They work on checkboxes, radios, switches, and filter
  chips or toggle buttons that expose their state, and do nothing when the state is already right. A chip with
  no state to read is a `click`.
- `scroll: bottom` and `scroll: top` scroll the page and report the distance in `detail`. `did not move` means
  the content scrolls inside an element: `scroll: the results list` instead.

## Writing a claim (expect, wait)

A claim is one fact about something that is visible when the condition holds.

- Presence, not absence: `the message "It's gone!" is shown`, not `the checkbox is no longer visible`.
  Absence is hard to prove from a snapshot.
- Prove state by acting: to check an input is enabled, `fill` it, then assert the typed value is shown. Type a
  value that shares no words with the page: `hello` passed at 0.98 where `enabled-check` stalled at 0.8.
- One fact per string. Several facts: `expect: [fact 1, fact 2]`, one snapshot and one Jev call.
- Name things as the tree does: `a heading with the text "Secure Area"`, not `a title`.
- Nondeterministic pages: claim what is stable (`a notification bar is shown at the top`), not the random text.
- `wait` when the thing appears after a delay or animation; `expect` for a settled page.

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
| Hand-writing the YAML instead of `save` | `save`, then edit |
| Done after one green run | Run twice; flaky steps show on the second |
| Reading the tool's source to learn the thresholds | They are listed above |
| `snapshot` of the whole page to read a table | `snapshot` with `within`, or `evaluate` |
| `check: the Hotels chip` on a plain button | `click` it; `check` needs a state to read |

## Safety

Test environments only. Stop before the last irreversible step: payment, booking, sending. Credentials go in the
spec's `env` block as `$VAR` environment references and are used as `${env.*}` in steps, never as literals. Never
bypass bot protection.
