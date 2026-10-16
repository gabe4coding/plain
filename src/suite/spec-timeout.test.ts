import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSpec } from '../browser/runner.js';
import { sharedBrowser, closeSharedBrowser } from '../browser/session.js';
import { NativeSession, type NativeAdapter } from '../native/session.js';
import { runNativeSpec } from '../native/run-spec.js';
import { mobileLabel, type MobileStep } from '../mobile/spec.js';
import { checkSpecTimeoutFlag } from './spec-timeout.js';
import { specDeadline } from '../core/spec-deadline.js';
import { checkSpecTimeout, loadSpec, type Spec } from '../core/spec.js';
import { loadComputerSpec } from '../computer/spec.js';
import { loadMobileSpec } from '../mobile/spec.js';
import { validate } from './validate.js';
import type { SuiteEngine } from './types.js';

const opts = { headed: false, timeout: 10000 };
after(closeSharedBrowser);
function fixture(t: import('node:test').TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hooks = path.join(dir, 'hooks.mjs');
  const events = path.join(dir, 'events.json');
  fs.writeFileSync(hooks, `import { writeFileSync } from 'node:fs';
    export function teardown({data, result}) { writeFileSync(${JSON.stringify(events)}, JSON.stringify({data, result})); }`);
  const spec: Spec = { name: 'timeout', dir, hooks, url: 'about:blank', dialogs: 'accept', steps: [{ kind: 'goto', url: 'about:blank' }] };
  return { dir, hooks, events, spec };
}

test('timeout and browser fields load and validate for every supported engine without a key', (t) => {
  const { dir } = fixture(t);
  checkSpecTimeoutFlag(1000);
  checkSpecTimeoutFlag();
  checkSpecTimeout({ timeout: 1000 }, 'spec.yaml');
  for (const value of [0, -1, .5, Infinity, NaN]) {
    assert.throws(() => checkSpecTimeoutFlag(value), /--spec-timeout must be/);
    assert.throws(() => checkSpecTimeout({ timeout: value }, 'spec.yaml'), /timeout must be/);
  }
  const files = [
    ['browser.yaml', 'url: about:blank\nbrowser: { colorScheme: dark }\nsteps: [{goto: about:blank}]', loadSpec],
    ['desktop.yaml', 'app: Fixture\nsteps: [{press: Enter}]', loadComputerSpec],
    ['mobile.yaml', 'platform: android\ndevice: fixture\napp: app.fixture\nsteps: [{press: Enter}]', loadMobileSpec],
  ] as const;
  for (const [name, body, load] of files) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `name: fixture\ntimeout: 1000\n${body}\n`);
    const engine: SuiteEngine<unknown> = { engine: 'browser', load, maxWorkers: 1, meta: () => ({ name: 'fixture', tags: [] }), run: async () => { throw Error('not run'); } };
    assert.deepEqual(validate(engine, [file]), [{ file, warnings: [] }]);
  }
});

test('browser timeout cuts an optional slow goto, reports its origin, runs teardown and closes the page', async (t) => {
  const { spec, events, dir } = fixture(t);
  await sharedBrowser(opts);
  const url = 'data:text/html,' + encodeURIComponent('<img src="https://fixture.invalid/slow">');
  let page: import('playwright').Page | undefined;
  let requested = false;
  const order: string[] = [];
  const result = await runSpec({ ...spec, timeout: 1500, browser: { saveState: 'state.json' }, steps: [
    { kind: 'goto', url, optional: true, origin: 'flows/slow.yaml' },
    { kind: 'goto', url: 'about:blank' },
  ] }, opts, {
    sessionOpen: async ({ target }) => {
      order.push('open'); page = target.page!();
      await page.route('https://fixture.invalid/slow', () => { requested = true; });
    },
    stepEnd: async ({ result }) => { order.push(result.step === 'teardown' ? 'teardown' : 'step'); },
    sessionClose: async ({ status, target }) => { order.push('close'); assert.equal(status, 'error'); assert.equal(target.page!().isClosed(), false); return []; },
  });
  assert.equal(requested, true, 'the slow step actually started');
  assert.equal(result.status, 'error');
  assert.deepEqual(result.steps[0], { step: `flows/slow.yaml › goto ${url}`, status: 'error', detail: 'spec timeout after 1500 ms' });
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].step, 'teardown');
  assert.equal(JSON.parse(fs.readFileSync(events, 'utf8')).result.status, 'error');
  assert.equal(page!.isClosed(), true);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  assert.deepEqual(order, ['open', 'step', 'teardown', 'close']);
});

test('browser setup consumes the budget, and an expired first step is never started', async (t) => {
  const { spec, hooks, events } = fixture(t);
  fs.appendFileSync(hooks, '\nexport async function setup() { await new Promise(r => setTimeout(r, 150)); return {lease: 7}; }');
  let navigations = 0;
  const result = await runSpec({ ...spec, timeout: 100 }, opts, {
    sessionOpen: async ({ target }) => { target.page!().on('framenavigated', () => navigations++); },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.steps[0].step, 'setup');
  assert.equal(result.steps[1].detail, 'spec timeout after 100 ms');
  assert.equal(navigations, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(events, 'utf8')).data, { lease: 7 });
});

