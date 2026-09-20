# Authoring: write, debug or replay a spec

## Workflow

1. `open` the start URL. Pass `headed: true` when the user wants to watch. Pass `hooks: ./path.mjs` when the flow
   needs leased or generated data; the response lists the `${hooks.*}` placeholders to use in steps, and `save`
   keeps them as written.
2. Drive with `step`, one action or one check per call. Read `status`, `detail`, `notes` and `url` after every
   call. Only steps that pass go in the spec, so an inconclusive attempt costs nothing but a retry.
3. `save` when the flow is complete.
4. Edit the YAML: `optional: true` where the page is nondeterministic (a cookie banner, a promo), a `#` comment
   where a phrasing is non-obvious, a `wait` before anything that appears after a delay. Credentials become
   `$VAR` references in the `env` block, used as `${env.*}` in steps.
5. Replay headless: `node <plainwright dir>/dist/cli.js --headless spec.yaml` (the plugin dir is
   `${CLAUDE_PLUGIN_ROOT}`). Run it twice. Green twice is done. Anything else goes back to step 2 with the dump
   file named in `detail`.

## When a saved spec fails on replay

- `inconclusive` on a pick: the page has a sibling the session did not have, or the wording leaned on something
  that changed. Read the top guesses in the dump, then rephrase to exclude the sibling.
- `inconclusive` on a claim: the fact is in the grey zone. Claim a different visible effect, or scope with
  `expect: {that, within}`.
- `error`: a timeout or a `css=` target that matched nothing. Usually a `wait` is missing before the step.
- `fail`: Jev is sure the claim does not hold. Either the page changed or the claim was wrong: open the dump
  and look at what Jev saw.
- Passed headed, failed headless: something needs the viewport or a hover. Add a `wait` or `scroll` first.

## Common mistakes

| Mistake | Fix |
|---|---|
| Hand-writing the YAML instead of `save` | `save`, then edit |
| Done after one green run | Run twice; flaky steps show on the second |
| A literal password in a step | `env: { pass: $SITE_PASS }` and `${env.pass}` |
| A third rephrasing of the same fact | Change the fact (see "After a miss" in SKILL.md) |
