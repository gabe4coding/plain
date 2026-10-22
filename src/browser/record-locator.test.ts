import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { candidates } from './candidates.js';
import type { CandidateKind } from './candidates.js';
import { parseAriaHead, recordLocator, shapeOf, toLocator, type RecordedLocator } from './record-locator.js';

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
after(() => browser.close());

/** Records the candidate whose description is `desc`, or `desc` followed by its context. */
async function record(kind: CandidateKind, desc: string) {
  const found = await candidates(page, kind, 254);
  const candidate = found.find((c) => c.desc === desc || c.desc.startsWith(`${desc} context: `));
  assert.ok(candidate, `no candidate ${desc} in ${found.map((c) => c.desc).join(' | ')}`);
  return recordLocator(page, candidate);
}
const keyAt = (locator: RecordedLocator) => toLocator(page, locator.parts).getAttribute('data-key');

test('parseAriaHead reads role and quoted name, and skips text and generic nodes', () => {
  assert.deepEqual(parseAriaHead('- link "Order \\"42\\"":\n  - /url: /x'), { role: 'link', name: 'Order "42"' });
  assert.deepEqual(parseAriaHead('- button:\n  - img'), { role: 'button', name: '' });
  assert.equal(parseAriaHead('- text: plain div'), null);
});

test('a named control gets its role and name; a test id comes first', async () => {
  await page.setContent(`<button>Log in</button><button data-testid="close"><svg></svg></button>
    <label>Email <input></label><input placeholder="Search">`);
  const login = await record('click', 'button "Log in"');
  assert.ok(login.ok);
  assert.equal(login.text, "getByRole('button', { name: 'Log in', exact: true })");
  const close = await record('click', 'button');
  assert.ok(close.ok);
  assert.equal(close.locator.strategy, 'testid');
  const email = await record('fill', 'input label="Email"');
  assert.ok(email.ok);
  assert.deepEqual(email.locator.parts, [{ by: 'role', role: 'textbox', name: 'Email' }]);
});

test('an id that a framework generates per load is never recorded; a hand-written id is', async () => {
  const card = (id: string) => `<article><h3>Draft</h3><button id="${id}" data-key="more"><svg></svg></button><button><svg></svg></button></article>`;
  const recordMore = async (html: string) => {
    await page.setContent(html);
    const found = await candidates(page, 'click', 254);
    const keys = await Promise.all(found.map((c) => page.locator(`[data-jev-id="${c.id}"]`).getAttribute('data-key')));
    return recordLocator(page, found[keys.indexOf('more')]);
  };
  for (const id of [':r1:', '«r3»', '_r_6n_', 'base-ui-_r_6n_', 'radix-:r2:', 'headlessui-menu-button-1']) {
    const recorded = await recordMore(card(id));
    assert.ok(recorded.ok, `${id}: ${recorded.ok || recorded.reason}`);
    assert.ok(!recorded.locator.parts.some((part) => part.by === 'id'), `${id}: ${recorded.text}`);
    assert.equal(await keyAt(recorded.locator), 'more');
    // The next load generates another id: the position-based locator still holds the same shape.
    await page.setContent(card(`${id}x`));
    assert.equal(await shapeOf(toLocator(page, recorded.locator.parts)), recorded.locator.shape, id);
  }
  const stable = await recordMore(card('draft-menu'));
  assert.ok(stable.ok);
  assert.deepEqual(stable.locator.parts, [{ by: 'id', value: 'draft-menu' }]);
});

test('a placeholder inside an editor takes no click, so the editor is recorded, not its text', async () => {
  await page.setContent(`<div contenteditable="true" role="textbox" data-key="editor"><div><span contenteditable="false"
    style="pointer-events:none">Any thoughts...</span><br></div></div>`);
  const recorded = await record('click', 'div[role=textbox] "Any thoughts..."');
  assert.ok(recorded.ok, recorded.ok ? '' : recorded.reason);
  assert.deepEqual(recorded.locator.parts, [{ by: 'css', selector: 'div[role="textbox"]' }]);
  assert.equal(await keyAt(recorded.locator), 'editor');
});

