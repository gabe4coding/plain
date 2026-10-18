import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { intelligence } from '../core/automation.js';
import { candidates, elementById } from './candidates.js';
import { capturePage, installSettleObserver, mark, markFields, markUnchecked, maskPasswords, settle, shortenUrls, snapshot, snapshotRegion, unchangedSince, waitForMutation } from './page.js';
import { holdActivity, mayNavigate, settlePage, waitHold } from './activity.js';
import { resolveLocators } from './locate.js';
import { settledAsk } from './settled-ask.js';
import { type StepContext } from './context.js';

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
  assert.deepEqual(descs, ['label "Hotels"', 'button "4 Stars"', 'input[type=checkbox] value="on" label="Visible" id="v"']);
});

test('candidates: a control carries its wrapping or for= label once, without its own options', async () => {
  await page.goto(
    html(
      `<label><input type="checkbox"> Cheese</label><label><input type="checkbox" checked> Olives</label>` +
        `<label for="n">Nickname</label><input id="n" placeholder="Nickname">` +
        `<label>Size <select name="size"><option>Small</option><option>Large</option></select></label>` +
        `<label><input type="checkbox" aria-label="Pickles"> Pickles</label>`
    )
  );
  assert.deepEqual((await candidates(page, 'check', 254)).map((c) => c.desc), [
    'input[type=checkbox] value="on" label="Cheese"',
    'input[type=checkbox] value="on" label="Olives"',
    'input[type=checkbox] value="on" aria-label="Pickles"',
  ]);
  assert.deepEqual((await candidates(page, 'fill', 254)).map((c) => c.desc), ['input placeholder="Nickname" id="n"']);
  assert.match((await candidates(page, 'select', 254))[0].desc, /^select "Small Large" label="Size" name="size"/);
});

test('candidates: a row labelled by its own heading names it once', async () => {
  await page.goto(html('<ul><li aria-label="Fix the flaky test"><h3>Fix the flaky test</h3><button>Assign</button></li>' +
    '<li aria-label="Row two"><h3>Other heading</h3><button>Assign</button></li></ul>'));
  const [same, different] = (await candidates(page, 'click', 254)).map((c) => c.desc);
  assert.match(same, /context: li name="Fix the flaky test"$/);
  assert.match(different, /context: li name="Row two" heading="Other heading"$/);
});

test('candidates: a region is a list of things, not a row of short labels', async () => {
  const book = (t: string) => `<li><h3>${t}</h3><span>First published in 1969 · 91 editions · 8 ebooks</span></li>`;
  await page.goto(html(`<ul id="results">${book('The Left Hand of Darkness')}${book('The Dispossessed')}</ul>` +
    '<div><ul id="meta"><li>Python</li><li>4.2k</li><li>Updated yesterday</li></ul></div>' +
    '<ul role="list" id="named"><li>A</li><li>B</li></ul>'));
  const regions = (await candidates(page, 'region', 254)).map((c) => c.desc);
  assert.equal(regions.length, 2);
  assert.match(regions[0], /^ul .*The Left Hand of Darkness/);
  assert.match(regions[1], /^ul\[role=list\]/); // an explicit role=list always counts
});

