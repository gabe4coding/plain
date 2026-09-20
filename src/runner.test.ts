import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from './spec.js';
import { runSpec } from './runner.js';

const OPTS = { headed: false, timeout: 5000 };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jev-e2e-runner-test-'));
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
