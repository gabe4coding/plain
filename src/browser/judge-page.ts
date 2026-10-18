import type { Locator } from 'playwright';
import { intelligence, judgeState, type Snapshot } from '../core/automation.js';
import { capturePage, captureRegion } from './page.js';
import { settledAsk } from './settled-ask.js';
import { resolveOne } from './locate.js';
import { timed, type StepContext } from './context.js';
import { needsLayout, prepareEvidence } from './evidence.js';
import { StepKind } from '../core/step-kind.js';
import { layoutSnapshot } from './layout.js';
import { sha256 } from '../core/lock.js';
import { parameterize, type RunValues } from '../core/parameters.js';
import { layoutRelations } from '../core/layout.js';

/**
 * What a judgment is about: the snapshot plus the events (downloads, console errors, dialogs) as they were when
 * it was taken. An event that lands while the page settles makes it a different state.
 */
export interface Observed { snap: Snapshot; events: string[]; /** Uncut tree when the capture kept one. Absent from `snap`. */ fullAria?: string }

/** `spatial`: the observation carried rendered geometry, as the lock must record. */
interface Judged { state: Observed; probabilities: number[] | null; spatial: boolean; longContext?: boolean }

/**
 * Answers an earlier expect's request gave for the claims of the expects right after it (lookahead), with the exact
 * observation they are about. A later expect uses them only when its own settled observation is the same: then Jev
 * would get the same input, so the request is skipped. Otherwise it asks as usual.
 */
interface Prefetched { observed: Observed; spatial: boolean; probabilities: Map<string, number>; longContext?: boolean }
const prefetched = new WeakMap<StepContext, Prefetched>();
type Judgment = { probabilities: number[]; tokens: number; requests?: number; longContext?: boolean; reused?: boolean };

const sameObserved = (a: Observed, b: Observed): boolean =>
  a.snap.url === b.snap.url && a.snap.title === b.snap.title && a.snap.aria === b.snap.aria && a.snap.layout === b.snap.layout &&
  a.fullAria === b.fullAria &&
  a.events.length === b.events.length && a.events.every((event, i) => event === b.events[i]);

/**
 * Judges claims against the whole settled page, in one request; null probabilities when `skip` says so. `ahead`:
 * claims of later expects, asked in the same request for them to reuse.
 */
export async function judgeSettled(ctx: StepContext, claims: string[], skip?: (observed: Observed) => boolean,
  ahead: string[] = []): Promise<Judged> {
  const spatial = await needsLayout(ctx, claims);
  return judgeObservation(ctx, claims, spatial, undefined, skip, ahead);
}

/** The claims of the whole-page expects right after this one that share its route, for one request with it. */
async function claimsAhead(ctx: StepContext, claims: string[]): Promise<string[]> {
  const ahead: string[] = [];
  const spatial = await needsLayout(ctx, claims);
  for (const step of ctx.upcoming ?? []) {
    if (step.kind !== StepKind.expect || step.within !== undefined) break;
    if (await needsLayout(ctx, step.expectations) !== spatial) break;
    ahead.push(...step.expectations.filter((claim) => !claims.includes(claim) && !ahead.includes(claim)));
  }
  return ahead;
}

function reuse(ctx: StepContext, observed: Observed, claims: string[], spatial: boolean): Judgment | null {
  const known = prefetched.get(ctx);
  if (!known || known.spatial !== spatial || !sameObserved(known.observed, observed)) return null;
  if (!claims.every((claim) => known.probabilities.has(claim))) return null;
  return { probabilities: claims.map((claim) => known.probabilities.get(claim)!), tokens: 0, longContext: known.longContext, reused: true };
}

/** What a judgment sees: the page or the region, its compact geometry when spatial, and the events so far. */
export async function observe(ctx: StepContext, spatial: boolean, within?: Locator): Promise<Observed> {
  const captured = await timed(ctx, 'snapshot', async () => {
    const page = ctx.page;
    const shot = await (within ? captureRegion(page, within) : capturePage(page));
    const snap = spatial ? { ...shot.snap, layout: await layoutSnapshot(page, within, { compact: true }) } : shot.snap;
    return { snap, fullAria: shot.fullAria };
  });
  return { ...captured, events: [...ctx.events] };
}

/**
 * The recorded form of a judged state (src/core/lock.ts): a hash, so no page text lands in the lock. Without the
 * origin and the query, and without where a download was saved (a fresh temp folder per run): a lock recorded on
 * one host or port replays on another. A spatial claim keeps the layout's relations, not its bounds: a bound moves
 * by a point between two renders of the same screen. The run's values are placeholders in it: a page that shows this
 * run's title where the recorded run showed its own is the same state.
 */
