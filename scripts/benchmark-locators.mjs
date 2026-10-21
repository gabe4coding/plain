#!/usr/bin/env node
// Locator builder prototype benchmark (src/browser/record-locator.ts). No Jev key: it records a locator for every
// candidate, not only for picked ones, so it measures the builder, not Jev.
//
// 1. Coverage: on each page of e2e/site.mjs (and each --url), for each step kind, the share of candidates that get
//    a verified locator, by strategy, and why the others get none.
// 2. Stability: on a built-in orders page, every element carries a hidden `data-key` (its identity). Locators are
//    recorded on the page, then replayed on changed copies of it:
//      right  one match, the same element        wrong  one match, another element
//      miss   no match or several (a replay would fall back to Jev, or fail in a no-Jev mode)
//    Pass bar: 0 wrong on every change.
//
//   node scripts/benchmark-locators.mjs [--url https://…] [--out result.json]
//
// Build first (npm run build).
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { candidates } from '../dist/browser/candidates.js';
import { recordLocator, shapeOf, toLocator } from '../dist/browser/record-locator.js';
import { startSite } from '../e2e/site.mjs';

const { values } = parseArgs({ options: { url: { type: 'string', multiple: true }, out: { type: 'string' } } });
const KINDS = ['click', 'fill', 'select', 'check'];
const SITE_PAGES = ['/spatial-controls', '/spatial-reference', '/spatial-values', '/spatial-names', '/spatial', '/field-state',
  '/candidate-editor', '/candidate-dialog', '/consent', '/overlay', '/cookie-bar', '/login', '/secure', '/forms', '/dialogs',
  '/frames', '/files', '/drag', '/boxes', '/waits', '/where', '/generated-ids',
  '/editor-placeholder'];

// ---- the orders page and its changes ---------------------------------------------------------------------------
const ORDERS = [
  { id: '#1041', who: 'Ada Lovelace', status: 'Paid', total: '€42.00' },
  { id: '#1042', who: 'Alan Turing', status: 'Paid', total: '€18.50' },
  { id: '#1043', who: 'Grace Hopper', status: 'Pending', total: '€99.90' },
  { id: '#1044', who: 'Ada Lovelace', status: 'Refunded', total: '€7.00' },
];
const PRODUCTS = [{ name: 'Espresso cup', price: '€9' }, { name: 'Moka pot', price: '€35' }, { name: 'Milk jug', price: '€14' }];
const orderRow = (o, useId, i) => `<tr data-key="row${o.id}"><td>${o.id}</td><td>${o.who}</td><td>${o.status}</td><td>${o.total}</td>
  <td><a href="#" data-key="view${o.id}">View</a> <button data-key="edit${o.id}">Edit</button>
  <button id="base-ui-_r_${useId}${i}_" aria-haspopup="menu" data-key="more${o.id}"><svg width="12" height="12"></svg></button>
  <button aria-label="Delete order" data-key="del${o.id}">🗑</button></td></tr>`;
const MINUS = '<svg width="12" height="12"><path d="M0 6h12"/></svg>';
const PLUS = '<svg width="12" height="12"><path d="M0 6h12M6 0v12"/></svg>';
const card = (p, swapIcons = false) => `<article data-key="card${p.name}"><h3>${p.name}</h3><p>${p.price}</p>
  <button data-key="add${p.name}">Add to cart</button><input type="number" aria-label="Quantity" value="1" data-key="qty${p.name}">
  ${swapIcons ? `<button data-key="plus${p.name}">${PLUS}</button><button data-key="minus${p.name}">${MINUS}</button>`
    : `<button data-key="minus${p.name}">${MINUS}</button><button data-key="plus${p.name}">${PLUS}</button>`}</article>`;
function ordersPage({ orders = ORDERS, products = PRODUCTS, editLabel = 'Edit', idSuffix = 'k3j9x2', useId = 'a', swapIcons = false } = {}) {
  return `<!doctype html><title>Orders</title><body>
  <nav><a href="#" data-key="nav-home">Home</a> <a href="#" data-key="nav-orders">Orders</a>
    <button data-testid="account-menu" data-key="account"><svg width="16" height="16"></svg></button></nav>
  <main><h1>Orders</h1>
  <form><input id="q-${idSuffix}" placeholder="Search orders" data-key="search">
    <select aria-label="Status" data-key="status"><option>All</option><option>Paid</option><option>Pending</option></select>
    <label><input type="checkbox" data-key="mine"> Only mine</label><button data-key="go">Search</button></form>
  <table><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Total</th><th></th></tr></thead>
  <tbody>${orders.map((o, i) => orderRow(o, useId, i)).join('').replaceAll('>Edit<', `>${editLabel}<`)}</tbody></table>
  <div><a href="#" data-key="page-1">1</a> <a href="#" data-key="page-2">2</a> <a href="#" data-key="next">Next</a></div>
  <section><h2>Shop</h2>${products.map((p) => card(p, swapIcons)).join('')}</section>
  <div onclick="1" data-key="more">Show more</div></main></body>`;
}
const CHANGES = {
  unchanged: () => ordersPage(),
  'row-added': () => ordersPage({ orders: [{ id: '#1045', who: 'Alan Turing', status: 'Paid', total: '€3.00' }, ...ORDERS] }),
  'row-removed': () => ordersPage({ orders: ORDERS.filter((o) => o.id !== '#1042') }),
  reordered: () => ordersPage({ orders: [...ORDERS].reverse(), products: [...PRODUCTS].reverse() }),
  'status-changed': () => ordersPage({ orders: ORDERS.map((o) => (o.id === '#1043' ? { ...o, status: 'Paid' } : o)) }),
  'id-regenerated': () => ordersPage({ idSuffix: 'p0w7qa' }),
  // React useId ids (Base UI) differ on every load.
  'use-id-regenerated': () => ordersPage({ useId: 'b' }),
  renamed: () => ordersPage({ editLabel: 'Modify' }),
  'duplicate-row': () => ordersPage({ orders: [...ORDERS, ORDERS[1]] }),
  // Two unnamed icon buttons trade places: a position-based locator must miss, not click the other one.
  'icons-swapped': () => ordersPage({ swapIcons: true }),
  // The recorded row and card are gone; a new one holds their text as a substring.
  lookalike: () => ordersPage({ orders: ORDERS.map((o) => (o.id === '#1042' ? { ...o, id: '#10420' } : o)),
    products: PRODUCTS.map((p) => (p.name === 'Moka pot' ? { ...p, name: 'Moka pot XL' } : p)) }),
};

