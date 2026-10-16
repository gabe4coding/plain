import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { artifactsObserver } from './artifacts.js';
import { parseSuiteArgs } from './options.js';
import { runSuite } from './run-suite.js';
import type { CaptureTarget, Engine, SpecInfo } from '../core/run-contract.js';
import type { RunObserver, SuiteOptions } from './types.js';
import type { Status } from '../core/results.js';

const base: SuiteOptions = { files: ['case.yaml'], workers: 1, retries: 0, bail: 0, lastFailed: false,
  tags: [], list: false, reporters: [], timing: false };
const info: SpecInfo = { file: 'tests/login.yaml', name: 'login', tags: [], attempt: 0 };
function temp(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function options(dir: string, screenshot: 'off' | 'on-failure' | 'always' = 'on-failure',
  trace: 'off' | 'on-failure' | 'always' = 'off'): SuiteOptions {
  return { ...base, artifacts: { dir, screenshot, trace } };
}
function target(engine: Engine = 'browser'): CaptureTarget<Page> {
  return { engine, async screenshot(file) { fs.writeFileSync(file, 'PNG'); } };
}
async function start(observer: RunObserver, engine: Engine = 'browser', files = [info.file]): Promise<void> {
  await observer.runStart!({ engine, specs: files.map((file) => ({ file, name: file, tags: [] })) });
}
async function attempt(observer: RunObserver, capture: CaptureTarget<Page>, data = info, status: Status = 'fail') {
  await observer.sessionOpen!({ ...data, target: capture });
  await observer.stepEnd!({ ...data, target: capture, index: 0, result: { step: 'expect', status } });
  return observer.sessionClose!({ ...data, target: capture, status });
}

test('capture stays off without a directory, and modes alone warn once', (t) => {
  assert.equal(artifactsObserver(base), null);
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => messages.push(message));
  const parsed = parseSuiteArgs(['--screenshot', 'always', '--trace', 'off', 'case.yaml'], 'browser', {}, temp(t), () => ({}));
  assert.equal(artifactsObserver(parsed.opts), null);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /no effect without --artifacts/);
});

test('run start creates the marker, accepts an empty folder, and cleans only marked output', async (t) => {
  const root = temp(t);
  const dir = path.join(root, 'results');
  const observer = artifactsObserver(options(dir))!;
  await start(observer);
  assert.equal(fs.readFileSync(path.join(dir, '.plain-results'), 'utf8'), 'plain results\n');
  fs.mkdirSync(path.join(dir, 'old', 'attempt-0'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'old', 'attempt-0', 'trace.zip'), 'old');
  await start(observer);
  assert.deepEqual(fs.readdirSync(dir), ['.plain-results']);
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  await start(artifactsObserver(options(empty))!);
  assert.ok(fs.existsSync(path.join(empty, '.plain-results')));
});

test('foreign folders remain intact and the failed observer never writes later', async (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'precious.txt'), 'keep');
  const observer = artifactsObserver(options(dir, 'always'))!;
  await assert.rejects(start(observer), /exists and was not created by plain/);
  assert.deepEqual(await attempt(observer, target()), []);
  assert.deepEqual(fs.readdirSync(dir), ['precious.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'precious.txt'), 'utf8'), 'keep');
});

test('symlinked output folders and symlinked markers never authorize deletion', async (t) => {
  const root = temp(t);
  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, '.plain-results'), 'marker');
  fs.writeFileSync(path.join(foreign, 'keep'), 'keep');
  const link = path.join(root, 'link');
  fs.symlinkSync(foreign, link, 'dir');
  await assert.rejects(start(artifactsObserver(options(link))!), /was not created by plain/);
  const dir = path.join(root, 'results');
  fs.mkdirSync(dir);
  fs.symlinkSync(path.join(foreign, '.plain-results'), path.join(dir, '.plain-results'));
  await assert.rejects(start(artifactsObserver(options(dir))!), /was not created by plain/);
  assert.equal(fs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'keep');
});

test('on-failure screenshots capture failures across all engines, excluding pass and skipped', async (t) => {
  for (const engine of ['browser', 'desktop', 'mobile'] as const) {
    const dir = path.join(temp(t), engine);
    const observer = artifactsObserver(options(dir), engine)!;
    await start(observer, engine);
    const capture = target(engine);
    await observer.sessionOpen!({ ...info, target: capture });
    const statuses: Status[] = ['pass', 'fail', 'error', 'inconclusive', 'skipped'];
    for (const [index, status] of statuses.entries())
      await observer.stepEnd!({ ...info, target: capture, index, result: { step: 'expect', status } });
    const artifacts = await observer.sessionClose!({ ...info, target: capture, status: 'fail' });
    assert.deepEqual(artifacts.map((a) => [path.basename(a.path), a.step, a.kind]), [
      ['step-1-fail.png', 1, 'screenshot'], ['step-2-error.png', 2, 'screenshot'], ['step-3-inconclusive.png', 3, 'screenshot'],
    ]);
    assert.ok(artifacts.every((a) => path.isAbsolute(a.path) && fs.existsSync(a.path)));
  }
});

