import { StepKind } from './step-kind.js';
import { z } from 'zod';
import type { Page, Frame, Locator } from 'playwright';

export const CandidateSchema = z.object({
  id: z.number(),
  desc: z.string(),
  frameIndex: z.number(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const CandidateKindSchema = z.enum([StepKind.click, StepKind.hover, StepKind.fill, StepKind.select, StepKind.check, StepKind.upload, 'region']);
export type CandidateKind = z.infer<typeof CandidateKindSchema>;

const CLICK_SELECTOR =
  'a, button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [role=listbox] li, [role=menuitemradio], [onclick]';
const FILL_SELECTOR =
  'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]';
const SELECT_SELECTOR = 'select';
// Toggles that keep their state in aria-pressed/aria-checked (filter chips, menu check items) count too; the
// `check` step reads that state before acting. Labels whose checkbox has no size are added by the walker.
const CHECK_SELECTOR =
  'input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch], [role=menuitemcheckbox], [role=menuitemradio], [aria-pressed]';
const UPLOAD_SELECTOR = 'input[type=file]';
const REGION_SELECTOR =
  'main, section, article, dialog, nav, header, footer, aside, form, table, [role=region], [role=dialog], [role=main], [role=tabpanel], [role=list]';

// Layers decide what a dense page loses to the cap: an open dialog blocks everything else, so its controls
// come first; nav and footer link farms (131 of trivago's first 254 candidates) come last.
const DIALOG_SELECTOR = 'dialog, [role=dialog], [role=alertdialog], [aria-modal=true]';
const CHROME_SELECTOR = 'nav, footer, [role=navigation], [role=contentinfo]';

const SELECTORS: Record<CandidateKind, string> = {
  [StepKind.click]: CLICK_SELECTOR,
  [StepKind.hover]: `${CLICK_SELECTOR}, img, svg, figure`, // hover targets are often plain images with no clickable signal
  [StepKind.fill]: FILL_SELECTOR,
  [StepKind.select]: SELECT_SELECTOR,
  [StepKind.check]: CHECK_SELECTOR,
  [StepKind.upload]: UPLOAD_SELECTOR,
  region: REGION_SELECTOR,
};

/** Wait until the DOM stops mutating for `quietMs` (debounced autocompletes, modals), giving up after `maxMs`. */
export function settle(page: Page, quietMs = 500, maxMs = 3000): Promise<void> {
  return page.evaluate(
    ({ quietMs, maxMs }) =>
      new Promise<void>((resolve) => {
        let timer = setTimeout(done, quietMs);
        const obs = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, quietMs);
        });
        const cap = setTimeout(done, maxMs);
        obs.observe(document.body, { childList: true, subtree: true, attributes: true });
        function done() {
          obs.disconnect();
          clearTimeout(timer);
          clearTimeout(cap);
          resolve();
        }
      }),
    { quietMs, maxMs }
  );
}

/**
 * Runs inside the page/frame. Walks the whole document — including open shadow roots — collecting
 * elements that match `selector`. For `includeExtras` (the `click` kind), also collects React-style
 * clickables that match no selector: cursor:pointer, [tabindex], [contenteditable], summary, label.
 * For `labelsOfToggles` (the `check` kind), a label whose checkbox/radio has no size stands in for it.
 * Order before the cap: dialog content, then the page, then nav/footer; within a layer selector-matched
 * elements first (DOM order), extras after.
 */
