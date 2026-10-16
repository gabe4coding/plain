import type { App, Element } from '@crowecawcaw/xa11y';
import { MAX_CANDIDATES, type Frame } from '../core/automation.js';
import type { Bounds, Candidate } from '../core/candidate.js';
import type { CaptureOptions, NativeAdapter } from '../native/session.js';
import { MAX_LAYOUT_ELEMENTS, nativeLayout, type LayoutItem } from '../core/layout.js';

export type ComputerKind = 'click' | 'fill' | 'check' | 'hover' | 'region' | 'scroll';
export type ComputerAction = 'click' | 'fill' | 'check' | 'uncheck' | 'hover' | 'dblclick' | 'rightclick' | 'scroll';
export interface ComputerTarget { app?: string; pid?: number }

export interface ComputerAdapter<T = unknown> extends NativeAdapter<T, ComputerKind> {
  apps(): Promise<{ name: string; pid: number | null }[]>;
  open(target: ComputerTarget, activate: boolean): Promise<{ name: string; pid: number | null }>;
  act(kind: ComputerAction, element: T, value?: string): Promise<void>;
  mouse(x: number, y: number): Promise<void>;
  drag(source: T, target: T): Promise<void>;
}

type KindFields = Pick<Element, 'visible' | 'enabled' | 'editable' | 'checked' | 'actions' | 'focusable' | 'role'>;

export function matchesKind(el: KindFields, kind: ComputerKind): boolean {
  if (kind === 'region') return el.visible;
  if (kind === 'scroll') return el.visible && /scroll|list|table|tree|text|window|group/.test(el.role);
  if (!el.visible || !el.enabled) return false;
  if (kind === 'fill') return el.editable || el.actions.includes('set_value');
  if (kind === 'check') return el.checked !== null;
  return el.actions.length > 0 || el.focusable || /button|link|menu_item|tab|row|cell|image/.test(el.role);
}

type AccessibleNode = Pick<Element, 'role' | 'name' | 'value' | 'visible' | 'enabled' | 'editable' | 'checked' | 'selected' | 'focused' |
  'actions' | 'focusable' | 'modal'> & { readonly bounds?: Element['bounds']; children(): Promise<AccessibleNode[]> };

/** xa11y bounds are desktop coordinates: points on macOS, physical pixels on Windows. */
export const DESKTOP_COORDINATES = 'desktop screen coordinates';

const TEXT_ROLE = /^(static_text|text)$/;
/** macOS: an NSSecureTextField is a text field with this subrole. */
const SECURE_SUBROLE = 'AXSecureTextField';
/** Parts of a control, not controls of their own: inside a candidate they are no candidates (a row's cells too). */
const PART_ROLE = /^(static_text|text|group|image|generic|table_cell|cell)$/;
/** A candidate names only the start of a long value (an editor's whole file); the snapshot keeps all of it. */
const VALUE_CHARS = 100;
/** Enough inner text to name a row by all its cells (message, author, hash, date). */
const TEXT_CHARS = 160;
const MAX_NODES = 5000;
const MAX_TREE_CHARS = 60000;
const MAX_DEPTH = 32;

interface CapturedTree<T> {
  snapshot: { aria: string; truncated: boolean; layout?: string };
  candidates: Candidate[];
  elements: Map<number, T>;
  /** Candidates inside a web view (Electron apps, embedded browsers). */
  inWebView: Set<T>;
}

/**
 * Walks an accessibility tree into the snapshot text and the candidates for `kind`. Electron and web views list
 * a control's own label as a separate static_text with actions: as two candidates they would split Jev's
 * confidence between one thing. So text, groups and images inside a candidate are no candidates (a real control
 * inside one, such as a row's button, still is), and an unnamed candidate is described by the text inside it.
 * The context leaves out "in application X" always and "in window X" when the app has one window.
 */
