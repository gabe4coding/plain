import { createHash, randomUUID } from 'node:crypto';
import type { Frame, FrameLocator, Locator, Page } from 'playwright';
import type { Candidate } from '../core/candidate.js';
import { elementById } from './candidates.js';
import { parameterize, type RunValues } from '../core/parameters.js';

/*
 * Turns the element Jev picked into a Playwright locator that a replay can use without Jev (src/core/lock.ts). A
 * locator is kept only when it matches exactly one element on the recorded page and that element is the picked one
 * (or, for a text match, inside it). The first strategy that passes wins, most stable first. An element in an
 * iframe gets the iframe's locator first, one per frame level. Check a change with scripts/benchmark-locators.mjs.
 */

/** One link of a locator chain; a scope part narrows the parts after it. */
export type LocatorPart =
  | { by: 'testid'; attr: string; value: string }
  | { by: 'role'; role: string; name: string }
  | { by: 'label'; text: string }
  | { by: 'placeholder'; text: string }
  | { by: 'id'; value: string }
  /** A tag with a stable attribute: a form control's `name`, a link's `href`, a copy button's `value`. */
  | { by: 'attr'; tag: string; attr: string; value: string }
  | { by: 'text'; text: string }
  /** A container (row, list item, card) found by its tag or role and an element in it with exactly this text. */
  | { by: 'scope'; selector: string; hasText: string }
  /** A tag whose own text starts with this text, a word boundary after it (a `<label>` that wraps its select). */
  | { by: 'tagtext'; selector: string; text: string }
  /** A tag alone: an unnamed control, unique on the page or in its container. */
  | { by: 'css'; selector: string }
  /** The n-th match of a tag: only inside a container, or for an iframe that nothing else names. */
  | { by: 'nth'; selector: string; index: number }
  /** The content of the iframe that these parts name; the parts after it are inside that frame. */
  | { by: 'frame'; parts: ElementPart[] };
type ElementPart = Exclude<LocatorPart, { by: 'frame' }>;

export type Strategy = 'testid' | 'role' | 'label' | 'placeholder' | 'id' | 'attr' | 'text' | 'tagtext' | 'css' | 'scoped' | 'equivalent';

/**
 * `equivalent`: the parts match several links with the same name and `href` (a repo link in a header and in a
 * card). Any of them goes to the same place, so a replay acts on the first while all of them keep that `href`.
 */
export interface RecordedLocator {
  strategy: Strategy;
  parts: LocatorPart[];
  equivalent?: { href: string };
  /** A position-based locator: a hash of the element's markup, so a control that took its place is a miss. */
  shape?: string;
}

export type RecordResult =
  | { ok: true; locator: RecordedLocator; text: string }
  | { ok: false; reason: string };

const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
/** `value` only on elements that do not take typing: a field's value is what a step changes. */
const STABLE_ATTRS = ['name', 'href', 'title', 'alt', 'value'];
/** Ids that frameworks generate per render: React `:r1:`, Ember, long numbers or hex runs. */
const GENERATED_ID = /^:|^ember\d|^react|\d{3,}|[0-9a-f]{8,}/i;
const MAX_SCOPE_TEXTS = 10;
const MAX_SCOPES = 3;
const MAX_TEXT = 80;
/** A copy button's `value` holds the whole code sample. */
const MAX_ATTR = 300;
/**
 * The container search tries scope × text × part combinations, each a page round trip, before the step acts: past
 * this, it gives up (the step still runs; the pick is not recorded).
 */
const SCOPE_SEARCH_MS = 1500;

type Root = Page | Frame | Locator | FrameLocator;

/** A Playwright locator from recorded parts, in `root` (a page or a frame). */
export function toLocator(root: Page | Frame, parts: LocatorPart[]): Locator {
  const frames = parts.filter((part) => part.by === 'frame');
  const element = parts.filter((part): part is ElementPart => part.by !== 'frame');
  if (!element.length) throw new Error('a locator must end with an element part');
  return chain(rootOf(root, frames), element);
}

