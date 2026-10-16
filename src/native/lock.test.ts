import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockStore, type LockIO, type RunMode } from '../core/lock.js';
import type { Intelligence } from '../core/automation.js';
import type { SpecInfo } from '../core/run-contract.js';
import { fakeIntelligence, refusingIntelligence } from '../core/fake-intelligence.test.js';
import { ComputerSession, runComputerSpec } from '../computer/session.js';
import { loadComputerSpec } from '../computer/spec.js';
import { MobileSession, runMobileSpec } from '../mobile/session.js';
import { loadMobileSpec } from '../mobile/spec.js';
import { FakeComputerAdapter, FakeMobileAdapter } from './fake-adapter.test.js';
import { nativeIdentity } from './session.js';

// The lock code is shared, but each platform wires its own session and spec runner to it, so every run mode
// test runs on both.
const PLATFORMS = ['desktop', 'mobile'] as const;
type Platform = typeof PLATFORMS[number];
type App = FakeComputerAdapter | FakeMobileAdapter;

/** The spec lines that name the Mail app. */
const TARGET: Record<Platform, string> = { desktop: 'app: Mail\n', mobile: 'platform: android\ndevice: emulator-5554\napp: Mail\n' };

/** A Mail app whose controls and screen text the test sets; a click sends the mail. */
function mail(platform: Platform): App {
  const app = platform === 'desktop' ? new FakeComputerAdapter() : new FakeMobileAdapter();
  app.title = 'Mail';
  app.text = 'Mail ready';
  app.controls = [
    { id: 0, desc: 'button "Send" in window "Mail"' },
    { id: 1, desc: 'button "Cancel" in window "Mail"' },
    { id: 2, desc: 'text_field "To" value="" in window "Mail"' },
  ];
  app.handle = (c) => c.desc;
  app.onAct = (kind) => { if (kind === 'click') app.text = 'Mail sent'; };
  return app;
}

function runOn(app: App, file: string, ai: Intelligence, info: SpecInfo) {
  return app instanceof FakeComputerAdapter
    ? runComputerSpec(loadComputerSpec(file), new ComputerSession(app, 100, ai), undefined, info)
    : runMobileSpec(loadMobileSpec(file), new MobileSession(app, 100, ai), undefined, info);
}

