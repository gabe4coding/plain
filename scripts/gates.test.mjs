// Gate floors: fails when a gate gets weaker in a way no other test sees (CODING_STANDARDS.md, "Tests"). An e2e step
// marked `optional`, a skipped or focused test, a removed `expect-fail` tag, spec or eval case, or a moved Jev
// decision threshold all keep every other check green. Each floor is the exact count: a change that adds a spec or
// case raises its floor, so that a later removal fails; a change that removes one lowers it and says why.
// The threshold and include checks read dist/, so they need a build first (`npm test` builds).
// The skip scan reads the source, so it does not see a skip or todo whose options sit in a variable (unless set to
// true), a call as `t[name]()` with a variable name, or options with a nested `}` before the key.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { expandIncludes } from '../dist/core/include.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/gates.test.mjs';

const FLOORS = {
  'e2e specs (e2e/*.yaml)': 36,
  'expect-fail e2e specs': 15,
  'claim cases (scripts/claim-cases.json)': 233,
  'claim cases that expect fail': 135,
  'pick cases (scripts/pick-cases.json)': 62,
  'read cases (scripts/read-cases.json)': 23,
  'routing cases (scripts/routing-cases.json)': 13,
  'planner cases (scripts/planner-cases.json)': 59,
};

// Files that may skip, with the hit count and the line that limits the skip to a platform the test cannot run on.
const ALLOWED_SKIPS = {
  'scripts/plugin-npx.test.mjs': { hits: 2, platform: /^const skip = process\.platform === 'win32' \? '[^']*' : false;$/m },
};

const RULE = "CODING_STANDARDS.md 'Tests': never weaken a gate.";
const weaker = (what, fix) => `a gate got weaker: ${what}. ${RULE} ${fix}`;

const read = (path) => readFileSync(join(root, path), 'utf8');
const e2eSpecs = () => readdirSync(join(root, 'e2e')).filter((name) => name.endsWith('.yaml')).sort()
  .map((name) => `e2e/${name}`);
const specDocs = (path) => parseAllDocuments(read(path)).map((doc) => doc.toJS());

/** The cases of an eval data file: the file itself or its `cases` key, as an array. */
function cases(path) {
  const data = JSON.parse(read(path));
  const list = Array.isArray(data) ? data : data?.cases;
  assert.ok(Array.isArray(list), `${path}: no case array (the file or its "cases" key); update cases() in ${SELF} to the new shape`);
  return list;
}

/** The paths (as `steps[2].optional`) of every `optional: true` in a parsed spec, at any depth. */
function optionalKeys(value, path = '') {
  if (Array.isArray(value)) return value.flatMap((item, i) => optionalKeys(item, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const at = path ? `${path}.${key}` : key;
    return [...(key === 'optional' && item === true ? [at] : []), ...optionalKeys(item, at)];
  });
}

