import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { candidates, installSettleObserver, settle } from './page.js';
import { mayNavigate, type StepContext } from './steps.js';

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

test('settle: resolves immediately when the DOM has already been quiet for quietMs, waits out ongoing mutations to the cap', async () => {
  await installSettleObserver(page);
  await page.goto('about:blank'); // addInitScript only fires on a real navigation, not on setContent() reusing the doc
  await page.setContent('<body><p>x</p></body>');
  await new Promise((r) => setTimeout(r, 600));
  const quietStart = Date.now();
  await settle(page);
  assert.ok(Date.now() - quietStart < 150, 'already-quiet page should settle immediately');

  await page.evaluate(() => {
    setInterval(() => document.body.appendChild(document.createElement('span')), 100);
  });
  await new Promise((r) => setTimeout(r, 150)); // let at least one tick land so settle sees a recent mutation, not a stale one
  const busyStart = Date.now();
  await settle(page, 500, 1500);
  assert.ok(Date.now() - busyStart >= 1000, 'continuously-mutating page should wait out to near the cap');
});

test('mayNavigate: returns quickly on a no-op action, waits out a triggered fetch plus its grace', async () => {
  const ctx: StepContext = { page, spec: { name: 't', url: '', dir: process.cwd(), dialogs: 'accept', steps: [] }, timeout: 5000, events: [], track: () => {}, ms: {} };

  // A real origin so the page's own fetch('/slow') resolves relatively; the navigation itself is
  // routed too so this never touches the real network.
  await page.route('https://example.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto('https://example.test/');
  await page.route('**/slow', async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.setContent(
    `<button id="noop">noop</button><button id="slow">slow</button>` +
      `<script>document.getElementById('slow').onclick = () => setTimeout(() => fetch('/slow'), 100);</script>`
  );

  const fastStart = Date.now();
  await mayNavigate(ctx, () => page.click('#noop'));
  assert.ok(Date.now() - fastStart < 500, `no-op action should finish well under the cap, took ${Date.now() - fastStart}ms`);

  const slowStart = Date.now();
  await mayNavigate(ctx, () => page.click('#slow'));
  const elapsed = Date.now() - slowStart;
  // fetch starts ~100ms in, the route fulfils it ~400ms later (~500ms), then the default 200ms grace ≈ 700ms
  assert.ok(elapsed >= 500, `should wait out the triggered fetch, took only ${elapsed}ms`);
  assert.ok(elapsed < 1500, `should return before the hard cap, took ${elapsed}ms`);

  await page.unroute('**/slow');
  await page.unroute('https://example.test/');
});
