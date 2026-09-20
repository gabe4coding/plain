import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadSpec, interpolate } from './spec.js';

function specFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-e2e-spec-test-'));
  const path = join(dir, 'spec.yaml');
  writeFileSync(path, yaml);
  return path;
}

test('optional: true on a step is parsed, defaults to false otherwise', () => {
  const path = specFile(`
name: optional flag
url: https://example.com
steps:
  - click: "the cookie accept button"
    optional: true
  - press: Enter
`);
  const spec = loadSpec(path);
  assert.equal(spec.steps[0].optional, true);
  assert.equal(spec.steps[1].optional, false);
});

test('hover, dblclick and rightclick steps are parsed', () => {
  const path = specFile(`
name: pointer steps
url: https://example.com
steps:
  - hover: "the first avatar"
  - dblclick: "the file icon"
  - rightclick: "the context menu target"
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.steps[0], { kind: 'hover', target: 'the first avatar', optional: false });
  assert.deepEqual(spec.steps[1], { kind: 'dblclick', target: 'the file icon', optional: false });
  assert.deepEqual(spec.steps[2], { kind: 'rightclick', target: 'the context menu target', optional: false });
});

test('select step requires target and value', () => {
  const path = specFile(`
name: select
url: https://example.com
steps:
  - select: { target: "the dropdown list", value: "Option 2" }
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.steps[0], { kind: 'select', target: 'the dropdown list', value: 'Option 2', optional: false });
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nsteps:\n  - select: { target: "a" }\n')));
});

test('check and uncheck steps are parsed', () => {
  const path = specFile(`
name: checkboxes
url: https://example.com
steps:
  - check: "the first checkbox"
  - uncheck: "the second checkbox"
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.steps[0], { kind: 'check', target: 'the first checkbox', optional: false });
  assert.deepEqual(spec.steps[1], { kind: 'uncheck', target: 'the second checkbox', optional: false });
});

test('upload step requires a non-empty files list', () => {
  const path = specFile(`
name: upload
url: https://example.com
steps:
  - upload: { target: "the file input", files: ["fixtures/hello.txt"] }
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.steps[0], { kind: 'upload', target: 'the file input', files: ['fixtures/hello.txt'], optional: false });
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nsteps:\n  - upload: { target: "a", files: [] }\n')));
});

test('scroll step is parsed, including the top/bottom shortcuts', () => {
  const path = specFile(`
name: scroll
url: https://example.com
steps:
  - scroll: bottom
  - scroll: "the footer link"
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.steps[0], { kind: 'scroll', target: 'bottom', optional: false });
  assert.deepEqual(spec.steps[1], { kind: 'scroll', target: 'the footer link', optional: false });
});

test('wait step is parsed for both css= and natural-language conditions', () => {
  const path = specFile(`
name: wait
url: https://example.com
steps:
  - wait: "css=#done"
  - wait: "the text 'Hello World!' is visible"
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.steps[0], { kind: 'wait', condition: 'css=#done', optional: false });
  assert.deepEqual(spec.steps[1], { kind: 'wait', condition: "the text 'Hello World!' is visible", optional: false });
});

test('expect supports the plain string, list, and scoped { that, within } forms', () => {
  const path = specFile(`
name: expect forms
url: https://example.com
steps:
  - expect: "the page loaded"
  - expect: ["claim one is true", "claim two is true"]
  - expect: { that: "a success message is shown", within: "the dialog" }
  - expect: { that: ["claim a", "claim b"] }
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.steps[0], { kind: 'expect', expectations: ['the page loaded'], optional: false });
  assert.deepEqual(spec.steps[1], {
    kind: 'expect',
    expectations: ['claim one is true', 'claim two is true'],
    optional: false,
  });
  assert.deepEqual(spec.steps[2], {
    kind: 'expect',
    expectations: ['a success message is shown'],
    within: 'the dialog',
    optional: false,
  });
  assert.deepEqual(spec.steps[3], { kind: 'expect', expectations: ['claim a', 'claim b'], optional: false });
});

test('expect rejects an empty list and a non-string item, in both the plain and { that } forms', () => {
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nsteps:\n  - expect: []\n')));
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nsteps:\n  - expect: [1]\n')));
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nsteps:\n  - expect: { that: [] }\n')));
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nsteps:\n  - expect: { that: [1] }\n')));
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nsteps:\n  - expect: { that: "" }\n')));
});

test('auth option is parsed, literal values pass through unchanged', () => {
  const path = specFile(`
name: auth
url: https://example.com
auth: { user: admin, pass: admin }
steps:
  - click: "ok"
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.auth, { user: 'admin', pass: 'admin' });
});

test('auth option resolves $VAR values from the environment, errors clearly if unset', () => {
  process.env.JEV_E2E_TEST_PASS = 'secret123';
  const withEnv = loadSpec(
    specFile('name: x\nurl: https://example.com\nauth: { user: admin, pass: "$JEV_E2E_TEST_PASS" }\nsteps:\n  - click: "ok"\n')
  );
  assert.deepEqual(withEnv.auth, { user: 'admin', pass: 'secret123' });
  delete process.env.JEV_E2E_TEST_PASS;
  assert.throws(
    () => loadSpec(specFile('name: x\nurl: https://example.com\nauth: { user: admin, pass: "$JEV_E2E_TEST_PASS" }\nsteps:\n  - click: "ok"\n')),
    /JEV_E2E_TEST_PASS/
  );
});

