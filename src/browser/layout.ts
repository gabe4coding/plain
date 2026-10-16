import type { ElementHandle, Frame, JSHandle, Locator, Page } from 'playwright';
import { boundsText, type Candidate } from '../core/candidate.js';
import { joinLayout, LAYOUT_TRUNCATED, MAX_LAYOUT_ELEMENTS, neighborRelations, type LayoutItem } from '../core/layout.js';
import { frameLabel } from './frames.js';
import { PASSWORD_MASK } from './page.js';

const MAX_LAYOUT_TEXT = 120;
const MAX_LAYOUT_NODES = 10_000;
/** An iframe capture that fails or outlasts this (detached, navigating) becomes one "unavailable" line. */
const IFRAME_LAYOUT_MS = 2_000;

function edges(box: { x: number; y: number; width: number; height: number }): NonNullable<Candidate['bounds']> {
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
}

/** Visibility inside a document does not account for its embedding iframe or outer frames. */
function renderedFrame(frame: Frame, cache: Map<Frame, Promise<boolean>>): Promise<boolean> {
  const known = cache.get(frame);
  if (known) return known;
  const visible = (async () => {
    if (frame.isDetached()) return false;
    const parent = frame.parentFrame();
    if (!parent) return true;
    if (!await renderedFrame(parent, cache)) return false;
    const embedding = await frame.frameElement();
    try {
      return await embedding.evaluate((el) => el instanceof Element &&
        el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    } finally {
      await embedding.dispose().catch(() => {});
    }
  })();
  cache.set(frame, visible);
  return visible;
}

/** Playwright supplies main-viewport coordinates, including transformed and nested iframe elements. */
export async function spatialCandidates(page: Page, candidates: Candidate[]): Promise<Candidate[]> {
  const frames = page.frames();
  const visibility = new Map<Frame, Promise<boolean>>();
  const observed = await Promise.all(candidates.map(async (candidate) => {
    const frame = frames[candidate.frameIndex ?? 0];
    if (!frame || frame.isDetached()) return null;
    try {
      if (!await renderedFrame(frame, visibility)) return null;
      // Do not auto-wait for a scanned element that unmounted while the observation was in flight.
      const elements = await frame.locator(`[data-jev-id="${candidate.id}"]`).elementHandles();
      try {
        const element = elements[0];
        if (!element) return null;
        const box = await element.boundingBox();
        if (!box && !await element.evaluate((el) => el.isConnected)) return null;
        // Hidden file inputs are actionable through setInputFiles even without rendered geometry.
        return box ? { ...candidate, bounds: edges(box) } : candidate;
      } finally {
        await Promise.all(elements.map((element) => element.dispose().catch(() => {})));
      }
    } catch (error) {
      if (frame !== page.mainFrame() && (frame.isDetached() || /context was destroyed|frame.*detached|navigat/i.test(String(error)))) return null;
      throw error;
    }
  }));
  return observed.filter((candidate): candidate is Candidate => candidate !== null);
}

/**
 * Returns actual elements: no DOM attributes are written, and handles retain identity during a layout change.
 * Walks the rendered tree: a slot's assigned elements, a shadow root's children in place of the host's light
 * children, so `visited` lists each slotted element once.
 */
function layoutElements(root: Element, limits: { elements: number; nodes: number }): { elements: Element[]; truncated: boolean } {
  const found: Element[] = [];
  for (let ancestor: Element | null = root; ancestor;) {
    if (ancestor.getAttribute('aria-hidden') === 'true') return { elements: [], truncated: false };
    const tree = ancestor.getRootNode();
    ancestor = ancestor.assignedSlot ?? ancestor.parentElement ?? (tree instanceof ShadowRoot ? tree.host : null);
  }
  const pending = [root];
  const visited = new Set<Element>();
  while (pending.length) {
    const el = pending.pop()!;
    if (visited.has(el)) continue;
    if (visited.size >= limits.nodes || found.length >= limits.elements) return { elements: found, truncated: true };
    visited.add(el);
    if (el.matches('script, style, template, noscript') || el.getAttribute('aria-hidden') === 'true') continue;
    const slotText = Array.from(el.children).some((child) => {
      if (!(child instanceof HTMLSlotElement) || child.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(child);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
        child.assignedNodes({ flatten: true }).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    });
    const text = slotText || Array.from(el.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
    if ((text || el.matches('button, input, select, textarea, img, [role], [aria-label], [alt]')) &&
      el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) found.push(el);
    const assigned = el instanceof HTMLSlotElement ? el.assignedElements({ flatten: true }) : [];
    const children = assigned.length ? assigned : Array.from(el.shadowRoot?.children ?? el.children);
    pending.push(...children.reverse());
  }
  return { elements: found, truncated: false };
}

/**
 * `desc` keeps native values and the accessible name apart from the rendered text. Transparent descendants count in a
 * content-derived name but not in the rendered text; `name` states both when they differ, so a name never passes
 * for visible text. A collapsed select shows only its displayed selection and value. A filled password field's value
 * is PASSWORD_MASK.
 */
async function describeElement(element: ElementHandle<Element>, maxText: number) {
  return element.evaluate((el, { max, passwordMask }) => {
    const role = el.getAttribute('role');
    const tree = el.getRootNode();
    const referenced = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
      .map((id) => tree instanceof Document || tree instanceof ShadowRoot ? tree.getElementById(id)?.textContent ?? '' : '').join(' ').trim();
    const labelParts: string[] = [];
    for (const label of (el as HTMLInputElement).labels ?? []) {
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        // A wrapping label's name excludes the control's own subtree.
        if (!el.contains(node)) labelParts.push(node.textContent ?? '');
      }
    }
    const explicitLabel = referenced || el.getAttribute('aria-label') || el.getAttribute('alt') ||
      labelParts.join(' ').trim().replace(/\s+/g, ' ');
    const collapsedSelect = (select: HTMLSelectElement) => !select.multiple && select.size <= 1 &&
      !(CSS.supports('selector(:open)') && select.matches(':open'));
    const slottedText = (node: Node, visible = true): string => {
      if (node instanceof Element) {
        if (!visible && node.getAttribute('aria-hidden') === 'true') return '';
        const style = getComputedStyle(node);
        if (node.matches('script, style, template, noscript') || style.display === 'none' ||
          style.visibility === 'hidden' || style.visibility === 'collapse' || (visible && Number(style.opacity) === 0)) return '';
      }
      if (node instanceof HTMLSelectElement) {
        const options = !collapsedSelect(node) ? Array.from(node.options).filter((option) =>
          option.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) : Array.from(node.selectedOptions);
        return options.map((option) => option.label).join(' ');
      }
      if (node instanceof HTMLTextAreaElement) return node.value;
      if (node instanceof HTMLOptionElement) return node.label;
      const children = node instanceof HTMLSlotElement ? node.assignedNodes({ flatten: true }) :
        Array.from(node instanceof Element && node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes);
      return children.map((child) => child.nodeType === Node.TEXT_NODE ? child.textContent ?? '' : slottedText(child, visible)).join(' ');
    };
    const buttonValue = el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type) ?
      el.value || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : '') : '';
    // Text-entry controls render their current value, rather than their initial DOM text.
    const fieldText = el instanceof HTMLTextAreaElement ? el.value : el instanceof HTMLInputElement &&
      ['text', 'search', 'email', 'tel', 'url'].includes(el.type) ? el.value : undefined;
    const text = (buttonValue || fieldText || (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? '' : slottedText(el)))
      .trim().replace(/\s+/g, ' ').slice(0, max);
    const contentNamed = el.matches('button, a, h1, h2, h3, h4, h5, h6, [role=button], [role=link], [role=heading], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=option], [role=tab]');
    const accessibleText = contentNamed ? slottedText(el, false).trim().replace(/\s+/g, ' ').slice(0, max) : '';
    const label = explicitLabel || (accessibleText !== text ? accessibleText : '') ||
      (text ? '' : el.getAttribute('title') || el.getAttribute('placeholder'));
    const value = el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement &&
      !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden'].includes(el.type))
      ? (el.value && el instanceof HTMLInputElement && el.type === 'password' ? passwordMask : el.value) : undefined;
    const type = el instanceof HTMLInputElement ? `[type=${el.type}]` : '';
    const notDisplayed = el instanceof HTMLSelectElement && collapsedSelect(el)
      ? Array.from(el.options).filter((option) => !option.selected &&
        !Array.from(el.selectedOptions).some((selected) => selected.label === option.label))
        .map((option) => option.label).join(' | ').slice(0, max) : undefined;
    const tag = el.tagName.toLowerCase();
    const desc = `${tag}${type}${role ? `[role=${role}]` : ''} ${JSON.stringify(text)}` +
      (label ? ` label=${JSON.stringify(label.slice(0, max))}` : '') +
      (contentNamed && accessibleText !== text ? ` visible_text=${JSON.stringify(text)}` : '') +
      (value !== undefined ? ` value=${JSON.stringify(value.slice(0, max))}` : '') +
      (el instanceof HTMLSelectElement ? ` collapsed=${collapsedSelect(el)} displayed_selection=${JSON.stringify(text)}` : '') +
      (notDisplayed === undefined ? '' : ` options_not_displayed=${JSON.stringify(notDisplayed)}`);
    const kind = role || (/^h[1-6]$/.test(tag) ? 'heading' : el instanceof HTMLTextAreaElement ? 'field' :
      el instanceof HTMLInputElement ? (['button', 'submit', 'reset'].includes(el.type) ? 'button' : 'field') : tag);
    let name = `${kind} ${JSON.stringify((label || text || value || '').slice(0, max))}`;
    if (el instanceof HTMLSelectElement) {
      name = `${kind} with accessible name ${JSON.stringify((label || '').slice(0, max))} and displayed selection ${JSON.stringify(text)}`;
    } else if (value) {
      name = `${kind} with accessible name ${JSON.stringify((label || '').slice(0, max))} and current value ${JSON.stringify(value.slice(0, max))}`;
    } else if (contentNamed && label && label !== text) {
      name = `${kind} with visible text ${JSON.stringify(text)} and accessible name ${JSON.stringify(label.slice(0, max))}`;
    }
    return { desc, name };
  }, { max: maxText, passwordMask: PASSWORD_MASK });
}