export function stateHash({ snap, events, fullAria }: Observed, parameters: RunValues = []): string {
  const generic = (text: string) => parameterize(text, parameters);
  // The uncut tree, so a record and a no-judge replay hash the same text. Replay cannot tell which one was stored.
  const aria = fullAria ?? snap.aria;
  return sha256(JSON.stringify([generic(pathOf(snap.url)), generic(snap.title), generic(aria),
    snap.layout === undefined ? null : generic(layoutRelations(snap.layout)), events.map((event) => generic(event.replace(SAVED_TO, '$1')))]));
}

const SAVED_TO = /^(download: .*?) saved to .*$/s;

/** Decoded, so a run value in the path (`/events/Plain%205678`) becomes its placeholder too. */
function pathOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return url;
  }
}

async function judgeObservation(ctx: StepContext, claims: string[], spatial: boolean, within?: Locator,
  skip?: (observed: Observed) => boolean, ahead: string[] = []): Promise<Judged> {
  // The settle re-check keeps the cut tree: a second long-context call repeats the whole uncut page.
  let spentLongContext = false;
  const { state, result } = await settledAsk(ctx, {
    // A scoped region can live in a shadow root, outside the main document's mutation observer.
    reobserve: spatial || within !== undefined,
    observe: () => observe(ctx, spatial, within),
    same: sameObserved,
    ask: async (observed): Promise<Judgment> => {
      const known = within ? null : reuse(ctx, observed, claims, spatial);
      if (known) return known;
      const asked = [...claims, ...ahead];
      const fullAria = spentLongContext ? undefined : observed.fullAria;
      if (fullAria && observed.snap.truncated && fullAria.length > observed.snap.aria.length) spentLongContext = true;
      const result = await judgeState(observed.snap, asked, observed.events, intelligence, { fullAria });
      if (ahead.length) prefetched.set(ctx, {
        observed, spatial, longContext: result.longContext,
        probabilities: new Map(asked.map((claim, i) => [claim, result.probabilities[i]])),
      });
      return {
        probabilities: result.probabilities.slice(0, claims.length), tokens: result.tokens,
        requests: result.requests, longContext: result.longContext,
      };
    },
    discard: (unused) => account(ctx, unused),
    skip,
  });
  if (result) account(ctx, result);
  return { state, probabilities: result?.probabilities ?? null, spatial, longContext: result?.longContext };
}

/** One `track` per model request. A long-context retry is a second request with no extra tokens of its own. */
function account(ctx: StepContext, judgment: Judgment): void {
  if (judgment.reused) return;
  ctx.track(judgment.tokens);
  for (let extra = 1; extra < (judgment.requests ?? 1); extra++) ctx.track(0);
}

/** Judges one claim against a region only; null probabilities when `skip` says so. */
export async function judgeRegion(ctx: StepContext, region: Locator, claim: string, skip: (observed: Observed) => boolean): Promise<Judged> {
  const spatial = await needsLayout(ctx, [claim]);
  return judgeObservation(ctx, [claim], spatial, region, skip);
}

type ClaimsJudgment = { snap: Snapshot; probabilities: number[]; state: Observed; spatial: boolean; longContext?: boolean } | { detail: string };

/** One judgment of the claims, against the page or the region `within` names (`detail` when Jev finds no region). */
export async function judgeClaims(ctx: StepContext, claims: string[], within?: string): Promise<ClaimsJudgment> {
  // The claims and the region are queued together, so one request routes both (MCP `ask` is not a step).
  prepareEvidence(ctx, [{ kind: StepKind.expect, expectations: claims, within }]);
  if (within) {
    const region = await resolveOne(ctx, 'region', within);
    if (!region.element) return { detail: region.detail };
    const spatial = await needsLayout(ctx, claims);
    const { state, probabilities, longContext } = await judgeObservation(ctx, claims, spatial, region.element!);
    return { snap: state.snap, probabilities: probabilities!, state, spatial, longContext };
  }
  // Settled, because a client-side route change reaches `load` at once and the claim is about the content.
  const judged = await judgeSettled(ctx, claims, undefined, await claimsAhead(ctx, claims));
  return { snap: judged.state.snap, probabilities: judged.probabilities!, state: judged.state, spatial: judged.spatial, longContext: judged.longContext };
}

/** The MCP `ask` tool: one judgment, like expect, but not a step: no status, not recorded. */
export async function askPage(ctx: StepContext, claims: string[], within?: string) {
  ctx.ms = {};
  const judged = await judgeClaims(ctx, claims, within);
  return 'detail' in judged ? { ...judged, ms: ctx.ms } : { snap: judged.snap, probabilities: judged.probabilities, ms: ctx.ms };
}