export async function captureTree<T extends AccessibleNode>(root: T, kind: ComputerKind, timeout: number,
  { spatial = false } = {}): Promise<CapturedTree<T>> {
  const candidates: Candidate[] = [];
  const layout: LayoutItem[] = [];
  const elements = new Map<number, T>();
  const inWebView = new Set<T>();
  const lines: string[] = [];
  let chars = 0;
  let visited = 0;
  let truncated = false;
  const deadline = Date.now() + timeout;
  const windowCount = root.role === 'application' ? (await root.children()).filter((child) => child.role === 'window').length : 0;
  const outOfBudget = () => visited >= MAX_NODES || chars >= MAX_TREE_CHARS || Date.now() >= deadline;

  /** Returns the visible text of the subtree (capped), so an unnamed candidate can be described by it. */
  const walk = async (el: T, depth: number, context: string, inCandidate: boolean, inWeb = false): Promise<string> => {
    if (++visited > MAX_NODES || chars >= MAX_TREE_CHARS || Date.now() >= deadline) {
      truncated = true;
      return '';
    }
    const state = [!el.enabled && 'disabled', el.checked && `checked=${el.checked}`, el.selected && 'selected', el.focused && 'focused']
      .filter(Boolean).join(' ');
    const named = `${el.role} ${JSON.stringify(el.name ?? '')}`;
    const flags = state ? ` [${state}]` : '';
    const desc = `${named}${el.value === null ? '' : ` value=${JSON.stringify(el.value)}`}${flags}`;
    const shortDesc = el.value !== null && el.value.length > VALUE_CHARS
      ? `${named} value=${JSON.stringify(`${el.value.slice(0, VALUE_CHARS)}…`)}${flags}`
      : desc;
    const line = `${'  '.repeat(depth)}${desc}\n`;
    lines.push(line.slice(0, MAX_TREE_CHARS - chars));
    chars += line.length;

    const candidate = matchesKind(el, kind) && !(inCandidate && PART_ROLE.test(el.role));
    // One accessibility read, only in a spatial capture and only for a node that is listed.
    const bounds = spatial && el.visible && (candidate || el.name || el.value) ? edges(el.bounds) : undefined;
    // One row past the cap tells nativeLayout() the layout was cut.
    if (bounds && (el.name || el.value) && layout.length <= MAX_LAYOUT_ELEMENTS) {
      layout.push({ description: shortDesc, name: named, bounds });
    }
    let id: number | undefined;
    if (candidate) {
      if (candidates.length < MAX_CANDIDATES) {
        id = candidates.length;
        candidates.push({ id, desc: `${shortDesc}${context ? ` in ${context}` : ''}`, ...(bounds ? { bounds } : {}) });
        elements.set(id, el);
        if (inWeb) inWebView.add(el);
      } else {
        truncated = true;
      }
    }
    let text = TEXT_ROLE.test(el.role) ? String(el.value || el.name || '') : '';
    if (depth >= MAX_DEPTH) {
      truncated = true;
      return text;
    }

    const children = (await el.children()) as T[];
    // Modal and dialog contents win the cap over app menus and background content.
    children.sort((a, b) => Number(b.modal || b.role === 'dialog') - Number(a.modal || a.role === 'dialog'));
    const namesContext = el.name && el.role !== 'application' && !(el.role === 'window' && windowCount === 1);
    const childContext = namesContext ? `${el.role} ${JSON.stringify(el.name)}` : context;
    for (const child of children) {
      if (outOfBudget()) {
        truncated = true;
        break;
      }
      const inner = await walk(child, depth + 1, childContext, inCandidate || id !== undefined, inWeb || el.role === 'web_area');
      if (inner && text.length < TEXT_CHARS) text = `${text} ${inner}`.trim().slice(0, TEXT_CHARS);
    }
    // Only a missing name is filled in: some tabs carry their selection ("0"/"1") as their value, not a label.
    if (id !== undefined && !el.name && text && text !== el.value) {
      candidates[id].desc = candidates[id].desc.replace(shortDesc, `${shortDesc} text=${JSON.stringify(text)}`);
    }
    return text;
  };
  await walk(root, 0, '', false);
  const snapshot = { aria: lines.join(''), truncated, ...(spatial ? { layout: nativeLayout(layout, DESKTOP_COORDINATES, truncated) } : {}) };
  return { snapshot, candidates, elements, inWebView };
}

