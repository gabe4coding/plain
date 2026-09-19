import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from './spec.js';

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

test('expect supports both the plain string and scoped { that, within } forms', () => {
  const path = specFile(`
name: expect forms
url: https://example.com
steps:
  - expect: "the page loaded"
  - expect: { that: "a success message is shown", within: "the dialog" }
`);
  const spec = loadSpec(path);
  assert.deepEqual(spec.steps[0], { kind: 'expect', expectation: 'the page loaded', optional: false });
  assert.deepEqual(spec.steps[1], {
    kind: 'expect',
    expectation: 'a success message is shown',
    within: 'the dialog',
    optional: false,
  });
  assert.throws(() => loadSpec(specFile('name: x\nurl: https://example.com\nsteps:\n  - expect: { that: "a" }\n')));
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
