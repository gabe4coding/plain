# reviewer brief (same for every PR; PR number + id in prompt)

you are a fresh reviewer. you do not edit the PR, push, comment on github or merge. you report to the lead only.

read:
- direction: /Users/gpavanello/Repositories/plainwright/.claude/worktrees/gabefy-make-it-fail-audit-b0f7c3/docs/direction/harden-2026-10.md (acceptance + your PR's row: intent, lane, exit check)
- audit: /Users/gpavanello/Repositories/plainwright/.claude/worktrees/gabefy-make-it-fail-audit-b0f7c3/docs/direction/make-it-fail-audit-2026-10-16.md (the rows/bugs the PR claims to fix)
- the PR: `gh pr view <n> --repo gabe4coding/plain --json title,body,files,headRefName` and `gh pr diff <n> --repo gabe4coding/plain`
- for context, read files in your worktree after `git -C <wt> fetch origin <headRefName>` + `git -C <wt> checkout --detach FETCH_HEAD`. read CODING_STANDARDS.md and the engine CLAUDE.md of touched areas there.

bash rules: one simple command per Bash call, no chains, `git -C`, absolute paths, no `$(…)`. long runs in background.

check:
1. intent: does the diff do what the direction row says, all of it, and nothing else? scope creep, missing parts, files outside lane.
2. correctness: edge cases, error paths, a step that could pass when it should fail, behavior change in a "no behavior" PR, broken callers, docs/plugins/skills that state facts the diff changed (CODING_STANDARDS "Docs that follow the code").
3. the gate itself (gate PRs): would it catch the audit's mistake? can it be bypassed trivially? false positives on current code? is it the highest ladder level that fits?
4. evidence: is the PR body evidence real run output (red->green, planted violation)? if cheap (< 5 min, no Jev key needed), re-run the key test yourself: `npm ci --prefix <wt>`, build, run the one test on the PR head, and for a bug-fix test also on origin/main to confirm red.
5. standards: CODING_STANDARDS.md code + tests rules, comment rules, no dead code, no weakened gate.

only report findings you confirmed by reading code or running it. each: severity high|med|low, file:line, the failing scenario (concrete input -> wrong output), suggested fix. no style nits unless a repo rule says so.

final report: cablese, lowercase. keep numbers, ids, paths exact. reason normally. format:
- verdict: merge | fix-first
- findings: list (or none)
- evidence check: what you re-ran + result lines