function setup(t: { after: (fn: () => void) => void }, platform: Platform) {
  const dir = mkdtempSync(join(tmpdir(), 'plain-native-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'send.yaml');
  writeFileSync(file, `name: send\n${TARGET[platform]}steps:\n  - fill: { target: the To field, value: ada@example.test }\n` +
    '  - click: the Send button\n  - expect: the mail was sent\n');
  const files = new Map<string, string>();
  const io: LockIO = { read: (path) => files.get(path), write: (path, text) => void files.set(path, text) };
  const calls = { pick: 0, judge: 0 };
  const ai = fakeIntelligence({
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
  });
  const noJev = refusingIntelligence('no-judge');
  const run = async (app: App, mode: RunMode) => {
    const store = new LockStore(mode, io);
    const lock = store.attempt();
    const result = await runOn(app, file, mode === 'no-judge' ? noJev : ai, { file, name: 'send', tags: [], attempt: 0, lock });
    lock.finish(result.status === 'pass');
    store.write();
    return result;
  };
  return { run, calls, app: () => mail(platform), lock: () => files.get(join(dir, 'send.lock.json')) ?? '' };
}

/** One test per platform, with the platform in front of its name. */
function onBothPlatforms(name: string, fn: (t: TestContext, platform: Platform) => Promise<void>) {
  for (const platform of PLATFORMS) test(`${platform}: ${name}`, (t) => fn(t, platform));
}

test('nativeIdentity drops the value and the state flags, and keeps role, name and context', () => {
  assert.equal(nativeIdentity('text_field "To" value="ada" [focused] in window "Mail"'), 'text_field "To" in window "Mail"');
});

onBothPlatforms('judge records, no-judge replays with no Jev call, auto-healing heals a renamed button', async (t, platform) => {
  const s = setup(t, platform);
  const judged = await s.run(s.app(), 'judge');
  assert.equal(judged.status, 'pass', JSON.stringify(judged.steps));
  assert.match(s.lock(), /"identity": "button \\"Send\\" in window \\"Mail\\""/);
  assert.match(s.lock(), /"identity": "text_field \\"To\\" in window \\"Mail\\""/);
  assert.doesNotMatch(s.lock(), /ada@example/, 'a typed value never lands in the lock');

  const replay = await s.run(s.app(), 'no-judge');
  assert.equal(replay.status, 'pass', JSON.stringify(replay.steps));
  assert.deepEqual(replay.steps.map((step) => step.replayed ?? false), [true, true, false]);
  assert.match(replay.steps[2].detail!, /recorded passing state/);

  const renamed = s.app();
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

onBothPlatforms('a step that fails with its replayed element is healed by Jev', async (t, platform) => {
  const s = setup(t, platform);
  await s.run(s.app(), 'judge');
  // The recorded Send button is still there but refuses the click; a new Submit button works.
  const app = s.app();
  app.controls.push({ id: 3, desc: 'button "Submit" in window "Mail"' });
  app.onAct = (kind, element) => {
    if (kind === 'click' && element === 'button "Send" in window "Mail"') throw new Error('Send is disabled');
    if (kind === 'click') app.text = 'Mail sent';
  };
  const healed = await s.run(app, 'auto-healing');
  assert.equal(healed.status, 'pass', JSON.stringify(healed.steps));
  assert.equal(healed.steps[1].healed, true);
  assert.equal(healed.steps[1].replayed, undefined, 'the passing attempt picked every target with Jev');
  assert.match(healed.steps[1].detail!, /\(healed; replayed element failed: Send is disabled\)/);
});

onBothPlatforms('a step with no lock entry is a Jev pick, not a heal', async (t, platform) => {
  const s = setup(t, platform);
  const fresh = await s.run(s.app(), 'auto-healing');
  assert.equal(fresh.status, 'pass', JSON.stringify(fresh.steps));
  assert.deepEqual(fresh.steps.map((step) => step.healed ?? false), [false, false, false]);
  assert.doesNotMatch(JSON.stringify(fresh.steps), /healed/);
});

onBothPlatforms('a value that changes each run keeps one entry per step and replays in no-judge', async (t, platform) => {
  const dir = mkdtempSync(join(tmpdir(), 'plain-native-values-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PLAIN_LOCK_TITLE; });
  const file = join(dir, 'open.yaml');
  writeFileSync(file, `name: open\n${TARGET[platform]}env:\n  title: $PLAIN_LOCK_TITLE\nsteps:\n` +
    '  - click: the Open button of the ${env.title} message\n  - expect: the ${env.title} message is open\n');
  const files = new Map<string, string>();
  const io: LockIO = { read: (path) => files.get(path), write: (path, text) => void files.set(path, text) };
  const app = (title: string) => {
    const inbox = mail(platform);
    inbox.controls = [{ id: 0, desc: `button "Open" in cell "${title}"` }, { id: 1, desc: 'button "Open" in cell "Other"' }];
    inbox.onAct = () => { inbox.text = `Opened ${title}`; };
    return inbox;
  };
  const ai = fakeIntelligence({
    pick: async (candidates, targets) => targets.map((target) => ({ tokens: 1, probability: 0.97, confidence: 0.97, probabilities: {},
      id: candidates.find((c) => c.desc.includes(/of the (.*) message/.exec(target)![1]))?.id ?? null })),
    judge: async (state, claims) => ({ tokens: 1, probabilities: claims.map((claim) =>
      ((state as { aria: string }).aria === `Opened ${/the (.*) message/.exec(claim)![1]}` ? 0.97 : 0.02)) }),
  });
  const run = async (title: string, mode: RunMode) => {
    process.env.PLAIN_LOCK_TITLE = title;
    const store = new LockStore(mode, io);
    const lock = store.attempt();
    const result = await runOn(app(title), file, ai, { file, name: 'open', tags: [], attempt: 0, lock });
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

onBothPlatforms('one of two identical controls replays by its order, and misses when a third twin appears', async (t, platform) => {
  const s = setup(t, platform);
  const twins = (count: number) => {
    const app = s.app();
    app.controls = [{ id: 0, desc: 'text_field "To" value="" in window "Mail"' },
      ...Array.from({ length: count }, (_, i) => ({ id: i + 1, desc: 'button "Send" in window "Mail"' }))];
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

onBothPlatforms('a control whose container text changed replays by role and name while no other control has them', async (t, platform) => {
  const s = setup(t, platform);
  assert.equal((await s.run(s.app(), 'judge')).status, 'pass');
  // The window is now named by its content (a list that grew), as an Android container often is.
  const renamed = s.app();
  renamed.controls = renamed.controls.map((c) => ({ ...c, desc: c.desc.replace('in window "Mail"', 'in window "Mail Inbox 12 messages"') }));
  const replayed = await s.run(renamed, 'no-judge');
  assert.equal(replayed.status, 'pass', JSON.stringify(replayed.steps));
  assert.equal(replayed.steps[1].replayed, true);
});
