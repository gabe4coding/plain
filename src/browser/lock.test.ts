import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { intelligence } from '../core/automation.js';
import { LOCK_VERSION, type RunMode } from '../core/lock.js';
import { loadSpec } from '../core/spec.js';
import { runSpec } from './runner.js';
import { closeSharedBrowser } from './session.js';
import { runSuite } from '../suite/run-suite.js';
import type { SuiteOptions } from '../suite/types.js';

// Clicking a button writes "Clicked <name>"; the claim checks it. `label` renames the first button.
const page = (label = 'Go', extra = '') => `<main><section><h2>Actions</h2>${extra}<button onclick="document.body.insertAdjacentHTML('beforeend', ` +
  `'<p>Clicked ${label}</p>')">${label}</button><button onclick="document.body.insertAdjacentHTML('beforeend', '<p>Clicked Stop</p>')">Stop</button>` +
  '</section><label>Name <input readonly></label><label>Full name <input></label></main>';
const url = (html: string) => `data:text/html,${encodeURIComponent(html)}`;

/** A spec dir, a fake Jev that counts its calls, and a runner per mode. Jev picks the first button and the field. */
function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-lock-'));
  const file = path.join(dir, 'go.yaml');
  const saved = { ...intelligence };
  const calls = { pick: 0, judge: 0 };
  const logs: string[] = [];
  let judgeFails = false;
  let pickScore = 0.97;
  intelligence.ask = async (_state, questions) => ({ tokens: 0, answers: questions.map(() => ({ choice: 'semantic', confidence: 1 })) });
  intelligence.pick = async (candidates, targets) => {
    calls.pick++;
    return targets.map((target, i) => {
      const wanted = /field/.test(target) ? /^input label="Full name"/ : /^button "(Go|Start)"/;
      return { id: candidates.find((c) => wanted.test(c.desc))?.id ?? null, probability: pickScore, confidence: pickScore,
        probabilities: {}, tokens: i === 0 ? 50 : 0 };
    });
  };
  intelligence.judge = async (state, claims) => {
    calls.judge++;
    const { aria } = state as { aria: string };
    return { probabilities: claims.map(() => (!judgeFails && /Clicked (Go|Start)/.test(aria) ? 0.97 : 0.02)), tokens: 3 };
  };
  t.after(async () => {
    Object.assign(intelligence, saved);
    await closeSharedBrowser();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (html: string, steps = '  - click: the first action button\n  - expect: the first action was clicked\n') =>
    fs.writeFileSync(file, `name: go\nurl: "${url(html)}"\nsteps:\n  - goto: "${url(html)}"\n${steps}`);
  const run = async (mode: RunMode, timeout = 5000) => {
    const opts: SuiteOptions = { files: [file], workers: 1, retries: 0, bail: 0, lastFailed: false, tags: [], list: false, reporters: [],
      timing: false, mode };
    const engine = { engine: 'browser' as const, maxWorkers: Infinity, load: loadSpec,
      meta: (spec: ReturnType<typeof loadSpec>) => ({ name: spec.name, tags: [] }),
      run: (spec: ReturnType<typeof loadSpec>, observer: Parameters<typeof runSpec>[2], info: Parameters<typeof runSpec>[3]) =>
        runSpec(spec, { headed: false, timeout }, observer, info) };
    // no-judge must never ask for a key.
    const services = { provider: () => { if (mode === 'no-judge') throw new Error('no-judge asked for a key'); return 'typesafe' as const; },
      warmUp: () => {} };
    const cwd = process.cwd(), error = console.error;
    process.chdir(dir); console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      const report = await runSuite(engine, opts, services);
      return { report, steps: report.specs[0].attempts[0].steps };
    } finally {
      process.chdir(cwd); console.error = error;
    }
  };
  const lock = () => JSON.parse(fs.readFileSync(path.join(dir, 'go.lock.json'), 'utf8')) as { version: number; entries: Record<string, Record<string, unknown>> };
  return { write, run, lock, calls, logs, file, dir, failJudge: (on: boolean) => { judgeFails = on; }, scorePicks: (score: number) => { pickScore = score; } };
}