// A skip, only or todo as a method call (on test, it, describe or the test context t; also `?.` and `['skip']`), as
// a key in the options object of a test, it, describe or suite call (also when the options sit on the next lines)
// unless set to false, or set to true anywhere.
const CALL = /(?:\.|\?\.|\[\s*['"`])(?:skip|only|todo)(?:['"`]\s*\])?\s*(?:\?\.)?\s*\(/g;
const NAME = /(['"`])(?:\\.|(?!\1)[^\\])*\1/.source;
const OPTION = new RegExp(`\\b(?:test|it|describe|suite)\\s*\\(\\s*${NAME}\\s*,\\s*\\{[^}]*?\\b(?:skip|only|todo)\\b(?!\\s*:\\s*false\\b)`, 'g');
const SET_TRUE = /\b(?:skip|only|todo)\s*:\s*true\b/g;

/** The `line: text` of each skip, only or todo in a test file's source, at the line of the word. */
function skipHits(source) {
  const lines = source.split('\n');
  const lineAt = (index) => source.slice(0, index).split('\n').length;
  const found = new Set([CALL, OPTION, SET_TRUE].flatMap((pattern) => [...source.matchAll(pattern)]
    .map((match) => lineAt(match.index + match[0].length))));
  return [...found].sort((a, b) => a - b).map((line) => `${line}: ${lines[line - 1].trim()}`);
}

/** Every test file under src/, scripts/ and mods/, this one included, as repo paths. */
function testFiles() {
  return ['src', 'scripts', 'mods'].flatMap((dir) => readdirSync(join(root, dir), { recursive: true })
    .map((name) => `${dir}/${String(name).split('\\').join('/')}`))
    .filter((path) => /\.test\.(?:ts|mjs|js)$/.test(path) && !path.includes('node_modules/'))
    .sort();
}

test('the skip detector finds calls, options and true flags, also on the next line, and not other skip keys', () => {
  // The @ inside each word keeps the samples from being hits in this file, which the scan below reads too.
  const source = [
    "test.sk@ip('a', () => {});",
    "describe.on@ly('b', () => {});",
    "test('c', { sk@ip: process.platform === 'win32' }, () => {});",
    "test(`d ${x}`, {",
    '  timeout: 5, to@do: "later",',
    '}, () => {});',
    "test('e', async (t) => { t.sk@ip('later'); });",
    "const options = { on@ly: true };",
    "test('g', (t) => { t.sk@ip?.(); t['to@do']('x'); });",
    "test('h', () => { applies({ ...RULE, skip: /x/ }); });",
    "const filter = { only: ['a'], skip };",
    "test('j', { skip: false, only: false }, () => {});",
  ].join('\n').replaceAll('@', '');
  assert.deepEqual(skipHits(source).map((hit) => Number(hit.split(':')[0])), [1, 2, 3, 5, 7, 8, 9]);
});

test('no e2e step is optional, also in an included flow', () => {
  const hits = e2eSpecs().flatMap((path) => specDocs(path).flatMap((doc) => {
    const steps = Array.isArray(doc?.steps) ? expandIncludes(doc.steps, join(root, path)) : [];
    const stepHits = steps.flatMap((step, i) => optionalKeys(step, `steps[${i}]`)
      .map((at) => (step?.origin ? `${at} (from ${step.origin})` : at)));
    return [...optionalKeys({ ...doc, steps: undefined }), ...stepHits].map((at) => `${path}: ${at}`);
  }));
  assert.deepEqual(hits, [], weaker(`optional e2e step: ${hits.join(', ')}`,
    'an e2e step must pass; fix the step, the page or the product.'));
});

test('no test is skipped, focused or left as a todo', () => {
  const problems = [];
  for (const path of testFiles()) {
    const source = read(path);
    const hits = skipHits(source);
    const allowed = ALLOWED_SKIPS[path];
    const ok = allowed ? hits.length === allowed.hits && allowed.platform.test(source) : hits.length === 0;
    if (!ok) problems.push(...hits.map((hit) => `${path}:${hit}`));
  }
  assert.deepEqual(problems, [], weaker(`skipped, focused or todo test: ${problems.join(' | ')}`,
    'if the skip only names a platform the test cannot run on, add it to ALLOWED_SKIPS in this file and say why.'));
});

test('each gate count equals its floor', () => {
  const specs = e2eSpecs();
  const expectFail = specs.filter((path) => specDocs(path)
    .some((doc) => [doc?.tags ?? []].flat().includes('expect-fail')));
  const counts = {
    'e2e specs (e2e/*.yaml)': specs.length,
    'expect-fail e2e specs': expectFail.length,
    'claim cases (scripts/claim-cases.json)': cases('scripts/claim-cases.json').length,
    'claim cases that expect fail': cases('scripts/claim-cases.json').filter((c) => c.expect === 'fail').length,
    ...Object.fromEntries(['pick', 'read', 'routing', 'planner'].map((name) => [
      `${name} cases (scripts/${name}-cases.json)`, cases(`scripts/${name}-cases.json`).length])),
  };
  assert.deepEqual(Object.keys(counts), Object.keys(FLOORS));
  const off = (compare) => Object.entries(FLOORS).filter(([what, floor]) => compare(counts[what], floor))
    .map(([what, floor]) => `${what} ${counts[what]}, floor ${floor}`);
  const drops = off((count, floor) => count < floor);
  assert.deepEqual(drops, [], weaker(drops.join('; '),
    'if the removal is right, lower the floor in this file in the same PR and say why.'));
  const behind = off((count, floor) => count > floor);
  assert.deepEqual(behind, [], `a gate floor is behind the count: ${behind.join('; ')}. raise the floor in ${SELF} `
    + 'to the count in this change, so that a later removal fails.');
});

test('the Jev decision thresholds stay at 0.9 pass, 0.1 fail and 0.5 pick', async () => {
  const { decide } = await import('../dist/jev/decide.js');
  const just = 1e-9;
  const got = {
    'expect at 0.9': decide(0.9, 'expect'), 'expect just below 0.9': decide(0.9 - just, 'expect'),
    'expect at 0.1': decide(0.1, 'expect'), 'expect just above 0.1': decide(0.1 + just, 'expect'),
    'pick at 0.5': decide(0.5, 'pick'), 'pick just below 0.5': decide(0.5 - just, 'pick'),
  };
  assert.deepEqual(got, {
    'expect at 0.9': 'pass', 'expect just below 0.9': 'inconclusive',
    'expect at 0.1': 'fail', 'expect just above 0.1': 'inconclusive',
    'pick at 0.5': 'pass', 'pick just below 0.5': 'inconclusive',
  }, weaker('a Jev decision threshold in src/jev/decide.ts moved',
    'a threshold change needs eval evidence and the matching change of this test.'));
});
