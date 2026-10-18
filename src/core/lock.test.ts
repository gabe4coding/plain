import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryKey, formatLock, LOCK_UPGRADE_NOTICE, LOCK_VERSION, LockStore, parseLock, type LockIO, type LockRef } from './lock.js';

const memory = (): LockIO & { files: Map<string, string> } => {
  const files = new Map<string, string>();
  return { files, read: (file) => files.get(file), write: (file, text) => void files.set(file, text) };
};
const ref = (index: number): LockRef => ({ at: { file: '/specs/go.yaml', index }, kind: 'click', slot: 'target:the Go button' });
const entry = { locator: { strategy: 'role', parts: [] }, text: "getByRole('button', { name: 'Go', exact: true })" };

test('auto-healing replays on the first attempt only; a retry asks Jev; no-judge always replays; judge never does', () => {
  assert.equal(new LockStore('auto-healing').attempt(0).replays, true);
  assert.equal(new LockStore('auto-healing').attempt(1).replays, false);
  assert.equal(new LockStore('no-judge').attempt(2).replays, true);
  assert.equal(new LockStore('judge').attempt(0).replays, false);
});

test('a passed attempt writes its passed steps; a failed step, a failed attempt and no-judge write nothing', () => {
  const io = memory();
  const store = new LockStore('judge', io);
  const attempt = store.attempt();
  attempt.record(ref(1), entry);
  attempt.endStep({ status: 'pass' });
  attempt.record(ref(2), entry);
  attempt.endStep({ status: 'fail' });
  attempt.finish(true);
  assert.deepEqual(store.write(), ['/specs/go.lock.json']);
  assert.deepEqual([...parseLock(io.files.get('/specs/go.lock.json')!)!.entries.keys()], [entryKey(ref(1))]);

  const failed = new LockStore('judge', memory());
  const handle = failed.attempt();
  handle.record(ref(1), entry);
  handle.endStep({ status: 'pass' });
  handle.finish(false);
  assert.deepEqual(failed.write(), []);

  const replayOnly = new LockStore('no-judge', memory());
  const replay = replayOnly.attempt();
  replay.record(ref(1), entry);
  replay.endStep({ status: 'pass' });
  replay.finish(true);
  assert.deepEqual(replayOnly.write(), []);
});

test('only a passed healed step counts as healed', () => {
  const attempt = new LockStore('auto-healing', memory()).attempt();
  attempt.endStep({ status: 'fail', healed: true, replayed: true });
  attempt.endStep({ status: 'pass', healed: true });
  attempt.endStep({ status: 'pass', replayed: true });
  assert.deepEqual([attempt.healed, attempt.replayed], [1, 2]);
});

test('the file is deterministic, in step order, and a file of another version is ignored', () => {
  const entries = new Map([[entryKey(ref(3)), entry], [entryKey(ref(1)), entry]]);
  const text = formatLock(entries);
  assert.ok(text.indexOf('[1,') < text.indexOf('[3,'), 'entries in step order');
  assert.equal(formatLock(parseLock(text)!.entries), text);
  assert.equal(parseLock(text.replace(`"version": ${LOCK_VERSION}`, '"version": 0')), null);
  const legacy = parseLock(text.replace(`"version": ${LOCK_VERSION}`, '"version": 1'));
  assert.equal(legacy?.version, 1);
  assert.equal(legacy?.entries.size, 2);
});

test('a version 1 lock is read, and the upgrade notice is one line', () => {
  const io = memory();
  const text = formatLock(new Map([[entryKey(ref(1)), entry]])).replace(`"version": ${LOCK_VERSION}`, '"version": 1');
  io.files.set('/specs/go.lock.json', text);
  const lines: string[] = [];
  const error = console.error;
  console.error = (line?: unknown) => { lines.push(String(line)); };
  try {
    const store = new LockStore('no-judge', io);
    assert.deepEqual(store.get(ref(1)), entry);
    assert.equal(store.versionOf('/specs/go.yaml'), 1);
    store.get(ref(1));
  } finally {
    console.error = error;
  }
  assert.deepEqual(lines, [`plain: ${LOCK_UPGRADE_NOTICE}: /specs/go.lock.json`]);
});
