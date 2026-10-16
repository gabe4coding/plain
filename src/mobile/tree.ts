import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { MAX_CANDIDATES, type Frame } from '../core/automation.js';
import type { Bounds, Candidate } from '../core/candidate.js';
import { MAX_LAYOUT_ELEMENTS, nativeLayout, type LayoutItem } from '../core/layout.js';

export type MobileKind = 'click' | 'fill' | 'check' | 'region' | 'scroll';

export interface MobileNode {
  path: string;
  /** iOS class chain from the application (type and index among same-type siblings); '' elsewhere. */
  chain?: string;
  attrs: Record<string, string>;
  role: string;
  name: string;
  visible: boolean;
  enabled: boolean;
  children: MobileNode[];
}

export interface MobileElement {
  path: string;
  identity: string;
  generation: number;
  /** Picked from a capture without XCUITest's `visible`: its visibility is still unconfirmed. */
  approximate?: boolean;
  /** iOS: a class chain lookup is quicker than an XPath one. */
  chain?: string;
  /** A secure text field (iOS XCUIElementTypeSecureTextField, Android password="true"). */
  secret?: true;
}

const MAX_SOURCE_CHARS = 5_000_000;
const MAX_NODES = 5000;
const MAX_DEPTH = 32;
const MAX_TREE_CHARS = 60000;
const MAX_INNER_NAME = 500;
const IOS_TYPE = 'XCUIElementType';
/** Containers whose content can lie outside their own frame (scrolled away), a web view's page too. */
const CLIPPING_ROLE = /ScrollView|Table|CollectionView|WebView|Window|Application/;
const CHECKABLE_ROLE = /Switch|CheckBox|Checkbox|ToggleButton/;

type Box = { left: number; top: number; right: number; bottom: number };
type XmlItem = Record<string, unknown>;

const IDENTITY_ATTRIBUTES = ['resource-id', 'name', 'label', 'content-desc', 'text'];

/** The identity a target is checked against before acting: labels and native ids, not values or checked state. */
export function nodeIdentity(node: MobileNode): string {
  return JSON.stringify([node.role, node.name, ...IDENTITY_ATTRIBUTES.map((key) => node.attrs[key] ?? '')]);
}

/** The parts of nodeIdentity() an iOS lookup can check: `nativeName` is the element's own `name` attribute. */
export function parseIdentity(identity: string): { role: string; name: string; nativeName: string; label: string } {
  const [role, name, , nativeName, label] = JSON.parse(identity) as string[];
  return { role, name, nativeName, label };
}

const isPassword = (attrs: Record<string, string>, role: string) => attrs.password === 'true' || /SecureTextField/.test(role);

function ownName(attrs: Record<string, string>, role: string): string {
  if (isPassword(attrs, role)) return attrs['content-desc'] || attrs.label || 'password';
  return attrs['content-desc'] || attrs.label || attrs.text || attrs.name || '';
}

function intersection(a: Box, b: Box): Box {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}

const overlaps = (box: Box, clip: Box) => box.left < clip.right && box.right > clip.left && box.top < clip.bottom && box.bottom > clip.top;

/**
 * Parses an XCUITest or UiAutomator2 page source. `boundsVisibility`: for an iOS source read without the costly
 * `visible` attribute, a node counts as visible when its frame has an area inside the window and every scrolling
 * ancestor. That keeps every node XCUITest reports visible, but also covered ones (content under a sheet), so it
 * is only for picking targets whose visibility is confirmed before acting.
 */
