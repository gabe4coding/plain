// Tests of the source rule runner: which files a rule checks, its hits, the rule format and its examples, the ratchet
// against the baseline, then the CLI on a throwaway git repository with a planted rule, a new file that breaks it, a
// link to that file, a broken baseline and files in the rules folder that git ignores or that are no rule.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BASELINE_FILE, RULES_DIR, applies, evaluate, ruleHits, ruleProblem } from './check-source.mjs';
import casts from './source-rules/casts.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-source.mjs');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const NO_ANY = { name: 'no-any', files: /^src\/.*\.ts$/, pattern: /\bas any\b/, message: 'use a real type',
  examples: { hit: ['x as any'], miss: ['x as unknown', 'canvas anything'] } };
const CHECK_EXAMPLES = { hit: [{ path: 'src/a.ts', text: 'x' }], miss: [{ path: 'src/b.ts', text: '' }] };
const ONE_HIT = { ...NO_ANY, pattern: undefined, examples: CHECK_EXAMPLES,
  check: (text) => (text ? [{ line: 1 }] : []) };
const RULE_FILE = `${RULES_DIR}/no-any.mjs`;

test('checks the matching files, leaves out tests unless asked, the allowlist and the rule files', () => {
  assert.equal(applies(NO_ANY, 'src/core/lock.ts'), true);
  assert.equal(applies(NO_ANY, 'scripts/x.ts'), false);
  assert.equal(applies(NO_ANY, 'src/core/lock.test.ts'), false);
  assert.equal(applies({ ...NO_ANY, tests: true }, 'src/core/lock.test.ts'), true);
  const fixtures = { ...NO_ANY, skip: /\/fixtures\// };
  assert.equal(applies(fixtures, 'src/core/lock.test.ts'), false);
  assert.equal(applies(fixtures, 'src/fixtures/a.ts'), false);
  assert.equal(applies(fixtures, 'src/core/lock.ts'), true);
  const allowed = { ...NO_ANY, allow: ['src/jev/', 'src/core/hooks.ts'] };
  assert.equal(applies(allowed, 'src/jev/ask.ts'), false);
  assert.equal(applies(allowed, 'src/core/hooks.ts'), false);
  assert.equal(applies(allowed, 'src/core/lock.ts'), true);
  assert.equal(applies({ ...NO_ANY, allow: ['src/jev'] }, 'src/jevtrain/a.ts'), true);
  assert.equal(applies({ ...NO_ANY, allow: ['src/core/'] }, 'src/core/hooks.ts.bak.ts'), false);
  assert.equal(applies({ ...NO_ANY, allow: ['src/core/hooks.ts'] }, 'src/core/hooks.tsx.ts'), true);
  assert.equal(applies({ ...NO_ANY, files: /^scripts\// }, RULE_FILE), false);
});

test('finds pattern hits on code lines, skips JS comment lines only in JS and TS files', () => {
  const text = ['const a = b as any;', '// x as any', '  /* as any */', '   * as any', 'f(x as any); // ok',
    '/** open as any', '   */', '/* lint */ const c = d as any;', '  *[Symbol.iterator]() { return e as any; }',
    '   *as any'].join('\n');
  assert.deepEqual(ruleHits(NO_ANY, 'src/a.ts', text).map(({ line }) => line), [1, 5, 8, 9, 10]);
  assert.deepEqual(ruleHits(NO_ANY, 'scripts/a.mjs', text).map(({ line }) => line), [1, 5, 8, 9, 10]);
  assert.deepEqual(ruleHits(NO_ANY, 'docs/a.md', text).map(({ line }) => line), [1, 2, 3, 4, 5, 6, 8, 9, 10]);
});

test('counts each type escape of the casts rule in code, and a @ts- directive, but no text in strings or comments', () => {
  const text = ['const a = b!.c(d!) as any;', '// e as any, f!', '  // @ts-ignore', 'const g = (h as unknown) as I;',
    "if (j !== k && !l) throw new Error('Saved! as any: any'); // done!", 'let m!: (n: string) => any;',
    'const o = p', '  .q()!;', '/** @ts-ignore */', '/*', ' * @ts-expect-error', ' */',
    'r(); // see // @ts-ignore', "const s = '// @ts-ignore' + `/* @ts-nocheck ${t} */`;"].join('\n');
  const kinds = ruleHits(casts, 'src/a.ts', text).map(({ line, message }) => `${line} ${message.split(' skips')[0]}`);
  assert.deepEqual(kinds, ['1 `as any`', '1 a non-null `!`', '1 a non-null `!`', '3 a `@ts-` directive',
    '4 `as unknown as`', '6 a definite `!`', '6 an `any` type', '8 a non-null `!`', '9 a `@ts-` directive',
    '11 a `@ts-` directive']);
});

test('takes the message of a check hit, and rejects a malformed or throwing check with the file', () => {
  const twice = { ...ONE_HIT, message: 'default', check: (body, path) => [
    { line: 2, message: `${path}: ${body.length}` }, { line: 3 }] };
  assert.deepEqual(ruleHits(twice, 'src/a.ts', 'abc'),
    [{ line: 2, message: 'src/a.ts: 3' }, { line: 3, message: 'default' }]);
  const malformed = 'check on src/a.ts must return [{ line, message? }] with line a positive integer';
  for (const result of [null, [{}], [{ line: 0 }], [{ line: '2' }], [{ line: 1, message: 5 }]]) {
    assert.throws(() => ruleHits({ ...ONE_HIT, check: () => result }, 'src/a.ts', ''), { message: malformed });
  }
  assert.throws(() => ruleHits({ ...ONE_HIT, check: () => { throw new Error('boom'); } }, 'src/a.ts', ''),
    { message: 'check on src/a.ts threw: boom' });
});

test('rejects a rule module that breaks the format', () => {
  const problem = (change, file = 'no-any.mjs') => ruleProblem({ ...NO_ANY, ...change }, file);
  assert.equal(problem({}), null);
  assert.equal(problem({ skip: /x/, tests: true, allow: ['src/a.ts'], ratchet: false }), null);
  assert.equal(ruleProblem(ONE_HIT, 'no-any.mjs'), null);
  assert.equal(ruleProblem(undefined, 'no-any.mjs'), 'needs a default export: the rule object');
  assert.equal(problem({ include: /x/, exclude: /y/ }), 'unknown key include, exclude: the keys are name, files, '
    + 'skip, tests, allow, pattern, check, message, ratchet, examples');
  assert.equal(problem({}, 'casts.mjs'), 'name must be "casts", the file name');
  assert.equal(problem({ files: 'src/' }), 'files must be a RegExp');
  assert.equal(problem({ skip: null }), 'skip must be a RegExp');
  assert.equal(problem({ tests: 'yes' }), 'tests must be true or false');
  for (const allow of ['src/jev/', [], [''], [3]]) {
    assert.equal(problem({ allow }), 'allow must be a non-empty array of file paths and folders ending in /');
  }
  const either = 'needs pattern (a RegExp) or check (a function), not both';
  assert.equal(problem({ pattern: 'as any' }), either);
  assert.equal(problem({ check: () => [] }), either);
  assert.equal(problem({ message: undefined }), 'needs message');
  assert.equal(problem({ ratchet: 'no' }), 'ratchet must be true or false');
  const lines = 'examples must be { hit: [...], miss: [...] }, neither empty, of lines';
  for (const examples of [undefined, { hit: ['x as any'] }, { hit: [], miss: ['x'] }, { hit: [{}], miss: ['x'] }]) {
    assert.equal(problem({ examples }), lines);
  }
  assert.equal(ruleProblem({ ...ONE_HIT, examples: NO_ANY.examples }, 'no-any.mjs'),
    'examples must be { hit: [...], miss: [...] }, neither empty, of { path, text }');
  assert.equal(problem({ pattern: /as any/g }), 'a RegExp must not have the g or y flag');
  assert.equal(problem({ skip: /x/y }), 'a RegExp must not have the g or y flag');
});

const FILES = { 'src/a.ts': 'x as any\ny as any\n', 'src/b.ts': 'z as any\n', 'src/c.ts': 'clean\n' };
const run = (rules, baseline = {}, broken = []) =>
  evaluate(rules, Object.keys(FILES), (path) => FILES[path], baseline, broken);
const RATCHET = { ...NO_ANY, ratchet: true };

test('reports each hit of a plain rule as a problem', () => {
  assert.deepEqual(run([NO_ANY]), { problems: [
    'src/a.ts:1: [no-any] use a real type',
    'src/a.ts:2: [no-any] use a real type',
    'src/b.ts:1: [no-any] use a real type',
  ] });
  assert.deepEqual(run([{ ...NO_ANY, allow: ['src/a.ts'] }]).problems, ['src/b.ts:1: [no-any] use a real type']);
});

test('fails a rule whose examples give the wrong result, before it reads a file', () => {
  const read = () => assert.fail('read a file');
  const broken = { ...NO_ANY, pattern: /\x08as any\x08/, examples: { hit: ['x as any'], miss: ['as'] } };
  assert.deepEqual(evaluate([broken], ['src/a.ts'], read, {}).problems,
    [`${RULE_FILE}: [no-any] hit example "x as any" has no hit`]);
  const wide = { ...NO_ANY, examples: { hit: ['x as any'], miss: ['y as any'] } };
  assert.deepEqual(evaluate([wide], ['src/a.ts'], read, {}).problems,
    [`${RULE_FILE}: [no-any] miss example "y as any" hits`]);
  const check = { ...ONE_HIT, examples: { hit: [{ path: 'src/x.ts', text: '' }], miss: CHECK_EXAMPLES.miss } };
  assert.deepEqual(evaluate([check], ['src/a.ts'], read, {}).problems,
    [`${RULE_FILE}: [no-any] hit example "src/x.ts" has no hit`]);
});

test('reads a pattern example as a line of the files the rule checks: a comment line is no code in JS or TS', () => {
  const clean = () => 'clean\n';
  const comment = { ...NO_ANY, examples: { hit: ['// x as any'], miss: ['x as unknown'] } };
  assert.deepEqual(evaluate([comment], ['src/a.ts'], clean, {}).problems, [`${RULE_FILE}: [no-any] hit example `
    + '"// x as any" has no hit: a line that is only a comment is not code in a JS or TS file']);
  assert.deepEqual(evaluate([{ ...comment, files: /\.md$/ }], ['docs/a.md'], clean, {}).problems, []);
  assert.deepEqual(evaluate([{ ...comment, files: /\.(ts|md)$/ }], ['docs/a.md', 'src/a.ts'], clean, {}).problems,
    []);
  const skipped = { ...NO_ANY, examples: { hit: ['x as any'], miss: ['  // x as any'] } };
  assert.deepEqual(evaluate([skipped], ['src/a.ts'], clean, {}).problems, []);
});

test('fails a rule that checks no file, a stale allow entry and a check that throws', () => {
  assert.deepEqual(run([{ ...NO_ANY, files: /^\.\/src\// }]).problems,
    [`${RULE_FILE}: [no-any] checks no file: fix files, skip or tests`]);
  assert.deepEqual(run([{ ...NO_ANY, allow: ['src/a.ts', 'src/gone.ts', 'src/core/', 'src'] }]).problems, [
    `${RULE_FILE}: [no-any] allow entry "src/gone.ts" names no file this rule checks: remove it`,
    `${RULE_FILE}: [no-any] allow entry "src/core/" names no file this rule checks: remove it`,
    `${RULE_FILE}: [no-any] allow entry "src" names no file this rule checks: remove it`,
  ]);
  const throws = { ...ONE_HIT, check: (text) => {
    if (text === 'clean\n') throw new Error('boom');
    return text ? [{ line: 1 }] : [];
  } };
  assert.deepEqual(run([throws]).problems, [`${RULE_FILE}: [no-any] check on src/c.ts threw: boom`]);
});

test('fails a ratchet rule above or below its baseline, passes it at the baseline', () => {
  assert.deepEqual(run([RATCHET], { 'no-any': 2 }), { problems: [
    'src/a.ts:1: [no-any] use a real type',
    'src/a.ts:2: [no-any] use a real type',
    'src/b.ts:1: [no-any] use a real type',
    `${BASELINE_FILE}: [no-any] 3 hits, baseline 2: remove the new hit, do not raise the baseline`,
  ] });
  assert.deepEqual(run([RATCHET], { 'no-any': 3 }), { problems: [] });
  assert.deepEqual(run([RATCHET], { 'no-any': 5 }).problems, [`${BASELINE_FILE}: [no-any] 3 hits, baseline 5: `
    + 'set "no-any": 3 in the same change, so the slack cannot hide a new hit']);
});

test('fails a ratchet rule with no baseline or a baseline that is not a count, and a key with no ratchet rule', () => {
  assert.deepEqual(run([RATCHET]),
    { problems: [`${BASELINE_FILE}: [no-any] no baseline: add "no-any": 3`] });
  for (const count of ['5', -1, 1.5, null]) {
    assert.deepEqual(run([RATCHET], { 'no-any': count }),
      { problems: [`${BASELINE_FILE}: [no-any] the baseline must be a whole number of 0 or more`] });
  }
  assert.deepEqual(run([], { gone: 1 }).problems,
    [`${BASELINE_FILE}: [gone] no ratchet rule has this name: remove it`]);
  assert.deepEqual(run([{ ...NO_ANY, files: /^src\/c\.ts$/ }], { 'no-any': 0 }).problems,
    [`${BASELINE_FILE}: [no-any] no ratchet rule has this name: remove it`]);
});

test('keeps the baseline key of a rule file that is broken: removing it would reset the ratchet', () => {
  assert.deepEqual(run([], { 'no-any': 3, gone: 1 }, ['no-any']).problems,
    [`${BASELINE_FILE}: [gone] no ratchet rule has this name: remove it`]);
});

test('checks no ratchet rule against a baseline that cannot be read, and still runs the other rules', () => {
  assert.deepEqual(run([RATCHET, { ...NO_ANY, name: 'plain', files: /^src\/b\.ts$/ }], null).problems,
    ['src/b.ts:1: [plain] use a real type']);
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
  const problems = result.stderr.split('\n').filter((line) => /^\S+(:\d+)?: /.test(line));
  return { code: result.status, stdout: result.stdout, problems };
}

const RULE_SOURCE = "export default { name: 'no-any', files: /\\.ts$/, pattern: /\\bas any\\b/, "
  + "message: 'use a real type', examples: { hit: ['x as any'], miss: ['x as unknown'] } };\n";

before(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plain-source-rules-')));
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  write('.gitignore', 'dist/\n');
  write(RULE_FILE, RULE_SOURCE);
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

test('reports a baseline file that does not parse or is not an object, with no stack', () => {
  try {
    write(BASELINE_FILE, '{ "no-any": 1,\n');
    const broken = check();
    assert.equal(broken.code, 1);
    assert.deepEqual(broken.problems.map((line) => line.replace(/cannot parse: .+/, 'cannot parse: <error>')),
      [`${BASELINE_FILE}: cannot parse: <error>`]);
    write(BASELINE_FILE, 'null\n');
    assert.deepEqual(check(), { code: 1, stdout: '', problems: [
      `${BASELINE_FILE}: must be a JSON object of rule names and their counts`] });
  } finally {
    rmSync(join(repo, BASELINE_FILE), { force: true });
  }
});

test('takes the rule files from git: an ignored file in the rules folder is not loaded and not reported', () => {
  try {
    write('.gitignore', 'dist/\n.DS_Store\n*~\nscratch.mjs\n');
    write(`${RULES_DIR}/.DS_Store`, '');
    write(`${RULES_DIR}/no-any.mjs~`, RULE_SOURCE);
    write(`${RULES_DIR}/scratch.mjs`, 'export default {\n');
    assert.deepEqual(check(), { code: 0, stdout: 'source rules ok: 1 rule(s)\n', problems: [] });
  } finally {
    write('.gitignore', 'dist/\n');
    for (const name of ['.DS_Store', 'no-any.mjs~', 'scratch.mjs']) rmSync(join(repo, RULES_DIR, name));
  }
});

test('fails a file in the rules folder that is not a rule, and a rule module that does not load', () => {
  write(`${RULES_DIR}/casts.js`, RULE_SOURCE);
  write(`${RULES_DIR}/old/casts.mjs`, RULE_SOURCE);
  write(`${RULES_DIR}/named.mjs`, 'export const rule = {};\n');
  write(`${RULES_DIR}/syntax.mjs`, 'export default {\n');
  symlinkSync('named.mjs', join(repo, RULES_DIR, 'linked.mjs'));
  write(BASELINE_FILE, '{ "named": 1, "syntax": 2 }\n');
  const { code, problems } = check();
  assert.equal(code, 1);
  assert.deepEqual(problems.map((line) => line.replace(/cannot load: .*/, 'cannot load: <error>')), [
    `${RULES_DIR}/casts.js: only rule files (<name>.mjs) and baseline.json go here`,
    `${RULES_DIR}/linked.mjs: only rule files (<name>.mjs) and baseline.json go here`,
    `${RULES_DIR}/old/casts.mjs: only rule files (<name>.mjs) and baseline.json go here`,
    `${RULES_DIR}/named.mjs: needs a default export: the rule object`,
    `${RULES_DIR}/syntax.mjs: cannot load: <error>`,
  ]);
});
