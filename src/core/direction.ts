/**
 * The directions of a desktop or mobile `scroll: "<direction>: <target>"` step and of a mobile swipe. Each engine
 * declares the directions it supports as a subset of this list, and parses its scroll steps against that subset.
 */
export const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface Scroll<D extends Direction> { direction: D; target: string }

const SCROLL = /^(\w+):\s*(\S[\s\S]*)$/;

/** `value` when it is one of `directions`. */
export const directionIn = <D extends Direction>(value: unknown, directions: readonly D[]): D | undefined =>
  directions.find((known) => known === value);

/** `"down: the results list"` → `{ direction: 'down', target: 'the results list' }`; undefined for another form. */
export function parseScroll<D extends Direction>(text: string, directions: readonly D[]): Scroll<D> | undefined {
  const match = SCROLL.exec(text);
  const direction = directionIn(match?.[1], directions);
  return match && direction ? { direction, target: match[2] } : undefined;
}

/** As `parseScroll`, but a scroll in another form is an error that gives the syntax and `directions`. */
export function requireScroll<D extends Direction>(text: string, directions: readonly D[], engine: string): Scroll<D> {
  const scroll = parseScroll(text, directions);
  if (!scroll) throw new Error(`${engine} scroll syntax: "down: the results list" (directions: ${directions.join(', ')})`);
  return scroll;
}

/** The `scroll` value of a step. */
export const scrollText = ({ direction, target }: Scroll<Direction>) => `${direction}: ${target}`;
