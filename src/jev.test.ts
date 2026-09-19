import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnprocessableEntityError, BadRequestError } from '@typesafe-ai/sdk';
import { decide, selectProvider, isTooLong } from './jev.js';

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
