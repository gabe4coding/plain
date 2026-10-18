import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateHash, type Observed } from './judge-page.js';

const snap = { url: 'https://app.test/items?x=1', title: 'Items', aria: 'cut', truncated: true };

test('stateHash uses the uncut tree when the capture kept one', () => {
  const cut = stateHash({ snap, events: [] });
  const full = stateHash({ snap, events: [], fullAria: 'cut plus the tail' });
  assert.notEqual(cut, full);
  assert.equal(stateHash({ snap: { ...snap, truncated: false }, events: [] }), cut);
  const again: Observed = { snap, events: ['download: report saved to /tmp/a'], fullAria: 'cut plus the tail' };
  assert.equal(stateHash(again), stateHash({ ...again, events: ['download: report saved to /tmp/b'] }));
});