test('judge records the lock; no-judge replays it with no Jev call', async (t) => {
  const s = setup(t);
  s.write(page());
  const judged = await s.run('judge');
  assert.equal(judged.report.status, 'pass', JSON.stringify(judged.steps));
  assert.deepEqual(s.calls, { pick: 1, judge: 1 });
  const lock = s.lock();
  assert.equal(lock.version, LOCK_VERSION);
  const [target, claims] = Object.entries(lock.entries);
  assert.deepEqual(JSON.parse(target[0]), [1, 'click', 'target:the first action button']);
  assert.equal(target[1].text, "getByRole('button', { name: 'Go', exact: true })");
  assert.deepEqual(JSON.parse(claims[0]), [2, 'expect', 'claims:["the first action was clicked"]']);
  assert.match(claims[1].state as string, /^[0-9a-f]{64}$/);
  assert.equal(claims[1].spatial, false);
  assert.doesNotMatch(JSON.stringify(lock), /Clicked/, 'a claim keeps a hash, never page text');

  const replayed = await s.run('no-judge');
  assert.equal(replayed.report.status, 'pass', JSON.stringify(replayed.steps));
  assert.deepEqual(s.calls, { pick: 1, judge: 1 }, 'no Jev call');
  assert.equal(replayed.report.specs[0].attempts[0].jevCalls, 0);
  assert.equal(replayed.steps[1].replayed, true);
  assert.match(replayed.steps[1].detail!, /getByRole\('button', \{ name: 'Go', exact: true \}\) \(replayed\)/);
  assert.match(replayed.steps[2].detail!, /recorded passing state/);
  assert.equal(replayed.report.totals.replayed, 1);
});

