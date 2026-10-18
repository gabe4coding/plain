import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnprocessableEntityError, BadRequestError } from '@typesafe-ai/sdk';
import { dangerHeaders, isTooLong, tokenCount } from './ask.js';

test('isTooLong: a 422 whose body names max_tokens_exceeded is too long', () => {
  const body = { error: { code: 'max_tokens_exceeded' } };
  assert.equal(isTooLong(new UnprocessableEntityError(422, body, new Headers())), true);
});

test('isTooLong: the live TypeSafe 400 max_tokens_exceeded is too long; another 400 is not', () => {
  const live = { detail: { error_type: 'max_tokens_exceeded' } };
  assert.equal(isTooLong(new BadRequestError(400, live, new Headers(), 'Bad Request')), true);
  assert.equal(isTooLong(new BadRequestError(400, { detail: { error_type: 'invalid_request', msg: 'token field missing' } }, new Headers(), 'Bad Request')), false);
});

test('isTooLong: a plain Error naming the gateway wording is too long', () => {
  assert.equal(isTooLong(new Error('max_tokens_exceeded')), true);
});

test('dangerHeaders names only the experimental path the call opted into', () => {
  assert.deepEqual(dangerHeaders(), {});
  assert.deepEqual(dangerHeaders({ images: true }), { 'TypeSafe-Danger-Zone-Images': 'true' });
  assert.deepEqual(dangerHeaders({ longContext: true }), { 'TypeSafe-Danger-Zone-Long-Context': 'true' });
  assert.deepEqual(dangerHeaders({ images: true, longContext: true }), {
    'TypeSafe-Danger-Zone-Images': 'true', 'TypeSafe-Danger-Zone-Long-Context': 'true',
  });
});

test('tokenCount treats a null usage field as zero', () => {
  assert.equal(tokenCount({ input_tokens: null, output_tokens: 4 }), 4);
  assert.equal(tokenCount({ input_tokens: 3, output_tokens: null }), 3);
  assert.equal(tokenCount({ input_tokens: null, output_tokens: null }), 0);
});
