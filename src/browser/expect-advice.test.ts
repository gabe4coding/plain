import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { intelligence } from '../core/automation.js';
import type { Spec } from '../core/spec.js';
import { SPLIT_TEXT_HINT } from './split-text.js';
import { closeSharedBrowser } from './session.js';
import { runSpec } from './runner.js';

after(closeSharedBrowser);
const options = { headed: false, timeout: 5000 };
const html = (body: string) => `data:text/html,${encodeURIComponent(`<!doctype html><html><body>${body}</body></html>`)}`;
const spec = (url: string, expectations: string[]): Spec => ({
  name: 'advice', url, dir: process.cwd(), dialogs: 'accept',
  steps: [{ kind: 'goto', url }, { kind: 'expect', expectations }],
});

async function withModel(t: { after: (fn: () => void) => void }, judge: typeof intelligence.judge, explain: typeof intelligence.explain) {
  const saved = { judge: intelligence.judge, explain: intelligence.explain };
  t.after(() => { intelligence.judge = saved.judge; intelligence.explain = saved.explain; });
  intelligence.judge = judge;
  intelligence.explain = explain;
}

test('a passing check does not read the screenshot', async (t) => {
  const url = html('<p>Hello</p>');
  await withModel(t, async () => ({ probabilities: [0.99], tokens: 3 }), async () => { throw new Error('must not explain a pass'); });
  const result = await runSpec(spec(url, ['Hello is shown']), options);
  assert.equal(result.status, 'pass', JSON.stringify(result.steps));
  assert.equal(result.jevCalls, 1);
  assert.equal(result.totalTokens, 3);
  assert.doesNotMatch(result.steps[1].detail ?? '', /screenshot:/);
});

