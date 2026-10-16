import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-cli-d-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const engines = [
  { cli: 'cli.js', entry: '../cli.js', header: 'url: https://example.com', action: 'click' },
  { cli: 'computer-cli.js', entry: '../computer/cli.js', header: 'app: TestApp', action: 'click' },
  { cli: 'mobile-cli.js', entry: '../mobile/cli.js', header: 'platform: android\ndevice: fixture\napp: org.test', action: 'tap' },
];
const env = { ...process.env, TYPESAFE_API_KEY: '', AI_GATEWAY_API_KEY: '', JEV_PROVIDER: 'invalid-provider' };
const entryOf = (cli: string) => engines.find((engine) => engine.cli === cli)!.entry;
function run(cli: string, args: string[]) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(entryOf(cli), import.meta.url)), ...args],
    { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined);
  return result;
}

for (const { cli, header, action } of engines) {
  const file = `${cli}.yaml`;
  fs.writeFileSync(path.join(dir, file), `name: Smoke\ntags: [smoke, checkout]\n${header}\nsteps:\n  - ${action}: OK\n`);
  test(`${cli}: --list applies selection without asking for a provider`, () => {
    const result = run(cli, ['--list', '--grep', '^Smoke$', '--tag', 'smoke', '--tag', 'checkout', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${file}  Smoke  [smoke, checkout]`);
    assert.equal(result.stderr, '');
    const empty = run(cli, ['--list', '--tag', 'absent', file]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout, '');
  });
  test(`${cli}: invalid regex returns usage exit 2`, () => {
    const result = run(cli, ['--list', '--grep', '[', file]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--grep: invalid regex/);
  });
  test(`${cli}: validate is key-free and distinguishes warnings from errors`, () => {
    assert.equal(run(cli, ['validate', file]).status, 0);
    const warning = `${cli}-warn.yaml`;
    fs.writeFileSync(path.join(dir, warning), `name: Warning\n${header}\nenv: {value: $PLAIN_LANE_D_MISSING_ENV}\nsteps:\n  - ${action}: '\${env.value}'\n`);
    const warned = run(cli, ['validate', warning]);
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stdout, new RegExp(`^✔ ${warning}$`, 'm'));
    assert.match(warned.stdout, new RegExp(`^! ${warning}: .*env var is not set`, 'm'));
    const bad = `${cli}-bad.yaml`;
    fs.writeFileSync(path.join(dir, bad), `name: Bad\n${header}\nsteps:\n  - ${action}: '\${env.missing}'\n`);
    const invalid = run(cli, ['validate', bad]);
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stdout, new RegExp(`^✘ ${bad}: .*env.missing.*not defined`, 'm'));
  });
  test(`${cli}: validate warns on a literal secret in a fill step or an env key, not on $VAR`, () => {
    const literal = `${cli}-literal.yaml`;
    fs.writeFileSync(path.join(dir, literal), `name: Literal\n${header}\n` +
      'env: {apiKey: abc123, user: ada, credentials: {stripe: sk_test_1}}\nsteps:\n' +
      `  - fill: { target: the Password field, value: hunter2 }\n  - fill: { target: the Name field, value: '\${env.user}' }\n`);
    const warned = run(cli, ['validate', literal]);
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stdout, new RegExp(`^✔ ${literal}$`, 'm'));
    assert.match(warned.stdout, new RegExp(`^! ${literal}: .*"env\\.apiKey" holds a literal secret`, 'm'));
    assert.match(warned.stdout, new RegExp(`^! ${literal}: .*"env\\.credentials\\.stripe" holds a literal secret`, 'm'));
    assert.match(warned.stdout, new RegExp(`^! ${literal}: .*step 0 fills "the Password field" with a literal secret`, 'm'));
    assert.equal(warned.stdout.match(/literal secret/g)?.length, 3, warned.stdout);
    const referenced = `${cli}-referenced.yaml`;
    fs.writeFileSync(path.join(dir, referenced), `name: Referenced\n${header}\n` +
      'env: {password: $PLAIN_TEST_UNSET_PASSWORD, db_pass: $PLAIN_TEST_UNSET_PASSWORD}\nsteps:\n' +
      `  - fill: { target: the Password field, value: '\${env.password}' }\n`);
    const clean = run(cli, ['validate', referenced]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.doesNotMatch(clean.stdout, /literal secret/);
  });
}

test('cli.js: validate warns on a literal auth pass and names the flow of an included literal fill', () => {
  fs.mkdirSync(path.join(dir, 'flows'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'flows/sign-in.yaml'), 'steps:\n  - fill: { target: the PIN field, value: "1234" }\n');
  const spec = 'auth-literal.yaml';
  fs.writeFileSync(path.join(dir, spec), 'name: Auth\nurl: https://example.com\nauth: { user: admin, pass: admin }\n' +
    'steps:\n  - goto: /\n  - include: ./flows/sign-in.yaml\n');
  const warned = run('cli.js', ['validate', spec]);
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stdout, new RegExp(`^! ${spec}: .*"auth\\.pass" holds a literal secret`, 'm'));
  assert.match(warned.stdout, new RegExp(`^! ${spec}: .*flows.sign-in\\.yaml: step 0 fills "the PIN field" with a literal secret`, 'm'));
  assert.doesNotMatch(warned.stdout, /auth\.user/);
});

test('cli.js: validate warns on literal text next to a placeholder, in list items and on pin names, not on spinner', () => {
  const spec = 'edges-literal.yaml';
  fs.writeFileSync(path.join(dir, spec), [
    'name: Edges', 'url: https://example.com', 'env:',
    '  accounts: [{user: tom, password: hunter2}]', '  passwords: [{a: hunter2}]',
    '  user_pin: 1234', '  pinCode: "0000"', '  passphrase: open sesame',
    '  spinner: fast', '  pinned: yes', '  opinion: good', '  pin_code: $PLAIN_TEST_UNSET_PASSWORD',
    'steps:', '  - goto: /',
    `  - fill: { target: the Password field, value: 'hunter2\${env.spinner}' }`,
    `  - fill: { target: the Password field, value: '\${env.passphrase}' }`,
    '  - fill: { target: the spinner speed field, value: fast }',
    '  - fill: { target: the userPin field, value: "42" }', '',
  ].join('\n'));
  const warned = run('cli.js', ['validate', spec]);
  assert.equal(warned.status, 0, warned.stderr);
  for (const field of ['env.accounts.0.password', 'env.passwords.0.a', 'env.user_pin', 'env.pinCode', 'env.passphrase']) {
    assert.match(warned.stdout, new RegExp(`"${field.replaceAll('.', '\\.')}" holds a literal secret`), warned.stdout);
  }
  assert.match(warned.stdout, /step 1 fills "the Password field" with a literal secret/);
  assert.match(warned.stdout, /step 4 fills "the userPin field" with a literal secret/);
  assert.equal(warned.stdout.match(/literal secret/g)?.length, 7, warned.stdout);
  assert.doesNotMatch(warned.stdout, /(spinner|pinned|opinion|accounts\.0\.user|pin_code)" holds|step [23] fills/);
});
