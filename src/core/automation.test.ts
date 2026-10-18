import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LONG_CONTEXT_MAX_CHARS, resolveTargets, judgeState, askSettled } from './automation.js';
import { fakeIntelligence } from './fake-intelligence.test.js';
const adapter = { candidates: [{ id: 1, desc: 'button OK' }], state: { url: 'desktop://test', title: 'Test' }, element: () => 'handle' };
const ai = fakeIntelligence({
  pick: async () => [{ id: 1, probability: .4, confidence: .8, probabilities: { '1': .4 }, tokens: 12 }],
  judge: async () => ({ probabilities: [.95], tokens: 4 }),
});
test('shared resolver uses confidence, accounts once, and maps accepted IDs through adapter', async () => {
  const [r] = await resolveTargets(adapter, ['OK'], ai);
  assert.equal(r.element, 'handle'); assert.equal(r.tokens, 12); assert.equal(r.usedJev, true);
});
test('shared resolver rejects confident unknown IDs and low-confidence picks', async () => {
  for (const pick of [{ id: 99, probability: 1 }, { id: 1, probability: .49 }, { id: null, probability: 1 }]) {
    const [r] = await resolveTargets(adapter, ['OK'], { ...ai, pick: async () => [{ ...pick, probabilities: {}, tokens: 1 }] });
    assert.equal(r.element, null);
  }
});
test('empty candidate set makes no paid model request', async () => {
  const [r] = await resolveTargets({ ...adapter, candidates: [] }, ['OK'], { ...ai, pick: async () => { throw new Error('must not call'); } });
  assert.equal(r.usedJev, false); assert.equal(r.element, null);
});
test('shared judge halves oversized state and preserves all claims/events', async () => {
  const lengths: number[] = [];
  const result = await judgeState({ ...adapter.state, aria: 'x'.repeat(9000), truncated: false }, ['a', 'b'], ['downloaded'], {
    ...ai, judge: async (state, claims) => {
      const s = state as { aria: string; events: string[] }; lengths.push(s.aria.length);
      assert.deepEqual(claims, ['a', 'b']); assert.deepEqual(s.events, ['downloaded']);
      if (s.aria.length > 5000) throw new Error('max_tokens_exceeded');
      return { probabilities: [.95, .05], tokens: 9 };
    },
  });
  assert.deepEqual(lengths, [9000, 4500]); assert.equal(result.tokens, 9);
});

test('a region is judged without the page URL; a whole page with it', async () => {
  const states: unknown[] = [];
  const spy = fakeIntelligence({ ...ai, judge: async (state) => { states.push(state); return { probabilities: [.95], tokens: 1 }; } });
  await judgeState({ ...adapter.state, aria: '- text: B', truncated: false, region: true }, ['B is shown'], ['downloaded'], spy);
  await judgeState({ ...adapter.state, aria: '- text: B', truncated: false }, ['B is shown'], [], spy);
  assert.deepEqual(states, [{ title: 'Test', aria: '- text: B', events: ['downloaded'] }, { url: 'desktop://test', title: 'Test', aria: '- text: B', events: [] }]);
});

test('a cut tree is judged again on the full text; a failed retry keeps the first verdict', async () => {
  const calls: { aria: string; longContext?: boolean }[] = [];
  const snap = { ...adapter.state, aria: 'cut', truncated: true };
  const failing = fakeIntelligence({
    ...ai, judge: async (state, _claims, options) => {
      calls.push({ aria: (state as { aria: string }).aria, longContext: options?.longContext });
      if (options?.longContext) throw new Error('gateway');
      return { probabilities: [.2, .95], tokens: 5 };
    },
  });
  assert.deepEqual(await judgeState(snap, ['a', 'b'], [], failing, { fullAria: 'cut plus the tail' }),
    { probabilities: [.2, .95], tokens: 5, requests: 1 });
  assert.deepEqual(calls, [
    { aria: 'cut', longContext: undefined },
    { aria: 'cut plus the tail', longContext: true },
  ]);

  calls.length = 0;
  const retrying = fakeIntelligence({
    ...ai, judge: async (state, _claims, options) => {
      calls.push({ aria: (state as { aria: string }).aria, longContext: options?.longContext });
      return { probabilities: options?.longContext ? [.99, .01] : [.2, .95], tokens: options?.longContext ? 8 : 5 };
    },
  });
  assert.deepEqual(await judgeState(snap, ['a', 'b'], [], retrying, { fullAria: 'full' }),
    { probabilities: [.99, .01], tokens: 13, requests: 2, longContext: true });

  calls.length = 0;
  await judgeState({ ...snap, truncated: false }, ['a', 'b'], [], retrying, { fullAria: 'full' });
  await judgeState(snap, ['a', 'b'], [], retrying, { fullAria: 'cut' });
  assert.deepEqual(calls.map((call) => call.longContext), [undefined, undefined]);

  calls.length = 0;
  await judgeState(snap, ['a', 'b'], [], retrying, { fullAria: 'y'.repeat(LONG_CONTEXT_MAX_CHARS + 80) });
  assert.equal(calls[1].aria.length, LONG_CONTEXT_MAX_CHARS);
  assert.equal(calls[1].longContext, true);
});

test('askSettled keeps the early answer when the settled look is the same, and asks again when it is not', async () => {
  const run = async (early: string | null, settled: string, skip?: (f: string) => boolean) => {
    const asked: string[] = []; const discarded: string[] = [];
    const out = await askSettled({
      early: async () => early, settled: async () => settled, same: (a, b) => a === b,
      ask: async (f) => { asked.push(f); return `answer:${f}`; }, discard: (r) => discarded.push(r), skip,
    });
    return { ...out, asked, discarded };
  };
  assert.deepEqual(await run('A', 'A'), { frame: 'A', result: 'answer:A', reasked: false, asked: ['A'], discarded: [] });
  assert.deepEqual(await run('A', 'B'), { frame: 'B', result: 'answer:B', reasked: true, asked: ['A', 'B'], discarded: ['answer:A'] });
  assert.deepEqual(await run(null, 'B'), { frame: 'B', result: 'answer:B', reasked: false, asked: ['B'], discarded: [] });
  // Skip: no question for an unchanged, already answered state; an early answer is still accounted.
  assert.deepEqual(await run('A', 'A', (f) => f === 'A'), { frame: 'A', result: null, reasked: false, asked: [], discarded: [] });
  assert.deepEqual(await run('B', 'A', (f) => f === 'A'), { frame: 'A', result: null, reasked: true, asked: ['B'], discarded: ['answer:B'] });
  // A failing early look is no early look; a failing early answer never surfaces when it is not used.
  const failing = await askSettled({ early: async () => { throw new Error('quick read failed'); }, settled: async () => 'S', same: () => false,
    ask: async (f) => f, discard: () => {} });
  assert.deepEqual(failing, { frame: 'S', result: 'S', reasked: false });
  const staleError = await askSettled({ early: async () => 'A', settled: async () => 'B', same: (a, b) => a === b,
    ask: async (f) => { if (f === 'A') throw new Error('stale'); return f; }, discard: () => {} });
  assert.deepEqual(staleError, { frame: 'B', result: 'B', reasked: true });
});
