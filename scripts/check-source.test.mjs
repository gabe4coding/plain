// Tests of the source rule runner: which files a rule checks, its hits, the ratchet against the baseline, then the
// CLI on a throwaway git repository with a planted rule, a new file that breaks it and a link to that file.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BASELINE_FILE, RULES_DIR, applies, evaluate, ruleHits, ruleProblem } from './check-source.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-source.mjs');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const NO_ANY = { name: 'no-any', files: /^src\/.*\.ts$/, pattern: /\bas any\b/, message: 'use a real type' };

test('checks the matching files, leaves out tests, the allowlist and the rule files', () => {
  assert.equal(applies(NO_ANY, 'src/core/lock.ts'), true);
  assert.equal(applies(NO_ANY, 'scripts/x.ts'), false);
  assert.equal(applies(NO_ANY, 'src/core/lock.test.ts'), false);
  assert.equal(applies({ ...NO_ANY, skip: undefined }, 'src/core/lock.test.ts'), false);
  assert.equal(applies({ ...NO_ANY, skip: null }, 'src/core/lock.test.ts'), true);
  assert.equal(applies({ ...NO_ANY, skip: /\/fixtures\// }, 'src/core/lock.test.ts'), true);
  assert.equal(applies({ ...NO_ANY, skip: /\/fixtures\// }, 'src/fixtures/a.ts'), false);
  const allowed = { ...NO_ANY, allow: ['src/jev/', 'src/core/hooks.ts'] };
  assert.equal(applies(allowed, 'src/jev/ask.ts'), false);
  assert.equal(applies(allowed, 'src/core/hooks.ts'), false);
  assert.equal(applies(allowed, 'src/core/lock.ts'), true);
  assert.equal(applies({ ...NO_ANY, files: /^scripts\// }, `${RULES_DIR}/no-any.mjs`), false);
});

test('finds pattern hits on code lines only, and takes the message of a check hit', () => {
  const text = ['const a = b as any;', '// x as any', '  /* as any */', '   * as any', 'f(x as any); // ok',
    '/** open as any', '   */', '/* lint */ const c = d as any;', '  *[Symbol.iterator]() { return e as any; }',
    '   *as any'].join('\n');
  assert.deepEqual(ruleHits(NO_ANY, 'src/a.ts', text).map(({ line }) => line), [1, 5, 8, 9, 10]);
  const twice = { name: 'twice', files: /./, message: 'default', check: (body, path) => [
    { line: 2, message: `${path}: ${body.length}` }, { line: 3 }] };
  assert.deepEqual(ruleHits(twice, 'src/a.ts', 'abc'),
    [{ line: 2, message: 'src/a.ts: 3' }, { line: 3, message: 'default' }]);
});

test('rejects a rule module with a wrong name, a missing part or a stateful RegExp', () => {
  assert.equal(ruleProblem(NO_ANY, 'no-any.mjs'), null);
  assert.equal(ruleProblem({ ...NO_ANY, pattern: undefined, check: () => [] }, 'no-any.mjs'), null);
  assert.equal(ruleProblem(undefined, 'no-any.mjs'), 'name must be "no-any", the file name');
  assert.equal(ruleProblem(NO_ANY, 'casts.mjs'), 'name must be "casts", the file name');
  assert.equal(ruleProblem({ ...NO_ANY, files: 'src/' }, 'no-any.mjs'), 'files must be a RegExp');
  assert.equal(ruleProblem({ ...NO_ANY, skip: 'fixtures' }, 'no-any.mjs'), 'skip must be a RegExp or null');
  assert.equal(ruleProblem({ ...NO_ANY, allow: 'src/jev/' }, 'no-any.mjs'), 'allow must be an array of path prefixes');
  const neither = 'needs pattern (a RegExp) or check (a function), not both';
  assert.equal(ruleProblem({ ...NO_ANY, pattern: 'as any' }, 'no-any.mjs'), neither);
  assert.equal(ruleProblem({ ...NO_ANY, check: () => [] }, 'no-any.mjs'), neither);
  assert.equal(ruleProblem({ ...NO_ANY, message: undefined }, 'no-any.mjs'), 'needs message');
  assert.equal(ruleProblem({ ...NO_ANY, pattern: undefined, check: () => [], message: undefined }, 'no-any.mjs'),
    'needs message');
  assert.equal(ruleProblem({ ...NO_ANY, pattern: /as any/g }, 'no-any.mjs'), 'a RegExp must not have the g or y flag');
  assert.equal(ruleProblem({ ...NO_ANY, skip: /x/y }, 'no-any.mjs'), 'a RegExp must not have the g or y flag');
});

const FILES = { 'src/a.ts': 'x as any\ny as any\n', 'src/b.ts': 'z as any\n', 'src/c.ts': 'clean\n' };
const run = (rules, baseline = {}) => evaluate(rules, Object.keys(FILES), (path) => FILES[path], baseline);
const RATCHET = { ...NO_ANY, ratchet: true };

test('reports each hit of a plain rule as a problem', () => {
  assert.deepEqual(run([NO_ANY]), { problems: [
    'src/a.ts:1: [no-any] use a real type',
    'src/a.ts:2: [no-any] use a real type',
    'src/b.ts:1: [no-any] use a real type',
  ], notes: [] });
});

test('fails a ratchet rule above its baseline, passes it at the baseline, notes it below', () => {
  assert.deepEqual(run([RATCHET], { 'no-any': 2 }), { problems: [
    'src/a.ts:1: [no-any] use a real type',
    'src/a.ts:2: [no-any] use a real type',
    'src/b.ts:1: [no-any] use a real type',
    `${BASELINE_FILE}: [no-any] 3 hits, baseline 2: remove the new hit, do not raise the baseline`,
  ], notes: [] });
  assert.deepEqual(run([RATCHET], { 'no-any': 3 }), { problems: [], notes: [] });
  assert.deepEqual(run([RATCHET], { 'no-any': 5 }), { problems: [], notes: [
    `[no-any] 3 hits, baseline 5: set "no-any": 3 in ${BASELINE_FILE}`,
  ] });
});

test('fails a ratchet rule with no baseline, and a baseline key with no ratchet rule', () => {
  assert.deepEqual(run([RATCHET]),
    { problems: [`${BASELINE_FILE}: [no-any] no baseline: add "no-any": 3`], notes: [] });
  assert.deepEqual(run([], { gone: 1 }).problems,
    [`${BASELINE_FILE}: [gone] no ratchet rule has this name: remove it`]);
  assert.deepEqual(run([{ ...NO_ANY, files: /^none$/ }], { 'no-any': 0 }).problems,
    [`${BASELINE_FILE}: [no-any] no ratchet rule has this name: remove it`]);
});

let repo;

/** Write a file of the fixture repository, creating its folders. */
function write(path, text) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

/** Run the runner on the fixture repository, from another folder. */
function check() {
  const result = spawnSync(process.execPath, [script, '--root', repo], { cwd: tmpdir(), encoding: 'utf8', env });
  const problems = result.stderr.split('\n').filter((line) => /^\S+:\d+: /.test(line));
  return { code: result.status, stdout: result.stdout, problems };
}

before(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plain-source-rules-')));
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  write('.gitignore', 'dist/\n');
  write(`${RULES_DIR}/no-any.mjs`, "export default { name: 'no-any', files: /\\.ts$/, "
    + "pattern: /\\bas any\\b/, message: 'use a real type' };\n");
  write('src/core/clean.ts', 'export const a = 1;\n');
  write('src/core/clean.test.ts', 'const b = a as any;\n');
  write('dist/core/out.ts', 'const c = a as any;\n');
  execFileSync('git', ['add', '-A'], { cwd: repo, env });
  write('src/core/new.ts', 'export const a = 1;\nexport const d = a as any;\n');
  symlinkSync('new.ts', join(repo, 'src/core/link.ts'));
});

after(() => rmSync(repo, { recursive: true, force: true }));

test('reports a hit in an untracked file once, as path:line: [rule] message, exits 1, then passes once fixed', () => {
  assert.deepEqual(check(), { code: 1, stdout: '', problems: ['src/core/new.ts:2: [no-any] use a real type'] });
  write('src/core/new.ts', 'export const a = 1;\nexport const d: number = a;\n');
  assert.deepEqual(check(), { code: 0, stdout: 'source rules ok: 1 rule(s)\n', problems: [] });
});