// ---- run ------------------------------------------------------------------------------------------------------
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const site = await startSite();
const coverage = { total: 0, ok: 0, byStrategy: {}, byReason: {}, pages: [] };
const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1; };

async function cover(label, load) {
  const row = { page: label, total: 0, ok: 0, misses: [] };
  for (const kind of KINDS) {
    await load();
    for (const candidate of await candidates(page, kind, 254)) {
      const result = await recordLocator(page, candidate);
      row.total++;
      if (result.ok) { row.ok++; bump(coverage.byStrategy, result.locator.strategy); }
      else { bump(coverage.byReason, result.reason); row.misses.push(`${kind}: ${candidate.desc.slice(0, 90)} — ${result.reason}`); }
    }
  }
  coverage.total += row.total;
  coverage.ok += row.ok;
  coverage.pages.push(row);
}

for (const path of SITE_PAGES) await cover(`site${path}`, () => page.goto(site.url + path));
await cover('orders', () => page.setContent(ordersPage()));
// Public pages: some never reach `load` (pending ads and trackers); their DOM is enough here.
for (const url of values.url ?? []) {
  await cover(url, async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  }).catch((error) => console.error(`${url}: ${error.message.split('\n')[0]}`));
}

// Stability: record every candidate on the orders page once, replay on each change.
await page.setContent(ordersPage());
const recorded = [];
for (const kind of KINDS) {
  for (const candidate of await candidates(page, kind, 254)) {
    const result = await recordLocator(page, candidate);
    const key = await page.locator(`[data-jev-id="${candidate.id}"]`).getAttribute('data-key');
    if (result.ok && key) recorded.push({ kind, key, desc: candidate.desc, result });
  }
}
const stability = {};
for (const [change, html] of Object.entries(CHANGES)) {
  await page.setContent(html());
  const tally = { right: 0, wrong: 0, miss: 0, wrongs: [] };
  for (const { kind, key, result } of recorded) {
    const locator = toLocator(page, result.locator.parts);
    const count = await locator.count();
    // As a replay does: one match (or equivalent links), and the same markup for a position-based locator.
    if (count !== 1 || (result.locator.shape && await shapeOf(locator) !== result.locator.shape)) { tally.miss++; continue; }
    const got = await locator.evaluate((el) => el.closest('[data-key]')?.getAttribute('data-key') ?? null);
    if (got === key) tally.right++;
    else { tally.wrong++; tally.wrongs.push(`${kind} ${key} → ${got}: ${result.text}`); }
  }
  stability[change] = tally;
}
await browser.close();
await site.close();

// ---- report ---------------------------------------------------------------------------------------------------
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
console.log(`Coverage: ${coverage.ok}/${coverage.total} candidates (${pct(coverage.ok, coverage.total)}) get a verified locator`);
console.log('  by strategy:', JSON.stringify(coverage.byStrategy));
console.log('  no locator: ', JSON.stringify(coverage.byReason));
for (const row of coverage.pages) {
  console.log(`  ${row.page.padEnd(28)} ${String(row.ok).padStart(3)}/${String(row.total).padEnd(3)} ${pct(row.ok, row.total)}`);
  for (const miss of row.misses) console.log(`      ${miss}`);
}
console.log(`\nStability on the orders page: ${recorded.length} recorded locators`);
console.log('| Change | Right | Wrong | Miss |\n|---|---:|---:|---:|');
for (const [change, t] of Object.entries(stability)) console.log(`| ${change} | ${t.right} | ${t.wrong} | ${t.miss} |`);
for (const [change, t] of Object.entries(stability)) for (const wrong of t.wrongs) console.log(`  wrong (${change}): ${wrong}`);
if (values.out) writeFileSync(values.out, JSON.stringify({ coverage, stability, recorded: recorded.map((r) => ({ kind: r.kind, key: r.key, locator: r.result.text })) }, null, 2));
process.exitCode = Object.values(stability).some((t) => t.wrong) ? 1 : 0;
