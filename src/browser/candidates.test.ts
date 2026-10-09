import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { CandidateKindSchema, candidates, elementById } from './candidates.js';

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
after(() => browser.close());
const html = (body: string) => 'data:text/html,' + encodeURIComponent(`<!doctype html><body>${body}</body>`);

test('candidate kinds are the element-acting step kinds plus region', () => {
  assert.deepEqual(CandidateKindSchema.options, ['click', 'hover', 'fill', 'select', 'check', 'upload', 'region']);
});

test('fill finds empty and plaintext-only editable hosts and Playwright can fill them', async () => {
  await page.goto(html(`<div contenteditable aria-label="Body"></div>
    <div contenteditable="plaintext-only" aria-label="Notes"></div>
    <div contenteditable="false" aria-label="Locked"></div>
    <div contenteditable="invalid" aria-label="Invalid"></div>`));
  const found = await candidates(page, 'fill', 254);
  assert.deepEqual(found.map(c => c.desc), ['div aria-label="Body"', 'div aria-label="Notes"']);
  for (const candidate of found) await elementById(page, candidate.id).fill('Research');
  assert.equal(await page.locator('[aria-label=Body]').innerText(), 'Research');
  assert.equal(await page.locator('[aria-label=Notes]').innerText(), 'Research');
  assert.equal(await page.locator('[aria-label=Locked]').innerText(), '');
});

test('elements whose value property is not a string, such as list items, do not empty the scan', async () => {
  await page.goto(html(`<ul role="listbox"><li role="option">Paris</li><li role="option" value="3">Rome</li></ul>
    <progress value="0.5" tabindex="0"></progress>`));
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc),
    ['li[role=option] "Paris"', 'li[role=option] "Rome"', 'progress']);
});

test('inert controls do not consume the cap, including shadow descendants; removing inert restores them', async () => {
  await page.goto(html(`<main inert>${'<button>Continue</button>'.repeat(300)}<div id="shadow"></div></main>
    <button onclick="this.textContent='Done'">Continue</button>
    <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Continue</button>'</script>`));
  const found = await candidates(page, 'click', 10);
  assert.deepEqual(found.map(c => c.desc), ['button "Continue"']);
  await elementById(page, found[0].id).click();
  assert.equal(await page.locator('body > button').innerText(), 'Done');
  await page.locator('main').evaluate(el => el.removeAttribute('inert'));
  assert.equal((await candidates(page, 'click', 400)).length, 302);
  await page.locator('body').evaluate(el => el.setAttribute('inert', ''));
  assert.deepEqual(await candidates(page, 'click', 400), []);
});

test('native modal dialogs escape inherited inertness but keep their own explicit inert', async () => {
  await page.goto(html('<main inert><button>Background</button><dialog><button>Continue</button></dialog></main>'));
  await page.locator('dialog').evaluate(el => (el as HTMLDialogElement).showModal());
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc), ['button "Continue"']);
  await page.locator('dialog').evaluate(el => el.setAttribute('inert', ''));
  assert.deepEqual(await candidates(page, 'click', 254), []);
});

test('an open modal dialog, also in a shadow root, blocks every control and frame outside it', async () => {
  await page.goto(html(`<button>Background</button><iframe srcdoc="<button>Framed</button>"></iframe><div id="host"></div>
    <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<dialog><button>Close</button></dialog>'</script>`));
  const dialog = page.locator('#host dialog');
  await dialog.evaluate(el => (el as HTMLDialogElement).showModal());
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc), ['button "Close"']);
  await dialog.evaluate(el => (el as HTMLDialogElement).close());
  await dialog.evaluate(el => (el as HTMLDialogElement).show());
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc),
    ['button "Close"', 'button "Background"', '[iframe srcdoc] button "Framed"']);
  await page.setContent('<button>Background</button><iframe srcdoc="<button>Framed</button>"></iframe><dialog><button>Close</button></dialog>');
  await page.locator('dialog').evaluate(el => (el as HTMLDialogElement).showModal());
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc), ['button "Close"']);
});