async function captureLayout(root: Locator, label: string, remaining: number, timeout?: number) {
  const capture = await root.evaluateHandle(layoutElements, { elements: remaining, nodes: MAX_LAYOUT_NODES }, { timeout });
  const handles: JSHandle[] = [capture];
  try {
    const captured = await capture.getProperties();
    handles.push(...captured.values());
    const properties = await captured.get('elements')!.getProperties();
    handles.push(...properties.values());
    const elements = [...properties.values()].map((handle) => handle.asElement()).filter((element) => element !== null);
    const observed = await Promise.all(elements.slice(0, remaining).map(async (element) => {
      const [description, box] = await Promise.all([describeElement(element, MAX_LAYOUT_TEXT), element.boundingBox()]);
      return box && box.width > 0 && box.height > 0 ? {
        description: `${label}: ${description.desc}`, name: `${label}: ${description.name}`, bounds: edges(box),
      } : null;
    }));
    return { items: observed.filter((item) => item !== null), count: elements.length,
      truncated: await captured.get('truncated')!.jsonValue() as boolean };
  } finally {
    // A detached frame can also invalidate its handles; disposal must not mask the observation failure.
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => {})));
  }
}

/**
 * Bounded spatial evidence for a page or exactly one region, including its open shadow roots. `compact`, for a judge:
 * a page without iframes drops the `main: ` label from its rows, and the neighbors are grouped per element. Judgments
 * were the same on the e2e spatial claims; picks lost confidence, so they keep the full text.
 */
