import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './jev.js';

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
