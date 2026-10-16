import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readLastFailed, writeLastRun } from './last-run.js';
import type { Engine } from '../core/run-contract.js';
import type { RunReport, SpecReport } from './types.js';

const spec = (file: string, status: SpecReport['status'], flaky = false): SpecReport =>
  ({ file, name: file, tags: [], status, flaky, attempts: [] });
const report = (specs: SpecReport[], engine: Engine = 'browser'): RunReport =>
  ({ engine, specs, provider: 'typesafe', model: 'test', startedAt: new Date().toISOString(), durationMs: 100,
    status: 'fail', totals: { jevCalls: 0, tokens: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, replayed: 0, healed: 0 } });
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'plain-last-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function warnings(t: TestContext): string[] {
  const lines: string[] = [];
  const oldError = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  t.after(() => { console.error = oldError; });
  return lines;
}

for (const engine of ['browser', 'desktop', 'mobile'] as const) {
  test(`last-run ${engine} round trip preserves final statuses and absolute paths`, (t) => {
    const cwd = fixture(t);
    const entries = [spec('pass.yaml', 'pass'), spec('flaky.yaml', 'pass', true), spec('fail.yaml', 'fail'),
      spec('inconclusive.yaml', 'inconclusive'), spec('error.yaml', 'error'), spec('skipped.yaml', 'skipped'),
      spec(join(cwd, 'absolute.yaml'), 'fail')];
    const before = Date.now();
    writeLastRun(cwd, report(entries, engine));
    const saved = JSON.parse(readFileSync(join(cwd, '.plain', 'last-run.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved).sort(), ['engine', 'finishedAt', 'schemaVersion', 'specs']);
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.engine, engine);
    assert.ok(Date.parse(saved.finishedAt) >= before && Date.parse(saved.finishedAt) <= Date.now());
    assert.deepEqual(saved.specs, entries.map(({ file, status, flaky }) => ({ file: resolve(cwd, file), status, flaky })));
    assert.deepEqual(readLastFailed(cwd), new Set(entries.slice(2).map(({ file }) => resolve(cwd, file))));
    assert.deepEqual(readdirSync(join(cwd, '.plain')), ['last-run.json']);
  });
}

test('passing and empty last runs return an empty Set; later writes replace earlier failures', (t) => {
  const cwd = fixture(t);
  writeLastRun(cwd, report([spec('failed.yaml', 'fail')]));
  writeLastRun(cwd, report([spec('passing.yaml', 'pass'), spec('flaky.yaml', 'pass', true)]));
  assert.deepEqual(readLastFailed(cwd), new Set());
  writeLastRun(cwd, report([]));
  assert.deepEqual(readLastFailed(cwd), new Set());
});

test('missing last run returns undefined without warning (selection prints the fallback note)', (t) => {
  const cwd = fixture(t);
  const lines = warnings(t);
  assert.equal(readLastFailed(cwd), undefined);
  assert.deepEqual(lines, []);
});

test('unreadable last-run path returns undefined with one warning', (t) => {
  const cwd = fixture(t);
  mkdirSync(join(cwd, '.plain', 'last-run.json'), { recursive: true });
  const lines = warnings(t);
  assert.equal(readLastFailed(cwd), undefined);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not read.*last-run.json/);
});

test('malformed JSON, schemas and spec records cannot silently become no failures', (t) => {
  const cwd = fixture(t);
  mkdirSync(join(cwd, '.plain'));
  const lines = warnings(t);
  const valid = { schemaVersion: 1, finishedAt: new Date().toISOString(), engine: 'browser',
    specs: [{ file: join(cwd, 'case.yaml'), status: 'fail', flaky: false }] };
  const invalid = ['{', 'null', '{}', JSON.stringify({ ...valid, schemaVersion: 2 }),
    JSON.stringify({ ...valid, finishedAt: 'invalid' }), JSON.stringify({ ...valid, engine: 'unknown' }),
    ...[{ file: 'relative.yaml', status: 'fail', flaky: false },
      { file: join(cwd, 'case.yaml'), status: 'unknown', flaky: false },
      { file: join(cwd, 'case.yaml'), status: 'fail' }, null].map((record) => JSON.stringify({ ...valid, specs: [record] }))];
  for (const [index, value] of invalid.entries()) {
    writeFileSync(join(cwd, '.plain', 'last-run.json'), value);
    assert.equal(readLastFailed(cwd), undefined);
    assert.equal(lines.length, index + 1);
  }
});

test('duplicate failed paths are returned only once', (t) => {
  const cwd = fixture(t);
  writeLastRun(cwd, report([spec('case.yaml', 'fail'), spec('case.yaml', 'error')]));
  assert.deepEqual(readLastFailed(cwd), new Set([join(cwd, 'case.yaml')]));
});

test('write failures warn without changing the suite result', (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, '.plain'), 'not a directory');
  const lines = warnings(t);
  assert.doesNotThrow(() => writeLastRun(cwd, report([spec('case.yaml', 'pass')])));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not write last run/);
});
