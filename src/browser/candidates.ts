import { z } from 'zod';
import type { Page, Locator } from 'playwright';
import { StepKind } from '../core/step-kind.js';
import type { Candidate } from '../core/candidate.js';
import { blockersIn, frameLabel, frameIsInert, releaseBlockers, type BlockerCache } from './frames.js';
import { PASSWORD_MASK } from './page.js';

export const CandidateKindSchema = z.enum([StepKind.click, StepKind.hover, StepKind.fill, StepKind.select, StepKind.check, StepKind.upload, 'region']);
export type CandidateKind = z.infer<typeof CandidateKindSchema>;

const CLICK_SELECTOR = 'a, button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], ' +
  '[role=radio], [role=option], [role=listbox] li, [role=menuitemradio], [onclick]';

const SELECTORS: Record<CandidateKind, string> = {
  [StepKind.click]: CLICK_SELECTOR,
  // Hover targets are often plain images with no clickable signal.
  [StepKind.hover]: `${CLICK_SELECTOR}, img, svg, figure`,
  [StepKind.fill]: 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), ' +
    'textarea, [contenteditable=""], [contenteditable=true], [contenteditable=plaintext-only]',
  [StepKind.select]: 'select',
  // Toggles that keep their state in aria-pressed/aria-checked count too: `check` reads that state before acting.
  [StepKind.check]: 'input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch], [role=menuitemcheckbox], ' +
    '[role=menuitemradio], [aria-pressed]',
  [StepKind.upload]: 'input[type=file]',
  // Plain ul/ol too: search results are often a bare list (the walk keeps only lists of things).
  region: 'main, section, article, dialog, nav, header, footer, aside, form, table, ul, ol, [role=region], [role=dialog], ' +
    '[role=main], [role=tabpanel], [role=list]',
};

interface ScanOptions {
  selector: string;
  /** `click`/`hover`: also cursor:pointer, [tabindex], [contenteditable], summary, label and [draggable] elements. */
  includeExtras: boolean;
  /** `check`: a label whose checkbox or radio has no size stands in for it. */
  labelsOfToggles: boolean;
  /** `region`: a plain ul/ol counts only when it lists things, not a row's inline labels or a short menu. */
  listsOfThings: boolean;
  /** `upload`: file inputs are usually hidden. */
  skipVisibility: boolean;
  /** A script dialog's layer over the page (layer.ts): what is outside it is covered. */
  layer: Element | null;
  /** PASSWORD_MASK: the scan runs in the page, so it gets the mask as an argument. */
  passwordMask: string;
  max: number;
  startId: number;
}

/**
 * Runs inside the page or frame, so every helper lives in here. Walks the document, open shadow roots included,
 * tags each kept element with `data-jev-id` and describes it.
 * Order before the cap: an open dialog's content first (it blocks the rest), then the page, then nav and footer
 * (link farms); within each layer, selector matches before extras, in DOM order. So the cap never cuts a cookie
 * banner appended at the end of the body.
 */