test('geolocation option is parsed, requires numeric lat/lon', () => {
  const path = specFile(`
name: geo
url: https://example.com
geolocation: { lat: 45.4642, lon: 9.19 }
steps:
  - click: "ok"
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.geolocation, { lat: 45.4642, lon: 9.19 });
  assert.throws(() =>
    loadSpec(specFile('name: x\nurl: https://example.com\ngeolocation: { lat: "45" }\nsteps:\n  - click: "ok"\n'))
  );
});

test('drag step requires source and target', () => {
  const path = specFile(`
name: drag
url: https://example.com
steps:
  - drag: { source: "the box labelled A", target: "the box labelled B" }
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.steps[0], { kind: 'drag', source: 'the box labelled A', target: 'the box labelled B', optional: false });
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nsteps:\n  - drag: { source: "a" }\n')));
});

test('mouse step requires numeric x/y, y may be negative', () => {
  const path = specFile(`
name: mouse
url: https://example.com
steps:
  - mouse: { x: 300, y: 300 }
  - mouse: { x: 300, y: -10 }
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.steps[0], { kind: 'mouse', x: 300, y: 300, optional: false });
  assert.deepEqual(spec.steps[1], { kind: 'mouse', x: 300, y: -10, optional: false });
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nsteps:\n  - mouse: { x: "a", y: 1 }\n')));
});

test('dialogs option is parsed at the top level, defaults to accept', () => {
  const withDialogs = loadSpec(
    specFile('name: x\nurl: https://example.com\ndialogs: dismiss\nsteps:\n  - click: "ok"\n')
  );
  assert.equal(withDialogs.dialogs, 'dismiss');
  const withoutDialogs = loadSpec(specFile('name: x\nurl: https://example.com\nsteps:\n  - click: "ok"\n'));
  assert.equal(withoutDialogs.dialogs, 'accept');
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\ndialogs: maybe\nsteps:\n  - click: "ok"\n')));
});

test('env block is parsed with arbitrary nesting', () => {
  const path = specFile(`
name: env block
url: https://example.com
env:
  path: /login
  user:
    name: tomsmith
steps:
  - click: "ok"
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.env, { path: '/login', user: { name: 'tomsmith' } });
});

test('env leaves starting with $ resolve from the OS environment, missing var fails clearly', () => {
  process.env.JEV_TEST_X = 'abc';
  const withVar = loadSpec(
    specFile('name: x\nurl: https://example.com\nenv:\n  token: "$JEV_TEST_X"\nsteps:\n  - click: "ok"\n')
  );
  assert.deepEqual(withVar.env, { token: 'abc' });
  delete process.env.JEV_TEST_X;
  assert.throws(
    () => loadSpec(specFile('name: x\nurl: https://example.com\nenv:\n  token: "$JEV_TEST_X"\nsteps:\n  - click: "ok"\n')),
    /JEV_TEST_X/
  );
});

test('env must be a mapping', () => {
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nenv: nope\nsteps:\n  - click: "ok"\n')));
});

test('hooks resolves to an absolute path relative to the spec file, must be a non-empty string', () => {
  const path = specFile('name: x\nurl: https://example.com\nhooks: ./hooks.mjs\nsteps:\n  - click: "ok"\n');
  const spec = loadSpec(path);
  assert.equal(spec.hooks, join(dirname(path), 'hooks.mjs'));
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nhooks: 5\nsteps:\n  - click: "ok"\n')));
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nhooks: ""\nsteps:\n  - click: "ok"\n')));
});

test('interpolate replaces ${env.*} and ${hooks.*} in a fill value, an expect entry, and a url', () => {
  const vars = { env: { user: { name: 'tomsmith' } }, hooks: { lease: { id: 7 } } };
  const value = {
    url: 'https://example.com/${hooks.lease.id}',
    fill: { target: 'the username field', value: '${env.user.name}' },
    expectations: ['claim one', 'lease ${hooks.lease.id} is active'],
  };
  const result = interpolate(value, vars, 'test spec');
  assert.equal(result.url, 'https://example.com/7');
  assert.equal(result.fill.value, 'tomsmith');
  assert.deepEqual(result.expectations, ['claim one', 'lease 7 is active']);
});

test('interpolate stringifies a number leaf', () => {
  const result = interpolate('id ${hooks.lease.id}', { env: {}, hooks: { lease: { id: 7 } } }, 'test spec');
  assert.equal(result, 'id 7');
});

test('interpolate fails on an unknown namespace and on an unresolved placeholder, naming the placeholder', () => {
  assert.throws(() => interpolate('${foo.x}', { env: {}, hooks: {} }, 'test spec'), /\$\{foo\.x\}/);
  assert.throws(() => interpolate('${env.nope}', { env: {}, hooks: {} }, 'test spec'), /\$\{env\.nope\}/);
});

test('interpolate returns a value without placeholders unchanged', () => {
  assert.equal(interpolate('plain string', { env: {}, hooks: {} }, 'test spec'), 'plain string');
});
