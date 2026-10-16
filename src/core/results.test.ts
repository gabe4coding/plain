import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { label, topGuesses, dumpDebug, overallStatus, type Status } from './results.js';
import type { Step } from './spec.js';

// Hooks teardown gets this status in agent mode, where steps go on after a failure.
test('overallStatus is the first failure, and pass when no step failed', () => {
  const of = (...statuses: Status[]) => overallStatus(statuses.map((status) => ({ status })));
  assert.equal(of(), 'pass');
  assert.equal(of('pass', 'skipped'), 'pass');
  assert.equal(of('fail', 'pass'), 'fail');
  assert.equal(of('pass', 'inconclusive', 'pass'), 'inconclusive');
  assert.equal(of('skipped', 'error', 'fail', 'pass'), 'error');
});

// Step results, the CLI, and desktop sessions print `label()`. Nothing else asserts the wording,
// including the branches that are not `${kind} "${target}"`.
test('label names every step kind the way results print them', () => {
  const cases: [Step, string][] = [
    [{ kind: 'goto', url: 'https://example.com/login' }, 'goto https://example.com/login'],
    [{ kind: 'fill', target: 'Email', value: 'a@b.c' }, 'fill "Email"'],
    [{ kind: 'click', target: 'Sign in' }, 'click "Sign in"'],
    [{ kind: 'hover', target: 'the avatar' }, 'hover "the avatar"'],
    [{ kind: 'dblclick', target: 'the file' }, 'dblclick "the file"'],
    [{ kind: 'rightclick', target: 'the row' }, 'rightclick "the row"'],
    [{ kind: 'select', target: 'Country', value: 'Spain' }, 'select "Spain" in "Country"'],
    [{ kind: 'check', target: 'Hotels' }, 'check "Hotels"'],
    [{ kind: 'uncheck', target: 'Hotels' }, 'uncheck "Hotels"'],
    [{ kind: 'upload', target: 'Resume', files: ['a.pdf'] }, 'upload 1 file(s) to "Resume"'],
    [{ kind: 'upload', target: 'Resume', files: ['a.pdf', 'b.pdf'] }, 'upload 2 file(s) to "Resume"'],
    [{ kind: 'scroll', target: 'the bottom of the page' }, 'scroll "the bottom of the page"'],
    [{ kind: 'wait', condition: 'the dialog is gone' }, 'wait "the dialog is gone"'],
    [{ kind: 'wait', condition: 'loaded', within: 'the results' }, 'wait "loaded" within "the results"'],
    [{ kind: 'press', key: 'Enter' }, 'press Enter'],
    [{ kind: 'drag', source: 'the card', target: 'the column' }, 'drag "the card" to "the column"'],
    [{ kind: 'mouse', x: 12, y: -3 }, 'mouse to (12, -3)'],
    [{ kind: 'expect', expectations: ['signed in'] }, 'expect "signed in"'],
    [{ kind: 'expect', expectations: ['an error is shown', 'Submit is disabled'] }, 'expect "an error is shown | Submit is disabled"'],
    [{ kind: 'expect', expectations: ['an error is shown', 'Submit is disabled'], within: 'the form' }, 'expect "an error is shown | Submit is disabled" within "the form"'],
  ];
  for (const [step, expected] of cases) assert.equal(label(step), expected);
});

// A rejected pick's detail line. `none` is not a candidate id; only the three likeliest options are shown.
test('topGuesses lists the three likeliest options by probability', () => {
  const candidates = [
    { id: 2, desc: 'button "Save"' },
    { id: 9, desc: 'link "Cancel"' },
    { id: 4, desc: 'button "Delete"' },
  ];
  assert.equal(
    topGuesses({ '9': 0.2, none: 0.41, '2': 0.3, '4': 0.05, '7': 0.04 }, candidates),
    'none (p=0.41) | button "Save" (p=0.30) | link "Cancel" (p=0.20)',
  );
});

// pid + a per-process counter: two dumps in one process must not share a path.
test('dumpDebug writes a distinct temp file each call', () => {
  const a = dumpDebug('pick', { instruction: 'Save' });
  const b = dumpDebug('pick', { instruction: 'Save' });
  assert.notEqual(a, b);
  const seq = (file: string) => Number(file.match(/-(\d+)-pick\.json$/)?.[1]);
  assert.match(a, /plain[/\\]\d+-\d+-\d+-pick\.json$/);
  assert.equal(seq(b), seq(a) + 1);
  assert.deepEqual(JSON.parse(readFileSync(a, 'utf8')), { instruction: 'Save' });
});