test('a version 1 lock replays locators in no-judge and asks to re-record', async (t) => {
  const s = setup(t);
  s.write(page());
  assert.equal((await s.run('judge')).report.status, 'pass');
  const lock = s.lock();
  lock.version = 1;
  fs.writeFileSync(path.join(s.dir, 'go.lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const replayed = await s.run('no-judge');
  assert.equal(replayed.report.status, 'pass', JSON.stringify(replayed.steps));
  assert.equal(replayed.steps[1].replayed, true);
  assert.match(replayed.steps[1].detail!, /replayed/);
  assert.match(replayed.steps[2].detail!, /recorded passing state/);
  assert.equal(replayed.report.specs[0].attempts[0].jevCalls, 0);
  assert.match(s.logs.join('\n'), /re-record to upgrade lock file/);
});

test('a version 1 claim hash that does not match is judged again', async (t) => {
  const s = setup(t);
  s.write(page());
  assert.equal((await s.run('judge')).report.status, 'pass');
  const lock = s.lock();
  lock.version = 1;
  for (const entry of Object.values(lock.entries)) if (typeof entry.state === 'string') entry.state = '0'.repeat(64);
  fs.writeFileSync(path.join(s.dir, 'go.lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const replayed = await s.run('no-judge', 8000);
  assert.equal(replayed.report.status, 'pass', JSON.stringify(replayed.steps));
  assert.equal(replayed.steps[1].replayed, true);
  assert.equal(s.calls.pick, 1, 'the locator still replays');
  assert.equal(s.calls.judge, 2, 'the stale hash is judged again');
  assert.doesNotMatch(replayed.steps[2].detail ?? '', /no recorded/);
  assert.equal(s.lock().version, 1, 'no-judge does not rewrite the lock');
});

test('a renamed button: no-judge is inconclusive, auto-healing picks again and rewrites the lock', async (t) => {
  const s = setup(t);
  s.write(page());
  await s.run('judge');
  s.write(page('Start'));
  const stale = await s.run('no-judge');
  assert.equal(stale.steps[1].status, 'inconclusive');
  assert.match(stale.steps[1].detail!, /^no-judge: recorded locator .*'Go'.* matched no element; run with --mode auto-healing/);

  const healed = await s.run('auto-healing');
  assert.equal(healed.report.status, 'pass', JSON.stringify(healed.steps));
  assert.equal(healed.steps[1].healed, true);
  assert.match(healed.steps[1].detail!, /\(healed; recorded locator .*'Go'.* matched no element\)$/);
  assert.equal(healed.report.totals.healed, 1);
  assert.deepEqual(s.calls, { pick: 2, judge: 2 }, 'Jev picked once more and judged the claim');
  assert.match(JSON.stringify(s.lock()), /name: 'Start'/);

  const again = await s.run('no-judge');
  assert.equal(again.report.status, 'pass', JSON.stringify(again.steps));
});

test('a step with no lock entry is a Jev pick, not a heal', async (t) => {
  const s = setup(t);
  s.write(page());
  const fresh = await s.run('auto-healing');
  assert.equal(fresh.report.status, 'pass', JSON.stringify(fresh.steps));
  assert.equal(fresh.steps[1].healed, undefined);
  assert.doesNotMatch(fresh.steps[1].detail!, /healed/);
  assert.equal(fresh.report.totals.healed, 0);
});

test('a healed step names its reason once, also when it resolves the target again', async (t) => {
  const s = setup(t);
  // Once a pick tags the section, the page renders it again (a new element): the wait resolves its region again,
  // and the recorded locator misses again for the same reason.
  const panel = (name: string) => `<main><section aria-label="${name}"><h2>Orders</h2><p>Loading</p></section></main><script>` +
    "let done = false; new MutationObserver(() => { const s = document.querySelector('section'); " +
    "if (done || !s.hasAttribute('data-jev-id')) return; done = true; setTimeout(() => { const n = document.createElement('section'); " +
    "n.setAttribute('aria-label', s.getAttribute('aria-label')); n.innerHTML = '<h2>Orders</h2><p>Ready</p>'; s.replaceWith(n); }, 1000); })" +
    ".observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-jev-id'] });</script>";
  intelligence.pick = async (candidates, targets) => targets.map(() =>
    ({ id: candidates.find((c) => c.desc.startsWith('section'))?.id ?? null, probability: 0.97, confidence: 0.97, probabilities: {}, tokens: 1 }));
  intelligence.judge = async (state, claims) =>
    ({ probabilities: claims.map(() => (/Ready/.test((state as { aria: string }).aria) ? 0.97 : 0.02)), tokens: 1 });
  const steps = '  - wait:\n      that: the orders are ready\n      within: the orders panel\n';
  s.write(panel('Orders'), steps);
  const judged = await s.run('judge', 10000);
  assert.equal(judged.report.status, 'pass', JSON.stringify(judged.steps));
  s.write(panel('Order list'), steps);
  const healed = await s.run('auto-healing', 10000);
  assert.equal(healed.report.status, 'pass', JSON.stringify(healed.steps));
  assert.equal(healed.steps[1].healed, true);
  assert.match(healed.steps[1].detail!, /\(healed; recorded locator [^;]*'Orders'[^;]* matched no element\)$/);
});

test('auto-healing replays a passing locator and still lets Jev judge every claim', async (t) => {
  const s = setup(t);
  s.write(page());
  await s.run('judge');
  const healing = await s.run('auto-healing');
  assert.equal(healing.report.status, 'pass');
  assert.equal(healing.steps[1].replayed, true);
  assert.deepEqual(s.calls, { pick: 1, judge: 2 });
});

test('a step that fails with its replayed locator is healed by Jev; a failed attempt writes nothing', async (t) => {
  const s = setup(t);
  // Recorded on the editable "Name" field; later that field is read-only and a "Full name" field takes its place.
  s.write(page().replace('<label>Name <input readonly>', '<label>Name <input>').replace('<label>Full name <input></label>', ''),
    '  - fill:\n      target: the name field\n      value: Ada\n');
  intelligence.pick = async (candidates, targets) => targets.map(() =>
    ({ id: candidates.find((c) => c.desc.startsWith('input label="Name"'))!.id, probability: 0.97, confidence: 0.97, probabilities: {}, tokens: 1 }));
  assert.equal((await s.run('judge')).report.status, 'pass');
  const recorded = JSON.stringify(s.lock());
  s.write(page(), '  - fill:\n      target: the name field\n      value: Ada\n');
  const pickFullName = intelligence.pick;
  intelligence.pick = async (candidates, targets) => targets.map(() =>
    ({ id: candidates.find((c) => c.desc.startsWith('input label="Full name"'))!.id, probability: 0.97, confidence: 0.97, probabilities: {}, tokens: 1 }));
  const healed = await s.run('auto-healing', 1500);
  assert.equal(healed.report.status, 'pass', JSON.stringify(healed.steps));
  assert.equal(healed.steps[1].healed, true);
  assert.equal(healed.steps[1].replayed, undefined, 'the passing attempt picked every target with Jev');
  assert.match(healed.steps[1].detail!, /\(healed; replayed locator failed: /);
  assert.notEqual(JSON.stringify(s.lock()), recorded);
  intelligence.pick = pickFullName;

  // A failing attempt keeps the lock as it was.
  s.write(page('Start'));
  const before = JSON.stringify(s.lock());
  s.failJudge(true);
  assert.equal((await s.run('auto-healing')).report.status, 'fail');
  assert.equal(JSON.stringify(s.lock()), before);
});

test('no-judge: a claim whose page differs from the recorded state is inconclusive; a marginal pick replays only in no-judge', async (t) => {
  const s = setup(t);
  s.write(page());
  await s.run('judge');
  s.write(page('Go', '<p>New banner</p>'));
  const changed = await s.run('no-judge');
  assert.equal(changed.steps[2].status, 'inconclusive');
  assert.equal(changed.steps[1].status, 'pass', 'the button locator still holds');
  assert.match(changed.steps[2].detail!, /^no-judge: the page differs from the recorded passing state — state: /);

  const fresh = setup(t);
  fresh.write(page());
  fresh.scorePicks(0.7);
  assert.equal((await fresh.run('judge')).report.status, 'pass');
  assert.match(JSON.stringify(fresh.lock()), /"marginal":true/);
  const replay = await fresh.run('no-judge');
  assert.equal(replay.report.status, 'pass', JSON.stringify(replay.steps));
  assert.equal(replay.steps[1].replayed, true);
  const healing = await fresh.run('auto-healing');
  assert.equal(healing.report.status, 'pass');
  assert.equal(fresh.calls.pick, 2, 'auto-healing asks Jev again for a marginal pick');
  assert.equal(healing.steps[1].healed, undefined, 'a marginal pick asked again is not a heal');
  assert.equal(healing.report.totals.healed, 0);
});

test('a value that changes each run: one entry per step, no value in the lock, and no-judge replays with the new value', async (t) => {
  const s = setup(t);
  const titled = (title: string) => `<main><article><h3>${title}</h3><p>Starts 15 Nov</p><button onclick="document.body.insertAdjacentHTML(` +
    `'beforeend', '<p>Opened ${title}</p>')">Open</button></article><article><h3>Other event</h3><button>Open</button></article></main>`;
  const write = (title: string) => {
    process.env.PLAIN_LOCK_TITLE = title;
    fs.writeFileSync(s.file, `name: go\nurl: "${url(titled(title))}"\nenv:\n  title: $PLAIN_LOCK_TITLE\nsteps:\n` +
      `  - goto: "${url(titled(title))}"\n  - click: the Open button of the \${env.title} event\n  - expect: the \${env.title} event was opened\n`);
  };
  t.after(() => { delete process.env.PLAIN_LOCK_TITLE; });
  intelligence.pick = async (candidates, targets) => targets.map((target) => {
    const title = /the Open button of the (.*) event/.exec(target)![1];
    return { id: candidates.find((c) => c.desc.startsWith('button "Open"') && c.desc.includes(title))?.id ?? null,
      probability: 0.97, confidence: 0.97, probabilities: {}, tokens: 1 };
  });
  intelligence.judge = async (state, claims) => ({ tokens: 1, probabilities: claims.map((claim) => {
    const title = /the (.*) event was opened/.exec(claim)![1];
    return (state as { aria: string }).aria.includes(`Opened ${title}`) ? 0.97 : 0.02;
  }) });

  write('Plain 1234');
  assert.equal((await s.run('judge')).report.status, 'pass');
  const first = s.lock();
  assert.doesNotMatch(JSON.stringify(first), /Plain 1234/, 'no run value in the lock');
  assert.match(JSON.stringify(first), /\$\{env\.title\}/);

  write('Plain 5678');
  const replayed = await s.run('no-judge');
  assert.equal(replayed.report.status, 'pass', JSON.stringify(replayed.steps));
  assert.match(replayed.steps[1].detail!, /Plain 5678.*\(replayed\)/);
  assert.match(replayed.steps[2].detail!, /recorded passing state/);

  assert.equal((await s.run('judge')).report.status, 'pass');
  assert.deepEqual(Object.keys(s.lock().entries), Object.keys(first.entries), 'the same keys: the lock does not grow');
});
