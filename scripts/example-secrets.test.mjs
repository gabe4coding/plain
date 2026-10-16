// Integration test of the literal-secret rule of check-examples: real `validate` output of the browser CLI on
// spec files, then the lines that fail the check. Build first (npm run build).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { literalSecrets } from './example-secrets.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const dir = mkdtempSync(join(tmpdir(), 'plain-example-secrets-'));
after(() => rmSync(dir, { recursive: true, force: true }));

function failing(specs) {
  for (const [name, text] of Object.entries(specs)) writeFileSync(join(dir, name), text);
  const out = spawnSync(process.execPath, [cli, 'validate', ...Object.keys(specs)], { cwd: dir, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  return literalSecrets(out.stdout, (file) => readFileSync(join(dir, file), 'utf8')).map(({ file, line }) =>
    `${file}: ${/"([^"]+)" (?:holds|with) a literal secret/.exec(line)[1]}`);
}

const spec = (head, fill) => `name: s\nurl: https://example.com\n${head}steps:\n  - goto: /\n` +
  `  - fill: { target: the Password field, value: ${fill} }\n`;

test('an expect-fail spec may fill a wrong literal password, but its auth and env literals still fail', () => {
  assert.deepEqual(failing({
    'negative.yaml': spec('tags: [expect-fail]\n', 'wrong'),
    'negative-env.yaml': spec('tags: [expect-fail]\nenv: {apiToken: abc123}\nauth: {user: admin, pass: admin}\n', 'wrong'),
    'positive.yaml': spec('tags: smoke\n', 'hunter2'),
  }), [
    'negative-env.yaml: auth.pass',
    'negative-env.yaml: env.apiToken',
    'positive.yaml: the Password field',
  ]);
});

test('a spec with $VAR values and ${env.*} fills has nothing to fail', () => {
  assert.deepEqual(failing({ 'clean.yaml': spec('env: {password: $PLAIN_TEST_UNSET_PASSWORD}\n', "'${env.password}'") }), []);
});
