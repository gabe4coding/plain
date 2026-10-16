import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScroll, requireScroll, scrollText } from './direction.js';

test('a scroll parses only against the directions an engine declares, and its text round-trips', () => {
  assert.deepEqual(parseScroll('left:  the photo strip ', ['left', 'right']), { direction: 'left', target: 'the photo strip ' });
  assert.equal(parseScroll('up: the list', ['left', 'right']), undefined);
  assert.equal(parseScroll('the list', ['up']), undefined);
  assert.throws(() => requireScroll('up: the list', ['left', 'right'], 'Fixture'), /^Error: Fixture scroll syntax: .*\(directions: left, right\)$/);
  assert.equal(scrollText(requireScroll('down:the list', ['down'], 'Fixture')), 'down: the list');
});