test('candidates: repeated buttons retain their own card context, ordinal and actionable identity', async () => {
  await page.goto(html('<main>' + Array.from({ length: 72 }, (_, i) =>
    `<article><h2>${i === 53 ? 'Field notebook 32' : `Office supply ${i + 1}`}</h2><p>In stock</p><button onclick="this.textContent=\'Opened\'">View details</button></article>`
  ).join('') + '</main>'));
  const found = await candidates(page, 'click', 254);
  const target = found.find(c => c.desc.includes('Field notebook 32'))!;
  assert.equal(target.id, 53);
  assert.match(target.desc, /button "View details" #54 context: article heading="Field notebook 32" text="In stock"/);
  assert.ok(found.filter(c => c.id !== target.id).every(c => !c.desc.includes('Field notebook 32')));
  await elementById(page, target.id, target.frameIndex).click();
  assert.equal(await page.locator('article').nth(53).locator('button').innerText(), 'Opened');
});

test('candidates: row context excludes adjacent and nested records, hidden text and form values', async () => {
  await page.goto(html(`<table><tbody>
    <tr><td>Account 32</td><td>old@example.test</td><td><span hidden>Hidden account</span><span aria-hidden="true">Decorative account</span><span style="display:none">Invisible account</span><input type="password" value="private-value"><button>Edit</button><table><tr><td>Nested account</td><td><button>Edit nested</button></td></tr></table></td></tr>
    <tr><td>Other account</td><td><button>Edit</button></td></tr>
    </tbody></table>`));
  const found = await candidates(page, 'click', 254);
  const first = found.find(c => c.desc.startsWith('button "Edit" #1'))!;
  assert.match(first.desc, /context: tr text="Account 32 old@example.test"/);
  assert.doesNotMatch(first.desc, /Hidden|Decorative|Invisible|private-value|Nested|Other/);
  assert.match(found.find(c => c.desc.startsWith('button "Edit" #2'))!.desc, /Other account/);
});

test('candidates: bounded context supports plain cards, named groups and shadow hosts without borrowing sibling headings', async () => {
  await page.goto(html(`<main>
    <div><div><h2>First card</h2><p>${'Detail '.repeat(1000)}</p><button>Choose</button></div><div><h2>Second card</h2><button>Choose</button></div><div><button>Unrelated</button></div></div>
    <section aria-label="Billing"><button>Save</button></section>
    <article><header><div><h2>Shadow card</h2></div></header><div id="host"></div></article>
    <script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>'</script>
    </main>`));
  const found = await candidates(page, 'click', 254);
  const first = found.find(c => c.desc.startsWith('button "Choose" #1'))!;
  assert.match(first.desc, /heading="First card"/);
  assert.ok(first.desc.length < 300);
  assert.doesNotMatch(first.desc, /Second card/);
  assert.equal(found.find(c => c.desc.startsWith('button "Unrelated"'))!.desc, 'button "Unrelated"');
  assert.match(found.find(c => c.desc.startsWith('button "Save"'))!.desc, /context: section name="Billing"/);
  assert.match(found.find(c => c.desc.startsWith('button "Shadow action"'))!.desc, /heading="Shadow card"/);
});

test('candidates: context is rebuilt after a row changes', async () => {
  await page.goto(html('<table><tr><td>Before</td><td><button>Edit</button></td></tr></table>'));
  assert.match((await candidates(page, 'click', 254))[0].desc, /Before/);
  await page.locator('td').first().evaluate(el => { el.textContent = 'After'; });
  const fresh = (await candidates(page, 'click', 254))[0].desc;
  assert.match(fresh, /After/);
  assert.doesNotMatch(fresh, /Before/);
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

  // The click returns after its short grace; its hold makes the next step's settle wait out a fetch the
  // click starts ~100ms in (fulfilled ~400ms later, ~500ms after the click).
  const slowStart = Date.now();
  await mayNavigate(ctx, () => page.click('#slow'));
  await settlePage(page);
  const elapsed = Date.now() - slowStart;
  assert.ok(elapsed >= 500, `should wait out the triggered fetch, took only ${elapsed}ms`);
  assert.ok(elapsed < 1500, `should return before the hard cap, took ${elapsed}ms`);

  await page.unroute('**/slow');
  await page.unroute('https://example.test/');
});

test('waitForMutation: false on a static page after maxMs, true as soon as a mutation lands', async () => {
  await page.goto('about:blank');
  await page.setContent('<body><p>x</p></body>');
  const staticStart = Date.now();
  const staticResult = await waitForMutation(page, 300);
  const staticElapsed = Date.now() - staticStart;
  assert.equal(staticResult, false);
  assert.ok(staticElapsed >= 250, `should wait out the full maxMs on a static page, took ${staticElapsed}ms`);

  await page.evaluate(() => {
    setTimeout(() => document.body.appendChild(document.createElement('p')), 100);
  });
  const mutateStart = Date.now();
  const mutateResult = await waitForMutation(page, 1500);
  const mutateElapsed = Date.now() - mutateStart;
  assert.equal(mutateResult, true);
  assert.ok(mutateElapsed < 800, `should resolve soon after the mutation, took ${mutateElapsed}ms`);
});

const stepContext = (): StepContext => ({ page, spec: { name: 't', url: '', dir: process.cwd(), dialogs: 'accept', steps: [] }, timeout: 5000, events: [], track: () => {}, ms: {} });

test('candidate scan: its data-jev-id tags do not count as a mutation, so a quiet page stays quiet', async () => {
  await installSettleObserver(page);
  await page.goto('about:blank');
  await page.setContent('<body><button>One</button><button>Two</button></body>');
  await new Promise((r) => setTimeout(r, 600));
  const before = await mark(page);
  await candidates(page, 'click', 10);
  const start = Date.now();
  const after = await settle(page);
  assert.ok(Date.now() - start < 150, 'the scan must not restart the quiet window');
  assert.ok(unchangedSince(before, after), 'the scan must not look like a page change');
});

test('settledAsk: keeps the early answer on an unchanged page, asks again when the page changes while settling', async () => {
  await installSettleObserver(page);
  await page.goto('about:blank');
  await page.setContent('<body><p id="t">Before</p></body>');
  await new Promise((r) => setTimeout(r, 600));
  const text = () => page.locator('#t').innerText();
  const run = async () => {
    const asked: string[] = [];
    const discarded: string[] = [];
    const ctx = stepContext();
    const { state, result } = await settledAsk(ctx, {
      observe: text,
      same: (a, b) => a === b,
      ask: async (s) => { asked.push(s); await new Promise((r) => setTimeout(r, 50)); return `answer about ${s}`; },
      discard: (r) => discarded.push(r),
    });
    return { state, result, asked, discarded, reasked: ctx.ms.reasked };
  };

  const quiet = await run();
  assert.deepEqual(quiet, { state: 'Before', result: 'answer about Before', asked: ['Before'], discarded: [], reasked: undefined });

  // The page is still busy (a mutation just now) and its text changes 100 ms after the first look:
  // settle waits for it, and the early answer is about a stale page.
  await page.evaluate(() => {
    document.body.appendChild(document.createElement('span'));
    setTimeout(() => { document.getElementById('t')!.textContent = 'After'; }, 100);
  });
  const changed = await run();
  assert.deepEqual(changed, { state: 'After', result: 'answer about After', asked: ['Before', 'After'], discarded: ['answer about Before'], reasked: 1 });
});

test('settlePage: waits for a young in-flight fetch even while the DOM is quiet', async () => {
  await installSettleObserver(page);
  await page.route('https://example.test/', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.route('**/slow', async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.goto('https://example.test/');
  await settlePage(page); // wires request tracking for this page
  await new Promise((r) => setTimeout(r, 400));
  const requested = page.waitForEvent('request', { predicate: request => request.url().endsWith('/slow') });
  await page.evaluate(() => void fetch('/slow'));
  await requested;
  const start = Date.now();
  await settlePage(page);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 600, `should wait for the response, took only ${elapsed}ms`);
  assert.ok(elapsed < 1500, `should not wait for the cap, took ${elapsed}ms`);
  await page.unroute('**/slow');
  await page.unroute('https://example.test/');
});

test('resolveLocators: a page swap during settle resolves against the new active page', async () => {
  const context = await browser.newContext();
  const opener = await context.newPage();
  const popup = await context.newPage();
  const originalPick = intelligence.pick;
  const originalAsk = intelligence.ask;
  const release = holdActivity(opener);
  let current: Page = opener;
  try {
    intelligence.ask = async (_state, questions) => ({ tokens: 0, answers: questions.map(() => ({ choice: 'semantic', confidence: 1 })) });
    await opener.setContent('<body><button>Stay here</button></body>');
    await popup.setContent('<body><button>Popup only</button></body>');
    let signalFirst = () => {};
    const firstPick = new Promise<void>((resolve) => { signalFirst = resolve; });
    const seen: string[] = [];
    intelligence.pick = async (cands) => {
      seen.push(cands.map((c) => c.desc).join('|'));
      if (seen.length === 1) signalFirst();
      return [{ id: 0, probability: 0.99, probabilities: { '0': 0.99 }, tokens: 1 }];
    };
    const ctx: StepContext = {
      get page() { return current; },
      spec: { name: 't', url: '', dir: process.cwd(), dialogs: 'accept', steps: [] },
      timeout: 5000,
      events: [],
      track: () => {},
      ms: {},
    };
    const pending = resolveLocators(ctx, 'click', ['the button']);
    await firstPick;
    // settlePage is held on the opener until the popup is the active page.
    await new Promise((r) => setTimeout(r, 200));
    current = popup;
    release();
    const [result] = await pending;
    assert.deepEqual(seen.map((desc) => /Popup only/.test(desc)), [false, true]);
    assert.match(seen[0], /Stay here/);
    assert.match(result.detail, /Popup only/);
    assert.equal(result.element!.page(), popup);
    assert.equal(await result.element!.innerText(), 'Popup only');
    assert.equal(ctx.ms.reasked, 1);
  } finally {
    intelligence.pick = originalPick;
    intelligence.ask = originalAsk;
    release();
    await context.close();
  }
});

test('mayNavigate holdMs: returns after the grace, the rest of the hold is waited by the next step', async () => {
  await page.goto('about:blank');
  await page.setContent('<body><input id="q"></body>');
  const ctx = stepContext();
  const start = Date.now();
  await mayNavigate(ctx, () => page.fill('#q', 'x'), 200, 500);
  const returned = Date.now() - start;
  assert.ok(returned < 450, `should return after the grace, took ${returned}ms`);
  await waitHold(page);
  assert.ok(Date.now() - start >= 490, `the hold should last until 500 ms after the action, took ${Date.now() - start}ms`);
});

test('markUnchecked: a checkable control without a checked mark says checked=false; other lines are kept', () => {
  const aria = [
    '- checkbox',
    '- checkbox [checked]',
    '- checkbox "Toggle Todo"',
    '- checkbox "Mixed" [checked=mixed]',
    '- checkbox "Off" [disabled]',
    '- radio "Grid"',
    '- switch "Filter by availability": Readable Only 27',
    '  - menuitemcheckbox "Bold":',
    '- \'checkbox "it\'\'s [x]"\'',
    '- checkbox "Say \\"checked\\""',
    '- text: checkbox 1',
    '- button "checkbox"',
    '- checkboxes',
  ].join('\n');
  assert.equal(markUnchecked(aria), [
    '- checkbox [checked=false]',
    '- checkbox [checked]',
    '- checkbox "Toggle Todo" [checked=false]',
    '- checkbox "Mixed" [checked=mixed]',
    '- checkbox "Off" [disabled] [checked=false]',
    '- radio "Grid" [checked=false]',
    '- switch "Filter by availability" [checked=false]: Readable Only 27',
    '  - menuitemcheckbox "Bold" [checked=false]:',
    '- \'checkbox "it\'\'s [x]" [checked=false]\'',
    '- checkbox "Say \\"checked\\"" [checked=false]',
    '- text: checkbox 1',
    '- button "checkbox"',
    '- checkboxes',
  ].join('\n'));
  assert.equal(markUnchecked(markUnchecked(aria)), markUnchecked(aria));
});

test('snapshot: an unchecked checkbox, radio or switch is marked checked=false', async () => {
  await page.goto(html(
    '<label><input type="checkbox"> one</label><label><input type="checkbox" checked> two</label>' +
    '<label><input type="radio" name="r"> a</label><label><input type="radio" name="r" checked> b</label>' +
    '<button role="switch" aria-checked="false">Wifi</button><input type="checkbox" id="m"><script>m.indeterminate = true</script>'
  ));
  const { aria } = await snapshot(page);
  assert.match(aria, /- checkbox "one" \[checked=false\]/);
  assert.match(aria, /- checkbox "two" \[checked\]$/m);
  assert.match(aria, /- radio "a" \[checked=false\]/);
  assert.match(aria, /- radio "b" \[checked\]$/m);
  assert.match(aria, /- switch "Wifi" \[checked=false\]/);
  assert.match(aria, /- checkbox \[checked=mixed\]/);
});

test('snapshot: empty and read-only fields are marked; an editor gets back the text the tree drops', async () => {
  await page.goto(html(
    '<label>Email <input placeholder="name@example.com"></label><label>City <input value="Paris"></label>' +
    '<label>Account <input value="ACME-42" readonly></label><label>Code <input disabled></label>' +
    '<label>Comment <textarea></textarea></label><input type="checkbox" aria-label="Agree"><input type="hidden">' +
    '<div contenteditable role="textbox" aria-label="Body">Draft about lighthouses</div>' +
    '<div contenteditable role="textbox" aria-label="Story"><div><span>Draft.js block</span></div></div>' +
    '<div contenteditable role="textbox" aria-label="Rich" aria-placeholder="Write"><p>Kept paragraph</p></div>' +
    '<div contenteditable role="textbox" aria-label="Notes"><p><br></p></div>' +
    '<div role="textbox" aria-label="Body">Second body</div><input aria-label="Hidden" style="display:none">' +
    '<div id="host"></div><iframe srcdoc="<label>Frame field <input></label>"></iframe>' +
    `<script>host.attachShadow({mode:'open'}).innerHTML='<label>Shadow field <input></label>'</script>` +
    '<div id="before"></div><div role="textbox" aria-label="Later">Light text</div>' +
    `<script>before.attachShadow({mode:'open'}).innerHTML='<input aria-label="Earlier">'</script>`
  ));
  await page.frames()[1].waitForLoadState();
  const { aria } = await snapshot(page);
  assert.match(aria, /- textbox "Email" \[empty\]:\n\s+- \/placeholder: name@example.com/);
  assert.match(aria, /- textbox "City": Paris$/m);
  assert.match(aria, /- textbox "Account" \[readonly\]: ACME-42$/m);
  assert.match(aria, /- textbox "Code" \[disabled\] \[empty\]$/m);
  assert.match(aria, /- textbox "Comment" \[empty\]$/m);
  assert.match(aria, /- checkbox "Agree" \[checked=false\]$/m);
  assert.match(aria, /- textbox "Body": Draft about lighthouses\n/);
  assert.match(aria, /- textbox "Story": Draft.js block$/m);
  assert.match(aria, /- textbox "Rich":\n\s+- paragraph: Kept paragraph$/m);
  assert.match(aria, /- textbox "Notes" \[empty\]:/);
  assert.match(aria, /- textbox "Body": Second body$/m); // the second field of one name gets its own text
  assert.match(aria, /- textbox "Shadow field" \[empty\]$/m);
  assert.match(aria, /--- iframe [^\n]+ ---\n[\s\S]*- textbox "Frame field" \[empty\]$/m);
  assert.doesNotMatch(aria, /Hidden/);
  assert.match(aria, /- textbox "Earlier" \[empty\]\n- textbox "Later": Light text$/m); // shadow content sits in place
  assert.equal((await snapshotRegion(page, page.getByRole('textbox', { name: 'Comment' }).locator('..'))).aria.includes('[empty]'), true);
  // A region that is the field itself.
  assert.equal((await snapshotRegion(page, page.getByRole('textbox', { name: 'Story' }))).aria, '- textbox "Story": Draft.js block');
});

test('markFields: marks go after the attributes, text becomes the value or a child; unknown lines are skipped', () => {
  const aria = ['- textbox "A"', '- textbox "B" [disabled]:', '  - /placeholder: b', "- 'textbox \"C: d\"'", '- textbox "A"'].join('\n');
  assert.equal(markFields(aria, [
    { head: '- textbox "Missing"', empty: true },
    { head: "- 'textbox \"C: d\"'", empty: true }, // out of tree order
    { head: '- textbox "A"', text: 'first' },
    { head: '- textbox "B" [disabled]:', readonly: true, text: '- dash' },
    { head: '- textbox "A"', empty: true },
  ]), ['- textbox "A": first', '- textbox "B" [disabled] [readonly]:', '  - text: "- dash"', '  - /placeholder: b',
    "- 'textbox \"C: d\" [empty]'", '- textbox "A" [empty]'].join('\n'));
});

test('shortenUrls: a link target over 200 characters keeps its part before ? or #; shorter ones and other lines are kept', () => {
  const query = 'x'.repeat(250);
  const aria = [
    '- link "Ad":',
    `  - /url: https://ads.example/aclk?sa=l&ai=${query}`,
    `  - /url: "https://ads.example/click#${query}"`,
    `  - /url: /${'p'.repeat(300)}`,
    '  - /url: https://example.com/search?q=shoes&page=2',
    '  - /url: "#"',
    `- text: /url: https://ads.example/aclk?${query}`,
  ].join('\n');
  assert.equal(shortenUrls(aria), [
    '- link "Ad":',
    '  - /url: https://ads.example/aclk…',
    '  - /url: https://ads.example/click…',
    `  - /url: /${'p'.repeat(199)}…`,
    '  - /url: https://example.com/search?q=shoes&page=2',
    '  - /url: "#"',
    `- text: /url: https://ads.example/aclk?${query}`,
  ].join('\n'));
  assert.equal(shortenUrls(shortenUrls(aria)), shortenUrls(aria));
});

test('snapshot: an iframe with an empty tree gets no section; long link targets are cut; snapshotRegion marks a region', async () => {
  await page.goto(html(`<p>outside</p><nav><a href="https://ads.example/aclk?sa=l&ai=${'y'.repeat(250)}">Sale</a></nav>` +
    '<iframe name="empty" srcdoc="<body></body>"></iframe>' +
    `<iframe name="filled" srcdoc="<button>Inside</button><a href='https://ads.example/aclk?sa=l&ai=${'x'.repeat(250)}'>Ad</a>"></iframe>`));
  await page.frameLocator('iframe[name=filled]').getByRole('button').waitFor();
  const snap = await snapshot(page);
  assert.doesNotMatch(snap.aria, /--- iframe empty ---/);
  assert.match(snap.aria, /--- iframe filled ---\n- button "Inside"/);
  assert.equal(snap.region, undefined);
  assert.match(snap.aria, /- \/url: https:\/\/ads\.example\/aclk…$/m);
  assert.doesNotMatch(snap.aria, /aclk\?sa=l/);
  const region = await snapshotRegion(page, page.locator('p'));
  assert.equal(region.region, true);
  assert.equal(region.aria, '- paragraph: outside');
  const links = await snapshotRegion(page, page.locator('nav'));
  assert.match(links.aria, /- \/url: https:\/\/ads\.example\/aclk…$/m);
});

test('snapshot: an iframe whose document has no body is skipped at once, not waited for', async () => {
  // Ad sync frames (static.admaster.cc cookieSync.html) remove their body; a `body` locator then waits its whole timeout.
  const timed = await browser.newPage();
  timed.setDefaultTimeout(15_000);
  try {
    await timed.goto(html(`<p>outside</p><iframe name="bodyless" srcdoc="<script>addEventListener('load', () => document.body.remove())</script>"></iframe>` +
      '<iframe name="filled" srcdoc="<button>Inside</button>"></iframe>'));
    await timed.frameLocator('iframe[name=filled]').getByRole('button').waitFor();
    await timed.frame('bodyless')!.waitForFunction(() => !document.body);
    const start = performance.now();
    const snap = await snapshot(timed);
    assert.ok(performance.now() - start < 2_000, `snapshot took ${Math.round(performance.now() - start)} ms`);
    assert.match(snap.aria, /^- paragraph: outside/);
    assert.match(snap.aria, /--- iframe filled ---\n- button "Inside"/);
    assert.doesNotMatch(snap.aria, /bodyless/);
  } finally {
    await timed.close();
  }
});

test('snapshot: an iframe still parsing its head gets its body waited for', async () => {
  const parsing = await browser.newPage();
  await parsing.route('https://slow.test/head.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.fulfill({ contentType: 'text/javascript', body: '' });
  });
  try {
    await parsing.goto(html(`<p>outside</p><iframe name="parsing" srcdoc="<script src='https://slow.test/head.js'></script><button>Late</button>"></iframe>`),
      { waitUntil: 'domcontentloaded' });
    await parsing.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.readyState === 'loading');
    assert.equal(await parsing.frame('parsing')!.evaluate(() => document.body), null);
    const snap = await snapshot(parsing);
    assert.match(snap.aria, /--- iframe parsing ---\n- button "Late"/);
  } finally {
    await parsing.close();
  }
});

