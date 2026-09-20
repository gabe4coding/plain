import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { runStep, type StepContext } from './steps.js';
import { parseStep } from './spec.js';

let browser: Browser;
let page: Page;
let ctx: StepContext;
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(5000);
  ctx = { page, spec: { name: 't', url: '', dir: process.cwd(), dialogs: 'accept', steps: [] }, timeout: 5000, events: [], track: () => {}, ms: {} };
});
after(() => browser.close());

const html = (body: string) => 'data:text/html,' + encodeURIComponent(`<!doctype html><html><body>${body}</body></html>`);
const run = (raw: unknown) => runStep(ctx, parseStep('t', 0, raw));

// css= targets keep these tests free of Jev calls; the toggle logic after the pick is what is under test.
test('check on a label whose checkbox has no size toggles the checkbox, and is a no-op when already set', async () => {
  await page.goto(html(`<label for="h">Hotels</label><input id="h" type="checkbox" style="width:0;height:0;padding:0;border:0">`));
  const checked = () => page.locator('#h').isChecked();

  let r = await run({ check: 'css=label' });
  assert.equal(r.status, 'pass', r.detail);
  assert.match(r.detail!, /now checked/);
  assert.equal(await checked(), true);

  r = await run({ check: 'css=label' });
  assert.match(r.detail!, /already checked/);
  assert.equal(await checked(), true);

  r = await run({ uncheck: 'css=label' });
  assert.match(r.detail!, /now unchecked/);
  assert.equal(await checked(), false);
});

test('check on an aria-pressed toggle button clicks only when the state differs', async () => {
  await page.goto(
    html(
      `<button id="b" aria-pressed="false" onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); window.clicks = (window.clicks ?? 0) + 1">4 Stars</button>`
    )
  );
  const pressed = () => page.getAttribute('#b', 'aria-pressed');

  assert.equal((await run({ check: 'css=#b' })).status, 'pass');
  assert.equal(await pressed(), 'true');
  assert.equal((await run({ check: 'css=#b' })).status, 'pass');
  assert.equal(await pressed(), 'true');
  assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 1);
  assert.equal((await run({ uncheck: 'css=#b' })).status, 'pass');
  assert.equal(await pressed(), 'false');
});

test('check on a toggle that ignores the click reports the error', async () => {
  await page.goto(html(`<button id="b" aria-pressed="false">Stuck</button>`));
  await assert.rejects(run({ check: 'css=#b' }), /still unchecked/);
});

test('scroll bottom/top and their spoken forms report the movement', async () => {
  await page.goto(html(`<div style="height:5000px">tall</div>`));
  let r = await run({ scroll: 'the bottom of the page' });
  assert.equal(r.status, 'pass');
  assert.match(r.detail!, /^scrolled 0 → \d+px$/);
  assert.notEqual(r.detail, 'scrolled 0 → 0px');
  r = await run({ scroll: 'bottom' });
  assert.match(r.detail!, /did not move/);
  r = await run({ scroll: 'top' });
  assert.match(r.detail!, /^scrolled \d+ → 0px$/);
});