/** The content of the iframes that `frames` name, one level after the other. */
function rootOf(root: Page | Frame, frames: Extract<LocatorPart, { by: 'frame' }>[]): Root {
  let from: Root = root;
  for (const frame of frames) from = chain(from, frame.parts).contentFrame();
  return from;
}

function chain(from: Root, parts: ElementPart[]): Locator {
  let locator: Locator | undefined;
  for (const part of parts) locator = partLocator(locator ?? from, part);
  if (!locator) throw new Error('empty locator');
  return locator;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function partLocator(from: Root, part: ElementPart): Locator {
  switch (part.by) {
    case 'testid': return from.locator(`[${part.attr}=${JSON.stringify(part.value)}]`);
    case 'role': return from.getByRole(part.role as Parameters<Page['getByRole']>[0], { name: part.name, exact: true });
    case 'label': return from.getByLabel(part.text, { exact: true });
    case 'placeholder': return from.getByPlaceholder(part.text, { exact: true });
    case 'id': return from.locator(`[id=${JSON.stringify(part.value)}]`);
    case 'attr': return from.locator(`${part.tag}[${part.attr}=${JSON.stringify(part.value)}]`);
    case 'text': return from.getByText(part.text, { exact: true });
    // Exact, not `hasText` (a substring): a row "#10420" must not stand in for a removed row "#1042".
    case 'scope': return from.locator(part.selector).filter({ has: from.getByText(part.hasText, { exact: true }) });
    case 'tagtext': return from.locator(part.selector).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(part.text)}(\\s|$)`) });
    case 'css': return from.locator(part.selector);
    case 'nth': return from.locator(part.selector).nth(part.index);
  }
}

/** Role and accessible name as Playwright computes them: the first line of the element's aria snapshot. */
export function parseAriaHead(snapshot: string): { role: string; name: string } | null {
  const match = /^- ([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?/.exec(snapshot);
  if (!match || match[1] === 'text' || match[1] === 'generic') return null;
  try {
    return { role: match[1], name: match[2] ? JSON.parse(match[2]) as string : '' };
  } catch {
    return null;
  }
}

interface ElementFacts {
  testids: { attr: string; value: string }[];
  id: string;
  /** The tag, with its `type` and `role` attributes: what a tag-only part matches. */
  selector: string;
  attrs: { attr: string; value: string }[];
  labels: string[];
  placeholder: string;
  text: string;
  /** The element's first own text, when its whole text is longer (a label that also holds its select's options). */
  lead: string;
  href: string | null;
  /**
   * Containers from the nearest up (tagged `data-plain-scope`), each with the lines it shows outside the element.
   * `labelled`: named by aria-label or aria-labelledby, not by its content (a row's name is all its cells).
   */
  scopes: { selector: string; texts: string[]; labelled: boolean }[];
}

const SCOPE_SELECTOR = 'tr, li, article, section, form, fieldset, dialog, [role=row], [role=listitem], [role=article], ' +
  '[role=group], [role=region], [role=dialog], [role=alertdialog], [role=gridcell]';
const SCOPE_ATTR = 'data-plain-scope';
/** A custom element whose shadow root renders one of these is a scope: its slotted content is the dialog's. */
const DIALOG_SELECTOR = 'dialog, [role=dialog], [role=alertdialog], [aria-modal=true]';

async function factsOf(element: Locator, nonce: string): Promise<ElementFacts> {
  return element.evaluate((el, { attrs, stableAttrs, scopeSelector, dialogSelector, scopeAttr, nonce, maxScopes, maxTexts, maxText, maxAttr }) => {
    const flat = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');
    const testids = attrs.flatMap((attr) => el.hasAttribute(attr) ? [{ attr, value: el.getAttribute(attr)! }] : []);
    const labels = Array.from((el as HTMLInputElement).labels ?? []).map((l) => flat(l.textContent)).filter(Boolean);
    const text = flat((el as HTMLElement).innerText ?? el.textContent);
    const firstOwn = Array.from(el.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && flat(node.textContent));
    const lead = flat(firstOwn?.textContent);
    // DOM tree, out through shadow hosts. Not the flat tree: a Playwright locator scoped to a shadow-root dialog
    // does not reach the light-DOM button slotted into it, but one scoped to the dialog's host does.
    const parentOf = (node: Element): Element | null => node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null);
    const hostsDialog = (node: Element) => node.shadowRoot?.querySelector(dialogSelector) != null;
    // Single text nodes, open shadow roots included: getByText({ exact }) can then find each one's element. A line
    // of innerText can span several elements, which no exact text match finds.
    const textsIn = (root: Element): string[] => {
      const out: string[] = [];
      const walk = (node: Node) => {
        for (let child = node.firstChild; child && out.length < maxTexts; child = child.nextSibling) {
          if (child.nodeType === Node.TEXT_NODE) {
            const line = flat(child.textContent);
            if (/[\p{L}\p{N}]/u.test(line) && line !== text && line.length <= maxText && !el.contains(child) && !out.includes(line)) out.push(line);
          } else if (child instanceof Element && !['SCRIPT', 'STYLE', 'TEMPLATE'].includes(child.tagName)) {
            if (child.shadowRoot) walk(child.shadowRoot);
            walk(child);
          }
        }
      };
      walk(root);
      return out;
    };
    const scopes: { selector: string; texts: string[]; labelled: boolean }[] = [];
    for (let up = parentOf(el); up && scopes.length < maxScopes; up = parentOf(up)) {
      if (!up.matches(scopeSelector) && !hostsDialog(up)) continue;
      up.setAttribute(scopeAttr, `${nonce}-${scopes.length}`);
      const role = up.getAttribute('role');
      const texts = textsIn(up);
      const base = role ? `${up.tagName.toLowerCase()}[role=${role}]` : up.tagName.toLowerCase();
      // Layout tables nest rows in rows: the outer row holds the same text, so only the innermost one is unique.
      const nested = up.parentElement?.closest(base) != null && up.querySelector(base) === null;
      scopes.push({ selector: nested ? `${base}:not(:has(${base}))` : base, texts,
        labelled: up.hasAttribute('aria-label') || up.hasAttribute('aria-labelledby') });
    }
    const field = el.matches('input, textarea, select, [contenteditable]');
    const attrsOf = stableAttrs.flatMap((attr) => {
      const value = el.getAttribute(attr);
      return value && value.length <= maxAttr && !(attr === 'value' && field) ? [{ attr, value }] : [];
    });
    const type = el.getAttribute('type');
    const role = el.getAttribute('role');
    const selector = el.localName + (type ? `[type=${JSON.stringify(type)}]` : '') + (role ? `[role=${JSON.stringify(role)}]` : '');
    return { testids, id: el.id, selector, attrs: attrsOf, labels, placeholder: flat(el.getAttribute('placeholder')), text,
      lead: lead && lead !== text && lead.length <= maxText ? lead : '', href: el instanceof HTMLAnchorElement ? el.getAttribute('href') : null, scopes };
  }, { attrs: TESTID_ATTRS, stableAttrs: STABLE_ATTRS, scopeSelector: SCOPE_SELECTOR, dialogSelector: DIALOG_SELECTOR, scopeAttr: SCOPE_ATTR, nonce,
    maxScopes: MAX_SCOPES, maxTexts: MAX_SCOPE_TEXTS, maxText: MAX_TEXT, maxAttr: MAX_ATTR });
}

/** The containers a scoped locator can start from: by role and name when it has a name, else by a text it holds. */
async function scopeParts(frame: Frame, facts: ElementFacts, nonce: string): Promise<ElementPart[]> {
  const out: ElementPart[] = [];
  for (const [i, scope] of facts.scopes.entries()) {
    const tagged = frame.locator(`[${SCOPE_ATTR}="${nonce}-${i}"]`);
    const head = scope.labelled ? parseAriaHead(await tagged.ariaSnapshot().catch(() => '')) : null;
    if (head?.name) out.push({ by: 'role', role: head.role, name: head.name });
    for (const hasText of scope.texts) out.push({ by: 'scope', selector: scope.selector, hasText });
  }
  // CSS locators pierce open shadow roots, where document.querySelectorAll does not reach.
  await frame.locator(`[${SCOPE_ATTR}^="${nonce}-"]`).evaluateAll((els, attr) => els.forEach((el) => el.removeAttribute(attr)), SCOPE_ATTR);
  return out;
}

/** Exactly one match, and it is the element tagged `jevId` (a text match may be inside it). */
async function pointsAt(locator: Locator, jevId: string, inside: boolean): Promise<boolean> {
  try {
    if (await locator.count() !== 1) return false;
    return await locator.evaluate((el, { id, inside }) =>
      el.getAttribute('data-jev-id') === id || (inside && el.closest(`[data-jev-id="${id}"]`) !== null), { id: jevId, inside });
  } catch {
    return false;
  }
}

/** The element's own parts, most stable first; each is tried alone, then inside a scope. */
function ownParts(facts: ElementFacts, aria: { role: string; name: string } | null): { strategy: Strategy; part: ElementPart }[] {
  const out: { strategy: Strategy; part: ElementPart }[] = [];
  for (const { attr, value } of facts.testids) out.push({ strategy: 'testid', part: { by: 'testid', attr, value } });
  if (aria?.name) out.push({ strategy: 'role', part: { by: 'role', role: aria.role, name: aria.name } });
  for (const text of facts.labels) out.push({ strategy: 'label', part: { by: 'label', text } });
  if (facts.placeholder) out.push({ strategy: 'placeholder', part: { by: 'placeholder', text: facts.placeholder } });
  if (facts.id && !GENERATED_ID.test(facts.id)) out.push({ strategy: 'id', part: { by: 'id', value: facts.id } });
  const tag = facts.selector.replace(/\[.*$/, '');
  for (const { attr, value } of facts.attrs) out.push({ strategy: 'attr', part: { by: 'attr', tag, attr, value } });
  if (facts.text && facts.text.length <= MAX_TEXT) out.push({ strategy: 'text', part: { by: 'text', text: facts.text } });
  if (facts.lead) out.push({ strategy: 'tagtext', part: { by: 'tagtext', selector: facts.selector, text: facts.lead } });
  out.push({ strategy: 'css', part: { by: 'css', selector: facts.selector } });
  return out;
}

/** The iframe element of `frame` in its parent, as parts: by title, name, id, label or source, else by position. */
async function iframePart(parent: Root, frame: Frame): Promise<ElementPart | null> {
  const handle = await frame.frameElement();
  try {
    const attrs = await handle.evaluate((node, maxAttr) => {
      const el = node as Element;
      const out: { attr: string; value: string }[] = [];
      for (const attr of ['title', 'name', 'aria-label', 'src']) {
        const value = el.getAttribute(attr);
        if (value && value.length <= maxAttr && !value.startsWith('data:')) out.push({ attr, value });
      }
      return { attrs: out, id: el.id, srcdoc: el.hasAttribute('srcdoc') };
    }, MAX_ATTR);
    const tries: ElementPart[] = attrs.attrs.map(({ attr, value }) => ({ by: 'attr', tag: 'iframe', attr, value }));
    if (attrs.id && !GENERATED_ID.test(attrs.id)) tries.push({ by: 'id', value: attrs.id });
    if (attrs.srcdoc) tries.push({ by: 'css', selector: 'iframe[srcdoc]' });
    const count = await parent.locator('iframe').count();
    for (let index = 0; index < count; index++) tries.push({ by: 'nth', selector: 'iframe', index });
    for (const part of tries) {
      const locator = chain(parent, [part]);
      if (await locator.count() === 1 && await locator.evaluate((el, other) => el === other, handle)) return part;
    }
    return null;
  } finally {
    await handle.dispose();
  }
}

/** The frame parts that lead from the page to `frame`, or null when an iframe on the way has no locator. */
async function framePath(page: Page, frame: Frame): Promise<Extract<LocatorPart, { by: 'frame' }>[] | null> {
  const parent = frame.parentFrame();
  if (!parent) return [];
  const above = await framePath(page, parent);
  if (!above) return null;
  const part = await iframePart(rootOf(page, above), frame);
  return part ? [...above, { by: 'frame', parts: [part] }] : null;
}

/** Several links with the same name and `href` as the picked one, the picked one among them. */
async function sameLinks(locator: Locator, jevId: string, href: string): Promise<boolean> {
  try {
    if (await locator.count() < 2) return false;
    return await locator.evaluateAll((els, { id, href }) => els.every((el) => el.getAttribute('href') === href) &&
      els.some((el) => el.getAttribute('data-jev-id') === id), { id: jevId, href });
  } catch {
    return false;
  }
}

/**
 * A hash of the element's markup without plain's own attributes: what tells two unnamed icon buttons apart. The
 * run's values are placeholders in it, so a card with this run's title has the shape it had with the last one.
 */
export async function shapeOf(locator: Locator, parameters: RunValues = []): Promise<string> {
  const markup = await locator.evaluate((el) => {
    const copy = el.cloneNode(true) as Element;
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      for (const attr of [...node.attributes]) if (attr.name.startsWith('data-jev') || attr.name.startsWith('data-plain')) node.removeAttribute(attr.name);
    }
    return copy.outerHTML;
  });
  return createHash('sha256').update(parameterize(markup, parameters)).digest('hex');
}

/** A replayable locator for `candidate` on the page it was scanned from, or why there is none. */
export async function recordLocator(page: Page, candidate: Candidate, parameters: RunValues = []): Promise<RecordResult> {
  const frame = page.frames()[candidate.frameIndex ?? 0];
  const prefix = await framePath(page, frame);
  if (!prefix) return { ok: false, reason: 'no locator for the iframe that holds the element' };
  const root = rootOf(page, prefix);
  const element = elementById(page, candidate.id, candidate.frameIndex ?? 0);
  const jevId = String(candidate.id);
  const nonce = randomUUID().slice(0, 8);
  const [facts, snapshot] = await Promise.all([factsOf(element, nonce), element.ariaSnapshot().catch(() => '')]);
  const parts = ownParts(facts, parseAriaHead(snapshot));
  const scopes = await scopeParts(frame, facts, nonce);

  const found = (strategy: Strategy, chained: ElementPart[], extra: Pick<RecordedLocator, 'equivalent' | 'shape'> = {}): RecordResult => {
    const locator: RecordedLocator = { strategy, parts: [...prefix, ...chained], ...extra };
    return { ok: true, locator, text: toLocator(page, locator.parts).toString() };
  };
  const inside = (part: ElementPart) => part.by === 'text' || part.by === 'tagtext';
  for (const { strategy, part } of parts) {
    if (await pointsAt(chain(root, [part]), jevId, inside(part))) return found(strategy, [part]);
  }
  // Several equal elements (a "View" link per row, a button behind a dialog): narrow by the nearest container
  // that is unique on the page; in it, an unnamed control may be named by its position.
  const deadline = Date.now() + SCOPE_SEARCH_MS;
  for (const container of scopes) {
    if (Date.now() > deadline) return { ok: false, reason: 'no unique locator within the search time' };
    if (await chain(root, [container]).count() !== 1) continue;
    for (const { part } of parts) {
      if (await pointsAt(chain(root, [container, part]), jevId, inside(part))) return found('scoped', [container, part]);
    }
    const all = chain(root, [container, { by: 'css', selector: facts.selector }]);
    const index = await all.evaluateAll((els, id) => els.findIndex((el) => el.getAttribute('data-jev-id') === id), jevId).catch(() => -1);
    const nth: ElementPart = { by: 'nth', selector: facts.selector, index };
    if (index >= 0 && await pointsAt(chain(root, [container, nth]), jevId, false)) {
      return found('scoped', [container, nth], { shape: await shapeOf(chain(root, [container, nth]), parameters) });
    }
  }
  if (facts.href !== null) {
    for (const { part } of parts) {
      if (part.by !== 'css' && await sameLinks(chain(root, [part]), jevId, facts.href)) return found('equivalent', [part], { equivalent: { href: facts.href } });
    }
  }
  return { ok: false, reason: 'no unique locator' };
}