test('slotted controls take the modal dialog and inertness of the slot they render in', async () => {
  await page.goto(html(`<button>Background</button>
    <x-dialog id="consent"><button>Accept</button></x-dialog><x-panel><button>Behind</button></x-panel>
    <script>
      document.querySelector('x-dialog').attachShadow({mode:'open'}).innerHTML='<dialog><slot></slot></dialog>';
      document.querySelector('x-panel').attachShadow({mode:'open'}).innerHTML='<div inert><slot></slot></div>';
    </script>`));
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc), ['button "Background"']);
  await page.locator('#consent dialog').evaluate(el => (el as HTMLDialogElement).showModal());
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc.split(' context:')[0]), ['button "Accept"']);
});

test('a script dialog whose fixed layer covers the viewport blocks every control and frame outside the layer', async () => {
  // The Shoelace shape: a fixed base holding a fixed overlay and the role=dialog panel, in a shadow root, with a
  // slotted button. A click on the background would hit the overlay.
  await page.goto(html(`<button>Background</button><iframe srcdoc="<button>Framed</button>"></iframe>
    <x-dialog><button>No, thanks</button></x-dialog>
    <script>document.querySelector('x-dialog').attachShadow({mode:'open'}).innerHTML =
      '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center">' +
      '<div style="position:fixed;inset:0;background:#0008"></div>' +
      '<div role="dialog" aria-modal="true" style="position:relative;background:white;padding:20px"><slot></slot></div></div>'</script>`));
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc.split(' context:')[0]), ['button "No, thanks"']);
});

test('a script dialog still animating out is looked at again once its animation ends', async () => {
  await page.goto(html(`<button>Background</button><div id="layer" style="position:fixed;inset:0;background:#0008">
    <div role="dialog" aria-modal="true" style="background:white"><button>Close</button></div></div>
    <script>document.querySelector('#layer button').onclick = () => {
      const layer = document.querySelector('#layer');
      layer.animate([{ opacity: 1 }, { opacity: 0 }], 400).finished.then(() => layer.remove());
    }</script>`));
  await page.locator('#layer button').click();
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc), ['button "Background"']);
});

test('an aria-modal banner that leaves the page uncovered blocks nothing', async () => {
  await page.goto(html(`<button>Background</button>
    <div role="dialog" aria-modal="true" style="position:fixed;left:0;right:0;bottom:0;background:white">
    <button>Accept cookies</button></div>`));
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc.split(' context:')[0]),
    ['button "Accept cookies"', 'button "Background"']);
});

test('the inner part of a clickable shadow host is not a second candidate beside its host', async () => {
  await page.goto(html(`<x-option role="option" style="cursor:pointer;display:block">Option 2</x-option>
    <script>document.querySelector('x-option').attachShadow({mode:'open'}).innerHTML='<span><slot></slot></span>'</script>`));
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc), ['x-option[role=option] "Option 2"']);
});

test('a shadow-root control is named by the text slotted into it', async () => {
  await page.goto(html(`<x-button>Necessary Only</x-button><x-button><i slot="start"></i> Accept All</x-button>
    <script>for (const host of document.querySelectorAll('x-button'))
      host.attachShadow({mode:'open'}).innerHTML='<button><slot name="start"></slot><slot></slot></button>'</script>`));
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc), ['button "Necessary Only"', 'button "Accept All"']);
});

test('inert embedding elements suppress candidates in nested and shadow-hosted frames', async () => {
  await page.goto(html(`<div inert><iframe srcdoc="<iframe srcdoc='&lt;button&gt;Nested&lt;/button&gt;'></iframe>"></iframe>
    <div id="shadow"></div></div><button>Continue</button>
    <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<iframe srcdoc="<button>Shadow frame</button>"></iframe>'</script>`));
  assert.ok(page.frames().length >= 4);
  assert.deepEqual((await candidates(page, 'click', 254)).map(c => c.desc), ['button "Continue"']);
});