export async function layoutSnapshot(page: Page, within?: Locator, { compact = false } = {}): Promise<string> {
  // A region's frame goes through the same embedding visibility check as a whole page's frames.
  let regionFrame: Frame | null | undefined;
  if (within) {
    const handles = await within.elementHandles();
    try {
      regionFrame = await handles[0]?.ownerFrame();
    } finally {
      await Promise.all(handles.map((handle) => handle.dispose().catch(() => {})));
    }
  }
  const roots = within ? [{ root: within, label: 'region', iframe: regionFrame !== page.mainFrame(), frame: regionFrame }] : page.frames().map((frame, i) => ({
    root: frame.locator('body'), label: i === 0 ? 'main' : `iframe ${frameLabel(frame)}`, iframe: i > 0, frame,
  }));
  const visibility = new Map<Frame, Promise<boolean>>();
  const lines = ['Rendered bounds in main viewport CSS pixels: x increases right, y increases down.',
    'Use bounds for spatial claims. Tree order is not visual order. Missing required geometry is insufficient evidence.',
    'The first quoted string in each element row is current visible text; an empty string has no visible text. label is the accessible name and value is the current form value. A claimed name or value and its spatial relation must all match the same elements.',
    'The accessibility tree can contain invisible text. A label is an accessible name, not proof of visible text. For claims about visible text, use the quoted rendered text.'];
  const headerLines = lines.length;
  const items: LayoutItem[] = [];
  let remaining = MAX_LAYOUT_ELEMENTS;
  for (const { root, label, iframe, frame } of roots) {
    if (!remaining) {
      lines.push(LAYOUT_TRUNCATED);
      break;
    }
    try {
      if (!frame) continue;
      if (!await renderedFrame(frame, visibility)) {
        lines.push(`Visibility=false for ${label}: its embedding is hidden. All text and controls in this document are invisible, including those in the accessibility tree.`);
        continue;
      }
      // A frame without a body must not wait out the action timeout.
      if (!await root.count()) continue;
      const captured = await captureLayout(root, label, remaining, iframe ? IFRAME_LAYOUT_MS : undefined);
      items.push(...captured.items);
      if (captured.truncated) lines.push(LAYOUT_TRUNCATED);
      remaining -= Math.min(captured.count, remaining);
    } catch (error) {
      if (!iframe) throw error;
      lines.push(`Layout unavailable for ${label}: missing geometry is insufficient evidence.`);
    }
  }
  if (compact && roots.length === 1 && roots[0].label === 'main') {
    for (const item of items) {
      item.description = item.description.replace(/^main: /, '');
      item.name = item.name.replace(/^main: /, '');
    }
  }
  const observations = items.map((item) => `${item.description} bounds=${boundsText(item.bounds)}`);
  if (items.some((item) => item.description.includes(' collapsed='))) {
    observations.unshift('For a collapsed native select, displayed_selection is the only displayed option; options_not_displayed are not visible. Its label is the control name, separate from its displayed selection.');
  }
  const neighbors = neighborRelations(items, compact);
  if (neighbors.length) observations.push('Measured neighbors (nearest with perpendicular overlap; other relations still use bounds):', ...neighbors);
  return joinLayout([...lines.slice(0, headerLines), ...observations, ...lines.slice(headerLines)]);
}
