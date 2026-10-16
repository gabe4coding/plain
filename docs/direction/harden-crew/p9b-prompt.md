you are builder for PR P9b, slug `rule-holes`. read + follow /Users/gpavanello/Repositories/plainwright/.claude/worktrees/gabefy-make-it-fail-audit-b0f7c3/docs/direction/harden-crew/builder-brief.md (all steps). direction row: P9b in docs/direction/harden-2026-10.md.

depends on merged: #86 (gates.test.mjs), #88 (casts.mjs), #90 (env.mjs). confirm all 3 in origin/main before you start.

lane: scripts/source-rules/env.mjs, scripts/source-rules/casts.mjs, scripts/gates.test.mjs, their tests (scripts/check-source.test.mjs or the rule's examples), scripts/source-rules/baseline.json only if a count changes (ratchet is EXACT: set the new count in the same change, say why).

intent: close bypasses that reviewers confirmed in the new gates. each fix: plant the bypass first, show the gate passes it (red = gate misses), fix, show it fails now, remove plant, run green. keep outputs for the PR body.

1. env.mjs (reviewer probes, P3 #90):
   - f1: ENV_READ misses default-import alias `import proc from 'node:process'; proc.env.X` and optional chain `process?.env.X`. catch both (e.g. `import\s+\w+\s+from\s+['"](node:)?process['"]`, `process\s*\??\.\s*env`). add hit examples.
   - f2: ACCESSOR_CALL list lacks `provider` / `selectProvider` (both read JEV_PROVIDER + keys at call time). `export const P = provider();` at module scope must hit. add example. allowlisted files skip the module-scope check: state that limit in header.
   - f3: module-scope heuristic sets deferred=true on any `=>`/`function` line. misses: top-level IIFE `(() => {\n  if (switchOn('PLAIN_X')) register();\n})();` (repo has one in src/core/hooks-child.ts:31; must not create false positive there unless it really reads env), `(function () {...})()`, class `static key = apiKey('t')`, `const f = () => 1; export const R = readEnabled();`. fix what is cheap (IIFE: statement starting with `(` keeps deferred=false; static field; text after first `=>` on same line). list remaining limits in header like scripts/source-rules/stdout.mjs does. no false positives on current src (run check:source).
2. casts.mjs (P9 #88 review): casts.mjs:63 directives() reads only ts.getLeadingCommentRanges(text, node.pos), so `export const ok = 1; // @ts-ignore\nexport const n: number = "x";` is not counted while tsc honors it. also read trailing comment ranges (ts.getTrailingCommentRanges(text, node.end)) or scan trivia; do not double count. add hit examples for `// @ts-ignore` and `/* @ts-expect-error */` after code. baseline stays 65 unless src has such a directive (it has 0 today; verify).
3. gates.test.mjs (P7 #86 re-review): f5 lookahead lets `{ skip: false || process.env.CI }` pass: anchor so only a bare literal `false` (then `,` or `}` or whitespace) is allowed. complete header limits list: name from variable/concat, destructured/aliased skip, early return in test body, conditional test registration. planted case must fail.

out of scope (stay P31): CI timeout-minutes, runtime skipped/todo check, non-literal dynamic import rule, ratchet printing only new hits.

tests run key-free: npm test + npm run verify. still run validate.mjs per brief (pr-gate needs it).
PR title idea: "Close known bypasses in the env, cast and gate-floor checks". Story row: P9b.

final report: cablese, lowercase. keep numbers, ids, paths exact. reason normally.
