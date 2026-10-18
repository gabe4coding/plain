# Changelog

## 3.1.0

### Web pilot

- Pin the TypeSafe model to `jev-1.14.0` and require `@typesafe-ai/sdk` 0.7.x.
  Token counts treat a null usage field as zero.
  The claim thresholds are unchanged.
- A failed browser check sends the viewport screenshot to TypeSafe and prints what it shows.
  The line is advisory: it does not change pass or fail.
  A failed image call leaves the verdict as it is.
  The Vercel AI Gateway path skips the image and says why.
- When a page is cut at 60,000 characters, plain judges the full tree once with long context and uses that answer.
  A failed retry keeps the cut verdict.
- A failed check about text the accessibility tree splits can add a hint.
  The hint does not change the result.
  The phrasing guide shows the wording that passes.
- `@modelcontextprotocol/sdk` is at least 1.32, and `webdriverio` is 10.0.2.
  `npm audit` reports no high or critical findings for production dependencies.
- The browser and desktop CLIs stop when Node is older than 22.
  The mobile CLI stops when Node is older than 22.19, which webdriverio 10 requires.
- The Live workflow also runs on a daily schedule at 06:00 UTC.
  GitHub runs that schedule on the default branch.
- The desktop and mobile engines are marked beta.
  The docs no longer claim React Native support.
- New guides: Security and data, and the web pilot runbook.
- New lock files are version 2, because a claim hash includes the uncut page text.
  A version 1 lock still replays locators.
  A claim hash that does not match is judged again.
  plain prints `re-record to upgrade lock file`.

### Since 3.0.0

These changes were already on main and ship in this version.

- `validate` warns on a literal credential in a spec.
- Environment switches are read on each call.
- Hook output goes to stderr, and MCP code does not write to stdout.
- Desktop scroll supports left and right, with one direction list for every engine.
- Teardown on every engine sees the first failed status.
- Desktop and mobile skills tell the agent to call tools by their full prefixed name.
- The README has a setup prompt for a coding agent.
- Docs and skill links match the current routes, tags and lock files.
