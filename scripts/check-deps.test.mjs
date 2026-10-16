// Tests of the module boundary rules in .dependency-cruiser.cjs: each rule still names files of the real src/, a
// throwaway tree with only allowed imports passes, and a tree with one planted import per rule fails each rule
// exactly. A rule without a planted case fails the test.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configFile = join(root, '.dependency-cruiser.cjs');
const config = createRequire(import.meta.url)(configFile);
const cli = join(root, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs');
const TSCONFIG = { compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true }, include: ['src'] };
const temps = [];
after(() => temps.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Writes `src/<path>` files, each importing the listed paths, and returns the rule violations depcruise reports. */
function cruise(tree) {
  const dir = mkdtempSync(join(tmpdir(), 'plain-deps-'));
  temps.push(dir);
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(TSCONFIG));
  for (const [file, imports] of Object.entries(tree)) {
    const path = join(dir, 'src', file);
    mkdirSync(dirname(path), { recursive: true });
    const lines = imports.map((target) => {
      const from = dirname(`src/${file}`).split('/').map(() => '..').join('/');
      return `import '${from}/src/${target.replace(/\.ts$/, '.js')}';`;
    });
    writeFileSync(path, [...lines, 'export const value = 1;', ''].join('\n'));
  }
  const run = spawnSync(process.execPath, [cli, 'src', '--config', configFile, '--output-type', 'json'],
    { cwd: dir, encoding: 'utf8' });
  assert.ok(run.stdout, run.stderr);
  return JSON.parse(run.stdout).summary.violations
    .map(({ rule, from, to }) => ({ rule: rule.name, from: from.replace(/^src\//, ''), to: to.replace(/^src\//, '') }));
}

test('each rule path names files in the real src/, so a renamed folder fails here', () => {
  const files = execFileSync('git', ['-C', root, 'ls-files', 'src'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const rule of config.forbidden) {
    for (const side of ['from', 'to']) {
      for (const pattern of [rule[side].path ?? []].flat()) {
        assert.ok(files.some((file) => new RegExp(pattern).test(file)), `${rule.name}: ${side}.path ${pattern} matches no file`);
      }
    }
  }
});

test('passes every allowed import between the folders, and imports from tests', () => {
  const violations = cruise({
    'cli.ts': ['browser/a.ts', 'suite/a.ts', 'core/a.ts', 'jev/a.ts'],
    'computer/cli.ts': ['suite/native-cli.ts', 'native/a.ts', 'core/a.ts', 'jev/a.ts'],
    'computer/a.ts': ['native/a.ts', 'core/a.ts', 'jev/a.ts'],
    'mobile/cli.ts': ['suite/native-cli.ts', 'native/a.ts'],
    'mobile/a.ts': ['native/a.ts', 'core/a.ts', 'jev/a.ts'],
    'browser/a.ts': ['core/a.ts', 'jev/a.ts'],
    'native/a.ts': ['core/a.ts', 'jev/a.ts'],
    'suite/native-cli.ts': ['suite/a.ts', 'core/a.ts', 'jev/a.ts'],
    'suite/a.ts': ['core/a.ts', 'jev/a.ts'],
    'core/a.ts': ['jev/a.ts'],
    'jev/a.ts': ['core/candidate.ts'],
    'core/candidate.ts': [],
    'browser/a.test.ts': ['suite/a.ts', 'computer/a.ts', 'cli.ts'],
  });
  assert.deepEqual(violations, []);
});

test('fails one planted import per rule, and only with that rule', () => {
  const planted = {
    'no-circular': ['core/loop-a.ts', 'core/loop-b.ts'],
    'known-areas': ['shared/a.ts', 'core/a.ts'],
    'known-areas-target': ['core/b.ts', 'shared/b.ts'],
    'browser-isolated': ['browser/a.ts', 'native/a.ts'],
    'native-no-platforms': ['native/b.ts', 'mobile/a.ts'],
    'platforms-isolated': ['computer/a.ts', 'mobile/a.ts'],
    'core-no-up': ['core/c.ts', 'browser/b.ts'],
    'jev-is-leaf': ['jev/a.ts', 'core/a.ts'],
    'candidate-is-leaf': ['core/candidate.ts', 'core/a.ts'],
    'suite-no-engines': ['suite/a.ts', 'browser/b.ts'],
    'engines-no-suite': ['native/c.ts', 'suite/b.ts'],
    'platform-cli-wiring': ['mobile/cli.ts', 'suite/c.ts'],
    'plain-cli-browser-only': ['cli.ts', 'computer/b.ts'],
    'no-cli-imports': ['browser/c.ts', 'cli.ts'],
    'no-test-imports': ['core/d.ts', 'core/a.test.ts'],
  };
  assert.deepEqual(Object.keys(planted).sort(), config.forbidden.map(({ name }) => name).sort(),
    'every rule in .dependency-cruiser.cjs needs one planted import here');
  const tree = { 'core/loop-b.ts': ['core/loop-a.ts'] };
  for (const [from, to] of Object.values(planted)) {
    tree[from] = [...(tree[from] ?? []), to];
    tree[to] ??= [];
  }
  const violations = cruise(tree);
  for (const [rule, [from, to]] of Object.entries(planted)) {
    const hit = violations.some((v) => v.rule === rule && (rule === 'no-circular' ? [from, to].includes(v.from) : v.from === from && v.to === to));
    assert.ok(hit, `${rule}: no violation for ${from} -> ${to}; got ${JSON.stringify(violations)}`);
  }
  assert.deepEqual([...new Set(violations.map(({ rule }) => rule))].sort(), Object.keys(planted).sort());
});
