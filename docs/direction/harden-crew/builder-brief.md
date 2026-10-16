# builder brief (same for every PR; your PR id + lane come in the prompt)

read first:
- direction: /Users/gpavanello/Repositories/plainwright/.claude/worktrees/gabefy-make-it-fail-audit-b0f7c3/docs/direction/harden-2026-10.md (acceptance, review, your row, decisions). do not edit it; only lead writes it.
- audit: /Users/gpavanello/Repositories/plainwright/.claude/worktrees/gabefy-make-it-fail-audit-b0f7c3/docs/direction/make-it-fail-audit-2026-10-16.md (your rows/bugs: locations, counts, proposed fix).
- in YOUR worktree: CLAUDE.md, CODING_STANDARDS.md, engine CLAUDE.md for areas you touch, .claude/skills/validating-changes/SKILL.md. read skill files from your worktree, not via Skill tool: the Skill tool loads repo skills from ~/Repositories/plainwright main checkout, which is 87 commits stale.
- do NOT copy docs/direction/ into your branch.

setup (your worktree may start on the lead branch; never build on it):
1. `git -C <wt> fetch origin main`
2. `git -C <wt> checkout -b harden/<slug> origin/main`  (slug given in prompt)
3. `npm ci --prefix <wt>`; `npx --prefix <wt> playwright install chromium` if browsers missing.
4. if your PR depends on merged PRs (prompt says), confirm they are in origin/main (`git -C <wt> log --oneline -5 origin/main`).

bash rules (permission checker): one simple command per Bash call. no `;` `&&` `||` chains, no `cd x && …` (use `git -C`, `npm --prefix`, absolute paths), no `$(…)`/backticks/variables in paths. multi-line logic -> script file in your scratchpad, then run it. long commands (validate.mjs, npm test) -> run_in_background, wait for notification.

build:
- stay in your lane (files in prompt). touch other files only when a rename/type change forces it; list each in your report.
- highest ladder level that catches the mistake (1 type > 2 generated > 3 arch > 4 grep/lint rule > 5 test > 6 doc).
- bug fix: write the test first, run it on the unfixed code, keep the red output (exact lines), then fix, then green.
- new gate/rule: plant a violation, run the gate, keep the failing output, remove the plant, run green. keep both outputs.
- grep/lint rules go in `scripts/source-rules/<name>.mjs` (runner `scripts/check-source.mjs`, from P0; read its header). never edit another rule's file. ratchet counts go in `scripts/source-rules/baseline.json` (one key per rule).
- match surrounding code style and comment density. comments give non-obvious reasons only, no history words.
- never weaken a gate: no lowered threshold, no edited expected output, no skip, no `optional`.
- docs follow code: CODING_STANDARDS.md "Docs that follow the code". user docs: follow .claude/skills/writing-docs/SKILL.md; agent notes: .claude/skills/writing-agent-notes/SKILL.md.

validate + review:
1. `npm --prefix <wt> run build`, then `npm --prefix <wt> test` green.
2. `node <wt>/scripts/validate.mjs` (background) must pass. rebase on origin/main right before the final run. a flaky live check that passes on retry: report it, do not hide it. missing key/CLI: report as blocker.
3. review own diff: read <wt>/.claude/skills/validating-changes/SKILL.md step 5; use the `code-review` skill on your diff; fix confirmed findings; re-run validate if code changed.

ship:
- commit message: ASD-STE100 style (short sentences, active voice), imperative title like repo history, end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `git -C <wt> push -u origin harden/<slug>`
- PR body: load skill `puredori:pr-write` (Skill tool is fine for that plugin skill). body needs `## Intent`, `## Evidence` (real output: red->green test lines, planted-violation output, validate.mjs result lines), `## Story` (one row: this PR id from direction table). do not link docs/direction (not on main). end body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. write body to a file in your scratchpad, `gh pr create --repo gabe4coding/plain --base main --head harden/<slug> --title "<title>" --body-file <file>`. not draft.
- scratchpad is shared by all builders: name every scratch file with your slug (e.g. `<slug>-pr-body.md`), never a generic name.
- do NOT merge. do NOT edit other PRs. do NOT force-push to main.
- if a permission check denies commit, push or `gh pr create`: do not retry or work around it. stop, leave the tree as is, write the commit message + pr body to scratchpad files, report exact state. lead ships it.

return (final report: cablese, lowercase. keep numbers, ids, paths exact. reason normally.):
- pr url + number, branch, worktree path
- changed files (+ any outside lane, why)
- evidence: red lines, green lines, planted-gate output, validate.mjs summary lines
- code-review findings: fixed / rejected (why)
- open questions or doubts for lead; anything not done
