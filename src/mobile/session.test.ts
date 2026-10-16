import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MobileSession, runMobileSpec } from './session.js';
import { loadMobileSpec, parseMobileStep, MobileTargetSchema } from './spec.js';
import type { MobileAdapter } from './adapter.js';
import { HiddenTargetError } from '../core/automation.js';
import type { MobileTarget } from './spec.js';
import { createMobileServer } from './mcp.js';
import { serialQueue } from '../core/serial-queue.js';
import type { Intelligence } from '../core/automation.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { askResult } from '../core/mcp-result.js';

class FakeAdapter implements MobileAdapter<string> {
  log: unknown[] = []; text = 'Ready'; closed = 0;
  async open(target: MobileTarget) { this.log.push(target); return target; }
  async capture(kind: unknown, within?: string) { this.log.push(['capture', kind, within]); return {
    snapshot: { url: 'mobile://42', title: 'Fixture', aria: this.text, truncated: false },
    candidates: [{ id: 0, desc: 'button Preview' }], elements: new Map([[0, 'control']]),
  }; }
  async act(...args: unknown[]) { this.log.push(args); }
  async press(key: string) { this.log.push(['press', key]); if (key === 'Enter') throw new Error('input failed'); }
  async gesture(...args: unknown[]) { this.log.push(['gesture', ...args]); }
  async screenshot() { return Buffer.from('png'); }
  async close() { this.closed++; }
}
const ai: Intelligence = {
  pick: async (_c, targets) => targets.map((_, i) => ({ id: 0, probability: .95, probabilities: { '0': .95 }, tokens: i === 0 ? 10 : 0 })),
  judge: async (_state, claims) => ({ probabilities: claims.map(() => .95), tokens: 7 }),
  describe: async () => ({ screen: { type: 'other', probability: .99, confidence: .99 }, signals: {}, relevance: [], tokens: 100 }),
};
test('mobile schema accepts shared steps and rejects browser-only vocabulary before acting', () => {
  for (const raw of [{ goto: '/' }, { upload: { target: 'file', files: ['a'] } }, { select: { target: 'list', value: 'a' } }, { click: 'css=button' }, { scroll: 'bottom' },
    { hover: 'button' }, { rightclick: 'row' }, { mouse: { x: 1, y: 1 } }, { drag: { source: 'a', target: 'b' } },
    { swipe: 'diagonal' }, { swipe: { direction: 'left', within: 'css=panel' } }, { wait: 'css=button' }, { press: 'Control+a' }, { tap: 'x', click: 'y' }]) assert.throws(() => parseMobileStep(raw));
  for (const raw of [{ tap: 'button' }, { longpress: 'row' }, { swipe: 'left' }, { swipe: { direction: 'up', within: 'panel' } }, { press: '${hooks.key}' }]) assert.ok(parseMobileStep(raw));
  assert.equal(parseMobileStep({ scroll: 'down: the list' }).kind, 'scroll');
  assert.throws(() => MobileTargetSchema.parse({ app: 'A', pid: 1 }));
  assert.throws(() => MobileTargetSchema.parse({}));
  assert.throws(() => MobileTargetSchema.parse({ platform: 'android', device: 'serial', app: 'package', url: '/' }));
});
test('mobile acts only after accepted picks, and gestures retain their direction', async () => {
  const adapter = new FakeAdapter(); const session = new MobileSession(adapter, 100, ai);
  assert.equal((await session.step({ fill: { target: 'Message', value: 'Hello' } })).status, 'pass');
  assert.deepEqual(adapter.log.at(-1), ['fill', 'control', 'Hello']);
  await session.step({ swipe: { direction: 'left', within: 'panel' } });
  assert.deepEqual(adapter.log.at(-1), ['gesture', 'swipe', 'left', 'control']);
  assert.equal(session.calls, 2); assert.equal(session.tokens, 20);
  const reject = new MobileSession(adapter, 100, { ...ai, pick: async () => [{ id: 0, probability: .1, probabilities: {}, tokens: 1 }] });
  const before = adapter.log.length;
  assert.equal((await reject.step({ click: 'Preview' })).status, 'inconclusive');
  assert.equal(adapter.log.length, before + 1); // capture only
});
test('mobile scroll takes up, down, left and right, and a direction only after interpolation', async () => {
  const adapter = new FakeAdapter();
  const picked: string[] = [];
  const session = new MobileSession(adapter, 100, { ...ai, pick: async (...args) => { picked.push(...args[1]); return ai.pick(...args); } });
  for (const direction of ['up', 'down', 'left', 'right']) {
    assert.equal((await session.step({ scroll: `${direction}: the carousel` })).status, 'pass');
    assert.deepEqual(adapter.log.at(-1), ['gesture', 'scroll', direction, 'control']);
  }
  assert.deepEqual(picked, ['the carousel', 'the carousel', 'the carousel', 'the carousel']);
  for (const raw of [{ scroll: 'sideways: the list' }, { scroll: 'left:' }, { scroll: 'Down: the list' }]) assert.throws(() => parseMobileStep(raw), /Mobile scroll syntax/);
  // A templated target loads; the step is checked again once the placeholder is filled in.
  assert.ok(parseMobileStep({ scroll: '${hooks.where}' }));
  const filled = await session.run({ kind: 'scroll', target: 'sideways: the list' });
  assert.equal(filled.status, 'error'); assert.match(filled.detail ?? '', /Mobile scroll syntax/);
});
test('a hidden pick is targeted again once from a new capture, then reported', async () => {
  const adapter = new FakeAdapter(); const session = new MobileSession(adapter, 100, ai);
  let hidden = 1;
  adapter.act = async (...args: unknown[]) => { adapter.log.push(args); if (hidden-- > 0) throw new HiddenTargetError(); };
  const r = await session.step({ tap: 'Preview' });
  assert.equal(r.status, 'pass'); assert.equal(r.ms?.retargeted, 1);
  assert.equal(adapter.log.filter((e) => Array.isArray(e) && e[0] === 'capture').length, 2);
  hidden = 2;
  const twice = await session.step({ tap: 'Preview' });
  assert.equal(twice.status, 'error'); assert.match(twice.detail ?? '', /not visible/);
});
test('a rejected pick from an approximate capture is picked again from an exact one', async () => {
  const adapter = new FakeAdapter(); let exact = false, prefer = 0;
  const capture = adapter.capture.bind(adapter);
  adapter.capture = async (kind: unknown, within?: string) => ({ ...await capture(kind, within), ...(exact ? {} : { approximate: true }) });
  (adapter as FakeAdapter & { preferExact(): void }).preferExact = () => { prefer++; exact = true; };
  const scores = [.3, .8];
  const session = new MobileSession(adapter, 100, { ...ai, pick: async () => [{ id: 0, probability: scores.shift()!, probabilities: {}, tokens: 1 }] });
  const r = await session.step({ tap: 'Preview' });
  assert.equal(r.status, 'pass'); assert.equal(r.ms?.retargeted, 1); assert.equal(prefer, 1);
  exact = false; scores.push(.6);
  const accepted = await session.step({ tap: 'Preview' });
  assert.equal(accepted.ms?.retargeted, undefined, 'an accepted approximate pick is used as is');
  exact = false;
  const picks = [{ id: null, probability: .97 }, { id: 0, probability: .95 }]; // a sure "none", then the element
  const none = new MobileSession(adapter, 100, { ...ai, pick: async () => [{ ...picks.shift()!, probabilities: {}, tokens: 1 }] as never });
  const rejected = await none.step({ tap: 'Preview' });
  assert.equal(rejected.status, 'pass'); assert.equal(rejected.ms?.retargeted, 1, 'a rejected approximate pick is asked again from an exact capture');
});
test('a covered region from an approximate pick is picked once more before its claims are judged', async () => {
  const adapter = new FakeAdapter(); let covered = 1, prefer = 0;
  const capture = adapter.capture.bind(adapter);
  adapter.capture = async (kind: unknown, within?: string, options?: { regionPick?: boolean }) => {
    if (within && covered-- > 0) throw new HiddenTargetError('Region');
    return { ...await capture(kind, within), ...(options?.regionPick && !prefer ? { approximate: true } : {}) };
  };
  (adapter as FakeAdapter & { preferExact(): void }).preferExact = () => { prefer++; };
  const r = await new MobileSession(adapter, 100, ai).step({ wait: { that: 'Ready', within: 'panel' } });
  assert.equal(r.status, 'pass'); assert.equal(r.ms?.retargeted, 1); assert.equal(prefer, 1);
  assert.equal(adapter.log.filter((e) => Array.isArray(e) && e[0] === 'capture' && e[1] === 'region' && e[2] === undefined).length, 2, 'two region picks');
});
test('scoped expectations use subtree, combine claims, and fail beats inconclusive', async () => {
  const adapter = new FakeAdapter();
  const session = new MobileSession(adapter, 100, { ...ai, judge: async () => ({ probabilities: [.5, .05], tokens: 8 }) });
  const r = await session.step({ expect: { that: ['a', 'b'], within: 'panel' }, optional: true });
  assert.equal(r.status, 'fail'); assert.equal(session.tokens, 18);
  assert.deepEqual(adapter.log.at(-1), ['capture', 'region', 'control']);
});
test('optional tolerates errors but an explicit expectation failure is preserved', async () => {
  const session = new MobileSession(new FakeAdapter(), 100, ai);
  assert.equal((await session.step({ press: 'Enter', optional: true })).status, 'skipped');
  assert.equal((await session.step({ press: 'Enter' })).status, 'error');
});
test('wait avoids rejudging unchanged negative snapshots and returns inconclusive at timeout', async () => {
  const session = new MobileSession(new FakeAdapter(), 20, { ...ai, judge: async () => ({ probabilities: [0], tokens: 2 }) });
  assert.equal((await session.step({ wait: 'Ready' })).status, 'inconclusive');
  assert.equal(session.calls, 1);
});
test('mobile YAML resolves env and hooks, teardown sees failures, and detach always runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-spec-'));
  try {
    writeFileSync(join(dir, 'hooks.mjs'), `import {writeFileSync} from 'node:fs'; export const setup=()=>({key:'Enter'}); export const teardown=({result})=>writeFileSync(${JSON.stringify(join(dir, 'result.json'))},JSON.stringify(result));`);
    writeFileSync(join(dir, 'test.yaml'), 'name: test\nplatform: android\ndevice: emulator-5554\napp: Fixture\nhooks: ./hooks.mjs\nsteps:\n  - press: "${hooks.key}"\n');
    const adapter = new FakeAdapter();
    const result = await runMobileSpec(loadMobileSpec(join(dir, 'test.yaml')), new MobileSession(adapter, 100, ai));
    assert.equal(result.status, 'error'); assert.equal(adapter.closed, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).status, 'error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('setup failure does not attach or call teardown; teardown failure marks run error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-hooks-'));
  try {
    for (const setup of [true, false]) {
      const file = join(dir, 'hooks.mjs');
      writeFileSync(file, setup ? 'export const setup=()=>{throw Error("setup failure")}; export const teardown=()=>{throw Error("should not run")};' : 'export const teardown=()=>{throw Error("teardown failure")};');
      const adapter = new FakeAdapter();
      const r = await runMobileSpec({ name: 'test', platform: 'android', device: 'emulator-5554', app: 'Fixture', dir, hooks: file, env: {}, steps: [] }, new MobileSession(adapter, 100, ai));
      assert.equal(r.status, 'error'); assert.equal(adapter.closed, 1);
      assert.equal(r.steps.at(-1)?.step, setup ? 'setup' : 'teardown');
      if (setup) assert.equal(adapter.log.length, 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('mobile replay resolves env target and reports close failure without losing action results', async () => {
  const adapter = new FakeAdapter();
  adapter.close = async () => { adapter.closed++; throw new Error('session deletion failed'); };
  const result = await runMobileSpec({ name: 'target interpolation', platform: 'android', device: '${env.device}', app: '${env.app}',
    capabilities: { 'appium:appActivity': '${env.activity}' }, dir: process.cwd(),
    env: { device: 'serial', app: 'com.example.fixture', activity: '.MainActivity' }, steps: [parseMobileStep({ tap: 'Preview' })],
  }, new MobileSession(adapter, 100, ai));
  assert.deepEqual(adapter.log[0], { platform: 'android', device: 'serial', app: 'com.example.fixture', capabilities: { 'appium:appActivity': '.MainActivity' } });
  assert.equal(result.status, 'error'); assert.equal(result.steps[0].status, 'pass');
  assert.equal(result.steps.at(-1)?.step, 'close'); assert.equal(adapter.closed, 1);
});
test('interpolated browser selectors are rejected before a mobile capture/action', async () => {
  const adapter = new FakeAdapter();
  const session = new MobileSession(adapter, 100, ai);
  const result = await session.run({ kind: 'tap', target: 'css=button' });
  assert.equal(result.status, 'error'); assert.equal(adapter.log.length, 0);
});
test('queue serializes operations and continues after rejection', async () => {
  const queue = serialQueue(); const log: number[] = [];
  const first = queue(async () => { await new Promise(r => setTimeout(r, 5)); log.push(1); throw new Error('failed'); });
  const second = queue(async () => { log.push(2); });
  await assert.rejects(first); await second; assert.deepEqual(log, [1, 2]);
});
test('real MCP protocol records successful placeholder steps, saves replayable YAML, and resets on open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-mcp-'));
  const adapter = new FakeAdapter();
  const discoveries: string[] = [];
  const { server, close } = createMobileServer(adapter, 100, ai, {
    listDevices: async (platform) => { discoveries.push(`devices:${platform}`); return { scope: 'local', devices: [], errors: [] }; },
    listApps: async ({ platform, device, offset }) => {
      discoveries.push(`apps:${device}`);
      return { scope: 'local', platform, device, apps: [{ app: 'Fixture' }], total: 1, offset, nextOffset: null };
    },
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    assert.ok(r.structuredContent, `${name} must return structuredContent`);
    assert.deepEqual(r.structuredContent, JSON.parse((r.content as { text: string }[])[0].text));
    return r.structuredContent as Record<string, any>;
  }
  try {
    const listed = await client.listTools(); assert.equal(listed.tools.length, 11);
    for (const name of ['list_devices', 'list_apps']) assert.equal(listed.tools.find(t => t.name === name)?.annotations?.readOnlyHint, true);
    await call('list_devices', { platform: 'android' });
    assert.equal((await call('list_apps', { platform: 'android', device: 'emulator-5554' })).apps[0].app, 'Fixture');
    assert.equal(adapter.log.length, 0); assert.equal(adapter.closed, 0);
    assert.deepEqual(discoveries, ['devices:android', 'apps:emulator-5554']);
    assert.ok((await client.callTool({ name: 'list_apps', arguments: { platform: 'android' } })).isError);
    const error = await client.callTool({ name: 'step', arguments: { step: { press: 'Enter' } } });
    assert.equal(error.isError, true);
    assert.equal(error.structuredContent, undefined);
    assert.match((error.content as { text: string }[])[0].text, /call open first/);
    const hook = join(dir, 'hooks.mjs'); writeFileSync(hook, "export const setup=()=>({text:'leased value',app:'Fixture'});");
    const opened = await call('open', { platform: 'android', device: 'emulator-5554', app: '${hooks.app}', hooks: hook });
    assert.deepEqual(opened.placeholders, ['${hooks.text}', '${hooks.app}']);
    assert.equal(opened.app, 'Fixture');
    const screenshot = await client.callTool({ name: 'screenshot', arguments: {} });
    assert.ok(!screenshot.isError);
    assert.equal(screenshot.structuredContent, undefined);
    assert.deepEqual(screenshot.content, [{ type: 'image', mimeType: 'image/png', data: Buffer.from('png').toString('base64') }]);
    assert.equal((await call('find', { kind: 'click', target: 'Preview' })).found, true);
    await call('step', { step: { fill: { target: 'Message', value: '${hooks.text}' } } });
    assert.deepEqual(adapter.log.filter((e) => !(Array.isArray(e) && e[0] === 'capture')).at(-1), ['fill', 'control', 'leased value']);
    await call('step', { step: { press: 'Enter' } });
    await call('snapshot');
    const compact = await call('snapshot', { mode: 'compact' });
    assert.equal(compact.observed.aria, 'Ready'); assert.equal(compact.jevTokens, 0);
    const smart = await call('snapshot', { mode: 'smart', within: 'panel', intent: 'inspect the controls' });
    assert.equal(smart.inferred.screen.type, 'other'); assert.equal(smart.jevTokens, 110);
    assert.ok(smart.ms.total >= smart.ms.jev);
    const asked = await call('ask', { claims: ['The panel says ${hooks.text}'], within: 'panel' });
    assert.deepEqual(asked.answers, [{ claim: 'The panel says ${hooks.text}', p: 0.95, answer: 'yes' }]);
    assert.ok(asked.jevTokens > 0);
    await call('list_devices');
    await call('list_apps', { platform: 'android', device: 'emulator-5554' });
    const path = join(dir, 'saved.yaml'); await call('save', { path });
    assert.match(readFileSync(path, 'utf8'), /\$\{hooks.text\}/);
    const spec = loadMobileSpec(path); assert.equal(spec.app, '${hooks.app}'); assert.equal(spec.steps.length, 1); assert.equal(spec.hooks, hook);
    const replay = new FakeAdapter();
    const replayResult = await runMobileSpec(spec, new MobileSession(replay, 100, ai));
    assert.equal(replayResult.status, 'pass');
    assert.equal((replay.log[0] as MobileTarget).app, 'Fixture');
    assert.deepEqual(replay.log.at(-1), ['fill', 'control', 'leased value']);
    await call('open', { platform: 'ios', device: 'ios-udid', app: 'Fixture' });
    assert.ok((await client.callTool({ name: 'save', arguments: { path } })).isError);
    await call('close');
    assert.ok((await client.callTool({ name: 'snapshot', arguments: {} })).isError);
  } finally { await close(); await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('mobile early capture: Jev works on it while the settled capture runs; kept only when both match', async () => {
  class EarlyAdapter extends FakeAdapter {
    earlyText = 'Ready';
    async captureEarly(kind: unknown, within?: string) { this.log.push(['early', kind, within]); const f = await super.capture(kind, within); this.log.pop(); return { ...f, snapshot: { ...f.snapshot, aria: this.earlyText } }; }
  }
  const adapter = new EarlyAdapter();
  const judged: string[] = [];
  const session = new MobileSession(adapter, 100, { ...ai, judge: async (state, claims) => { judged.push((state as { aria: string }).aria); return { probabilities: claims.map(() => .95), tokens: 7 }; } });
  // Seconds after the last step (an agent's turn) the UI is idle: no early capture.
  let r = await session.step({ expect: 'ready' });
  assert.deepEqual(adapter.log.at(-1), ['capture', 'region', undefined]); assert.ok(!adapter.log.some(e => Array.isArray(e) && e[0] === 'early'));
  judged.length = 0;
  session.noteActivity(); // e.g. the app was just opened
  r = await session.step({ expect: 'ready' });
  assert.equal(r.status, 'pass'); assert.deepEqual(judged, ['Ready']); assert.equal(r.ms?.reasked, undefined);
  assert.deepEqual(adapter.log.slice(-2), [['early', 'region', undefined], ['capture', 'region', undefined]]);
  // The UI was still changing: the early answer is about a stale tree, so the settled tree is judged too.
  adapter.earlyText = 'Loading';
  r = await session.step({ expect: 'ready' });
  assert.equal(r.status, 'pass'); assert.deepEqual(judged, ['Ready', 'Loading', 'Ready']); assert.equal(r.ms?.reasked, 1);
  assert.equal(session.calls, 4); assert.equal(session.tokens, 28); // the discarded answer is still accounted
});
test('MCP: an approximate target capture is never the before of changed; the previous after is', async () => {
  const adapter = new FakeAdapter() as FakeAdapter & { approximateTargets: boolean; preferExact(): void };
  adapter.approximateTargets = true;
  let exact = false;
  adapter.preferExact = () => { exact = true; };
  const capture = adapter.capture.bind(adapter);
  adapter.capture = async (kind: unknown, within?: string) => {
    const frame = await capture(kind, within);
    if (kind === 'region' || exact) { exact = false; return frame; }
    return { ...frame, snapshot: { ...frame.snapshot, aria: `${frame.snapshot.aria}\n- button "Covered"` }, approximate: true };
  };
  adapter.text = '- button "Compose"';
  const screens = ['- navigationbar "New Message"', '- navigationbar "Sent"'];
  adapter.act = async (...args: unknown[]) => { adapter.log.push(args); adapter.text = screens.shift()!; };
  const { server, close } = createMobileServer(adapter, 100, ai);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })).structuredContent as Record<string, any>;
  const captures = () => adapter.log.filter((e) => Array.isArray(e) && e[0] === 'capture').length;
  try {
    await call('open', { platform: 'ios', device: 'ios-udid', app: 'Mail' });
    let n = captures();
    await call('step', { step: { expect: 'Compose is shown' } });
    assert.equal(captures() - n, 2, 'a whole-screen claim looks first with an exact capture: no extra before');
    await call('open', { platform: 'ios', device: 'ios-udid', app: 'Mail' });
    n = captures();
    const first = await call('step', { step: { tap: 'Compose' } });
    assert.deepEqual(first.changed, { added: ['- navigationbar "New Message"'], addedOmitted: 0, removed: 1 });
    assert.equal(captures() - n, 3, 'right after open: an exact before, the approximate target capture, the after');
    n = captures();
    const second = await call('step', { step: { tap: 'Compose' } });
    assert.deepEqual(second.changed, { added: ['- navigationbar "Sent"'], addedOmitted: 0, removed: 1 }, 'diffed against the previous after');
    assert.equal(captures() - n, 2);
    await call('find', { kind: 'click', target: 'Compose' });
    assert.equal(adapter.log.filter((e) => Array.isArray(e) && e[0] === 'capture').length - n, 3);
    assert.equal(exact, false, 'find asked for an exact capture and got it');
  } finally { await close(); await client.close(); await server.close(); }
});
test('ask maps probabilities to yes/no/unsure at the expect thresholds', () => {
  const r = askResult(['a', 'b', 'c'], [0.93, 0.05, 0.5], { url: 'u', title: 't', truncated: true });
  assert.deepEqual(r.answers.map((a) => a.answer), ['yes', 'no', 'unsure']);
  assert.match(r.note!, /truncated/);
});

test('MCP steps report what they changed, picks see the open goal, read copies screen lines, save keeps the goal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-mcp-'));
  const adapter = new FakeAdapter();
  adapter.text = '- navigationbar "Inbox"\n  - button "Compose"';
  adapter.act = async (...args: unknown[]) => { adapter.log.push(args); adapter.text = '- navigationbar "New Message"\n  - textfield "To"'; };
  const states: unknown[] = [];
  const asked: unknown[] = [];
  const { server, close } = createMobileServer(adapter, 100, {
    ...ai,
    pick: async (c, targets, state) => { states.push(state); return ai.pick(c, targets, state); },
    ask: async (state, questions) => { asked.push(state); return { tokens: 9, answers: questions.map(() => ({ choice: '1', probabilities: { '1': .97 }, confidence: .96 })) }; },
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r));
    return r.structuredContent as Record<string, any>;
  };
  try {
    await call('open', { platform: 'ios', device: 'ios-udid', app: 'Mail', goal: 'Send a message to Ada' });
    const tapped = await call('step', { step: { tap: 'the Compose button' } });
    assert.deepEqual(tapped.changed, { added: ['- navigationbar "New Message"', '  - textfield "To"'], addedOmitted: 0, removed: 2 });
    assert.equal((states[0] as { goal?: string }).goal, 'Send a message to Ada');
    // The tap reused its own targeting capture as the before; a press, which never looks first, captures one.
    const captures = () => adapter.log.filter((e) => Array.isArray(e) && e[0] === 'capture').length;
    const n = captures();
    const pressed = await call('step', { step: { press: 'Home' } });
    assert.deepEqual(pressed.changed, { added: [], addedOmitted: 0, removed: 0 });
    assert.equal(captures() - n, 2);
    const read = await call('read', { question: 'the recipient field' });
    assert.equal(read.found, true);
    assert.equal(read.answer, '  - textfield "To"');
    assert.equal(read.jevTokens, 9);
    // The tap's target has no spatial cue, so it needs no route request (src/jev/evidence.ts); press and read none.
    assert.equal(asked.length, 1);
    assert.equal((asked[0] as { question: string }).question, 'the recipient field');
    const path = join(dir, 'saved.yaml'); await call('save', { path });
    assert.equal(loadMobileSpec(path).goal, 'Send a message to Ada');
  } finally { await close(); await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
