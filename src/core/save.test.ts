import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { entryKey, lockPath, parseLock, type LockEntry, type LockRef } from './lock.js';
import { SecretNames, writeSaved } from './save.js';

test('SecretNames asks only about new values, keeps empty and placeholder values, and its env block matches its keys', async () => {
  const secrets = new SecretNames();
  let asked = 0;
  const saved = async (value: string, secret: boolean) => {
    const step = await secrets.savedFill({ fill: { target: 'Field', value } }, value, () => (asked++, secret));
    return (step.fill as { value: string }).value;
  };
  assert.deepEqual(secrets.env(), {});
  assert.equal(await saved('', true), '');
  assert.equal(await saved('${hooks.pin}', true), '${hooks.pin}');
  assert.equal(asked, 0);
  assert.equal(await saved('tomsmith', false), 'tomsmith');
  assert.equal(await saved('hunter2', true), '${env.password}');
  assert.equal(await saved('correct horse', true), '${env.password2}');
  assert.equal(await saved('hunter2', false), '${env.password}');
  assert.equal(await saved('batteries', true), '${env.password3}');
  assert.equal(asked, 4);
  assert.deepEqual(secrets.env(), { env: { password: '$PASSWORD', password2: '$PASSWORD_2', password3: '$PASSWORD_3' } });
});

const ref = (index: number): LockRef => ({ at: { file: '', index }, kind: 'click', slot: 'target:Go' });
const entry = (n: number): LockEntry => ({ locator: { n }, text: `button ${n}` });
const recorded = [1, 2, 0, 3].map((index) => ({ ref: ref(index), entry: entry(index) }));
const steps = [{ click: 'Go' }, { click: 'Go' }];

test('writeSaved locks only the saved steps, removes a lock with no entry left, and refuses an empty spec', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plain-save-'));
  try {
    const file = join(dir, 'flow.yaml');
    assert.deepEqual(writeSaved(file, { name: 'flow', steps }, recorded), { lock: lockPath(file) });
    assert.deepEqual(parse(readFileSync(file, 'utf8')), { name: 'flow', steps });
    assert.deepEqual(parseLock(readFileSync(lockPath(file), 'utf8'))?.entries,
      new Map([[entryKey(ref(0)), entry(0)], [entryKey(ref(1)), entry(1)]]));
    assert.deepEqual(writeSaved(file, { name: 'flow', steps }, []), {});
    assert.equal(existsSync(lockPath(file)), false);
    writeFileSync(lockPath(file), '{}\n');
    assert.throws(() => writeSaved(file, { name: 'empty', steps: [] }, recorded), /No successful steps to save/);
    assert.equal(parse(readFileSync(file, 'utf8')).name, 'flow');
    assert.equal(readFileSync(lockPath(file), 'utf8'), '{}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