function collectCandidatesInPage(args: {
  selector: string;
  dialogSelector: string;
  chromeSelector: string;
  includeExtras: boolean;
  labelsOfToggles: boolean;
  skipVisibility: boolean;
  max: number;
  startId: number;
}): string[] {
  const { selector, dialogSelector, chromeSelector, includeExtras, labelsOfToggles, skipVisibility, max, startId } = args;

  function visible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
  const enabled = (el: Element) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
  function truncate(s: string, n: number): string {
    s = s.trim().replace(/\s+/g, ' ');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function describe(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const role = el.getAttribute('role');
    let head = tag;
    if (type) head += `[type=${type}]`;
    if (role) head += `[role=${role}]`;
    const parts: string[] = [head];

    const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
    const value = (el as HTMLInputElement).value;
    if (text && text.trim()) parts.push(`"${truncate(text, 60)}"`);
    else if (value) parts.push(`value="${truncate(value, 60)}"`);

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) parts.push(`aria-label="${truncate(ariaLabel, 60)}"`);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) parts.push(`placeholder="${truncate(placeholder, 60)}"`);
    const alt = el.getAttribute('alt');
    if (alt) parts.push(`alt="${truncate(alt, 60)}"`);
    const title = el.getAttribute('title');
    if (title) parts.push(`title="${truncate(title, 60)}"`);
    const name = el.getAttribute('name');
    if (name) parts.push(`name="${name}"`);
    const id = el.getAttribute('id');
    if (id) parts.push(`id="${id}"`);
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

  // `[draggable=true]` catches HTML5 drag-and-drop sources/targets — the-internet's /drag_and_drop
  // boxes are plain <div draggable="true"> with `cursor: move`, not `pointer`, so isPointer() alone
  // would never surface them for a `drag` step.
  const EXTRA_SELECTOR = '[tabindex]:not([tabindex="-1"]), [contenteditable=true], summary, label, [draggable=true]';
  // key = layer * 2 + (extra ? 1 : 0): dialog controls, dialog extras, page controls, page extras, nav/footer...
  const found: { el: Element; key: number }[] = [];

  // `cursor` is inherited: only the outermost pointer element is the clickable (the card), not every
  // span/svg/path inside it — those would only bloat the list toward the 255-option ceiling.
  const isPointer = (el: Element) => window.getComputedStyle(el).cursor === 'pointer';
  // A styled checkbox is usually a 0x0 or offscreen input behind a label: the label is what a user clicks.
  const isHiddenToggle = (c: HTMLElement | null) => c instanceof HTMLInputElement && (c.type === 'checkbox' || c.type === 'radio') && !visible(c);
  function visit(el: Element, layer: number) {
    if (el.hasAttribute('data-jev-id')) el.removeAttribute('data-jev-id');
    if (el.matches(dialogSelector)) layer = 0;
    else if (layer === 1 && el.matches(chromeSelector)) layer = 2;
    if (el.matches(selector)) found.push({ el, key: layer * 2 });
    else if (labelsOfToggles && el instanceof HTMLLabelElement && isHiddenToggle(el.control)) found.push({ el, key: layer * 2 });
    else if (includeExtras && !(el instanceof SVGElement) && (el.matches(EXTRA_SELECTOR) || (isPointer(el) && !(el.parentElement && isPointer(el.parentElement))))) {
      found.push({ el, key: layer * 2 + 1 });
    }
    if (el.shadowRoot) for (const c of Array.from(el.shadowRoot.children)) visit(c, layer);
    for (const c of Array.from(el.children)) visit(c, layer);
  }
  if (document.body) for (const c of Array.from(document.body.children)) visit(c, 1);

  const keep = (el: Element) => (skipVisibility || visible(el)) && enabled(el);
  const final = found
    .filter((f) => keep(f.el))
    .sort((a, b) => a.key - b.key) // stable: DOM order within a key
    .map((f) => f.el)
    .slice(0, max);
  const descs = final.map((el, i) => {
    el.setAttribute('data-jev-id', String(startId + i));
    return describe(el);
  });
  // Identical descriptions (three "img alt=User Avatar", two bare checkboxes) get an ordinal in DOM order,
  // so "the first …" / "the leftmost …" has exactly one answer.
  const counts = new Map<string, number>();
  for (const d of descs) counts.set(d, (counts.get(d) ?? 0) + 1);
  const seen = new Map<string, number>();
  return descs.map((d) => {
    if ((counts.get(d) ?? 0) < 2) return d;
    const n = (seen.get(d) ?? 0) + 1;
    seen.set(d, n);
    return `${d} #${n}`;
  });
}

function frameLabel(frame: Frame): string {
  const name = frame.name();
  if (name) return name;
  try {
    return new URL(frame.url()).pathname || frame.url();
  } catch {
    return frame.url();
  }
}

export async function candidates(page: Page, kind: CandidateKind, max: number): Promise<Candidate[]> {
  const selector = SELECTORS[kind];
  const includeExtras = kind === StepKind.click || kind === StepKind.hover;
  const labelsOfToggles = kind === StepKind.check;
  const skipVisibility = kind === StepKind.upload;
  const out: Candidate[] = [];
  const frames = page.frames();

  for (let frameIndex = 0; frameIndex < frames.length && out.length < max; frameIndex++) {
    const frame = frames[frameIndex];
    const startId = out.length;
    let descs: string[];
    try {
      descs = await frame.evaluate(collectCandidatesInPage, {
        selector,
        dialogSelector: DIALOG_SELECTOR,
        chromeSelector: CHROME_SELECTOR,
        includeExtras,
        labelsOfToggles,
        skipVisibility,
        max: max - out.length,
        startId,
      });
    } catch {
      continue; // detached or cross-origin frame — skip, never fatal
    }
    const prefix = frameIndex === 0 ? '' : `[iframe ${frameLabel(frame)}] `;
    for (const desc of descs) out.push({ id: out.length, desc: prefix + desc, frameIndex });
  }
  return out;
}

export function elementById(page: Page, id: number, frameIndex = 0): Locator {
  return page.frames()[frameIndex].locator(`[data-jev-id="${id}"]`);
}

export const SnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  aria: z.string(),
  truncated: z.boolean(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

const ARIA_MAX_CHARS = 60_000; // ponytail: hard truncate, no smart summarization — ≈15k tokens, ≈$0.0006/call

function capAria(s: string): { aria: string; truncated: boolean } {
  return s.length > ARIA_MAX_CHARS ? { aria: s.slice(0, ARIA_MAX_CHARS), truncated: true } : { aria: s, truncated: false };
}

function toSnapshot(page: Page, title: string, ariaFull: string): Snapshot {
  const { aria, truncated } = capAria(ariaFull);
  return { url: page.url(), title, aria, truncated };
}

export async function snapshot(page: Page): Promise<Snapshot> {
  const frames = page.frames();
  const iframeFrames = frames.slice(1);
  const [title, bodyAria, iframeArias] = await Promise.all([
    page.title(),
    page.locator('body').ariaSnapshot(),
    // detached or cross-origin — skip, never fatal
    Promise.all(iframeFrames.map((f) => f.locator('body').ariaSnapshot().catch(() => null))),
  ]);
  let full = bodyAria;
  iframeFrames.forEach((frame, i) => {
    const frameAria = iframeArias[i];
    if (frameAria !== null) full += `\n--- iframe ${frameLabel(frame)} ---\n${frameAria}`;
  });
  return toSnapshot(page, title, full);
}

/** Same as `snapshot()` but scoped to one region locator, for `expect: { that, within }`. */
export async function snapshotRegion(page: Page, locator: Locator): Promise<Snapshot> {
  const [title, ariaFull] = await Promise.all([page.title(), locator.ariaSnapshot()]);
  return toSnapshot(page, title, ariaFull);
}