export function parseMobileTree(xml: string, { boundsVisibility = false } = {}): { roots: MobileNode[]; truncated: boolean } {
  if (xml.length > MAX_SOURCE_CHARS) throw new Error('Mobile UI source exceeds 5 MB');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD/entity declarations are not supported in mobile UI source');
  if (XMLValidator.validate(xml) !== true) throw new Error('Appium returned invalid XML UI source');
  const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '',
    parseAttributeValue: false, parseTagValue: false, ignoreDeclaration: true }).parse(xml) as XmlItem[];
  let count = 0;
  let truncated = false;

  function walk(items: XmlItem[], path: string, depth: number, parentVisible: boolean, parentEnabled: boolean,
    clip?: Box, chain?: string): MobileNode[] {
    const nodes: MobileNode[] = [];
    let ordinal = 0;
    const sameTypeCount = new Map<string, number>();
    for (const item of items) {
      const tag = Object.keys(item).find((key) => key !== ':@' && !key.startsWith('#') && !key.startsWith('?'));
      if (!tag) continue;
      ordinal++;
      if (count >= MAX_NODES || depth > MAX_DEPTH) {
        truncated = true;
        break;
      }
      count++;
      const attrs = (item[':@'] ?? {}) as Record<string, string>;
      const role = attrs.type ?? attrs.class ?? tag;

      let box: Box | undefined;
      let childClip = clip;
      if (boundsVisibility && attrs.visible === undefined && attrs.x !== undefined) {
        box = { left: +attrs.x, top: +attrs.y, right: +attrs.x + +attrs.width, bottom: +attrs.y + +attrs.height };
        if (CLIPPING_ROLE.test(role)) childClip = clip ? intersection(clip, box) : box;
      }
      const nativeVisible = attrs.visible !== 'false' && attrs.displayed !== 'false';
      // XCUITest can mark a layout container invisible while its controls are visible: an iOS node's own flag
      // wins. Android visibility is inherited.
      const visible = box ? box.right > box.left && box.bottom > box.top && (!clip || overlaps(box, clip))
        : role.startsWith(IOS_TYPE) && attrs.visible !== undefined ? nativeVisible
          : parentVisible && nativeVisible;

      const typeIndex = (sameTypeCount.get(role) ?? 0) + 1;
      sameTypeCount.set(role, typeIndex);
      // The application (depth 0) is the chain's root; below it, iOS types only.
      const nodeChain = chain === undefined ? '' : role.startsWith(IOS_TYPE) ? `${chain}${chain ? '/' : ''}${role}[${typeIndex}]` : '';
      const node: MobileNode = {
        path: `${path}/*[${ordinal}]`,
        chain: nodeChain,
        attrs,
        role,
        name: ownName(attrs, role),
        visible,
        enabled: parentEnabled && attrs.enabled !== 'false',
        children: [],
      };
      const childChain = depth === 0 && role === `${IOS_TYPE}Application` ? '' : nodeChain || undefined;
      node.children = walk(item[tag] as XmlItem[], node.path, depth + 1, node.visible, node.enabled, childClip, childChain);
      // React Native often puts the text inside an otherwise unnamed pressable container.
      if (!node.name) {
        node.name = node.children.filter((child) => child.visible).map((child) => child.name).filter(Boolean).join(' ').slice(0, MAX_INNER_NAME);
      }
      nodes.push(node);
    }
    return nodes;
  }

  // XCUITest wraps the source in AppiumAUT, but its XPath lookup is rooted at the application: drop the wrapper so
  // paths address real nodes.
  const source = parsed.length === 1 && Array.isArray(parsed[0].AppiumAUT) ? parsed[0].AppiumAUT as XmlItem[] : parsed;
  return { roots: walk(source, '', 0, true, true), truncated };
}