test('snapshot: an open dialog at the end of a page over the cap is kept whole; a short page gets no extra section', async () => {
  const long = Array.from({ length: 2500 }, (_, i) => `<p>Paragraph number ${i} of a long article body</p>`).join('');
  // The page's own Dismiss button must not pass for the dialog's tree.
  await page.goto(html(`<main><button>Dismiss</button>${long}</main><div role="dialog" aria-label="Sign-in offer"><button>Dismiss</button></div>
    <div role="dialog" aria-label="Closed" hidden><button>Gone</button></div>`));
  const snap = await snapshot(page);
  assert.equal(snap.truncated, true);
  assert.ok(snap.aria.length <= 60_000);
  assert.ok(snap.aria.startsWith('- main:'));
  assert.ok(snap.aria.endsWith('\n--- open dialog ---\n- dialog "Sign-in offer":\n  - button "Dismiss"'), snap.aria.slice(-200));
  assert.ok(!snap.aria.includes('Gone'));
  await page.goto(html('<p>Short</p><div role="dialog" aria-label="Sign-in offer"><button>Dismiss</button></div>'));
  assert.ok(!(await snapshot(page)).aria.includes('--- open dialog ---'));
});

test('snapshot: room made for a cut dialog never drops another dialog that fit in the page part', async () => {
  const long = Array.from({ length: 1000 }, (_, i) => `<p>Paragraph number ${i} of a long article body</p>`).join('');
  const rows = Array.from({ length: 60 }, (_, i) => `<button>Option ${i} of the offer list</button>`).join('');
  // The first dialog ends near 59k characters, inside the cap; the room for the cut second one would drop it.
  await page.goto(html(`<main>${long}</main><div role="dialog" aria-label="Fits"><button>Keep me</button></div>
    <div role="dialog" aria-label="Offer">${rows}</div>`));
  const snap = await snapshot(page);
  assert.equal(snap.truncated, true);
  assert.ok(snap.aria.length <= 60_000);
  assert.ok(snap.aria.includes('button "Keep me"'));
  assert.ok(snap.aria.includes('button "Option 59 of the offer list"'));
});

