import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSpec } from '../core/spec.js';
import { runSpec } from './runner.js';
import { closeSharedBrowser } from './session.js';
import type { Page } from 'playwright';
import type { SessionObserver } from '../core/run-contract.js';

test('browser observer sees session and step, captures screenshot before close', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-observer-'));
  const file = path.join(dir, 'spec.yaml'), screenshot = path.join(dir, 'shot.png');
  fs.writeFileSync(file, 'name: observer\nurl: data:text/html,ok\nsteps:\n  - goto: data:text/html,ok\n');
  const calls: string[] = [];
  const observer: SessionObserver<Page> = {
    async sessionOpen({ target }) { calls.push(`open:${target.engine}`); assert.ok(target.page); },
    async stepEnd({ index, result }) { calls.push(`step:${index}:${result.status}`); },
    async sessionClose({ status, target }) {
      calls.push(`close:${status}`);
      await target.screenshot(screenshot);
      return [{ kind: 'screenshot', path: screenshot }];
    },
  };
  try {
    const result = await runSpec(loadSpec(file), { headed: false, timeout: 5000 }, observer,
      { file, name: 'observer', tags: [], attempt: 0 });
    assert.equal(result.status, 'pass');
    assert.deepEqual(calls, ['open:browser', 'step:0:pass', 'close:pass']);
    assert.ok(fs.statSync(screenshot).size > 0);
  } finally {
    await closeSharedBrowser();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
