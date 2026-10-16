import { z } from 'zod';
import { ask, isTooLong, MAX_CHOICE_OPTIONS } from '../jev/ask.js';
import { decide } from '../jev/decide.js';
import { describeSnapshot } from '../jev/describe.js';
import { judge } from '../jev/judge.js';
import { pickElements } from '../jev/pick.js';
import type { Candidate } from './candidate.js';
import { dumpDebug, topGuesses } from './results.js';

// What every engine (browser, desktop, mobile) shows Jev. Element handles stay inside the adapters.

/** At most four parallel requests per pick. Candidates are ordered so that a cut drops nav and footer links first. */
export const MAX_CANDIDATES = MAX_CHOICE_OPTIONS * 4;

export const SnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  aria: z.string(),
  truncated: z.boolean(),
  /** The tree of one region (`within`), not of the whole page. */
  region: z.boolean().optional(),
  /** Read-only rendered geometry, requested for spatial claims. */
  layout: z.string().optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** One native capture: what Jev sees, plus the adapter's handle for each candidate id. */
export interface Frame<T> {
  snapshot: Snapshot;
  candidates: Candidate[];
  elements: Map<number, T>;
  /** A cheaper capture that may also list covered elements (iOS): a pick from it is checked before acting. */
  approximate?: boolean;
  /** The coordinate space of candidate bounds and the layout, in a spatial capture. */
  coordinates?: string;
}

/** A pick from an approximate frame is covered or off screen: the caller picks again from an exact capture. */
export class HiddenTargetError extends Error {
  constructor(what = 'Mobile control') {
    super(`${what} is not visible (covered or off screen)`);
    this.name = 'HiddenTargetError';
  }
}

export interface TargetAdapter<T> {
  candidates: Candidate[];
  state: { url: string; title: string; goal?: string; layout?: string; coordinates?: string };
  element(candidate: Candidate): T;
}

export interface ResolvedTarget<T> {
  element: T | null;
  detail: string;
  tokens: number;
  usedJev: boolean;
  confidence?: number;
  /** What acceptance used: the confidence when the provider returned one, else the probability. */
  score?: number;
  approximate?: boolean;
  /** The accepted candidate, for the caller to record in the lock (src/core/lock.ts). */
  candidate?: Candidate;
}

/** The model calls, injectable so tests run without a key. */
export type Intelligence = { pick: typeof pickElements; judge: typeof judge; describe?: typeof describeSnapshot; ask?: typeof ask };
export const intelligence: Intelligence = { pick: pickElements, judge, describe: describeSnapshot, ask };

/** Resolves each target to an element, all in one Jev request. */
export async function resolveTargets<T>(adapter: TargetAdapter<T>, targets: string[], ai = intelligence): Promise<ResolvedTarget<T>[]> {
  if (!adapter.candidates.length) return targets.map(() => ({ element: null, detail: 'no candidates', tokens: 0, usedJev: false }));
  const picks = await ai.pick(adapter.candidates, targets, adapter.state);
  return targets.map((target, i) => {
    const isFirstPick = i === 0;
    const pick = picks[i];
    if (!pick) throw new Error('Jev returned fewer picks than targets');
    const { id, probability, confidence, probabilities, tokens } = pick;
    const candidate = adapter.candidates.find((c) => c.id === id);
    const confidenceText = confidence === undefined ? '' : ` c=${confidence.toFixed(2)}`;
    const base = { tokens, usedJev: isFirstPick, confidence, score: confidence ?? probability };
    if (candidate && decide(confidence ?? probability, 'pick') === 'pass') {
      return { ...base, element: adapter.element(candidate), candidate,
        detail: `→ ${candidate.desc} (p=${probability.toFixed(2)}${confidenceText})` };
    }
    const file = dumpDebug('pick', { instruction: target, probabilities, confidence, candidates: adapter.candidates });
    const reason = id === null ? 'no matching element' : 'low confidence or invalid candidate';
    return { ...base, element: null,
      detail: `${reason}${confidenceText} — top: ${topGuesses(probabilities, adapter.candidates)} — candidates: ${file}` };
  });
}

/**
 * Asks Jev about an early observation while the settled one is still being taken, instead of settle →
 * observe → ask. The early answer is kept only when the settled observation is the same; otherwise the
 * settled one is asked, and the early answer is still awaited so `discard` can count its tokens.
 * `early` resolving to null (or throwing) means no early look. `skip`: no question is needed for this
 * observation; the result is then null. The browser has its own variant (settledAsk in src/browser/settled-ask.ts).
 */
export async function askSettled<F, R>(options: {
  early?: () => Promise<F | null>;
  settled: () => Promise<F>;
  same: (a: F, b: F) => boolean;
  ask: (frame: F) => Promise<R>;
  discard: (result: R) => void;
  skip?: (frame: F) => boolean;
  /** Wraps the wait for an answer, for phase timing. */
  waitAnswer?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<{ frame: F; result: R | null; reasked: boolean }> {
  const { early, settled, same, discard, skip } = options;
  const waitAnswer = options.waitAnswer ?? (<T>(fn: () => Promise<T>) => fn());
  const earlyFrame = early ? await early().catch(() => null) : null;
  const earlyAnswer = earlyFrame !== null && !skip?.(earlyFrame) ? options.ask(earlyFrame) : null;
  earlyAnswer?.catch(() => {}); // its error surfaces below, only if this answer is used
  const frame = await settled();
  if (earlyAnswer && same(earlyFrame!, frame)) return { frame, result: await waitAnswer(() => earlyAnswer), reasked: false };

  const discarded = earlyAnswer?.then(discard, () => {});
  const reasked = earlyAnswer !== null;
  if (skip?.(frame)) {
    await discarded;
    return { frame, result: null, reasked };
  }
  const [result] = await waitAnswer(() => Promise.all([options.ask(frame), discarded]));
  return { frame, result, reasked };
}

const MIN_ARIA_TO_HALVE = 4000;
/** Sent with every layout: names, values, visibility and relations must all hold for the same elements. */
const SPATIAL_CLAIM_RULES = 'A spatial claim requires all its named text, current values, displayed selections, visibility and spatial relations to hold for the same elements. If any named text, value or selection differs, or required visible text belongs to an invisible element, the entire claim is false. A correct spatial relation alone does not make a claim with a mismatched name or value true. An available unselected option in the accessibility tree is not displayed by a collapsed select. Read the rendered evidence for physical position and visibility.';

/**
 * Judges claims against a snapshot. A state over the token limit is cut in half until it fits. A region goes
 * without the page URL: with it, Jev doubts a claim that a short region tree plainly shows. Without the title
 * too, it doubts claims phrased in the page's terms (docs/benchmarks/claims.md).
 */
export async function judgeState(snap: Snapshot, claims: string[], events: string[] = [], ai = intelligence) {
  let aria = snap.aria;
  const page = snap.region ? { title: snap.title } : { url: snap.url, title: snap.title };
  for (;;) {
    try {
      const result = await ai.judge({ ...page, aria, events,
        ...(snap.layout ? { layout: snap.layout, layoutRules: SPATIAL_CLAIM_RULES } : {}) }, claims);
      if (result.probabilities.length !== claims.length) throw new Error('Jev returned fewer judgments than claims');
      return result;
    } catch (error) {
      if (!isTooLong(error) || aria.length < MIN_ARIA_TO_HALVE) throw error;
      aria = aria.slice(0, Math.floor(aria.length / 2));
      console.error(`plain: state too long for the model, aria cut to ${aria.length} chars — scope the expect with \`within\` for precision`);
    }
  }
}