test('a repeated link is scoped by its row, and the scope survives a new row above it', async () => {
  const row = (id: string, key: string) => `<tr><td>${id}</td><td>Paid</td><td><a href="#" data-key="${key}">View</a></td></tr>`;
  await page.setContent(`<table>${row('#1041', 'a')}${row('#1042', 'b')}</table>`);
  const found = await candidates(page, 'click', 254);
  const second = found.find((c) => c.desc.startsWith('a "View"') && c.desc.includes(' #2 '));
  assert.ok(second, found.map((c) => c.desc).join(' | '));
  const recorded = await recordLocator(page, second);
  assert.ok(recorded.ok);
  assert.equal(recorded.locator.strategy, 'scoped');
  assert.deepEqual(recorded.locator.parts[0], { by: 'scope', selector: 'tr', hasText: '#1042' });

  await page.setContent(`<table>${row('#1043', 'c')}${row('#1041', 'a')}${row('#1042', 'b')}</table>`);
  assert.equal(await keyAt(recorded.locator), 'b');
});

test('a clickable div is found by its text; two identical unnamed buttons get no locator', async () => {
  await page.setContent(`<div onclick="1">Show more</div><button></button><button></button>`);
  const more = await record('click', 'div "Show more"');
  assert.ok(more.ok);
  assert.equal(more.locator.strategy, 'text');
  const blank = await record('click', 'button #1');
  assert.deepEqual(blank, { ok: false, reason: 'no unique locator' });
});

test('a scope matches its text exactly: a lookalike row does not stand in for a removed one', async () => {
  const row = (id: string, key: string) => `<tr><td>${id}</td><td><a href="#" data-key="${key}">View</a></td></tr>`;
  await page.setContent(`<table>${row('#1041', 'a')}${row('#1042', 'b')}</table>`);
  const found = await candidates(page, 'click', 254);
  const recorded = await recordLocator(page, found.find((c) => c.desc.includes(' #2 '))!);
  assert.ok(recorded.ok);
  await page.setContent(`<table>${row('#1041', 'a')}${row('#10420', 'c')}</table>`);
  assert.equal(await toLocator(page, recorded.locator.parts).count(), 0);
});

test('rows nested in a layout table are scoped to the innermost row', async () => {
  const story = (title: string, key: string) => `<tr><td>${title}</td></tr><tr><td><span>${key} points</span> | <a href="#" data-key="${key}">hide</a></td></tr>`;
  await page.setContent(`<table><tr><td><table>${story('First', '10')}${story('Second', '20')}</table></td></tr></table>`);
  const found = await candidates(page, 'click', 254);
  const recorded = await recordLocator(page, found.find((c) => c.desc.startsWith('a "hide"') && c.desc.includes(' #2 '))!);
  assert.ok(recorded.ok);
  assert.deepEqual(recorded.locator.parts[0], { by: 'scope', selector: 'tr:not(:has(tr))', hasText: '20 points' });
  assert.equal(await keyAt(recorded.locator), '20');
});

test('a button slotted into a shadow-root dialog is scoped by the dialog host, not confused with the page one', async () => {
  await page.setContent(`<button data-key="page">Subscribe</button><x-promo><p>Weekly digest</p><button data-key="dialog">Subscribe</button></x-promo>
    <script>document.querySelector('x-promo').attachShadow({ mode: 'open' }).innerHTML = '<div role="dialog" aria-modal="true"><slot></slot></div>';</script>`);
  const found = await candidates(page, 'click', 254);
  const keys = await Promise.all(found.map((c) => page.locator(`[data-jev-id="${c.id}"]`).getAttribute('data-key')));
  const recorded = await recordLocator(page, found[keys.indexOf('dialog')]);
  assert.ok(recorded.ok, `${recorded.ok || recorded.reason} — ${found.map((c) => c.desc).join(' | ')}`);
  assert.equal(recorded.locator.parts[0].by, 'scope');
  assert.equal(await keyAt(recorded.locator), 'dialog');
});

test('a control with no name is found by a stable attribute', async () => {
  await page.setContent(`<input name="q"><input name="email">`);
  const recorded = await record('fill', 'input name="q"');
  assert.ok(recorded.ok);
  assert.deepEqual(recorded.locator.parts, [{ by: 'attr', tag: 'input', attr: 'name', value: 'q' }]);
});