test('disabled fieldsets suppress fields and hidden checkbox labels but preserve the first legend exemption', async () => {
  await page.goto(html(`<fieldset disabled><legend><input aria-label="Legend"></legend>
    <input aria-label="Disabled"><label><input type="checkbox" style="width:0;height:0;padding:0;border:0">Locked</label></fieldset>
    <input aria-label="Enabled">`));
  assert.deepEqual((await candidates(page, 'fill', 254)).map(c => c.desc), ['input aria-label="Legend" context: fieldset text="Locked"', 'input aria-label="Enabled"']);
  assert.deepEqual(await candidates(page, 'check', 254), []);
});

test('a filled password field is described with a mask, never its value; an empty one has no value', async () => {
  await page.goto(html('<label>Password <input type="password" id="pw"></label><label>Repeat <input type="PASSWORD" id="again"></label>' +
    '<input type="password" id="empty" placeholder="Unused"><div id="host"></div>' +
    `<script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<input type=password aria-label=Shadow>'</script>`));
  for (const field of ['#pw', '#again', '#host input']) await page.locator(field).fill('hunter2');
  assert.deepEqual((await candidates(page, 'fill', 254)).map((c) => c.desc), [
    'input[type=password] value="[filled]" label="Password" id="pw"',
    'input[type=PASSWORD] value="[filled]" label="Repeat" id="again"',
    'input[type=password] placeholder="Unused" id="empty"',
    'input[type=password] value="[filled]" aria-label="Shadow"',
  ]);
});

test('a short cap keeps a trailing dialog and page controls, and drops extras, nav and footer', async () => {
  // DOM order is the opposite of the kept order: nav first, the dialog last, a pointer card between the controls.
  // draggable=false and tabindex=-1 are not click targets.
  await page.goto(html(`<nav><a href="/n">Nav</a><a href="/n">Nav</a></nav>
    <div style="cursor:pointer">Card</div><button>Save</button><a href="/more">More</a>
    <div draggable="true">Tile</div><div draggable="false">Still</div><span tabindex="-1">Skip</span>
    <footer><a href="/f">Foot</a></footer><dialog open><button>Accept</button></dialog>`));
  const names = async (max: number) => (await candidates(page, 'click', max)).map((c) => c.desc.split(' context:')[0]);
  assert.deepEqual(await names(20), [
    'button "Accept"', 'button "Save"', 'a "More" href=/more', 'div "Card"', 'div "Tile"',
    'a "Nav" href=/n #1', 'a "Nav" href=/n #2', 'a "Foot" href=/f',
  ]);
  const kept = await candidates(page, 'click', 2);
  assert.deepEqual(kept.map((c) => c.desc.split(' context:')[0]), ['button "Accept"', 'button "Save"']);
  assert.equal(await elementById(page, kept[0].id).innerText(), 'Accept');
});

test('hover adds images, svg and figure, and keeps the same extras as click', async () => {
  // The tile is first in the DOM and the summary is last: extras follow selector matches, then stay in DOM order.
  // draggable=false is not a target for either kind.
  await page.goto(html(`<div draggable="true">Tile</div><div draggable="false">Still</div>
    <button>Save</button>
    <img alt="Avatar" width="20" height="20">
    <svg width="20" height="20" role="img" aria-label="Mark"><rect width="20" height="20"></rect></svg>
    <figure>Chart</figure>
    <details><summary>Details</summary></details>`));
  const names = async (kind: 'click' | 'hover') =>
    (await candidates(page, kind, 20)).map((c) => c.desc.split(' context:')[0]);
  assert.deepEqual(await names('click'), ['button "Save"', 'div "Tile"', 'summary "Details"']);
  const hover = await candidates(page, 'hover', 20);
  assert.deepEqual(hover.map((c) => c.desc.split(' context:')[0]), [
    'button "Save"', 'img alt="Avatar"', 'svg[role=img] aria-label="Mark"', 'figure "Chart"',
    'div "Tile"', 'summary "Details"',
  ]);
  assert.equal(await elementById(page, hover[1].id).getAttribute('alt'), 'Avatar');
});