test('always adds final.png to failure-only step shots; off removes empty attempts', async (t) => {
  const dir = temp(t);
  const observer = artifactsObserver(options(dir, 'always'))!;
  await start(observer);
  const artifacts = await attempt(observer, target(), info, 'pass');
  assert.deepEqual(artifacts.map((a) => path.basename(a.path)), ['final.png']);
  assert.equal(artifacts[0].step, undefined);
  const off = artifactsObserver(options(dir, 'off'))!;
  await start(off);
  assert.deepEqual(await attempt(off, target()), []);
  assert.deepEqual(fs.readdirSync(dir), ['.plain-results']);
});

test('parallel specs, colliding slugs, retries, and duplicate inputs have distinct folders', async (t) => {
  const dir = temp(t);
  const files = ['tests/a b.yaml', 'tests/a-b.yaml', 'tests/a/b.yaml', 'tests/a-b-2.yaml'];
  const observer = artifactsObserver(options(dir))!;
  await start(observer, 'browser', files);
  const results = await Promise.all(files.map((file) => attempt(observer, target(), { ...info, file })));
  const paths = results.flat().map((a) => a.path);
  assert.equal(new Set(paths).size, 4);
  assert.ok(paths[0].endsWith(path.join('tests-a-b.yaml', 'attempt-0', 'step-0-fail.png')));
  assert.ok(paths.every((file) => /^[A-Za-z0-9._-]+$/.test(path.basename(path.dirname(path.dirname(file))))));
  const retried = await attempt(observer, target(), { ...info, file: files[0], attempt: 1 });
  assert.equal(path.dirname(path.dirname(retried[0].path)), path.dirname(path.dirname(paths[0])));
  assert.ok(retried[0].path.includes('attempt-1'));
  const duplicate = await attempt(observer, target(), { ...info, file: files[0] });
  assert.ok(!paths.includes(duplicate[0].path));
});

test('absolute spec paths slug relative to cwd and long slugs stay writable', async (t) => {
  const dir = temp(t);
  const observer = artifactsObserver(options(dir))!;
  const file = path.resolve('tests', 'unicode ü.yaml');
  await start(observer, 'browser', [file]);
  const artifacts = await attempt(observer, target(), { ...info, file });
  assert.ok(artifacts[0].path.includes(path.join('tests-unicode--.yaml', 'attempt-0')));
  const long = await attempt(observer, target(), { ...info, file: `${'a'.repeat(260)}.yaml` });
  assert.ok(fs.existsSync(long[0].path));
});

test('dump details are copied, retain originals, and carry their step index', async (t) => {
  const root = temp(t);
  const dumpRoot = path.join(os.tmpdir(), 'plain');
  fs.mkdirSync(dumpRoot, { recursive: true });
  const source = path.join(dumpRoot, `${path.basename(root)} state.json`);
  fs.writeFileSync(source, '{"state":"saved"}');
  t.after(() => fs.rmSync(source, { force: true }));
  const outside = path.join(root, 'unrelated.json');
  fs.writeFileSync(outside, 'not evidence');
  const observer = artifactsObserver(options(path.join(root, 'results'), 'off'))!;
  await start(observer);
  const capture = target();
  await observer.sessionOpen!({ ...info, target: capture });
  await observer.stepEnd!({ ...info, target: capture, index: 3, result: {
    step: 'expect', status: 'inconclusive', detail: `p=0.5 — state: ${source} | note — state: ${outside}`,
  } });
  const artifacts = await observer.sessionClose!({ ...info, target: capture, status: 'inconclusive' });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, 'dump');
  assert.equal(artifacts[0].step, 3);
  assert.equal(fs.readFileSync(artifacts[0].path, 'utf8'), fs.readFileSync(source, 'utf8'));
  assert.ok(fs.existsSync(source));
});

test('capture failures warn once, remove partial files, and preserve other evidence', async (t) => {
  const dir = temp(t);
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => messages.push(message));
  const observer = artifactsObserver(options(dir, 'always', 'always'))!;
  await start(observer);
  const capture: CaptureTarget<Page> = { engine: 'browser', page() { throw new Error('page gone'); }, async screenshot(file) {
    fs.writeFileSync(file, 'partial'); throw new Error('device gone');
  } };
  assert.deepEqual(await attempt(observer, capture), []);
  assert.equal(messages.length, 1);
  assert.deepEqual(fs.readdirSync(dir), ['.plain-results']);
});

