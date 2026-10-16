import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadSpec, parseStep } from './spec.js';
import { interpolate } from './interpolate.js';

// The step source (`at`, the lock key) is covered in src/core/lock.test.ts; these tests compare the parsed steps without it.
function stripped(spec: ReturnType<typeof loadSpec>) {
  return { ...spec, steps: spec.steps.map(({ at: _at, ...step }) => step) };
}

function specFile(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'plain-spec-test-'));
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
  assert.deepEqual(spec.auth, { user: 'admin', pass: 'admin' });
});

test('auth option resolves $VAR values from the environment, errors clearly if unset', () => {
  process.env.PLAIN_TEST_PASS = 'secret123';
  const withEnv = loadSpec(
    specFile('name: x\nurl: https://example.com\nauth: { user: admin, pass: "$PLAIN_TEST_PASS" }\nsteps:\n  - click: "ok"\n')
  );
  assert.deepEqual(withEnv.auth, { user: 'admin', pass: 'secret123' });
  delete process.env.PLAIN_TEST_PASS;
  assert.throws(
    () => loadSpec(specFile('name: x\nurl: https://example.com\nauth: { user: admin, pass: "$PLAIN_TEST_PASS" }\nsteps:\n  - click: "ok"\n')),
    /PLAIN_TEST_PASS/
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
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
  const spec = stripped(loadSpec(path));
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


test('step normalization preserves empty fill values', () => {
  assert.deepEqual(parseStep('mcp', 0, { fill: { target: 'the input', value: '' } }), { kind: 'fill', target: 'the input', value: '', optional: false });
  assert.deepEqual(parseStep('mcp', 1, { goto: '/login', optional: 'true' }), {
    kind: 'goto', url: '/login', optional: false,
  });
});

test('step validation reports source, step index and invalid field', () => {
  assert.throws(() => parseStep('session', 3, { fill: { target: 'input', value: 42 } }),
    /invalid spec: session: step 3: "value"/);
  for (const raw of [null, [], { click: 'a', hover: 'b' }, { unknown: 'a' }, { fill: [] }]) {
    assert.throws(() => parseStep('session', 3, raw), /invalid spec: session: step 3/);
  }
});

test('spec validation rejects arrays for mappings and non-finite coordinates', () => {
  for (const setting of ['env: []', 'auth: []', 'geolocation: []', 'geolocation: { lat: .nan, lon: 0 }']) {
    assert.throws(() => loadSpec(specFile(`name: x\nurl: /\n${setting}\nsteps:\n  - goto: /\n`)), /invalid spec:/);
  }
  for (const x of [NaN, Infinity, -Infinity]) {
    assert.throws(() => parseStep('session', 0, { mouse: { x, y: -10 } }), /step 0: "x"/);
  }
});

test('file specs require steps; dialogs and env have defaults', () => {
  assert.throws(() => loadSpec(specFile('name: x\nurl: /\nsteps: []\n')), /"steps"/);
  const spec = loadSpec(specFile('name: x\nurl: /\ndialogs: null\nsteps:\n  - goto: /\n'));
  assert.equal(spec.dialogs, 'accept');
  assert.deepEqual(spec.env, {});
});

test('a spec may name the goal of its flow', () => {
  const file = specFile('name: g\nurl: https://example.com\ngoal: read the F-Droid discussion\nsteps:\n  - click: the comments link\n');
  assert.equal(loadSpec(file).goal, 'read the F-Droid discussion');
});

test('wait takes a claim, or {that, within} to poll one region', () => {
  assert.deepEqual(parseStep('t', 0, { wait: 'the results are shown' }), { kind: 'wait', condition: 'the results are shown', optional: false });
  assert.deepEqual(parseStep('t', 0, { wait: { that: 'a price is shown', within: 'the results list' } }),
    { kind: 'wait', condition: 'a price is shown', within: 'the results list', optional: false });
  assert.throws(() => parseStep('t', 0, { wait: { within: 'the results list' } }), /invalid spec/);
});

test('unknown keys inside a step are errors that name the key and the closest known one', () => {
  const cases: [unknown, RegExp][] = [
    [{ expect: { that: 'a', whithin: 'b' } }, /step 2 "expect": unknown key "whithin"; did you mean "within"\?/],
    [{ wait: { that: 'a', withn: 'b' } }, /step 2 "wait": unknown key "withn"; did you mean "within"\?/],
    [{ fill: { target: 'a', valeu: 'b' } }, /step 2 "fill": unknown key "valeu"; did you mean "value"\?/],
    [{ select: { target: 'a', value: 'b', extra: 1 } }, /step 2 "select": unknown key "extra" \(expected one of target, value\)/],
    [{ upload: { target: 'a', file: ['x'] } }, /unknown key "file"; did you mean "files"\?/],
    [{ drag: { sourse: 'a', target: 'b' } }, /unknown key "sourse"; did you mean "source"\?/],
    [{ mouse: { x: 1, y: 2, z: 3 } }, /step 2 "mouse": unknown key "z"; did you mean "x"\?/],
    [{ click: 'a', optinal: true }, /step 2: unknown key "optinal"; did you mean "optional"\?/],
    [{ clik: 'a' }, /step 2: unknown key "clik"; did you mean "click"\?/],
    [{ click: 'a', within: 'b' }, /step 2: unknown key "within"/],
    [{ click: 'a', hover: 'b' }, /step 2 must have exactly one action key/],
  ];
  for (const [raw, message] of cases) assert.throws(() => parseStep('mcp', 2, raw), message, JSON.stringify(raw));
});

test('every documented step form and optional still parse', () => {
  const steps = [
    { goto: '/' }, { fill: { target: 'a', value: 'b' } }, { click: 'a', optional: true }, { hover: 'a' }, { dblclick: 'a' },
    { rightclick: 'a' }, { select: { target: 'a', value: 'b' } }, { check: 'a' }, { uncheck: 'a' },
    { upload: { target: 'a', files: ['x'] } }, { scroll: 'down' }, { wait: 'a' }, { wait: { that: 'a', within: 'b' } },
    { press: 'Enter' }, { drag: { source: 'a', target: 'b' } }, { mouse: { x: 0, y: -1 } }, { expect: 'a' }, { expect: ['a', 'b'] },
    { expect: { that: ['a'], within: 'b' } },
  ];
  for (const step of steps) assert.doesNotThrow(() => parseStep('mcp', 0, step), JSON.stringify(step));
});

test('unknown top-level and nested spec keys are errors that name the key', () => {
  const spec = (extra: string) => specFile(`name: x\nurl: https://example.com\n${extra}steps:\n  - goto: /\n`);
  const cases: [string, RegExp][] = [
    ['timout: 5\n', /spec\.yaml: unknown key "timout"; did you mean "timeout"\?/],
    ['tag: smoke\n', /unknown key "tag"; did you mean "tags"\?/],
    ['metadata: x\n', /unknown key "metadata" \(expected one of name, url, /],
    ['dir: /tmp\n', /unknown key "dir"/],
    ['auth: {user: a, pass: b, realm: c}\n', /"auth": unknown key "realm" \(expected one of user, pass\)/],
    ['geolocation: {lat: 1, lon: 2, lng: 3}\n', /"geolocation": unknown key "lng" \(expected one of lat, lon\)/],
    ['browser: {viewprt: {width: 1, height: 1}}\n', /"browser": unknown key "viewprt"; did you mean "viewport"\?/],
    ['browser: {viewport: {width: 1, heigth: 1}}\n', /"browser.viewport": unknown key "heigth"; did you mean "height"\?/],
  ];
  for (const [extra, message] of cases) assert.throws(() => loadSpec(spec(extra)), message, extra);
});

test('a strict spec still loads with every top-level key, an include and the loader fields', () => {
  const file = specFile([
    'name: x', 'url: https://example.com', 'goal: g', 'dialogs: dismiss', 'auth: {user: u, pass: p}',
    'geolocation: {lat: 1, lon: 2}', 'tags: [a]', 'timeout: 1000', 'env: {anything: {nested: 1}}', 'hooks: ./hooks.mjs',
    'browser: {viewport: {width: 800, height: 600}, locale: it-IT}', 'steps:', '  - include: flow.yaml', '  - click: Go',
    '    optional: true', '',
  ].join('\n'));
  writeFileSync(join(dirname(file), 'flow.yaml'), 'steps:\n  - expect: {that: a, within: b}\n');
  const spec = loadSpec(file);
  assert.deepEqual(spec.steps.map((step) => [step.kind, step.origin, step.at?.index]), [['expect', 'flow.yaml', 0], ['click', undefined, 1]]);
  assert.equal(spec.steps[1].optional, true);
});

test('a cyclic env list loads for a run, and the literal secret check visits each item once', () => {
  const path = specFile('name: cycle\nurl: https://example.com\nenv:\n  loop: &a [1, *a]\n  tokens: &t [abc, *t]\nsteps:\n  - goto: /\n');
  assert.equal(loadSpec(path).name, 'cycle');
  const warnings: string[] = [];
  loadSpec(path, { onLiteralSecret: (message) => warnings.push(message) });
  assert.deepEqual(warnings.map((message) => /"([^"]+)" holds/.exec(message)?.[1]), ['env.tokens.0']);
});