export function findMobileNode(roots: MobileNode[], path: string): MobileNode | undefined {
  for (const node of roots) {
    if (node.path === path) return node;
    if (path.startsWith(node.path + '/')) {
      const found = findMobileNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

function mobileMatches(node: MobileNode, kind: MobileKind): boolean {
  if (!node.visible) return false;
  if (kind === 'region') return true;
  if (!node.enabled) return false;
  const { attrs, role } = node;
  if (kind === 'fill') return attrs.editable === 'true' || /EditText|AutoCompleteTextView|XCUIElementType(SecureTextField|TextField|TextView|SearchField|PickerWheel)/.test(role);
  if (kind === 'check') return isCheckable(node);
  if (kind === 'scroll') return attrs.scrollable === 'true' || /ScrollView|ListView|RecyclerView|Table|CollectionView|WebView/.test(role);
  return attrs.clickable === 'true' || attrs['long-clickable'] === 'true' || attrs.focusable === 'true' ||
    /Button|Link|Cell|TextField|TextView|EditText|Switch|CheckBox|Checkbox|Image|StaticText/.test(role) ||
    (attrs.accessible === 'true' && !!node.name);
}

/**
 * Jetpack Compose marks a clickable view's role with an unnamed, non-clickable child of the same bounds. It is the
 * same control, and listing both splits Jev's pick between them, so the marker is no candidate; its parent is.
 */
function isRoleMarker(node: MobileNode, parent?: MobileNode): boolean {
  const attrs = node.attrs;
  return !!parent && parent.attrs.clickable === 'true' && attrs.clickable === 'false' && attrs['long-clickable'] !== 'true' &&
    !attrs.text && !attrs['content-desc'] && attrs.bounds !== undefined && attrs.bounds === parent.attrs.bounds;
}

const isCheckable = (node: MobileNode) => node.attrs.checkable === 'true' || CHECKABLE_ROLE.test(node.role);

/** The value Jev sees: none for a password field. */
function shownValue(node: MobileNode): string | undefined {
  if (isPassword(node.attrs, node.role)) return undefined;
  return node.attrs.value ?? (mobileMatches(node, 'fill') ? node.attrs.text : undefined);
}

function describeNode(node: MobileNode): string {
  const attrs = node.attrs;
  const password = isPassword(attrs, node.role);
  const nativeValue = shownValue(node);
  const value = nativeValue !== undefined ? ` value=${JSON.stringify(nativeValue)}` : '';
  const checkable = isCheckable(node);
  const flags = [
    !node.enabled && 'disabled',
    checkable && attrs.checked !== undefined && `checked=${attrs.checked}`,
    attrs.selected === 'true' && 'selected',
    password && 'password',
  ].filter(Boolean).join(' ');
  const name = password ? attrs.label || attrs['content-desc'] || 'password' : node.name;
  return `${node.role} ${JSON.stringify(name)}${value}${flags ? ` [${flags}]` : ''}`;
}

/** A node's frame: Android `bounds="[l,t][r,b]"`, iOS `x`, `y`, `width`, `height`. Undefined without an area. */
export function nodeBounds(attrs: Record<string, string>): Bounds | undefined {
  const android = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attrs.bounds ?? '');
  const box = android ? { left: +android[1], top: +android[2], right: +android[3], bottom: +android[4] }
    : attrs.x !== undefined && attrs.width !== undefined
      ? { left: +attrs.x, top: +attrs.y, right: +attrs.x + +attrs.width, bottom: +attrs.y + +attrs.height } : undefined;
  return box && Object.values(box).every(Number.isFinite) && box.right > box.left && box.bottom > box.top ? box : undefined;
}

/**
 * The snapshot text and the candidates for `kind`. `containersOnly`: region candidates are nodes with children.
 * `coordinates`: a spatial capture in that coordinate space, with candidate bounds and a layout.
 */
export function mobileFrame(roots: MobileNode[], kind: MobileKind, state: { url: string; title: string }, generation: number, truncated = false,
  { containersOnly = false, coordinates }: { containersOnly?: boolean; coordinates?: string } = {}): Frame<MobileElement> {
  const candidates: Candidate[] = [];
  const layout: LayoutItem[] = [];
  const elements = new Map<number, MobileElement>();
  const lines: string[] = [];
  let chars = 0;
  function walk(nodes: MobileNode[], depth: number, context: string, parent?: MobileNode) {
    for (const node of nodes) {
      if (!node.visible) {
        // A hidden node stays out, but its children are looked at: an iOS child's own visible=true holds.
        walk(node.children, depth, context, parent);
        continue;
      }
      if (chars >= MAX_TREE_CHARS) {
        truncated = true;
        return;
      }
      const desc = describeNode(node);
      const line = `${'  '.repeat(depth)}${desc}\n`;
      if (chars + line.length > MAX_TREE_CHARS) truncated = true;
      lines.push(line.slice(0, MAX_TREE_CHARS - chars));
      chars += line.length;
      const bounds = coordinates ? nodeBounds(node.attrs) : undefined;
      // One row past the cap tells nativeLayout() the layout was cut.
      if (bounds && (node.name || shownValue(node) !== undefined) && layout.length <= MAX_LAYOUT_ELEMENTS) {
        layout.push({ description: desc, name: `${node.role} ${JSON.stringify(node.name)}`, bounds });
      }
      if (mobileMatches(node, kind) && !(containersOnly && !node.children.length) && !isRoleMarker(node, parent)) {
        if (candidates.length >= MAX_CANDIDATES) {
          truncated = true;
        } else {
          const id = candidates.length;
          candidates.push({ id, desc: `${desc}${context ? ` in ${context}` : ''}`, ...(bounds ? { bounds } : {}) });
          elements.set(id, { path: node.path, identity: nodeIdentity(node), generation, ...(node.chain ? { chain: node.chain } : {}),
            ...(isPassword(node.attrs, node.role) ? { secret: true as const } : {}) });
        }
      }
      walk(node.children, depth + 1, node.name ? `${node.role} ${JSON.stringify(node.name)}` : context, node);
    }
  }
  walk(roots, 0, '');
  if (!coordinates) return { snapshot: { ...state, aria: lines.join(''), truncated }, candidates, elements };
  return { snapshot: { ...state, aria: lines.join(''), truncated, layout: nativeLayout(layout, coordinates, truncated) }, candidates, elements, coordinates };
}
