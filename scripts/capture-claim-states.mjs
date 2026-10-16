#!/usr/bin/env node
// Saves the accessibility snapshot of each UI state the claim benchmark judges (scripts/claim-states/<name>.json),
// so scripts/benchmark-claims.mjs runs on fixed pages. The actions are plain Playwright, no Jev: a state must
// be the same whatever the model does. Content pages are shared with the read benchmark (scripts/read-states/).
// A state with a `region` saves only that region's tree, as an `expect` with `within` sees it (`region: true`).
// The password states come from the local e2e site (e2e/site.mjs), so they need no remote site.
// Re-run only to refresh them (live sites change), then re-check the cases in scripts/claim-cases.json.
//   node scripts/capture-claim-states.mjs [--only <name>]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { snapshot, snapshotRegion, installSettleObserver, settle } from '../dist/browser/page.js';
import { startSite, USER } from '../e2e/site.mjs';

const INTERNET = 'https://the-internet.herokuapp.com';
const PRACTICE = 'https://practice.expandtesting.com';
const login = async (page, username, password) => {
  await page.goto(`${INTERNET}/login`);
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('#flash');
};
const loadingAfter = async (page) => {
  await page.goto(`${INTERNET}/dynamic_loading/2`);
  await page.click('#start button');
  await page.waitForSelector('#finish', { timeout: 15000 });
};
// Box A dragged onto box B: the two boxes swap their letters. An ad-funded page, so its tree also holds ads.
const dragged = async (page) => {
  await page.goto(`${PRACTICE}/drag-and-drop`);
  // A drag before the page script binds its handlers does nothing: repeat it until the letters swap.
  for (let i = 0; i < 5 && await page.textContent('#column-a header') !== 'B'; i++) {
    await page.dragAndDrop('#column-a', '#column-b');
    await page.waitForTimeout(500);
  }
};
const site = await startSite();
// The login form filled but not sent: the tree shows the password field's mask, never the value.
const loginForm = async (page, password) => {
  await page.goto(`${site.url}/login`);
  await page.fill('input[name=username]', USER.name);
  if (password) await page.fill('input[name=password]', password);
};
const STATES = {
  'login-error': (page) => login(page, 'tomsmith', 'wrong-password'),
  // The demo's published credentials, the ones its login page shows.
  'login-ok': (page) => login(page, 'tomsmith', 'SuperSecretPassword!'),
  checkboxes: (page) => page.goto(`${INTERNET}/checkboxes`),
  dropdown: async (page) => {
    await page.goto(`${INTERNET}/dropdown`);
    await page.selectOption('#dropdown', '2');
  },
  'loading-before': (page) => page.goto(`${INTERNET}/dynamic_loading/2`),
  'loading-after': loadingAfter,
  'controls-enabled': async (page) => {
    await page.goto(`${INTERNET}/dynamic_controls`);
    await page.click('#input-example button');
    await page.waitForSelector('#input-example input:enabled', { timeout: 15000 });
    await page.fill('#input-example input', 'hello');
  },
  todo: async (page) => {
    await page.goto('https://demo.playwright.dev/todomvc');
    for (const item of ['buy milk', 'call the bank', 'water the plants']) {
      await page.fill('.new-todo', item);
      await page.press('.new-todo', 'Enter');
    }
    await page.locator('.todo-list li').nth(1).locator('.toggle').check();
  },
  dragged,
  'dragged-a': { act: dragged, region: '#column-a' },
  'dragged-b': { act: dragged, region: '#column-b' },
  'dragged-boxes': { act: dragged, region: '#dnd-columns' },
  // Regions of the expandtesting copies of the same pages: the-internet times out in Chromium on 2026-10-02.
  'flash-error': {
    act: async (page) => {
      await page.goto(`${PRACTICE}/login`);
      await page.fill('#username', 'practice');
      await page.fill('#password', 'wrong-password');
      await page.click('#submit-login');
      await page.waitForSelector('#flash');
    },
    region: '#flash',
  },
  'flash-ok': { act: (page) => login(page, 'tomsmith', 'SuperSecretPassword!'), region: '#flash' },
  'table-row': { act: (page) => page.goto(`${PRACTICE}/tables`), region: '#table1 tbody tr:nth-child(2)' },
  'table-email': { act: (page) => page.goto(`${PRACTICE}/tables`), region: '#table1 tbody tr:nth-child(2) td:nth-child(3)' },
  'password-filled': (page) => loginForm(page, USER.pass),
  'password-empty': (page) => loginForm(page, ''),
};

const { values } = parseArgs({ options: { only: { type: 'string' } } });
mkdirSync(new URL('claim-states/', import.meta.url), { recursive: true });
const browser = await chromium.launch();
for (const [name, state] of Object.entries(STATES).filter(([n]) => !values.only || n === values.only)) {
  const { act, region } = typeof state === 'function' ? { act: state } : state;
  const page = await browser.newPage();
  await installSettleObserver(page);
  await act(page);
  await settle(page, 500, 5000);
  const snap = region ? { ...(await snapshotRegion(page, page.locator(region))), region: true } : await snapshot(page);
  // A local page's port changes each run: the saved URL leaves it out.
  writeFileSync(new URL(`claim-states/${name}.json`, import.meta.url), JSON.stringify({ ...snap, url: snap.url.replace(site.url, 'http://127.0.0.1') }));
  console.log(name, snap.aria.length, 'chars', snap.aria.split('\n').length, 'lines');
  await page.close();
}
await browser.close();
await site.close();
