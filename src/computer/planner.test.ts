import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, candidates, readings, spans, keysFrom, rest, type Ask } from './planner.js';
import type { AskAnswer, Question } from '../jev/ask.js';
import { parseComputerStep } from './spec.js';

test('keysFrom maps spoken keys to Playwright names', () => {
  assert.equal(keysFrom('command S'), 'Meta+s');
  assert.equal(keysFrom('the enter key'), 'Enter');
  assert.equal(keysFrom('control shift tab'), 'Control+Shift+Tab');
});

test('candidates: sentence ends and sequencing words split in code, "and" and commas are left to Jev', () => {
  const parts = candidates('Open TextEdit. Type milk and eggs in the body, then press enter. Mail tom@example.com');
  assert.deepEqual(parts.map((p) => p.piece), ['Open TextEdit', 'Type milk and eggs in the body', 'press enter', 'Mail tom@example.com']);
  assert.equal(parts[1].cuts.length, 1);
  assert.deepEqual(readings(parts[1].piece, parts[1].cuts), [['Type milk and eggs in the body'], ['Type milk', 'eggs in the body']]);
});

test('spans are every run of consecutive words, punctuation trimmed at the edges only', () => {
  assert.deepEqual(spans('Click OK.'), ['Click', 'OK', 'Click OK']);
  assert.ok(spans('type "Hello, how are you?"').includes('Hello, how are you'));
});

// Answers questions by matching their instructions; every choice defaults to its first option.
function fake(rules: [RegExp, (q: Question) => AskAnswer][]): Ask & { calls: number } {
  const ask = async (_state: unknown, questions: Question[]) => {
    ask.calls++;
    return { tokens: 10, answers: questions.map((q) => {
      const rule = rules.find(([re]) => re.test(q.instructions));
      if (rule) return rule[1](q);
      return q.kind === 'choice' ? { choice: 'none', probabilities: {}, confidence: 1 } : { probability: 0 };
    }) };
  };
  ask.calls = 0;
  return ask;
}
const option = (q: Question, text: string): AskAnswer => {
  const key = Object.entries(q.kind === 'choice' ? q.criteria : {}).find(([, v]) => v === text)?.[0];
  assert.ok(key, `no option "${text}"`);
  return { choice: key, probabilities: { [key]: 0.6 }, confidence: 0.3 }; // low confidence: spans overlap, still taken
};

test('plan: picks a reading, routes each piece and copies its arguments verbatim', async () => {
  const ask = fake([
    [/Which reading/, (q) => option(q, '1. type salt and pepper in the box  2. press enter')],
    [/What does `segments\[0\]`/, () => ({ choice: 'fill', probabilities: { fill: 1 }, confidence: 1 })],
    [/What does `segments\[1\]`/, () => ({ choice: 'press', probabilities: { press: 1 }, confidence: 1 })],
    [/segments\[0\].*control or field/, (q) => option(q, 'the box')],
    [/segments\[0\].*text to type/, (q) => option(q, 'salt and pepper')],
    [/segments\[1\].*key or shortcut/, (q) => option(q, 'enter')],
  ]);
  const { items, tokens } = await plan('type salt and pepper in the box and press enter', ask);
  assert.deepEqual(items, [
    { kind: 'step', step: { fill: { target: 'the box', value: 'salt and pepper' } }, risky: false },
    { kind: 'step', step: { press: 'Enter' }, risky: false },
  ]);
  assert.equal(ask.calls, 2); assert.equal(tokens, 20);
});

test('plan: no ambiguous boundary skips the split request; unsure and other actions are reported, not guessed', async () => {
  const ask = fake([[/What does/, () => ({ choice: 'other', probabilities: { other: 0.9 }, confidence: 0.9 })]]);
  const { items } = await plan('Delete the selected email', ask);
  assert.equal(ask.calls, 1);
  assert.deepEqual(items, [{ kind: 'unknown', text: 'Delete the selected email', reason: 'say which button or key does it' }]);
  const unsure = fake([[/What does/, () => ({ choice: 'click', probabilities: { click: 0.4 }, confidence: 0.2 })]]);
  assert.equal((await plan('Maybe the thing', unsure)).items[0].kind, 'unknown');
});

test('plan: a piece that is not an instruction after a failed one is joined back and routed again', async () => {
  let routes = 0;
  const ask: Ask = async (state, questions) => {
    const segments = (state as { segments?: string[] }).segments;
    if (!segments) { // the split: the wrong reading, cutting the text from its field
      const q = questions[0];
      const key = Object.entries(q.kind === 'choice' ? q.criteria : {}).find(([, v]) => v.includes('2. hello'))![0];
      return { tokens: 1, answers: [{ choice: key, probabilities: { [key]: 0.54 }, confidence: 0.1 }] };
    }
    routes++;
    return { tokens: 1, answers: questions.map((q) => {
      const i = Number(/segments\[(\d+)\]/.exec(q.instructions)![1]);
      const seg = segments[i];
      const span = (text: string) => { const k = Object.entries(q.kind === 'choice' ? q.criteria : {}).find(([, v]) => v === text)![0]; return { choice: k, probabilities: { [k]: 0.9 }, confidence: 0.9 }; };
      if (/What does/.test(q.instructions)) return seg.includes('hello') && seg.includes('write')
        ? { choice: 'fill', probabilities: { fill: 1 }, confidence: 1 } : seg.startsWith('hello')
        ? { choice: 'none', probabilities: { none: 0.9 }, confidence: 0.9 } : { choice: 'fill', probabilities: { fill: 1 }, confidence: 1 };
      if (seg.includes('write') && seg.includes('hello') && /control or field/.test(q.instructions)) return span('the text field');
      if (seg.includes('write') && seg.includes('hello') && /text to type/.test(q.instructions)) return span('hello, how are you');
      return q.kind === 'choice' ? { choice: 'none', probabilities: { none: 1 }, confidence: 1 } : { probability: 0 };
    }) };
  };
  const { items } = await plan('write inside the text field, hello, how are you?', ask);
  assert.equal(routes, 2);
  assert.deepEqual(items, [{ kind: 'step', step: { fill: { target: 'the text field', value: 'hello, how are you' } }, risky: false }]);
});

test('plan: every scroll direction Jev can pick gives a step the desktop runs', async () => {
  for (const direction of ['Left', 'Right', 'Up', 'Down']) {
    const ask = fake([
      [/What does/, () => ({ choice: 'scroll', probabilities: { scroll: 1 }, confidence: 1 })],
      [/in which direction/, (q) => option(q, direction)],
      [/control or field/, (q) => option(q, 'the list')],
    ]);
    const { items } = await plan(`scroll ${direction.toLowerCase()} in the list`, ask);
    assert.deepEqual(items, [{ kind: 'step', step: { scroll: `${direction.toLowerCase()}: the list` }, risky: false }]);
    // What `plain-computer do` runs: the step goes through the desktop parser before the first action.
    const step = items[0].kind === 'step' ? items[0].step : {};
    assert.deepEqual(parseComputerStep(step), { kind: 'scroll', target: `${direction.toLowerCase()}: the list`, optional: false });
  }
});

test('rest: the text of a fill is what is left without the verb and the field', () => {
  assert.equal(rest('Write a law in the text area.', 'the text area'), 'a law');
  assert.equal(rest('in the search box type hello world', 'the search box'), 'hello world');
  assert.equal(rest('type into the field', 'the field'), undefined);
  assert.ok(spans('Click on "Create Note" button').includes('Create Note button'));
});
