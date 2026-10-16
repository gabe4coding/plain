import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockStore, type LockIO, type RunMode } from '../core/lock.js';
import type { Frame, Intelligence } from '../core/automation.js';
import type { Candidate } from '../core/candidate.js';
import { ComputerSession, runComputerSpec } from '../computer/session.js';
import { loadComputerSpec } from '../computer/spec.js';
import type { ComputerAdapter } from '../computer/adapter.js';
import { nativeIdentity } from './session.js';

/** A desktop app whose controls and screen text the test sets; it logs each action. */
class App implements ComputerAdapter<string> {
  log: unknown[] = [];
  controls: Candidate[] = [
    { id: 0, desc: 'button "Send" in window "Mail"' },
    { id: 1, desc: 'button "Cancel" in window "Mail"' },
    { id: 2, desc: 'text_field "To" value="" in window "Mail"' },
  ];
  text = 'Mail ready';
  async apps() { return [{ name: 'Mail', pid: 42 }]; }
  async open() { return { name: 'Mail', pid: 42 }; }
  async capture(): Promise<Frame<string>> {
    return { snapshot: { url: 'desktop://42', title: 'Mail', aria: this.text, truncated: false }, candidates: this.controls,
      elements: new Map(this.controls.map((c) => [c.id, c.desc])) };
  }
  async act(...args: unknown[]) { this.log.push(args); if (args[0] === 'click') this.text = 'Mail sent'; }
  async press() {}
  async mouse() {}
  async drag() {}
  async scroll() {}
  async screenshot() { return Buffer.from(''); }
  async close() {}
}

function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'plain-native-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'send.yaml');
  writeFileSync(file, 'name: send\napp: Mail\nsteps:\n  - fill: { target: the To field, value: ada@example.test }\n' +
    '  - click: the Send button\n  - expect: the mail was sent\n');
  const files = new Map<string, string>();
  const io: LockIO = { read: (path) => files.get(path), write: (path, text) => void files.set(path, text) };
  const calls = { pick: 0, judge: 0 };
  const ai: Intelligence = {
    pick: async (candidates, targets) => {
      calls.pick++;
      // The To field, else the Submit button where one exists, else Send.
      const first = (pattern: RegExp) => candidates.find((c) => pattern.test(c.desc))?.id;
      return targets.map((target) => ({ id: (/To field/.test(target) ? first(/^text_field "To"/) : first(/^button "Submit"/) ?? first(/^button "Send"/)) ?? null,
        probability: 0.97, confidence: 0.97, probabilities: {}, tokens: 5 }));
    },
    judge: async (state, claims) => {
      calls.judge++;
      return { probabilities: claims.map(() => (/sent/.test((state as { aria: string }).aria) ? 0.97 : 0.02)), tokens: 3 };
    },
  };
  const noJev: Intelligence = {
    pick: async () => { throw new Error('no-judge called pick'); },
    judge: async () => { throw new Error('no-judge called judge'); },
  };
  const run = async (app: App, mode: RunMode) => {
    const store = new LockStore(mode, io);
    const lock = store.attempt();
    const session = new ComputerSession(app, 100, mode === 'no-judge' ? noJev : ai);
    const result = await runComputerSpec(loadComputerSpec(file), session, undefined, { file, name: 'send', tags: [], attempt: 0, lock });
    lock.finish(result.status === 'pass');
    store.write();
    return result;
  };
  return { run, calls, lock: () => files.get(join(dir, 'send.lock.json')) ?? '' };
}

test('desktop: nativeIdentity drops the value and the state flags, and keeps role, name and context', () => {
  assert.equal(nativeIdentity('text_field "To" value="ada" [focused] in window "Mail"'), 'text_field "To" in window "Mail"');
});

test('desktop: judge records, no-judge replays with no Jev call, auto-healing heals a renamed button', async (t) => {
  const s = setup(t);
  const judged = await s.run(new App(), 'judge');
  assert.equal(judged.status, 'pass', JSON.stringify(judged.steps));
  assert.match(s.lock(), /"identity": "button \\"Send\\" in window \\"Mail\\""/);
  assert.match(s.lock(), /"identity": "text_field \\"To\\" in window \\"Mail\\""/);
  assert.doesNotMatch(s.lock(), /ada@example/, 'a typed value never lands in the lock');

  const replay = await s.run(new App(), 'no-judge');
  assert.equal(replay.status, 'pass', JSON.stringify(replay.steps));
  assert.deepEqual(replay.steps.map((step) => step.replayed ?? false), [true, true, false]);
  assert.match(replay.steps[2].detail!, /recorded passing state/);

  const renamed = new App();
  renamed.controls[0] = { id: 0, desc: 'button "Submit" in window "Mail"' };
  const stale = await s.run(renamed, 'no-judge');
  assert.equal(stale.steps[1].status, 'inconclusive');
  assert.match(stale.steps[1].detail!, /^no-judge: recorded element .*matched 0 elements, 1 expected/);

  const before = { ...s.calls };
  const healed = await s.run(renamed, 'auto-healing');
  assert.equal(healed.status, 'pass', JSON.stringify(healed.steps));
  assert.equal(healed.steps[1].healed, true);
  assert.match(healed.steps[1].detail!, /\(healed; recorded element .*matched 0 elements, 1 expected\)$/);
  assert.equal(healed.steps[0].replayed, true);
  assert.equal(s.calls.pick, before.pick + 1);
  assert.match(s.lock(), /button \\"Submit\\"/);
});