test('an element in an iframe gets the iframe locator first, and replays through it', async () => {
  await page.setContent(`<iframe title="Comment editor" srcdoc="<label>Comment <textarea data-key='c'></textarea></label>"></iframe>`);
  await page.frames()[1].waitForLoadState();
  const recorded = await record('fill', '[iframe srcdoc] textarea label="Comment"');
  assert.ok(recorded.ok, recorded.ok ? '' : recorded.reason);
  assert.deepEqual(recorded.locator.parts[0], { by: 'frame', parts: [{ by: 'attr', tag: 'iframe', attr: 'title', value: 'Comment editor' }] });
  await toLocator(page, recorded.locator.parts).fill('Hello');
  assert.equal(await page.frames()[1].locator('textarea').inputValue(), 'Hello');
});

test('links with the same name and href are equivalent; an unnamed button is found by position in its card', async () => {
  await page.setContent(`<header><a href="/repo">playwright</a></header><main><a href="/repo">playwright</a></main>
    <article><h3>Moka pot</h3><button data-key="a"></button><button data-key="b"></button></article>`);
  const found = await candidates(page, 'click', 254);
  const link = await recordLocator(page, found.find((c) => c.desc.startsWith('a "playwright"'))!);
  assert.ok(link.ok);
  assert.equal(link.locator.strategy, 'equivalent');
  assert.deepEqual(link.locator.equivalent, { href: '/repo' });
  const keys = await Promise.all(found.map((c) => page.locator(`[data-jev-id="${c.id}"]`).getAttribute('data-key')));
  const second = await recordLocator(page, found[keys.indexOf('b')]);
  assert.ok(second.ok);
  assert.deepEqual(second.locator.parts.at(-1), { by: 'nth', selector: 'button', index: 1 });
  assert.equal(await keyAt(second.locator), 'b');
});

test('a label that wraps its select is found by its leading text', async () => {
  await page.setContent(`<label data-key="size">Size <select><option>Small</option><option>Large</option></select></label>
    <label>Sizes <select><option>S</option></select></label>`);
  const found = await candidates(page, 'click', 254);
  const label = found.find((c) => c.desc.startsWith('label "Size Small'))!;
  const recorded = await recordLocator(page, label);
  assert.ok(recorded.ok, recorded.ok ? '' : recorded.reason);
  assert.equal(recorded.locator.strategy, 'tagtext');
  assert.equal(await keyAt(recorded.locator), 'size');
});

test('a position-based locator keeps the markup hash: two icon buttons that swap places no longer match it', async () => {
  const icons = (first: string, second: string) => `<article><h3>Moka pot</h3><button data-key="${first}"><svg><path d="${first}"/></svg></button>` +
    `<button data-key="${second}"><svg><path d="${second}"/></svg></button></article>`;
  await page.setContent(icons('M0', 'M1'));
  const found = await candidates(page, 'click', 254);
  const keys = await Promise.all(found.map((c) => page.locator(`[data-jev-id="${c.id}"]`).getAttribute('data-key')));
  const recorded = await recordLocator(page, found[keys.indexOf('M1')]);
  assert.ok(recorded.ok);
  assert.match(recorded.locator.shape ?? '', /^[0-9a-f]{64}$/);
  assert.equal(await shapeOf(toLocator(page, recorded.locator.parts)), recorded.locator.shape);
  await page.setContent(icons('M1', 'M0'));
  assert.notEqual(await shapeOf(toLocator(page, recorded.locator.parts)), recorded.locator.shape);
});

test('a fixed reference stays in the position hash: two icon buttons that differ only in aria-controls and swap places no longer match', async () => {
  const icons = (first: string, second: string) => `<article><h3>Moka pot</h3><button aria-controls="${first}"><svg><path d="M0"/></svg></button>` +
    `<button aria-controls="${second}"><svg><path d="M0"/></svg></button></article>`;
  await page.setContent(icons('panel-123', 'panel-456'));
  const found = await candidates(page, 'click', 254);
  const controls = await Promise.all(found.map((c) => page.locator(`[data-jev-id="${c.id}"]`).getAttribute('aria-controls')));
  const recorded = await recordLocator(page, found[controls.indexOf('panel-456')]);
  assert.ok(recorded.ok);
  assert.deepEqual(recorded.locator.parts.at(-1), { by: 'nth', selector: 'button', index: 1 });
  await page.setContent(icons('panel-456', 'panel-123'));
  const locator = toLocator(page, recorded.locator.parts);
  assert.equal(await locator.getAttribute('aria-controls'), 'panel-123');
  assert.notEqual(await shapeOf(locator), recorded.locator.shape);
});
