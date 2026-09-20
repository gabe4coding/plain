# Phrasing guide

Jev never sees the page the way you do. It gets the accessibility tree and your sentence, and returns
a probability. The lever is wording, not thresholds.

## How Jev decides

**Picking an element** (`click`, `fill`, `hover`, `select`, `check`, `upload`, `scroll`, `drag`,
`expect ... within`). plainwright collects the candidate elements for the step kind, numbers them, and asks
Jev one Choice question: which candidate does the sentence mean, or `none`. The pick is accepted when
Jev's confidence in the chosen option is at least 0.5 and the answer is not `none`. The step's detail
shows `p=` (probability) and, on the TypeSafe backend, `c=` (confidence). Otherwise the step is
`inconclusive` and `detail` lists the top guesses with their probabilities.

Candidates are the real controls first (buttons, links, inputs, options...), then extras: the outermost
element with a `cursor: pointer` style (React-style clickable cards), `[tabindex]`, `[contenteditable]`,
`summary`, `label`, `[draggable=true]`, `img`/`svg`/`figure` for `hover`, anything inside an open shadow
root, and everything inside same-page iframes (prefixed `[iframe ...]`). Identical descriptions get
`#1`, `#2`... in DOM order, so "the first ..." has one answer. Hard ceiling: 254 candidates, because a
Jev Choice takes at most 255 options. Past that, scope with `within` or use `css=`.

**Judging a claim** (`expect`, `wait`). One yes/no question per claim against the snapshot. It passes
at p ≥ 0.9, fails at p ≤ 0.1, and is `inconclusive` in between. `wait` repeats the question every
1.5 s, up to 8 times.

A rejected pick or a non-passing claim dumps the exact state Jev saw to `$TMPDIR/plainwright/*.json`. The
path is in `detail`.

## Writing a target

One element, one true answer, named the way the accessibility tree names it: role, visible text, and
what sets it apart from its siblings.

- `the Login button`, `the username textbox`, `the edit link in the 5th table row`
- `the cuisine search input (not the location field)`: name the sibling to exclude
- `the earliest available day`, never `an available day`: five valid answers split the probability to
  about 0.45 each, and nothing gets picked

## Writing a claim

A claim is one fact about something that is visible when the condition holds.

- **One fact per string.** `the secure area is shown with a success message` is two facts. Use the list
  form: `expect: [a heading with the text "Secure Area" is shown, a success message is shown]`. One
  snapshot, one Jev call.
- **Presence, not absence.** `the message "It's gone!" is shown`, not `the checkbox is no longer
  visible`. Absence is hard to prove from a snapshot.
- **Name things as the tree does.** `a heading with the text "name: user1"` scored 0.97 where
  `a caption ...` scored 0.86.
- **Prove state by acting.** To check an input is enabled, `fill` it, then assert the typed value is
  shown. Use a value that shares no words with the page: `hello` passed at 0.98 where `enabled-check`
  stalled at 0.8.
- **Nondeterministic pages.** Claim what is stable (`a notification bar is shown at the top`), not the
  random text.
- `wait` when the thing appears after a delay or an animation. `expect` for a settled page.

## When a step comes back `?`

Read `detail` first. The top guesses say what Jev thought you meant.

1. First miss: rephrase with the words of the top guess and name the sibling to exclude.
2. Second miss on the same fact: the fact is the problem, not the words. Assert a different visible
   effect, use a different test value, prove it by acting, or scope with `expect: { that, within }`.
3. Third miss: read the dump file (or call the `snapshot` MCP tool) to see the tree, then use `css=`
   as the last resort, with a comment saying why.

A third rephrasing of the same fact is never the next move.

`examples/google-flights.yaml` shows the pattern on a dense page: a comment on every non-obvious
phrasing, and a single `css=` escape with the reason next to it.

Run a spec twice before calling it done. Flaky steps show on the second run. Mark a step
`optional: true` only when the page really is nondeterministic; otherwise add a `wait`.