test('capturePage keeps the uncut tree off the public snapshot, including a dialog the cap would drop', async () => {
  const long = Array.from({ length: 2500 }, (_, i) => `<p>Paragraph number ${i} of a long article body</p>`).join('');
  await page.goto(html(`<main>${long}<p>Late unique paragraph marker</p></main>` +
    '<div role="dialog" aria-label="Sign in"><button>Stay</button></div>'));
  const captured = await capturePage(page);
  assert.equal(captured.snap.truncated, true);
  assert.ok(!captured.snap.aria.includes('Late unique paragraph marker'), captured.snap.aria.slice(-180));
  const full = captured.fullAria ?? '';
  assert.ok(full.includes('Late unique paragraph marker'));
  assert.ok(full.includes('button "Stay"') || full.includes('--- open dialog ---'));
  assert.ok(full.length > captured.snap.aria.length);
  const pub = await snapshot(page);
  assert.equal(Object.hasOwn(pub, 'fullAria'), false);
  assert.equal(pub.aria, captured.snap.aria);
  await page.goto(html('<p>Short</p>'));
  assert.equal((await capturePage(page)).fullAria, undefined);
});

test('snapshot: a filled password field shows a mask in every tree, never its value; an empty one shows [empty]', async () => {
  const secret = 'hunter2: Pw#1';
  await page.goto(html(`<form><label>Password <input type="password" id="main"></label>` +
    '<label>Hinted <input type="password" id="hinted" placeholder="Your password"></label>' +
    '<label>Unused <input type="password"></label><label>Name <input id="name"></label></form><div id="host"></div>' +
    '<iframe name="login" srcdoc="<label>Frame password <input type=password></label>"></iframe>' +
    `<script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<label>Shadow password <input type=password></label>'</script>`));
  for (const field of ['#main', '#hinted', '#host input']) await page.locator(field).fill(secret);
  await page.frameLocator('iframe[name=login]').locator('input').fill(secret);
  await page.locator('#name').fill('Ada');
  const snap = await snapshot(page);
  assert.ok(!snap.aria.includes('hunter2'), snap.aria);
  assert.match(snap.aria, /^- textbox "Password": "\[filled\]"$/m);
  assert.match(snap.aria, /^- textbox "Hinted":\n {2}- \/placeholder: Your password\n {2}- text: "\[filled\]"$/m);
  assert.match(snap.aria, /^- textbox "Unused" \[empty\]$/m);
  assert.match(snap.aria, /^- textbox "Name": Ada$/m);
  assert.match(snap.aria, /^- textbox "Shadow password": "\[filled\]"$/m);
  assert.match(snap.aria, /--- iframe login ---\n- text: Frame password\n- textbox "Frame password": "\[filled\]"$/);
  const region = await snapshotRegion(page, page.locator('form'));
  assert.ok(!region.aria.includes('hunter2'), region.aria);
  assert.match(region.aria, /^- textbox "Password": "\[filled\]"$/m);
  const framed = await snapshotRegion(page, page.frameLocator('iframe[name=login]').locator('body'));
  assert.equal(framed.aria, '- text: Frame password\n- textbox "Frame password": "[filled]"');

  // A page over the cap adds its open dialog's own tree: masked too.
  const long = Array.from({ length: 2500 }, (_, i) => `<p>Paragraph number ${i} of a long article body</p>`).join('');
  await page.goto(html(`<main>${long}</main><div role="dialog" aria-label="Sign in"><label>Dialog password <input type="password"></label></div>`));
  await page.locator('[role=dialog] input').fill(secret);
  const truncated = await snapshot(page);
  assert.equal(truncated.truncated, true);
  assert.ok(!truncated.aria.includes('hunter2'), truncated.aria.slice(-300));
  assert.ok(truncated.aria.endsWith('\n--- open dialog ---\n- dialog "Sign in":\n  - text: Dialog password\n  - textbox "Dialog password": "[filled]"'),
    truncated.aria.slice(-300));
  const captured = await capturePage(page);
  assert.ok(captured.fullAria && !captured.fullAria.includes('hunter2'), captured.fullAria?.slice(-300));
});

test('maskPasswords: replaces a textbox value or its text line that equals a password, in every quoting form', () => {
  const secrets = new Set(['a: b', "it's", 'plain', 'x\\y']);
  const aria = [
    '- \'textbox "Pw: main"\': "a: b"',
    '- \'textbox "It\'\'s" [disabled]\': it\'s',
    '- textbox "Hinted":',
    '  - /placeholder: Your password',
    '  - text: plain',
    '- textbox "Other": x\\y',
    '- text: plain',
    '- textbox "Name": Ada',
  ].join('\n');
  assert.equal(maskPasswords(aria, secrets), [
    '- \'textbox "Pw: main"\': "[filled]"',
    '- \'textbox "It\'\'s" [disabled]\': "[filled]"',
    '- textbox "Hinted":',
    '  - /placeholder: Your password',
    '  - text: "[filled]"',
    '- textbox "Other": "[filled]"',
    '- text: plain', // page text, not a field value
    '- textbox "Name": Ada',
  ].join('\n'));
  assert.equal(maskPasswords('- textbox "Q": "\\"x\\""', new Set(['"x"'])), '- textbox "Q": "[filled]"');
  assert.equal(maskPasswords(aria, new Set()), aria);
});