function scanCandidatesInPage({ selector, includeExtras, labelsOfToggles, listsOfThings, skipVisibility, layer, passwordMask, max, startId }: ScanOptions):
  string[] {
  const DIALOG = 'dialog, [role=dialog], [role=alertdialog], [aria-modal=true]';
  const PAGE_CHROME = 'nav, footer, [role=navigation], [role=contentinfo]';
  const EXTRA = '[tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable=true], [contenteditable=plaintext-only], summary, label, [draggable=true]';
  const LAYER = { dialog: 0, page: 1, chrome: 2 };
  const MAX_TEXT = 60;
  const LABELABLE = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'METER', 'PROGRESS', 'OUTPUT']);

  // One style read per element per scan: the walk, the visibility filter and the context all ask.
  const styles = new Map<Element, CSSStyleDeclaration>();
  function styleOf(el: Element): CSSStyleDeclaration {
    let style = styles.get(el);
    if (!style) styles.set(el, (style = window.getComputedStyle(el)));
    return style;
  }
  function visible(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = styleOf(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
  // `:disabled` also covers the controls of a disabled fieldset, except those in its first legend.
  const enabled = (el: Element) => !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
  function truncate(text: string, max: number): string {
    const flat = text.trim().replace(/\s+/g, ' ');
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
  }

  /** The text of a labelable control's labels, without the control's own text (a select's options). */
  function labelText(el: Element): string {
    if (!LABELABLE.has(el.tagName)) return '';
    const texts: string[] = [];
    for (const label of (el as HTMLInputElement).labels ?? []) {
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!el.contains(node)) texts.push(node.textContent ?? '');
    }
    return truncate(texts.join(' '), MAX_TEXT);
  }

  /** The text a shadow-root element shows through its slots, which innerText leaves out. */
  function slottedText(node: Node): string {
    const parts = node instanceof HTMLSlotElement ? node.assignedNodes({ flatten: true }) : Array.from(node.childNodes);
    return parts.map((child) => child instanceof HTMLSlotElement ? slottedText(child)
      : child instanceof HTMLElement ? (child.innerText || slottedText(child)) : child.nodeType === Node.TEXT_NODE ? child.textContent : '')
      .join(' ');
  }

  function describe(el: Element): string {
    const type = el.getAttribute('type');
    const role = el.getAttribute('role');
    const parts = [el.tagName.toLowerCase() + (type ? `[type=${type}]` : '') + (role ? `[role=${role}]` : '')];
    const ownText = (el as HTMLElement).innerText ?? el.textContent ?? '';
    const text = ownText.trim() || !el.querySelector('slot') ? ownText : slottedText(el);
    // Only form controls have a string value: an <li>'s or a <progress>'s is a number. A throw here would empty the
    // whole frame's scan, since candidates() skips a frame whose evaluate fails. A password field's value is a secret.
    const rawValue = (el as HTMLInputElement).value;
    const value = typeof rawValue !== 'string' ? '' : rawValue && el instanceof HTMLInputElement && el.type === 'password' ? passwordMask : rawValue;
    if (text && text.trim()) parts.push(`"${truncate(text, MAX_TEXT)}"`);
    else if (value) parts.push(`value="${truncate(value, MAX_TEXT)}"`);
    // An input's own text is empty: its <label> (wrapping or for=) is often the only name it has.
    const label = labelText(el);
    const shown = [text, value, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title')]
      .map((s) => truncate(s ?? '', MAX_TEXT));
    if (label && !shown.includes(label)) parts.push(`label="${label}"`);
    for (const attribute of ['aria-label', 'placeholder', 'alt', 'title', 'name', 'id']) {
      const attributeValue = el.getAttribute(attribute);
      const neverCut = attribute === 'name' || attribute === 'id';
      if (attributeValue) parts.push(`${attribute}="${neverCut ? attributeValue : truncate(attributeValue, MAX_TEXT)}"`);
    }
    const href = el.getAttribute('href');
    if (href) {
      try {
        parts.push(`href=${new URL(href, location.href).pathname}`);
      } catch {
        parts.push(`href=${href}`);
      }
    }
    return parts.join(' ');
  }

  // The context keeps a control's identity and its surroundings together: an Edit button's own text says
  // nothing about which row it edits. It never flattens a whole table or list, nor borrows another item's text.
  const ITEM = 'article, li, tr, [role=article], [role=listitem], [role=row]';
  const GROUP = 'section, form, fieldset, dialog, [role=group], [role=region], [role=dialog], [role=alertdialog]';
  const HEADING = 'h1, h2, h3, h4, h5, h6, [role=heading], legend';
  const OMIT = 'script, style, template, noscript, input, textarea, select, button, [role=button], nav, footer';
  const STOP = 'body, main, nav, footer, table, ul, ol, [role=main], [role=table], [role=list]';
  const MAX_DEPTH = 6;
  const MAX_NODES = 256;
  const MAX_HEADING = 80;
  const MAX_NEARBY = 160;
  const MAX_CONTEXT = 240;
  function parent(el: Element): Element | null {
    const root = el.getRootNode();
    return el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  // Candidates of one list share their containers: each check runs once per element per scan.
  const memo = <T>(fn: (el: Element) => T) => {
    const cache = new Map<Element, T>();
    return (el: Element): T => {
      let value = cache.get(el);
      if (value === undefined && !cache.has(el)) cache.set(el, (value = fn(el)));
      return value as T;
    };
  };
  const isHeading = memo((el) => el.matches(HEADING));
  const isItem = memo((el) => el.matches(ITEM));
  const isGroup = memo((el) => el.matches(GROUP));
  const isStop = memo((el) => el.matches(STOP));
  const isBoundary = memo((el) => el.matches(`${OMIT}, ${ITEM}, ${GROUP}`));
  const isHidden = memo((el) => {
    const style = styleOf(el);
    return el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden';
  });
  const hasHeading = memo((el) => {
    let scanned = 0;
    for (const child of el.children) {
      if (++scanned > MAX_NODES) break;
      if (isHeading(child)) return true;
    }
    return false;
  });

  /** ` context: <container> name=… heading=… text=…` from the nearest item, group or headed card, or ''. */
  function context(el: Element): string {
    let container = parent(el);
    for (let depth = 0; container && depth < MAX_DEPTH; depth++, container = parent(container)) {
      if (isStop(container)) break;
      const item = isItem(container);
      const group = isGroup(container);
      // A plain div card counts when it has a heading of its own; other generic wrappers are skipped.
      const headed = hasHeading(container);
      if (!item && !group && !headed) continue;

      let visited = 0;
      let heading = '';
      let nearby = '';
      const card = container;
      function read(node: Node, inHeading = false) {
        if (++visited > MAX_NODES || (heading.length >= MAX_HEADING && nearby.length >= MAX_NEARBY)) return;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent?.trim();
          if (text) {
            if (inHeading) heading = truncate(`${heading} ${text}`, MAX_HEADING);
            else if (item || headed) nearby = truncate(`${nearby} ${text}`, MAX_NEARBY);
          }
          return;
        }
        if (!(node instanceof Element)) return;
        if (node !== card) {
          if (node === el || isBoundary(node)) return;
          // A nested headed card is another card, unless the container itself is only a generic card.
          if (!item && !group && hasHeading(node)) return;
        }
        if (isHidden(node)) return;
        const underHeading = inHeading || isHeading(node);
        for (const child of node.childNodes) {
          if (visited >= MAX_NODES) break;
          read(child, underHeading);
        }
      }
      read(container);
      const label = container.getAttribute('aria-label');
      const name = label ? truncate(label, MAX_HEADING) : '';
      // A row is often labelled by its own heading: say it once.
      if (heading.trim() === name.trim()) heading = '';
      const parts = [name && `name=${JSON.stringify(name)}`, heading && `heading=${JSON.stringify(heading)}`,
        nearby && `text=${JSON.stringify(nearby)}`].filter(Boolean);
      // Stop at the nearest item or group even when it has nothing to say: looking further out could give this
      // control a sibling's identity.
      const kind = container.getAttribute('role') ?? container.tagName.toLowerCase();
      return parts.length ? ` context: ${kind} ${truncate(parts.join(' '), MAX_CONTEXT)}` : '';
    }
    return '';
  }

  // `cursor` is inherited: only the outermost pointer element (the card) is the clickable, not every span inside it.
  const pointer = new Map<Element, boolean>();
  function isPointer(el: Element): boolean {
    let is = pointer.get(el);
    if (is === undefined) pointer.set(el, (is = styleOf(el).cursor === 'pointer'));
    return is;
  }
  // A styled checkbox is usually a 0x0 or offscreen input behind a label: the label is what a user clicks.
  const isHiddenToggle = (control: HTMLElement | null) =>
    control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio') && !visible(control);
  const isPlainList = (el: Element) => (el.tagName === 'UL' || el.tagName === 'OL') && !el.hasAttribute('role');
  /** Two or more items of 40+ characters on average. */
  function listsThings(el: Element) {
    const items = Array.from(el.children).filter((child) => child.tagName === 'LI');
    return items.length >= 2 && (el.textContent ?? '').replace(/\s+/g, ' ').trim().length / items.length >= 40;
  }

  /** A pointer inside a pointer is part of one control; a shadow root's top element looks to its host. */
  function pointerParent(el: Element): boolean {
    const root = el.getRootNode();
    const parent = el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    return parent !== null && isPointer(parent);
  }

  // Sort key: layer * 2, + 1 for an extra.
  const found: { el: Element; key: number; inModal: boolean }[] = [];
  // An open showModal() dialog makes everything outside it inert, with no inert attribute to see.
  let modalOpen = false;
  // The previous scan's tags are removed after the walk: a write between style reads would make each read recompute.
  const staleTags: Element[] = [];
  // A slotted element renders inside its slot, so it takes the slot's layer, inertness and modal dialog, not its
  // host's. A host's shadow tree is walked before its children, so each slot is known when its elements come.
  const slotContext = new Map<Element, [number, boolean, boolean]>();
  function visit(el: Element, layer: number, inert: boolean, inModal: boolean) {
    const slotted = el.assignedSlot && slotContext.get(el.assignedSlot);
    if (slotted) [layer, inert, inModal] = slotted;
    if (el.hasAttribute('data-jev-id')) staleTags.push(el);
    const modal = el.matches('dialog:modal');
    modalOpen ||= modal;
    inModal ||= modal;
    // showModal() dialogs escape inherited inertness, but an explicit inert on the dialog still applies.
    inert = (inert && !modal) || el.hasAttribute('inert');
    if (el.matches(DIALOG)) layer = LAYER.dialog;
    else if (layer === LAYER.page && el.matches(PAGE_CHROME)) layer = LAYER.chrome;
    if (el instanceof HTMLSlotElement) slotContext.set(el, [layer, inert, inModal]);
    if (!inert && el.matches(selector)) {
      if (!listsOfThings || !isPlainList(el) || listsThings(el)) found.push({ el, key: layer * 2, inModal });
    } else if (!inert && labelsOfToggles && el instanceof HTMLLabelElement && isHiddenToggle(el.control) && enabled(el.control!)) {
      found.push({ el, key: layer * 2, inModal });
    } else if (!inert && includeExtras && !(el instanceof SVGElement)
      && (el.matches(EXTRA) || (isPointer(el) && !pointerParent(el)))) {
      found.push({ el, key: layer * 2 + 1, inModal });
    }
    if (el.shadowRoot) for (const child of Array.from(el.shadowRoot.children)) visit(child, layer, inert, inModal);
    for (const child of Array.from(el.children)) visit(child, layer, inert, inModal);
  }
  if (document.body) {
    const inert = document.body.hasAttribute('inert') || document.documentElement.hasAttribute('inert');
    for (const child of Array.from(document.body.children)) visit(child, LAYER.page, inert, false);
  }
  for (const el of staleTags) el.removeAttribute('data-jev-id');

  // Flat tree, like the layer: a slotted element is inside the box its slot renders in.
  function flatParent(el: Element): Element | null {
    const root = el.getRootNode();
    return el.assignedSlot ?? el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  function inLayer(el: Element): boolean {
    for (let at: Element | null = el; at; at = flatParent(at)) if (at === layer) return true;
    return false;
  }

  const kept = found
    .filter(({ inModal }) => inModal || !modalOpen)
    .filter(({ el }) => !layer || inLayer(el))
    .filter(({ el }) => (skipVisibility || visible(el)) && enabled(el))
    .sort((a, b) => a.key - b.key) // stable: DOM order within a key
    .map(({ el }) => el)
    .slice(0, max);
  const descs = kept.map((el, i) => {
    el.setAttribute('data-jev-id', String(startId + i));
    return describe(el);
  });

  // Identical descriptions get an ordinal in DOM order, so "the first …" has exactly one answer.
  const counts = new Map<string, number>();
  for (const desc of descs) counts.set(desc, (counts.get(desc) ?? 0) + 1);
  const seen = new Map<string, number>();
  return descs.map((desc, i) => {
    const ordinal = (seen.get(desc) ?? 0) + 1;
    seen.set(desc, ordinal);
    const numbered = counts.get(desc)! > 1 ? `${desc} #${ordinal}` : desc;
    return `${numbered}${context(kept[i])}`;
  });
}

/** The candidates of `kind` in every frame, main frame first, ids in scan order. */
export async function candidates(page: Page, kind: CandidateKind, max: number): Promise<Candidate[]> {
  const options = {
    selector: SELECTORS[kind],
    includeExtras: kind === StepKind.click || kind === StepKind.hover,
    labelsOfToggles: kind === StepKind.check,
    listsOfThings: kind === 'region',
    skipVisibility: kind === StepKind.upload,
    passwordMask: PASSWORD_MASK,
  };
  const found: Candidate[] = [];
  const blockers: BlockerCache = new Map();
  const frames = page.frames();
  try {
    for (let frameIndex = 0; frameIndex < frames.length && found.length < max; frameIndex++) {
      const frame = frames[frameIndex];
      let scanned: string[];
      try {
        if (await frameIsInert(frame, blockers)) continue;
        const layer = (await blockersIn(frame, blockers))?.layer ?? null;
        scanned = await frame.evaluate(scanCandidatesInPage, { ...options, layer, max: max - found.length, startId: found.length });
      } catch {
        continue; // a detached or cross-origin frame
      }
      const prefix = frameIndex === 0 ? '' : `[iframe ${frameLabel(frame)}] `;
      for (const desc of scanned) found.push({ id: found.length, desc: prefix + desc, frameIndex });
    }
  } finally {
    await releaseBlockers(blockers);
  }
  return found;
}

export function elementById(page: Page, id: number, frameIndex = 0): Locator {
  return page.frames()[frameIndex].locator(`[data-jev-id="${id}"]`);
}
