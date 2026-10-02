# Browsing: do or read something on a site

Steps act, `read` reads, nothing is saved. There is no test here: do not `save`, do not replay.

## Workflow

1. `open` the URL. Pass `headed: true` when the user wants to watch, or when the site blocks a headless browser
   (title "Access Denied", an empty page). Pass `goal`: the user's task in one sentence ("read the discussion
   about F-Droid 2.0"); picks use it to settle vague targets. Do not `snapshot` first: `step` and `find` do the looking.
2. Drive with `step`, one action per call, or `batch {steps:[...]}` for up to 16 already-known actions.
   Batch runs sequentially and stops on the first non-pass, including `skipped`; inspect its indexed
   results and `stoppedAt`. End the batch before a decision that needs new page information.
   Read `status`, `detail`, `notes`, `url` and `changed` after every call: `changed.added` holds the new
   page lines (a message, a menu, the top of a new page), often the answer itself. A cookie
   or consent dialog comes first: `click: the button that accepts all cookies`.
   When the next action is unknown, use `snapshot {mode:"compact"}` for an overview or
   `snapshot {mode:"smart",intent:"the task"}` for task-focused evidence and Jev classifications. Check omission counts;
   These are optional discovery reads, not prerequisites, and never the way to get a value: that is `read`.
3. Read the data once the page is there, with `read`:
   - `read {question}` returns the exact page lines that answer it, copied verbatim: "the author and first
     published year of the first result", "the titles and prices of the first three books". One call per
     question; several facts about one item fit in one question. Add `within` on a large page (Wikipedia,
     GitHub, long results): it costs a few thousand Jev tokens instead of 30–50k.
   - `found: false`: rephrase once with the words of `guesses`, or scope with `within`. Still not found: the
     value is probably not on the page (scroll, open the item, or say so).
   - Fall back only when `read` cannot do it: `evaluate` for many rows as structured JSON (every result's name
     and price), `snapshot` with `within` to see a region's structure. Never the whole-page snapshot for data.
   Measured: `read` cut agent cost 23% on data tasks, with the same answers.
4. Report what you found to the user, with the page URL. Stop.

## Steps that help here

- Lists that load late: `wait: the results list is visible`, then read.
- Autocomplete: a suggestion list can open seconds after `fill`. If the suggestion is not found, `ask` whether
  the box holds your text and whether a suggestion list is shown, then `wait: a list of suggestions is shown`;
  do not retype. `press: Enter` often submits the search instead.
- Pages with hundreds of links (Wikipedia, Hacker News, GitHub lists) cost 20–35k Jev tokens per pick. Read data
  with `read` (with `within`), and navigate by URL (`open`) when you know it, instead of clicking.
- Filters: `check: the Hotels filter chip` (a no-op if already on). A chip without a state: `click`.
- Long pages: `scroll: bottom`, read the distance in `detail`; `press: End` and `press: Escape` also work.
- A popover or calendar that opened by itself is already open: act inside it, do not click its trigger again.

## The user's real browser

A session starts as a fresh browser with no logins. Signed-in sessions need the server started with
`--profile` and `--channel chrome`, or `--cdp` to attach to a running Chrome (see
https://github.com/gabe4coding/plainwright/blob/main/docs/agent-mode.md). You cannot change that from inside a
session: if the task needs the user's accounts, say so and stop.

Anything you do in a real browser happens in the user's accounts. Stop before payment, booking, sending,
posting or deleting.
