import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnprocessableEntityError, BadRequestError } from '@typesafe-ai/sdk';
import { decide, selectProvider, isTooLong, USER_ENV_FILE } from './jev.js';

test('expect: high probability passes', () => {
  assert.equal(decide(0.95, 'expect'), 'pass');
});

test('expect: low probability fails', () => {
  assert.equal(decide(0.05, 'expect'), 'fail');
});

test('expect: boundary values still decide', () => {
  assert.equal(decide(0.9, 'expect'), 'pass');
  assert.equal(decide(0.1, 'expect'), 'fail');
});

test('expect: mid probability is inconclusive', () => {
  assert.equal(decide(0.5, 'expect'), 'inconclusive');
});

test('pick: probability at or above 0.5 accepts', () => {
  assert.equal(decide(0.5, 'pick'), 'pass');
  assert.equal(decide(0.8, 'pick'), 'pass');
});

test('pick: probability below 0.5 is inconclusive', () => {
  assert.equal(decide(0.49, 'pick'), 'inconclusive');
});

test('selectProvider: only TYPESAFE_API_KEY set → typesafe', () => {
  assert.equal(selectProvider({ TYPESAFE_API_KEY: 'k' }), 'typesafe');
});

test('selectProvider: only AI_GATEWAY_API_KEY set → gateway', () => {
  assert.equal(selectProvider({ AI_GATEWAY_API_KEY: 'k' }), 'gateway');
});

test('selectProvider: both keys set → typesafe wins', () => {
  assert.equal(selectProvider({ TYPESAFE_API_KEY: 'k', AI_GATEWAY_API_KEY: 'k' }), 'typesafe');
});

test('selectProvider: JEV_PROVIDER=gateway with both keys → gateway', () => {
  assert.equal(
    selectProvider({ JEV_PROVIDER: 'gateway', TYPESAFE_API_KEY: 'k', AI_GATEWAY_API_KEY: 'k' }),
    'gateway'
  );
});

test('selectProvider: JEV_PROVIDER=bogus throws', () => {
  assert.throws(() => selectProvider({ JEV_PROVIDER: 'bogus' }), /JEV_PROVIDER/);
});

test('selectProvider: no keys throws naming both variables', () => {
  assert.throws(() => selectProvider({}), /TYPESAFE_API_KEY/);
  assert.throws(() => selectProvider({}), /AI_GATEWAY_API_KEY/);
});

test('selectProvider: no keys names the user env file', () => {
  assert.throws(() => selectProvider({}), (err: Error) => err.message.includes(USER_ENV_FILE));
});

test('selectProvider: JEV_PROVIDER=typesafe without its key throws naming TYPESAFE_API_KEY', () => {
  assert.throws(() => selectProvider({ JEV_PROVIDER: 'typesafe', AI_GATEWAY_API_KEY: 'k' }), /TYPESAFE_API_KEY/);
});

test('isTooLong: a 422 whose body names max_tokens_exceeded is too long', () => {
  const body = { error: { code: 'max_tokens_exceeded' } };
  assert.equal(isTooLong(new UnprocessableEntityError(422, body, new Headers())), true);
});

test('isTooLong: a 400 with the same body is not too long — status decides, not the keyword alone', () => {
  const body = { error: { code: 'max_tokens_exceeded' } };
  assert.equal(isTooLong(new BadRequestError(400, body, new Headers(), 'Bad Request')), false);
});

test('isTooLong: a plain Error naming the gateway wording is too long', () => {
  assert.equal(isTooLong(new Error('max_tokens_exceeded')), true);
});

import { mergePicks, type PickResult } from './jev.js';

const pick = (id: number | null, p: number, probabilities: Record<string, number>, tokens = 0): PickResult => ({
  id,
  probability: p,
  confidence: p,
  probabilities,
  tokens,
});

test('mergePicks: the element found in a later chunk wins; tokens add up; maps merge with the winner\'s none', () => {
  const [r] = mergePicks([
    [pick(null, 0.98, { none: 0.98, '3': 0.02 }, 1000)],
    [pick(467, 0.95, { '467': 0.95, none: 0.05 }, 1200)],
  ]);
  assert.equal(r.id, 467);
  assert.equal(r.probability, 0.95);
  assert.equal(r.tokens, 2200);
  assert.deepEqual(r.probabilities, { '3': 0.02, '467': 0.95, none: 0.05 });
});

test('mergePicks: all none stays none, and shows the least sure chunk\'s guesses', () => {
  const [r] = mergePicks([[pick(null, 0.99, { none: 0.99, '1': 0.01 })], [pick(null, 0.6, { none: 0.6, '300': 0.4 })]]);
  assert.equal(r.id, null);
  assert.equal(r.probabilities.none, 0.6);
  assert.equal(r.probabilities['300'], 0.4);
});

test('mergePicks: two chunks each sure of a different element split the score below acceptance', () => {
  const [r] = mergePicks([[pick(7, 0.9, { '7': 0.9, none: 0.1 })], [pick(400, 0.8, { '400': 0.8, none: 0.2 })]]);
  assert.equal(r.id, 7);
  assert.equal(r.confidence, 0.45);
  assert.equal(decide(r.confidence!, 'pick'), 'inconclusive');
  assert.equal(r.probabilities['400'], 0.8); // both guesses stay visible in the detail
});

test('mergePicks: several instructions merge independently, only the first carries tokens', () => {
  const rs = mergePicks([
    [pick(1, 0.9, { '1': 0.9, none: 0.1 }, 500), pick(null, 0.9, { none: 0.9 })],
    [pick(null, 0.9, { none: 0.9 }, 500), pick(300, 0.7, { '300': 0.7, none: 0.3 })],
  ]);
  assert.deepEqual(rs.map((r) => r.id), [1, 300]);
  assert.deepEqual(rs.map((r) => r.tokens), [1000, 0]);
});
