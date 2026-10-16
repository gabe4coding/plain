import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { artifactsObserver } from './artifacts.js';
import { parseSuiteArgs } from './options.js';
import type { Page } from 'playwright';
import type { CaptureTarget } from '../core/run-contract.js';
import type { RunObserver, SuiteOptions } from './types.js';

const base: SuiteOptions = { files: [], workers: 1, retries: 0, bail: 0, lastFailed: false, tags: [], list: false, reporters: [], timing: false };
const observer = (dir: string): RunObserver => artifactsObserver({ ...base, artifacts: { dir, screenshot: 'on-failure', trace: 'off' } })!;
const target: CaptureTarget<Page> = { engine: 'browser', async screenshot(file) { fs.writeFileSync(file, 'PNG'); } };
const start = (o: RunObserver, files: string[]) => o.runStart!({ engine: 'browser', specs: files.map((file) => ({ file, name: file, tags: [] })) });
function inTemp(t: TestContext): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plain-artifacts-safety-')));
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('refuses the cwd, its parents, home, the filesystem root and a folder holding a spec', async (t) => {
  const dir = inTemp(t);
  for (const out of ['.', '..', os.homedir(), path.parse(dir).root])
    await assert.rejects(start(observer(out), ['tests/a.yaml']), /cannot hold artifacts/);
  fs.mkdirSync('e2e');
  await assert.rejects(start(observer('e2e'), ['e2e/checkout.yaml']), /cannot hold artifacts: it contains the spec e2e\/checkout\.yaml/);
  assert.deepEqual(fs.readdirSync('e2e'), []); // nothing marked, nothing deleted
});

test('a marked folder keeps everything a run did not make', async (t) => {
  inTemp(t);
  const first = observer('out');
  await start(first, ['tests/a.yaml']);
  await first.sessionOpen!({ file: 'tests/a.yaml', name: 'a', tags: [], attempt: 0, target });
  await first.stepEnd!({ file: 'tests/a.yaml', name: 'a', tags: [], attempt: 0, target, index: 0, result: { step: 'expect', status: 'fail' } });
  await first.sessionClose!({ file: 'tests/a.yaml', name: 'a', tags: [], attempt: 0, target, status: 'fail' });
  fs.writeFileSync('out/notes.txt', 'mine');
  fs.mkdirSync('out/keep'); fs.writeFileSync('out/keep/data.json', '{}');
  await start(observer('out'), ['tests/a.yaml']);
  assert.deepEqual(fs.readdirSync('out').sort(), ['.plain-results', 'keep', 'notes.txt']);
});

test('copies pick dumps (candidates:) as well as claim dumps (state:)', async (t) => {
  inTemp(t);
  const dumps = path.join(os.tmpdir(), 'plain');
  fs.mkdirSync(dumps, { recursive: true });
  const pick = path.join(dumps, `safety-${process.pid}-pick.json`); fs.writeFileSync(pick, '{}');
  const claim = path.join(dumps, `safety-${process.pid}-claim.json`); fs.writeFileSync(claim, '{}');
  t.after(() => { fs.rmSync(pick, { force: true }); fs.rmSync(claim, { force: true }); });
  const o = observer('out');
  const info = { file: 'tests/a.yaml', name: 'a', tags: [], attempt: 0 };
  await start(o, [info.file]);
  await o.sessionOpen!({ ...info, target });
  await o.stepEnd!({ ...info, target, index: 0, result: { step: 'click', status: 'inconclusive', detail: `p=0.31 — candidates: ${pick}` } });
  await o.stepEnd!({ ...info, target, index: 1, result: { step: 'expect', status: 'fail', detail: `p=0.02 — state: ${claim}` } });
  const artifacts = await o.sessionClose!({ ...info, target, status: 'fail' });
  assert.deepEqual(artifacts.filter((a) => a.kind === 'dump').map((a) => a.step), [0, 1]);
});

test('folder names never collide by case only', async (t) => {
  inTemp(t);
  const o = observer('out');
  const files = ['X/Login.yaml', 'x-login.yaml'];
  await start(o, files);
  const dirs = new Set<string>();
  for (const file of files) {
    const info = { file, name: file, tags: [], attempt: 0 };
    await o.sessionOpen!({ ...info, target });
    await o.stepEnd!({ ...info, target, index: 0, result: { step: 'expect', status: 'fail' } });
    for (const a of await o.sessionClose!({ ...info, target, status: 'fail' })) dirs.add(path.dirname(a.path).toLowerCase());
  }
  assert.equal(dirs.size, 2);
});

test('desktop and mobile default to --trace off, so --artifacts alone works', () => {
  for (const engine of ['desktop', 'mobile'] as const) {
    const { opts } = parseSuiteArgs(['--artifacts', 'out', 'case.yaml'], engine, {}, '/tmp/plain-options-absent');
    assert.equal(opts.artifacts?.trace, 'off');
    assert.ok(artifactsObserver(opts, engine));
    const traced = parseSuiteArgs(['--artifacts', 'out', '--trace', 'always', 'case.yaml'], engine, {}, '/tmp/plain-options-absent').opts;
    assert.throws(() => artifactsObserver(traced, engine), /--trace is browser-only/);
  }
});