test('browser spec timeout overrides the flag; the flag supplies a budget when omitted', async (t) => {
  const { spec } = fixture(t);
  const passed = await runSpec({ ...spec, timeout: 10000 }, { ...opts, specTimeout: 1 });
  assert.equal(passed.status, 'pass');
  const timedOut = await runSpec(spec, { ...opts, specTimeout: 1 });
  assert.equal(timedOut.status, 'error');
  assert.equal(timedOut.steps[0].detail, 'spec timeout after 1 ms');
});

class SlowAdapter implements NativeAdapter<unknown, string> {
  actions: string[] = [];
  closed = false;
  reject?: (error: Error) => void;
  async capture() { return { snapshot: { url: 'native://fixture', title: 'Fixture', aria: '', truncated: false }, candidates: [], elements: new Map() }; }
  async press(key: string) {
    this.actions.push(key);
    if (key === 'slow') await new Promise<void>((_resolve, reject) => { this.reject = reject; });
  }
  async screenshot() { return Buffer.from('png'); }
  async close() { this.closed = true; this.reject?.(new Error('closed')); }
}
class SlowSession extends NativeSession<unknown, string, MobileStep, SlowAdapter> {
  parse(): MobileStep { throw Error('not used'); }
  label(step: MobileStep) { return mobileLabel(step); }
  protected async act(step: MobileStep, name: string) {
    await this.adapter.press(step.kind === 'press' ? step.key : step.kind);
    return { step: name, status: 'pass' as const };
  }
}

test('desktop and mobile timeouts stop optional slow actions, retain labels, and teardown before closing', async (t) => {
  const { hooks, events } = fixture(t);
  for (const mobile of [false, true]) {
    const adapter = new SlowAdapter();
    const session = new SlowSession(adapter);
    const steps: MobileStep[] = mobile
      ? [{ kind: 'swipe', direction: 'up', within: 'list', origin: 'flow.yaml', optional: true }, { kind: 'press', key: 'next' }]
      : [{ kind: 'press', key: 'slow', origin: 'flow.yaml', optional: true }, { kind: 'press', key: 'next' }];
    if (mobile) adapter.press = async (key) => { adapter.actions.push(key); await new Promise<void>((_resolve, reject) => { adapter.reject = reject; }); };
    const spec = { name: 'native', env: {}, hooks, steps, ...(mobile ? { platform: 'android' } : {}) };
    const order: string[] = [];
    const result = await runNativeSpec(spec, session, async () => steps, {
      sessionOpen: async () => { order.push('open'); },
      stepEnd: async () => { order.push('step'); },
      sessionClose: async () => { assert.equal(adapter.closed, false); order.push('close'); return []; },
    }, undefined, 1000);
    assert.equal(result.status, 'error');
    assert.deepEqual(result.steps, [{ step: mobile ? 'flow.yaml › swipe up within "list"' : 'flow.yaml › press slow', status: 'error', detail: 'spec timeout after 1000 ms' }]);
    assert.equal(adapter.actions.length, 1);
    assert.equal(adapter.closed, true);
    assert.equal(JSON.parse(fs.readFileSync(events, 'utf8')).result.status, 'error');
    assert.deepEqual(order, ['open', 'step', 'close']);
  }
});

test('native setup time consumes the budget and spec timeout overrides the flag', async (t) => {
  const { hooks, events } = fixture(t);
  fs.appendFileSync(hooks, '\nexport async function setup() { await new Promise(r => setTimeout(r, 150)); return {lease: 7}; }');
  const steps: MobileStep[] = [{ kind: 'press', key: 'Enter' }];
  for (const timeout of [undefined, 10000]) {
    const adapter = new SlowAdapter();
    const result = await runNativeSpec({ name: 'native', env: {}, hooks, steps, timeout }, new SlowSession(adapter), async () => steps, undefined, undefined, 100);
    assert.equal(result.status, timeout === undefined ? 'error' : 'pass');
    assert.deepEqual(adapter.actions, timeout === undefined ? [] : ['Enter']);
    if (timeout === undefined) assert.equal(result.steps[0].detail, 'spec timeout after 100 ms');
    assert.equal(adapter.closed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(events, 'utf8')).data, { lease: 7 });
  }
});

test('deadline is shared across steps and observers, supports no cap and long caps, and handles late rejections', async () => {
  const deadline = specDeadline(30);
  assert.equal((await deadline.step(async () => ({ step: 'first', status: 'pass' }), () => 'first')).status, 'pass');
  await new Promise(r => setTimeout(r, 40));
  let called = false;
  assert.equal((await deadline.step(async () => { called = true; return { step: 'second', status: 'pass' }; }, () => 'second')).status, 'error');
  assert.equal(called, false);
  for (const cap of [undefined, 3_000_000_000])
    assert.equal((await specDeadline(cap).step(async () => ({ step: 'fast', status: 'pass' }), () => 'fast')).status, 'pass');
  let reject!: (error: Error) => void;
  const late = await specDeadline(10).step(() => new Promise((_resolve, fail) => { reject = fail; }), () => 'late');
  assert.equal(late.detail, 'spec timeout after 10 ms');
  reject(new Error('late failure'));
});