test('missing dumps and trace stop failures preserve successfully written screenshots', async (t) => {
  const dir = temp(t);
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => messages.push(message));
  const observer = artifactsObserver(options(dir, 'always', 'always'))!;
  await start(observer);
  const capture: CaptureTarget<Page> = { ...target(), page: () => ({ context: () => ({ tracing: {
    async start() {}, async stop(opts: { path: string }) { fs.writeFileSync(opts.path, 'partial'); throw new Error('trace gone'); },
  } }) }) as unknown as Page };
  await observer.sessionOpen!({ ...info, target: capture });
  await observer.stepEnd!({ ...info, target: capture, index: 0, result: { step: 'expect', status: 'fail',
    detail: `state: ${path.join(os.tmpdir(), 'plain', `${path.basename(dir)}-missing.json`)}` } });
  const artifacts = await observer.sessionClose!({ ...info, target: capture, status: 'fail' });
  assert.deepEqual(artifacts.map((a) => a.kind), ['screenshot', 'screenshot']);
  assert.equal(messages.length, 1);
  assert.ok(!fs.existsSync(path.join(path.dirname(artifacts[0].path), 'trace.zip')));
});

test('folder and screenshot failures share one warning budget across attempts', async (t) => {
  const dir = temp(t);
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => messages.push(message));
  const observer = artifactsObserver(options(dir, 'always'))!;
  await start(observer);
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', ((folder: fs.PathLike, opts: fs.MakeDirectoryOptions) => {
    if (String(folder).endsWith('attempt-0')) throw new Error('cannot create attempt folder');
    return mkdir(folder, opts);
  }) as typeof mkdir);
  assert.deepEqual(await attempt(observer, target()), []);
  const broken = { ...target(), async screenshot() { throw new Error('screenshot failed'); } };
  assert.deepEqual(await attempt(observer, broken, { ...info, attempt: 1 }), []);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /cannot create attempt folder/);
});

test('foreign output errors are logged once by the suite and do not change spec results', async (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'keep'), 'keep');
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => messages.push(message));
  const opts = { ...options(dir), files: ['first.yaml', 'second.yaml'] };
  const report = await runSuite({ engine: 'desktop', maxWorkers: 1, load: (file) => file,
    meta: (name) => ({ name, tags: [] }), async run(name, observer, data) {
      const capture = target('desktop');
      await attempt(observer!, capture, data, 'pass');
      return { name, status: 'pass', steps: [], jevCalls: 0, totalTokens: 0 };
    } }, opts, { provider: () => 'typesafe', warmUp: () => {} });
  assert.equal(report.status, 'pass');
  assert.ok(report.specs.every((spec) => spec.attempts[0].artifacts.length === 0));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /was not created by plain/);
  assert.equal(fs.readFileSync(path.join(dir, 'keep'), 'utf8'), 'keep');
});

test('native tracing is rejected at creation before engine runs', async (t) => {
  for (const engine of ['desktop', 'mobile'] as const) {
    const opts = options(path.join(temp(t), engine), 'off', 'on-failure');
    assert.throws(() => artifactsObserver(opts, engine), /--trace is browser-only/);
    let ran = false;
    await assert.rejects(runSuite({ engine, maxWorkers: 1, load: () => ({}), meta: () => ({ name: 'case', tags: [] }),
      async run() { ran = true; throw new Error('must not run'); } }, opts), /--trace is browser-only/);
    assert.equal(ran, false);
    assert.ok(artifactsObserver(options(opts.artifacts!.dir), engine));
  }
});

test('CDP targets skip tracing and print one note while still capturing screenshots', async (t) => {
  const dir = temp(t);
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => messages.push(message));
  const observer = artifactsObserver(options(dir, 'on-failure', 'always'))!;
  await start(observer);
  for (const attemptNumber of [0, 1]) {
    const capture = { ...target(), cdp: true, page(): Page { throw new Error('must not touch tracing'); } };
    const artifacts = await attempt(observer, capture, { ...info, attempt: attemptNumber });
    assert.deepEqual(artifacts.map((a) => a.kind), ['screenshot']);
  }
  assert.equal(messages.length, 1);
  assert.match(messages[0], /tracing skipped for --cdp/);
});

test('trace start and stop use the original context even after the active page changes', async (t) => {
  const calls: unknown[] = [];
  const tracing = { async start(opts: unknown) { calls.push(opts); }, async stop(opts?: { path: string }) {
    calls.push(opts); if (opts) fs.writeFileSync(opts.path, 'ZIP');
  } };
  let pageChanged = false;
  const capture: CaptureTarget<Page> = { ...target(), page: () => {
    assert.equal(pageChanged, false);
    return { context: () => ({ tracing }) } as unknown as Page;
  } };
  const observer = artifactsObserver(options(temp(t), 'off', 'always'))!;
  await start(observer);
  await observer.sessionOpen!({ ...info, target: capture });
  pageChanged = true;
  const artifacts = await observer.sessionClose!({ ...info, target: capture, status: 'pass' });
  assert.deepEqual(calls[0], { screenshots: true, snapshots: true, sources: false });
  assert.deepEqual(calls[1], { path: artifacts[0].path });
  assert.equal(artifacts[0].kind, 'trace');
});