test('desktop: a step that fails with its replayed element is healed by Jev', async (t) => {
  const s = setup(t);
  await s.run(new App(), 'judge');
  // The recorded Send button is still there but refuses the click; a new Submit button works.
  const app = new App();
  app.controls.push({ id: 3, desc: 'button "Submit" in window "Mail"' });
  app.act = async (...args: unknown[]) => {
    app.log.push(args);
    if (args[0] === 'click' && args[1] === 'button "Send" in window "Mail"') throw new Error('Send is disabled');
    if (args[0] === 'click') app.text = 'Mail sent';
  };
  const healed = await s.run(app, 'auto-healing');
  assert.equal(healed.status, 'pass', JSON.stringify(healed.steps));
  assert.equal(healed.steps[1].healed, true);
  assert.equal(healed.steps[1].replayed, undefined, 'the passing attempt picked every target with Jev');
  assert.match(healed.steps[1].detail!, /\(healed; replayed element failed: Send is disabled\)/);
});

test('desktop: a step with no lock entry is a Jev pick, not a heal', async (t) => {
  const s = setup(t);
  const fresh = await s.run(new App(), 'auto-healing');
  assert.equal(fresh.status, 'pass', JSON.stringify(fresh.steps));
  assert.deepEqual(fresh.steps.map((step) => step.healed ?? false), [false, false, false]);
  assert.doesNotMatch(JSON.stringify(fresh.steps), /healed/);
});

test('desktop: a value that changes each run keeps one entry per step and replays in no-judge', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'plain-native-values-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PLAIN_LOCK_TITLE; });
  const file = join(dir, 'open.yaml');
  writeFileSync(file, 'name: open\napp: Mail\nenv:\n  title: $PLAIN_LOCK_TITLE\nsteps:\n' +
    '  - click: the Open button of the ${env.title} message\n  - expect: the ${env.title} message is open\n');
  const files = new Map<string, string>();
  const io: LockIO = { read: (path) => files.get(path), write: (path, text) => void files.set(path, text) };
  const app = (title: string) => {
    const mail = new App();
    mail.controls = [{ id: 0, desc: `button "Open" in cell "${title}"` }, { id: 1, desc: 'button "Open" in cell "Other"' }];
    mail.act = async () => { mail.text = `Opened ${title}`; };
    return mail;
  };
  const ai: Intelligence = {
    pick: async (candidates, targets) => targets.map((target) => ({ tokens: 1, probability: 0.97, confidence: 0.97, probabilities: {},
      id: candidates.find((c) => c.desc.includes(/of the (.*) message/.exec(target)![1]))?.id ?? null })),
    judge: async (state, claims) => ({ tokens: 1, probabilities: claims.map((claim) =>
      ((state as { aria: string }).aria === `Opened ${/the (.*) message/.exec(claim)![1]}` ? 0.97 : 0.02)) }),
  };
  const run = async (title: string, mode: RunMode) => {
    process.env.PLAIN_LOCK_TITLE = title;
    const store = new LockStore(mode, io);
    const lock = store.attempt();
    const result = await runComputerSpec(loadComputerSpec(file), new ComputerSession(app(title), 100, ai), undefined,
      { file, name: 'open', tags: [], attempt: 0, lock });
    lock.finish(result.status === 'pass');
    store.write();
    return result;
  };
  assert.equal((await run('Plain 1234', 'judge')).status, 'pass');
  const first = files.get(join(dir, 'open.lock.json'))!;
  assert.doesNotMatch(first, /Plain 1234/);
  const replayed = await run('Plain 5678', 'no-judge');
  assert.equal(replayed.status, 'pass', JSON.stringify(replayed.steps));
  assert.equal(replayed.steps[0].replayed, true);
  await run('Plain 9999', 'judge');
  assert.deepEqual(Object.keys(JSON.parse(files.get(join(dir, 'open.lock.json'))!).entries), Object.keys(JSON.parse(first).entries));
});

test('desktop: one of two identical controls replays by its order, and misses when a third twin appears', async (t) => {
  const s = setup(t);
  const twins = (count: number) => {
    const app = new App();
    app.controls = [{ id: 0, desc: 'text_field "To" value="" in window "Mail"' },
      ...Array.from({ length: count }, (_, i) => ({ id: i + 1, desc: 'button "Send" in window "Mail"' }))];
    app.act = async (...args: unknown[]) => { app.log.push(args); if (args[0] === 'click') app.text = 'Mail sent'; };
    return app;
  };
  assert.equal((await s.run(twins(2), 'judge')).status, 'pass');
  assert.match(s.lock(), /"ordinal": 0,\s*"of": 2/);
  const pair = await s.run(twins(2), 'no-judge');
  assert.equal(pair.steps[1].status, 'pass', JSON.stringify(pair.steps));
  const three = await s.run(twins(3), 'no-judge');
  assert.equal(three.steps[1].status, 'inconclusive');
  assert.match(three.steps[1].detail!, /matched 3 elements, 2 expected/);
});

test('desktop: a control whose container text changed replays by role and name while no other control has them', async (t) => {
  const s = setup(t);
  assert.equal((await s.run(new App(), 'judge')).status, 'pass');
  // The window is now named by its content (a list that grew), as an Android container often is.
  const renamed = new App();
  renamed.controls = renamed.controls.map((c) => ({ ...c, desc: c.desc.replace('in window "Mail"', 'in window "Mail Inbox 12 messages"') }));
  const replayed = await s.run(renamed, 'no-judge');
  assert.equal(replayed.status, 'pass', JSON.stringify(replayed.steps));
  assert.equal(replayed.steps[1].replayed, true);
});
