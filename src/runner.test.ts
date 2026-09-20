import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from './spec.js';
import { runSpec, sharedBrowser, closeSharedBrowser, mapLimit } from './runner.js';
import { chromium } from 'playwright';

const OPTS = { headed: false, timeout: 5000 };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'plainwright-runner-test-'));
}

function writeSpec(dir: string, yaml: string): string {
  const path = join(dir, 'spec.yaml');
  writeFileSync(path, yaml);
  return path;
}

// hooks.mjs modules append one JSON line per lifecycle event to this file, so a test can assert
// both the order of events and the data each hook actually received.
function readEvents(dir: string): Array<Record<string, unknown>> {
  const path = join(dir, 'events.json');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('setup runs before steps and teardown after; hooks data flows into ${hooks.*} and into teardown', async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'hooks.mjs'),
    `
import { appendFileSync } from 'node:fs';
const log = new URL('./events.json', import.meta.url);
function record(e) { appendFileSync(log, JSON.stringify(e) + '\\n'); }
export async function setup() {
  record({ event: 'setup' });
  return { lease: { id: 7 } };
}
export async function teardown({ data, result }) {
  record({ event: 'teardown', leaseId: data.lease.id, status: result.status });
}
`
  );
  const specPath = writeSpec(
    dir,
    `
name: hooks basic
url: https://example.com
hooks: ./hooks.mjs
steps:
  - goto: "data:text/html,<h1>hi</h1>"
  - goto: "data:text/html,<p>\${hooks.lease.id}</p>"
`
  );

  const result = await runSpec(loadSpec(specPath), OPTS);

  assert.equal(result.status, 'pass');
  assert.equal(result.steps[0].step, 'setup');
  assert.equal(result.steps[0].status, 'pass');
  const last = result.steps[result.steps.length - 1];
  assert.equal(last.step, 'teardown');
  assert.equal(last.status, 'pass');

  const events = readEvents(dir);
  assert.deepEqual(events.map((e) => e.event), ['setup', 'teardown']);
  assert.equal(events[1].leaseId, 7);
  assert.equal(events[1].status, 'pass');
});

test('a step error still runs teardown, overall status is error', async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'hooks.mjs'),
    `
import { appendFileSync } from 'node:fs';
const log = new URL('./events.json', import.meta.url);
export async function teardown({ result }) {
  appendFileSync(log, JSON.stringify({ event: 'teardown', status: result.status }) + '\\n');
}
`
  );
  const specPath = writeSpec(
    dir,
    `
name: step error
url: https://example.com
hooks: ./hooks.mjs
steps:
  - goto: "http://127.0.0.1:9"
`
  );

  const result = await runSpec(loadSpec(specPath), OPTS);

  assert.equal(result.status, 'error');
  const events = readEvents(dir);
  assert.deepEqual(events.map((e) => e.event), ['teardown']);
  assert.equal(events[0].status, 'error');
});

test('a teardown error marks the overall run as error, with its own step entry', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'hooks.mjs'), `export async function teardown() { throw new Error('boom'); }\n`);
  const specPath = writeSpec(
    dir,
    `
name: teardown throws
url: https://example.com
hooks: ./hooks.mjs
steps:
  - goto: "data:text/html,<h1>hi</h1>"
`
  );

  const result = await runSpec(loadSpec(specPath), OPTS);

  assert.equal(result.status, 'error');
  const last = result.steps[result.steps.length - 1];
  assert.equal(last.step, 'teardown');
  assert.equal(last.status, 'error');
  assert.match(last.detail ?? '', /boom/);
});

test('a setup error skips steps and teardown entirely', async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'hooks.mjs'),
    `
import { appendFileSync } from 'node:fs';
const log = new URL('./events.json', import.meta.url);
export async function setup() { throw new Error('setup boom'); }
export async function teardown() {
  appendFileSync(log, JSON.stringify({ event: 'teardown' }) + '\\n');
}
`
  );
  const specPath = writeSpec(
    dir,
    `
name: setup throws
url: https://example.com
hooks: ./hooks.mjs
steps:
  - goto: "data:text/html,<h1>hi</h1>"
`
  );

  const result = await runSpec(loadSpec(specPath), OPTS);

  assert.equal(result.status, 'error');
  assert.deepEqual(result.steps, [{ step: 'setup', status: 'error', detail: 'setup boom' }]);
  assert.equal(existsSync(join(dir, 'events.json')), false);
});

const HI_SPEC = 'name: hi\nurl: "data:text/html,<h1>hi</h1>"\nsteps:\n  - goto: "data:text/html,<h1>hi</h1>"\n';

test('--profile: the persistent profile dir is created and the run passes', async () => {
  const dir = tempDir();
  const profile = join(dir, 'profile');
  const result = await runSpec(loadSpec(writeSpec(dir, HI_SPEC)), { ...OPTS, profile });
  assert.equal(result.status, 'pass');
  assert.ok(existsSync(join(profile, 'Default')), 'Chromium wrote a profile into the dir');
});

test('--cdp: attaches to a running browser, works in its own tab, leaves the browser running', async () => {
  const port = 9300 + Math.floor(Math.random() * 500);
  const running = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  try {
    const dir = tempDir();
    const result = await runSpec(loadSpec(writeSpec(dir, HI_SPEC)), { ...OPTS, cdp: `http://127.0.0.1:${port}` });
    assert.equal(result.status, 'pass');
    assert.ok(running.isConnected(), 'the attached-to browser is still alive after close()');
    assert.equal(running.contexts().flatMap((c) => c.pages()).length, 0, 'the tab we opened was closed');
  } finally {
    await running.close();
  }
});

test('--cdp rejects a spec with auth (cannot be applied to an existing context)', async () => {
  const dir = tempDir();
  const spec = loadSpec(writeSpec(dir, 'name: a\nurl: "data:text/html,<h1>hi</h1>"\nauth: { user: u, pass: p }\nsteps:\n  - goto: "data:text/html,<h1>hi</h1>"\n'));
  await assert.rejects(runSpec(spec, { ...OPTS, cdp: 'http://127.0.0.1:1' }), /--cdp attaches/);
});

test('sharedBrowser reuses one Chromium for the same options; closeSharedBrowser tears it down', async () => {
  const a = await sharedBrowser(OPTS);
  const b = await sharedBrowser(OPTS);
  assert.equal(a, b, 'same options reuse the same Browser instance');
  await closeSharedBrowser();
  assert.equal(a.isConnected(), false, 'closed after closeSharedBrowser()');
});

test('mapLimit runs at most `limit` tasks concurrently and resolves results in input order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const run = async (i: number): Promise<number> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight--;
    return i;
  };

  const results = await mapLimit([0, 1, 2, 3], 2, run);

  assert.deepEqual(results, [0, 1, 2, 3], 'results are in input order');
  assert.equal(maxInFlight, 2, 'never more than `limit` tasks in flight');
});
