import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSuite } from '../run-suite.js';
import { loadSpec } from '../../core/spec.js';
import type { Status } from '../../core/results.js';
import type { SuiteEngine, SuiteOptions } from '../types.js';
import { capture, options as baseOptions } from './fixtures.test.js';

const options = (files: string[], timing = false): SuiteOptions => ({ ...baseOptions, files, workers: 4, reporters: [{ name: 'text' }], timing });
const services = { provider: () => 'typesafe' as const, warmUp: () => {} };

test('browser text golden output covers every status, load error, and input order with four workers', async () => {
  const files = ['pass', 'fail', 'inconclusive', 'skipped', 'error', 'missing'];
  const statuses: Status[] = ['pass', 'fail', 'inconclusive', 'skipped', 'error'];
  const finished: string[] = [];
  const engine: SuiteEngine<string> = { engine: 'browser', maxWorkers: 4,
    load: (file) => { if (file === 'missing') throw new Error('bad yaml'); return file; },
    meta: (name) => ({ name, tags: [] }),
    run: async (name) => {
      await new Promise((resolve) => setTimeout(resolve, name === 'pass' ? 30 : 1));
      finished.push(name);
      const status = statuses[files.indexOf(name)];
      return { name, status, steps: [{ step: `click "${name}"`, status, detail: 'detail' }], jevCalls: 1, totalTokens: 10 };
    },
  };
  const lines = await capture(() => runSuite(engine, options(files), services));
  assert.notEqual(finished[0], 'pass');
  assert.deepEqual(lines, [
    '✔ pass  (1 Jev calls, 10 tokens)', '  ✔ click "pass" detail',
    '✘ fail  (1 Jev calls, 10 tokens)', '  ✘ click "fail" detail',
    '? inconclusive  (1 Jev calls, 10 tokens)', '  ? click "inconclusive" detail',
    '» skipped  (1 Jev calls, 10 tokens)', '  » click "skipped" detail',
    '✘ error  (1 Jev calls, 10 tokens)', '  ✘ click "error" detail',
    '✘ missing', '  error: bad yaml',
  ]);
});

test('browser load errors still print the message on stdout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-text-load-'));
  const yaml = path.join(dir, 'bad.yaml');
  const schema = path.join(dir, 'schema.yaml');
  fs.writeFileSync(yaml, 'a: [\n');
  fs.writeFileSync(schema, 'name: x\nurl: /\nsteps:\n  - nope: 1\n');
  const message = (file: string): string => {
    try { loadSpec(file); }
    catch (error) { return error instanceof Error ? error.message : String(error); }
    throw new Error(`expected ${file} to fail to load`);
  };
  const engine: SuiteEngine<ReturnType<typeof loadSpec>> = { engine: 'browser', maxWorkers: Infinity, load: loadSpec,
    meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [] }),
    run: async () => { throw new Error('not run'); } };
  try {
    assert.deepEqual(await capture(() => runSuite(engine, options([yaml, schema]), services)), [
      `✘ ${yaml}`, `  error: ${message(yaml)}`,
      `✘ ${schema}`, `  error: ${message(schema)}`,
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('browser timing golden output is unchanged on and off', async () => {
  const engine: SuiteEngine<string> = { engine: 'browser', maxWorkers: 4, load: (file) => file,
    meta: (name) => ({ name, tags: [] }),
    run: async (name) => ({ name, status: 'pass', jevCalls: 0, totalTokens: 0,
      steps: [{ step: 'goto data:text/html,ok', status: 'pass', ms: { total: 12, settle: 3 } as Record<string, number> },
        { step: 'expect "ok"', status: 'pass', ms: { total: 8, jev: 2 } as Record<string, number> }] }),
  };
  assert.deepEqual(await capture(() => runSuite(engine, options(['case']), services)), [
    '✔ case  (0 Jev calls, 0 tokens)', '  ✔ goto data:text/html,ok', '  ✔ expect "ok"',
  ]);
  assert.deepEqual(await capture(() => runSuite(engine, options(['case'], true), services)), [
    '✔ case  (0 Jev calls, 0 tokens)', '  ✔ goto data:text/html,ok', '    ms total=12 settle=3',
    '  ✔ expect "ok"', '    ms total=8 jev=2', '  ms spec total=20 settle=3 jev=2',
    'ms run total=20 settle=3 jev=2',
  ]);
});

test('a spec whose run threw prints the file and the error', async () => {
  const engine: SuiteEngine<string> = { engine: 'browser', maxWorkers: 4, load: (file) => file,
    meta: (name) => ({ name: `spec ${name}`, tags: [] }),
    run: async () => { throw new Error("Cannot find module '/x/hooks.mjs'"); } };
  const lines = await capture(() => runSuite(engine, options(['a.yaml']), services));
  assert.deepEqual(lines, ['✘ a.yaml', "  error: Cannot find module '/x/hooks.mjs'"]);
});