function edges(rect: Element['bounds'] | undefined): Bounds | undefined {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return undefined;
  return { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
}

/** The desktop through xa11y, imported on first use: browser runs and MCP discovery need no native binaries. */
export class Xa11yAdapter implements ComputerAdapter<Element> {
  private app: App | null = null;
  /**
   * Web content ignores the accessibility press on many elements, so those get a real pointer click. Native
   * controls keep press, which needs no focus, unless they do not offer it.
   */
  private webViewElements = new WeakSet<Element>();

  constructor(private timeout = 15000) {}

  private async sdk() {
    try {
      return (await import('@crowecawcaw/xa11y')).default;
    } catch (error) {
      throw new Error(`Desktop backend unavailable. Install @crowecawcaw/xa11y@0.15.0 with optional native packages enabled. ${error}`);
    }
  }

  private attachedApp(): App {
    if (!this.app) throw new Error('call open first');
    return this.app;
  }

  async apps() {
    const sdk = await this.sdk();
    return (await sdk.App.list()).map(({ name, pid }) => ({ name, pid }));
  }

  async open(target: ComputerTarget, activate: boolean) {
    const sdk = await this.sdk();
    const app = target.pid !== undefined
      ? await sdk.App.byPid(target.pid, { timeout: this.timeout })
      : await sdk.App.byName(target.app!, { timeout: this.timeout });
    if (activate) {
      const windows = await app.windows();
      const window = windows.find((w) => w.active) ?? windows.find((w) => w.modal) ?? windows[0];
      if (!window) throw new Error(`No window to activate for ${app.name}`);
      await window.activate();
    }
    this.app = app;
    return { name: app.name, pid: app.pid };
  }

  async capture(kind: ComputerKind, within?: Element, { spatial = false }: CaptureOptions = {}): Promise<Frame<Element>> {
    const app = this.attachedApp();
    const { inWebView, ...frame } = await captureTree(within ?? app.asElement(), kind, this.timeout, { spatial });
    for (const el of inWebView) this.webViewElements.add(el);
    return { ...frame, snapshot: { url: `desktop://${app.pid ?? encodeURIComponent(app.name)}`, title: app.name, ...frame.snapshot },
      ...(spatial ? { coordinates: DESKTOP_COORDINATES } : {}) };
  }

  /** Input simulation, only while the attached app is still in front. */
  private async foreground() {
    const app = this.attachedApp();
    const sdk = await this.sdk();
    const active = await sdk.App.foreground({ timeout: 0 });
    if (app.pid === null || active.pid !== app.pid) throw new Error(`Desktop focus changed. Open ${app.name} with activate: true before sending input.`);
    return sdk.inputSim();
  }

  async act(kind: ComputerAction, element: Element, value?: string) {
    this.attachedApp(); // closed (a step cut by the spec timeout): never touch the user's app again
    if (kind === 'click' && !this.webViewElements.has(element) && element.actions.includes('press')) return element.press();
    if (kind === 'fill') return element.setValue(value!);
    if (kind === 'check' || kind === 'uncheck') {
      if (element.checked === null) throw new Error('Control does not expose checked state');
      if (element.checked !== (kind === 'check' ? 'on' : 'off')) {
        if (element.checked === 'mixed') throw new Error('Mixed checkbox state cannot be set reliably; use click and verify');
        await element.toggle();
      }
      return;
    }
    const input = await this.foreground();
    if (kind === 'click') return input.click(element);
    if (kind === 'hover') return input.moveTo(element);
    if (kind === 'dblclick') return input.doubleClick(element);
    if (kind === 'rightclick') return input.rightClick(element);
    // A wheel scroll: scrollIntoView does nothing on macOS.
    return input.scroll(element, 0, Number(value ?? 3));
  }

  secret(element: Element) {
    return element.raw.ax_subrole === SECURE_SUBROLE;
  }

  async press(key: string) {
    const parts = key.split('+').map((part) => part.trim());
    if (parts.some((part) => !part)) throw new Error('Use a key or modifier+key, e.g. Control+a');
    const input = await this.foreground();
    const last = parts.pop()!;
    return parts.length ? input.chord(last, parts) : input.press(last);
  }

  async mouse(x: number, y: number) {
    await (await this.foreground()).moveTo([x, y]);
  }

  async drag(source: Element, target: Element) {
    await (await this.foreground()).drag(source, target);
  }

  async screenshot() {
    const sdk = await this.sdk();
    const windows = await this.attachedApp().windows();
    const window = windows.find((w) => w.active) ?? windows[0];
    if (!window) throw new Error('No application window available for screenshot');
    return (await sdk.screenshot({ element: window })).toPng();
  }

  /** Detaches; never quits the user's app. */
  async close() {
    this.app = null;
  }
}
