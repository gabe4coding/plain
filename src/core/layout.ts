import { boundsText, type Bounds } from './candidate.js';

export interface LayoutItem { description: string; name: string; bounds: Bounds }

/** The browser and the native layouts list at most this many elements, in at most this many characters. */
export const MAX_LAYOUT_ELEMENTS = 254;
export const MAX_LAYOUT_CHARS = 24_000;
export const LAYOUT_TRUNCATED = 'Layout truncated: do not infer absence or extremes across omitted elements.';

const DIRECTIONS = ['above', 'below', 'left of', 'right of'] as const;

/**
 * Qualitative neighbors expose measured order without asking Jev to infer it from tree order or arithmetic. Only
 * the nearest element per direction with perpendicular overlap is named: the raw bounds stay in the layout for the
 * other relations. `grouped`: one line per element with all its directions, for a judge; a pick reads one line per
 * relation better (a reference target lost confidence on grouped lines).
 */
export function neighborRelations(items: LayoutItem[], grouped = false): string[] {
  const relations = new Set<string>();
  for (const item of items) {
    const nearest: Partial<Record<typeof DIRECTIONS[number], { gap: number; items: LayoutItem[] }>> = {};
    for (const other of items) {
      if (item === other) continue;
      const a = item.bounds;
      const b = other.bounds;
      const horizontal = Math.min(a.right, b.right) > Math.max(a.left, b.left);
      const vertical = Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
      const measured: [keyof typeof nearest, number][] = [];
      if (horizontal && a.bottom <= b.top) measured.push(['above', b.top - a.bottom]);
      if (horizontal && a.top >= b.bottom) measured.push(['below', a.top - b.bottom]);
      if (vertical && a.right <= b.left) measured.push(['left of', b.left - a.right]);
      if (vertical && a.left >= b.right) measured.push(['right of', a.left - b.right]);
      for (const [direction, gap] of measured) {
        const known = nearest[direction];
        if (!known || gap < known.gap) nearest[direction] = { gap, items: [other] };
        else if (gap === known.gap) known.items.push(other);
      }
    }
    if (grouped) {
      const parts = DIRECTIONS.filter((direction) => nearest[direction])
        .map((direction) => `${direction} ${[...new Set(nearest[direction]!.items.map((other) => other.name))].join(' and ')}`);
      if (parts.length) relations.add(`${item.name} is ${parts.join('; is ')}.`);
      continue;
    }
    for (const [direction, found] of Object.entries(nearest)) {
      for (const other of found.items) relations.add(`${item.name} is ${direction} ${other.name}.`);
    }
  }
  return [...relations];
}

/** Joins lines up to MAX_LAYOUT_CHARS; a cut ends with the truncation line. */
export function joinLayout(lines: string[]): string {
  let text = '';
  for (const line of lines) {
    if (text.length + line.length > MAX_LAYOUT_CHARS) return `${text}\n${LAYOUT_TRUNCATED}`;
    text += `${text ? '\n' : ''}${line}`;
  }
  return text;
}

/**
 * The layout of a desktop or mobile capture: accessibility rows with their bounds and the measured neighbors.
 * `coordinates` names the platform's coordinate space.
 */
export function nativeLayout(items: LayoutItem[], coordinates: string, truncated: boolean): string {
  const listed = items.slice(0, MAX_LAYOUT_ELEMENTS);
  const neighbors = neighborRelations(listed);
  return joinLayout([
    `Rendered bounds in ${coordinates}: x increases right, y increases down.`,
    'Use bounds for spatial claims. Tree order is not visual order. Missing required geometry is insufficient evidence.',
    'Each row is an accessibility element: its role, its name in quotes and its current value. A claimed name or value and its spatial relation must all match the same elements.',
    ...listed.map((item) => `${item.description} bounds=${boundsText(item.bounds)}`),
    ...(neighbors.length ? ['Measured neighbors (nearest with perpendicular overlap; other relations still use bounds):', ...neighbors] : []),
    ...(truncated || items.length > listed.length ? [LAYOUT_TRUNCATED] : []),
  ]);
}

/** Edges this close count as touching, and gaps this close as equal: a bound moves by a point between renders. */
const TOLERANCE = 4;
type Direction = 'above' | 'below' | 'left of' | 'right of';

/**
 * What a recorded spatial target or claim depends on (src/core/lock.ts): for each element of a layout, its nearest
 * neighbor in each direction ("A is above B"), measured from the bounds with TOLERANCE, without the bounds. A
 * scroll or a one-point move changes nothing; a swap or a moved reference changes a relation. Names lose their
 * value and state (typed text, `[checked]`). `subject`: only the lines about that element, so a clock elsewhere on
 * the screen changes nothing.
 */
export function layoutRelations(layout: string, subject?: string): string {
  const items: { name: string; bounds: Bounds }[] = [];
  for (const line of layout.split('\n')) {
    const at = line.lastIndexOf(' bounds=');
    if (at < 0) continue;
    try {
      const bounds = JSON.parse(line.slice(at + ' bounds='.length)) as Bounds;
      items.push({ name: line.slice(0, at).replace(/ value="(?:[^"\\]|\\.)*"/g, '').replace(/ \[[^\]]*\]/g, '').trim(), bounds });
    } catch {
      // a cut line at the end of a truncated layout
    }
  }
  const relations = new Set<string>();
  for (const item of items) {
    const nearest: Partial<Record<Direction, { gap: number; names: { name: string; gap: number }[] }>> = {};
    for (const other of items) {
      if (item === other) continue;
      const a = item.bounds;
      const b = other.bounds;
      const horizontal = Math.min(a.right, b.right) - Math.max(a.left, b.left) > TOLERANCE;
      const vertical = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > TOLERANCE;
      const measured: [Direction, number][] = [];
      if (horizontal && a.bottom <= b.top + TOLERANCE) measured.push(['above', Math.max(0, b.top - a.bottom)]);
      if (horizontal && a.top >= b.bottom - TOLERANCE) measured.push(['below', Math.max(0, a.top - b.bottom)]);
      if (vertical && a.right <= b.left + TOLERANCE) measured.push(['left of', Math.max(0, b.left - a.right)]);
      if (vertical && a.left >= b.right - TOLERANCE) measured.push(['right of', Math.max(0, a.left - b.right)]);
      for (const [direction, gap] of measured) {
        const known = (nearest[direction] ??= { gap, names: [] });
        known.gap = Math.min(known.gap, gap);
        known.names.push({ name: other.name, gap });
      }
    }
    for (const [direction, found] of Object.entries(nearest)) {
      for (const other of found.names) if (other.gap <= found.gap + TOLERANCE) relations.add(`${item.name} is ${direction} ${other.name}.`);
    }
  }
  const about = (line: string) => subject === undefined || line.startsWith(`${subject} is `) || line.endsWith(` ${subject}.`);
  return [...relations].filter(about).sort().join('\n');
}
