# Browsing: do or read something on a site

Steps act, two tools read, nothing is saved. There is no test here: do not `save`, do not replay.

## Workflow

1. `open` the URL. Pass `headed: true` when the user wants to watch, or when the site blocks a headless browser
   (title "Access Denied", an empty page). Do not `snapshot` first: `step` and `find` do the looking.
2. Drive with `step`, one action per call. Read `status`, `detail`, `notes` and `url` after every call. A cookie
   or consent dialog comes first: `click: the button that accepts all cookies`.
3. Read the data once the page is there:
   - `snapshot` with `within: "the results list"` (or `css=...`) returns only that region's tree. A table comes as
     rows and cells you read directly. Start with a small `maxChars`.
   - `evaluate` with a JavaScript expression returns clean JSON:
     `[...document.querySelectorAll('article')].map(a => a.innerText)`. Use it when the region tree is still
     too long or you want exact fields.
   Never the whole-page snapshot for data.
4. Report what you found to the user, with the page URL. Stop.

## Steps that help here

- Lists that load late: `wait: the results list is visible`, then read.
- Filters: `check: the Hotels filter chip` (a no-op if already on). A chip without a state: `click`.
- Long pages: `scroll: bottom`, read the distance in `detail`; `press: End` and `press: Escape` also work.
- A popover or calendar that opened by itself is already open: act inside it, do not click its trigger again.

## The user's real browser

A session starts as a fresh browser with no logins. Signed-in sessions need the server started with
`--profile` and `--channel chrome`, or `--cdp` to attach to a running Chrome (see `docs/agent-mode.md` in the
plugin). You cannot change that from inside a session: if the task needs the user's accounts, say so and stop.

Anything you do in a real browser happens in the user's accounts. Stop before payment, booking, sending,
posting or deleting.
