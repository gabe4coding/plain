import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMs, timed, type StepContext } from './steps.js';

test('formatMs prints total first, then only the phases present', () => {
  assert.equal(formatMs({ total: 3985, settle: 512, jev: 1830 }), 'total=3985 settle=512 jev=1830');
  assert.equal(formatMs({ settle: 5 }), 'settle=5');
  assert.equal(formatMs({}), '');
});

test('timed() accumulates elapsed ms into ctx.ms[phase] across multiple calls', async () => {
  const ctx = { ms: {} } as unknown as StepContext;
  await timed(ctx, 'settle', () => new Promise((resolve) => setTimeout(resolve, 5)));
  const afterOne = ctx.ms.settle;
  assert.ok(afterOne > 0);
  await timed(ctx, 'settle', () => new Promise((resolve) => setTimeout(resolve, 5)));
  assert.ok(ctx.ms.settle > afterOne); // second call adds on top instead of overwriting
});