test('a failed check appends the screenshot line and keeps the fail when the image call throws', async (t) => {
  const url = html('<footer><strong>2</strong> items left</footer>');
  const claims = ['the footer says 2 items left', 'Hello is shown'];
  await withModel(t,
    async (_state, claims) => ({ probabilities: claims.map((claim) => claim.includes('footer') ? 0.05 : 0.99), tokens: 3 }),
    async (asked) => {
      assert.deepEqual(asked, ['the footer says 2 items left']);
      return { line: 'screenshot: contradicted (p=0.91)', tokens: 4 };
    });
  const failed = await runSpec(spec(url, claims), options);
  assert.match(failed.steps[1]?.step ?? '', /Hello is shown/, JSON.stringify(failed.steps));
  assert.equal(failed.status, 'fail', JSON.stringify(failed.steps));
  assert.match(failed.steps[1].detail ?? '', /screenshot: contradicted \(p=0\.91\)/);
  assert.match(failed.steps[1].detail ?? '', new RegExp(SPLIT_TEXT_HINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(failed.jevCalls, 2);
  assert.equal(failed.totalTokens, 7);

  intelligence.explain = async () => { throw new Error('image down'); };
  const degraded = await runSpec(spec(url, ['the footer says 2 items left']), options);
  assert.equal(degraded.status, 'fail', JSON.stringify(degraded.steps));
  assert.doesNotMatch(degraded.steps[1].detail ?? '', /screenshot:/);
  assert.match(degraded.steps[1].detail ?? '', /hint:/);
  assert.equal(degraded.jevCalls, 1);
  assert.equal(degraded.totalTokens, 3);
});

test('a check scoped with within does not send the viewport screenshot', async (t) => {
  const url = html('<footer><strong>2</strong> items left</footer>');
  const savedPick = intelligence.pick;
  t.after(() => { intelligence.pick = savedPick; });
  await withModel(t, async () => ({ probabilities: [0.05], tokens: 3 }),
    async () => { throw new Error('scoped check must not read the viewport'); });
  intelligence.pick = async (candidates) => [{
    id: candidates[0]?.id ?? null, probability: 0.99, confidence: 0.99, probabilities: {}, tokens: 1,
  }];
  const result = await runSpec({
    name: 'advice', url, dir: process.cwd(), dialogs: 'accept',
    steps: [{ kind: 'goto', url }, { kind: 'expect', expectations: ['the footer says 2 items left'], within: 'the footer' }],
  }, options);
  assert.equal(result.status, 'fail', JSON.stringify(result.steps));
  assert.doesNotMatch(result.steps[1].detail ?? '', /screenshot:/);
  assert.match(result.steps[1].detail ?? '', /hint:/);
});

test('a cut page sends long context once when the settled page differs', async (t) => {
  const long = Array.from({ length: 2500 }, (_, i) => `<p>Paragraph number ${i} of a long article body</p>`).join('');
  const ticking = `<p id="swap">Early</p>${long}<script>let n=0; const id=setInterval(() => {`
    + ` const el=document.getElementById('swap'); if (el) el.textContent='tick '+(++n); if (n>15) clearInterval(id); }, 100);</script>`;
  const url = html(`<main>${ticking}</main>`);
  const longCalls: boolean[] = [];
  await withModel(t, async (_state, _claims, judgeOptions) => {
    longCalls.push(judgeOptions?.longContext === true);
    return { probabilities: [0.99], tokens: 1 };
  }, async () => { throw new Error('must not explain a pass'); });
  const result = await runSpec(spec(url, ['the page has a paragraph']), { ...options, timeout: 8000 });
  assert.equal(result.status, 'pass', JSON.stringify(result.steps));
  assert.equal(longCalls.filter(Boolean).length, 1, JSON.stringify(longCalls));
});

test('a zero-token screenshot line is printed and not counted as a model call', async (t) => {
  const url = html('<p>Hello</p>');
  await withModel(t, async () => ({ probabilities: [0.04], tokens: 3 }),
    async () => ({ line: 'screenshot: not sent (the Vercel AI Gateway path has no image support)', tokens: 0 }));
  const result = await runSpec(spec(url, ['the missing banner is shown']), options);
  assert.equal(result.status, 'fail');
  assert.match(result.steps[1].detail ?? '', /the Vercel AI Gateway path has no image support/);
  assert.equal(result.jevCalls, 1);
  assert.equal(result.totalTokens, 3);
});

test('a cut page takes the long-context verdict, and a failed retry keeps the truncated one', async (t) => {
  const long = Array.from({ length: 2500 }, (_, i) => `<p>Paragraph number ${i} of a long article body</p>`).join('');
  const url = html(`<main>${long}<p>Late unique paragraph marker</p></main>`);
  let sawFull = false;
  await withModel(t, async (state, _claims, options) => {
    const aria = (state as { aria: string }).aria;
    if (options?.longContext) {
      sawFull = aria.includes('Late unique paragraph marker');
      return { probabilities: [0.99], tokens: 8 };
    }
    assert.equal(aria.includes('Late unique paragraph marker'), false);
    return { probabilities: [0.2], tokens: 5 };
  }, async () => { throw new Error('must not explain a pass'); });
  const passed = await runSpec(spec(url, ['the page has a late paragraph']), options);
  assert.equal(passed.status, 'pass', JSON.stringify(passed.steps));
  assert.equal(sawFull, true);
  assert.match(passed.steps[1].detail ?? '', /\(long context\)/);
  assert.doesNotMatch(passed.steps[1].detail ?? '', /aria truncated/);
  assert.equal(passed.jevCalls, 2);
  assert.equal(passed.totalTokens, 13);

  intelligence.judge = async (_state, _claims, options) => {
    if (options?.longContext) throw new Error('long context down');
    return { probabilities: [0.05], tokens: 5 };
  };
  intelligence.explain = async () => null;
  const kept = await runSpec(spec(url, ['the page has a late paragraph']), options);
  assert.equal(kept.status, 'fail', JSON.stringify(kept.steps));
  assert.match(kept.steps[1].detail ?? '', /aria truncated at 60k chars/);
  assert.doesNotMatch(kept.steps[1].detail ?? '', /long context/);
  assert.equal(kept.jevCalls, 1);
  assert.equal(kept.totalTokens, 5);
});
