import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { candidates } from './page.js';

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
after(() => browser.close());

const html = (body: string) => 'data:text/html,' + encodeURIComponent(`<!doctype html><html><body>${body}</body></html>`);

test('candidates: dialog content comes first, nav/footer links last, then the cap cuts', async () => {
  const footer = Array.from({ length: 300 }, (_, i) => `<a href="/r${i}">Hotels in region ${i}</a>`).join('');
  await page.goto(
    html(
      `<nav><a href="/menu">Menu</a></nav><main><button>Search</button></main><footer>${footer}</footer>` +
        `<div id="host"></div><script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<div role="dialog" aria-modal="true"><button>Allow all</button></div>'</script>`
    )
  );
  const cands = await candidates(page, 'click', 254);
  assert.equal(cands.length, 254);
  assert.match(cands[0].desc, /Allow all/); // the cookie dialog, last in the DOM and inside a shadow root
  assert.match(cands[1].desc, /Search/); // page content before nav/footer
  assert.match(cands[2].desc, /Menu/);
  assert.match(cands[3].desc, /Hotels in region 0/);
  // ids follow list order so elementById() still resolves the reordered entries
  assert.deepEqual(cands.slice(0, 3).map((c) => c.id), [0, 1, 2]);
});

test('candidates: check lists a label standing in for its sizeless checkbox, aria-pressed toggles, and no duplicate for a visible checkbox', async () => {
  await page.goto(
    html(
      `<label for="h">Hotels</label><input id="h" type="checkbox" style="width:0;height:0;padding:0;border:0">` +
        `<button aria-pressed="false">4 Stars</button>` +
        `<label for="v">Visible</label><input id="v" type="checkbox">` +
        `<span role="button">Plain chip</span>`
    )
  );
  const descs = (await candidates(page, 'check', 254)).map((c) => c.desc);
  assert.deepEqual(descs, ['label "Hotels"', 'button "4 Stars"', 'input[type=checkbox] value="on" id="v"']);
});
