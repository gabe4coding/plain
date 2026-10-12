---
name: validating-changes
description: Use before you open, update or mark ready any pull request in the plain repo, and before you report a code, doc, test or plugin change as done. Runs the full validation loop (key-free gate, live e2e and evals, agent evals, code/doc/test review) and records the pass a pre-PR hook checks.
---

# Validating a plain change

Mandatory before every pull request. A hook blocks `gh pr create` until `node scripts/validate.mjs` has passed
on exactly the files of HEAD. CI repeats the gates; it is the last line, not the first.

The hook sees only shell commands, so it catches only `gh pr create`. A pull request opened another way (the
GitHub web page, `gh api`, a GitHub MCP tool) is not blocked, but the rule still holds: validate first.

A green result that you did not see run is not evidence.

## 1. Scope

List what changed: `git diff --name-only origin/main...HEAD` and `git status`. Note which areas it touches
(browser steps, picks, judgments, MCP tools, skills, desktop, mobile, suite, docs, plugins).

## 2. Make the evidence exist

Before you run anything, check that the change carries the evidence `CODING_STANDARDS.md`, "Tests" requires.

## 3. Run the loop

```bash
node scripts/validate.mjs
```

It runs `npm run verify`, the live e2e (`scripts/e2e.mjs`), the claims gate, the agent evals
(`scripts/eval-agent.mjs`, Claude and Codex) when the MCP surface or the browser skill changed, and the routing
evals (`scripts/eval-routing.mjs`) when an agent note changed. It stops at the first failure and writes the stamp
only when all pass.

- Before the final run, rebase the branch on `origin/main`: a later update changes the files, and the stamp no
  longer matches.
- On a failure, find the cause and fix it. Never weaken a gate to get green (`CODING_STANDARDS.md`, "Tests").
- If an agent eval fails, run the same task on main and on the branch, at the same time
  (`docs/development.mdx`, "Agent evals"), before you call it a regression or a known flake.
- A live check that passes only on a retry is a finding. Name it in the report. Do not hide it.
- A missing Jev key or agent CLI is a blocker to report, not a pass. Ask the user.
- The end of the output repeats each check's result lines and names the file with the full output. Take the
  numbers for the report from there.

## 4. Area evals

`scripts/validate.mjs` ends with the area evals the changed files call for, each with its command and how to
compare it. For each one:

1. Run it on main first: `git worktree add /tmp/pw-main origin/main`, `npm ci && npm run build` there, run the
   eval with `--out /tmp/base.json` when the script takes `--out`.
2. Run it on the branch. Add `--compare /tmp/base.json` only when the script's usage line lists it; otherwise
   write a second file with `--out` and compare the two.
3. Judge the delta. False passes and wrong locator hits must stay 0. Any metric that gets worse needs a reason in
   the report, or a fix.

Compare only on local pages: saved pages and cases, or the `e2e/site.mjs` site (`scripts/benchmark-steps.mjs` with
`--e2e`). A run on the public demo sites (`scripts/benchmark-mcp.mjs`, `scripts/benchmark-steps.mjs` without
`--e2e`) is a smoke check, never a before/after number: ads, iframes and the network make its times vary.

## 5. Review the diff

Review your own diff against main as a reviewer would. In Claude Code, run the `code-review` skill on the diff.
In Codex, run `codex exec review --base origin/main`. Then check the diff yourself against `CODING_STANDARDS.md`,
and for correctness: edge cases, error paths, a step that could pass when it should fail.

## 6. Docs and agent-facing text

- Check the diff against `CODING_STANDARDS.md`, "Docs that follow the code". Follow the `writing-docs` skill for
  any user doc you touch.
- If the change touched an agent note, or taught you something an agent would get wrong again, follow the
  `writing-agent-notes` skill.
- `check:docs` and `check:examples` already ran in `verify`. They do not check facts: read the code for those.

## 7. Report

After a change from steps 5 or 6, run `node scripts/validate.mjs` again: the stamp covers files, not intentions.
Then report to the user, and put the same summary in the pull request description:

- Each check that ran, with its result (e2e specs, claims numbers, agent runs passed).
- Area eval deltas against main.
- What did not run, and why (no device, no key, not on macOS).
- Findings: flaky checks, gaps you saw but did not fix.

After you push, wait for CI with `gh pr checks <number> --watch` (it returns when all checks end), not with a
sleep loop. On a red check, read its log with `gh run view <run-id> --log-failed`.
