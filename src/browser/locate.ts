import type { Locator, Page } from 'playwright';
import { StepKind } from '../core/step-kind.js';
import { MAX_CANDIDATES, resolveTargets, type ResolvedTarget } from '../core/automation.js';
import type { Candidate } from '../core/candidate.js';
import { isTargetEntry, RECORD_AT, recordedStateNote, saveRecordedState, sha256, targetSlot, type LockRef, type TargetEntry } from '../core/lock.js';
import { dumpDebug } from '../core/results.js';
import { fill, mapStrings, parameterize, type RunValues } from '../core/parameters.js';
import { layoutRelations } from '../core/layout.js';
import { candidates, elementById, type CandidateKind } from './candidates.js';
import { settledAsk } from './settled-ask.js';
import { needsLayout } from './evidence.js';
import { layoutSnapshot, spatialCandidates } from './layout.js';
import { sleep, timed, type StepContext } from './context.js';
import { waitHold } from './activity.js';
import { actionError } from './action-error.js';
import { recordLocator, shapeOf, toLocator, type RecordedLocator } from './record-locator.js';

/** How long a step waits for a page with no candidates yet (still redirecting after `open`) to show some. */
const APPEAR_MS = 2000;
const APPEAR_POLL_MS = 150;

/** What to try instead when a step kind finds nothing at all to choose from. */
const NO_CANDIDATES_HINT: Partial<Record<CandidateKind, string>> = {
  [StepKind.check]: ' (no checkbox, radio, switch or aria-pressed toggle); for a plain button or chip use click',
  [StepKind.select]: ' (no native <select>); for a custom dropdown click the control, then click the option',
  [StepKind.upload]: ' (no file input); if the page opens a picker from a button, use css= on the hidden input',
};

interface Look { page: Page; cands: Candidate[]; url: string; title: string; layout?: string }

/** One target, its Jev call counted. */
export async function resolveOne(ctx: StepContext, kind: CandidateKind, target: string): Promise<ResolvedTarget<Locator>> {
  const [resolved] = await resolveLocators(ctx, kind, [target]);
  if (resolved.usedJev) ctx.track(resolved.tokens);
  return resolved;
}

/**
 * Resolves several targets of one kind, in order. `css=` targets resolve directly. With a lock that replays, a
 * target with a recorded locator acts on it; the others share one settle, one candidate scan and one Jev request,
 * whose tokens only the first Jev-resolved result carries, and each accepted pick is recorded.
 */
export async function resolveLocators(ctx: StepContext, kind: CandidateKind, targets: string[]): Promise<ResolvedTarget<Locator>[]> {
  const results: ResolvedTarget<Locator>[] = new Array(targets.length);
  let jevIndices: number[] = [];
  for (const [i, target] of targets.entries()) {
    if (target.startsWith('css=')) results[i] = await resolveCss(ctx, target.slice(4));
    else jevIndices.push(i);
  }
  if (!jevIndices.length) return results;

  const step = ctx.step;
  // Only a step with a source uses the lock: a spec step, or an MCP step, which records for `save` (judge mode).
  const lock = step?.at ? ctx.lock : undefined;
  const parameters = ctx.parameters ?? [];
  const refOf = (target: string): LockRef => ({ at: step!.at!, kind: step!.kind, slot: targetSlot(parameterize(target, parameters)) });
  /** Why the recorded locator of each target that goes to Jev missed. */
  const missed = new Map<number, string>();
  if (lock?.replays && !ctx.healing) {
    await timed(ctx, 'settle', () => waitHold(ctx.page));
    const misses: number[] = [];
    for (const i of jevIndices) {
      const entry = lock.lookup(refOf(targets[i]));
      // A marginal pick replays only where Jev cannot be asked again.
      const recorded = entry && isTargetEntry(entry) && !(entry.marginal && lock.judges) ? entry : undefined;
      const replayed = !recorded ? { element: null, detail: 'no recorded locator for this step' }
        : await timed(ctx, 'replay', () => replayTarget(ctx, kind, recorded))
          // A lock file edited by hand or merged badly: a miss that Jev repairs, not a step error.
          .catch((error: unknown) => ({ element: null, detail: `recorded locator ${recorded.text} is unusable: ${actionError(error)}` }));
      if (replayed.element) {
        results[i] = { element: replayed.element, detail: replayed.detail, tokens: 0, usedJev: false };
        if (ctx.locked) ctx.locked.replayed++;
      } else if (lock.judges) {
        misses.push(i);
        // Only a recorded locator that missed is healed: with no entry or a marginal pick, Jev picks as in judge mode.
        if (recorded) missed.set(i, replayed.detail);
      } else {
        results[i] = { element: null, detail: `no-judge: ${replayed.detail}; run with --mode auto-healing or judge to record it`,
          tokens: 0, usedJev: false };
      }
    }
    jevIndices = misses;
    if (!jevIndices.length) return results;
  }

  const jevTargets = jevIndices.map((i) => targets[i]);
  const { state: { page, cands, layout }, result: picks } = await lookAndPick(ctx, kind, jevTargets);
  // Recorded before the action: an action can navigate away from the tagged elements.
  if (lock?.judges) for (const [j, pick] of picks.entries()) {
    if (!pick.candidate || !pick.element) continue;
    const miss = missed.get(jevIndices[j]);
    if (miss !== undefined && ctx.locked) ctx.locked.healed.push(miss);
    const recorded = await timed(ctx, 'record', () => recordLocator(page, pick.candidate!, parameters));
    if (recorded.ok) {
      const relations = layout === undefined ? undefined : parameterize(layoutRelations(layout), parameters);
      if (relations !== undefined) saveRecordedState(sha256(relations), { target: jevTargets[j], relations });
      lock.record(refOf(jevTargets[j]), { locator: mapStrings(recorded.locator, (text) => parameterize(text, parameters), NAMES),
        text: parameterize(recorded.text, parameters), ...(relations === undefined ? {} : { layout: sha256(relations) }),
        ...((pick.score ?? 0) < RECORD_AT ? { marginal: true as const } : {}) });
    }
  }
  const noCandidates = `no candidates: nothing on the page matches a ${kind} target${NO_CANDIDATES_HINT[kind] ?? ''}`;
  picks.forEach((pick, j) => {
    results[jevIndices[j]] = { ...pick, detail: cands.length ? pick.detail : noCandidates };
  });
  return results;
}

/** Locator fields that name a kind of thing, never page data: a run value is not put in them. */
const NAMES: ReadonlySet<string> = new Set(['by', 'strategy', 'role', 'selector', 'shape']);
/** How long a recorded locator may take to show its element after the page settled. */
const REPLAY_APPEAR_MS = 2000;
/** Actionability of a replayed element (visible, enabled, not covered), checked without acting. */
const REPLAY_PROBE_MS = 2000;
const PROBED: ReadonlySet<CandidateKind> = new Set([StepKind.click, StepKind.hover, StepKind.fill, StepKind.check]);

/** The element a recorded locator names: exactly one match, and one an action can reach. */
async function replayTarget(ctx: StepContext, kind: CandidateKind, entry: TargetEntry): Promise<{ element: Locator | null; detail: string }> {
  const parameters: RunValues = ctx.parameters ?? [];
  const shown = fill(entry.text, parameters);
  // A spatial entry waits for its recorded layout: right after an action, a sliding panel is still moving.
  const deadline = Date.now() + Math.min(REPLAY_APPEAR_MS, ctx.timeout);
  for (;;) {
    if (entry.layout === undefined) break;
    const relations = parameterize(layoutRelations(await timed(ctx, 'snapshot', () => layoutSnapshot(ctx.page))), parameters);
    if (sha256(relations) === entry.layout) break;
    if (Date.now() >= deadline) {
      const file = dumpDebug('lock-layout', { target: shown, relations });
      return { element: null, detail: `the layout differs from the one ${shown} was picked in (spatial target) — layout: ${file}${recordedStateNote(entry.layout)}` };
    }
    await sleep(APPEAR_POLL_MS);
  }
  // This run's values go where the recording run's values were.
  const recorded = mapStrings(entry.locator as RecordedLocator, (text) => fill(text, parameters), NAMES);
  let locator = toLocator(ctx.page, recorded.parts);
  for (;;) {
    const count = await locator.count();
    if (count === 1) break;
    // Links that all go to the recorded place: any of them does.
    if (count > 1 && recorded.equivalent && (await locator.evaluateAll((els) => els.map((el) => el.getAttribute('href'))))
      .every((href) => href === recorded.equivalent!.href)) {
      locator = locator.first();
      break;
    }
    if (count > 1) return { element: null, detail: `recorded locator ${shown} matched ${count} elements` };
    if (Date.now() >= deadline) return { element: null, detail: `recorded locator ${shown} matched no element` };
    await sleep(APPEAR_POLL_MS);
  }
  if (recorded.shape !== undefined && await shapeOf(locator, parameters) !== recorded.shape) {
    return { element: null, detail: `the element at the position of ${shown} changed` };
  }
  if (PROBED.has(kind)) {
    try {
      await locator.click({ trial: true, timeout: REPLAY_PROBE_MS });
    } catch (error) {
      return { element: null, detail: `recorded locator ${shown} is not actionable: ${actionError(error)}` };
    }
  }
  return { element: locator, detail: `→ ${shown} (replayed)` };
}

/** No match yet is left to Playwright's auto-wait; several matches would end in its strict-mode error dump. */
async function resolveCss(ctx: StepContext, selector: string): Promise<ResolvedTarget<Locator>> {
  const element = ctx.page.locator(selector);
  const count = await element.count();
  return count > 1
    ? { element: null, detail: `css=${selector} matched ${count} elements; make the selector match exactly one`, tokens: 0, usedJev: false }
    : { element, detail: `→ css=${selector}`, tokens: 0, usedJev: false };
}

/**
 * Scans the candidates and asks Jev while the page settles, so debounced autocompletes and modals finish
 * rendering first. A page with no candidates yet, or one that navigates during the look, is looked at again
 * for up to APPEAR_MS.
 */
async function lookAndPick(ctx: StepContext, kind: CandidateKind, targets: string[]) {
  let spatial: boolean | undefined;
  const deadline = Date.now() + Math.min(APPEAR_MS, ctx.timeout);
  for (;;) {
    const look = await settledAsk<Look, ResolvedTarget<Locator>[]>(ctx, {
      get reobserve() { return spatial === true; },
      // The active page is read on every look: a popup may replace it while the page settles, and a locator
      // belongs to the page that was scanned.
      observe: async () => {
        let page = ctx.page;
        let found = await timed(ctx, 'candidates', () => candidates(page, kind, MAX_CANDIDATES));
        if (found.length && spatial === undefined) {
          spatial = await needsLayout(ctx, targets);
          // Routing can outlast a render or replace the active page; geometry needs a fresh scan.
          page = ctx.page;
          found = await timed(ctx, 'candidates', () => candidates(page, kind, MAX_CANDIDATES));
        }
        const cands = spatial ? await timed(ctx, 'candidates', () => spatialCandidates(page, found)) : found;
        const layout = spatial ? await timed(ctx, 'snapshot', () => layoutSnapshot(page)) : undefined;
        return { page, cands, url: page.url(), title: await page.title(), ...(layout === undefined ? {} : { layout }) };
      },
      same: (a, b) => a.page === b.page && a.url === b.url && a.title === b.title && a.layout === b.layout && sameCandidates(a.cands, b.cands),
      ask: ({ page, cands, url, title, layout }) => resolveTargets({
        candidates: cands,
        state: { url, title, goal: ctx.spec.goal, ...(layout === undefined ? {} : { layout }) },
        element: (candidate) => elementById(page, candidate.id, candidate.frameIndex),
      }, targets),
      discard: (results) => {
        for (const result of results) if (result.usedJev) ctx.track(result.tokens);
      },
    }).catch((error) => {
      if (Date.now() < deadline && /context was destroyed|frame was detached|navigat/i.test(String(error))) return null;
      throw error;
    });
    const expired = Date.now() >= deadline;
    if (look && (look.state.cands.length || expired)) return { state: look.state, result: look.result! };
    if (expired) throw new Error('the page kept navigating; no candidates could be read');
    await timed(ctx, 'idle', () => sleep(APPEAR_POLL_MS));
  }
}

/** Geometry can omit a detached element, leaving gaps in the ids of an otherwise equal list. */
function sameCandidates(a: Candidate[], b: Candidate[]): boolean {
  return a.length === b.length && a.every((candidate, i) => candidate.id === b[i].id &&
    candidate.desc === b[i].desc && candidate.frameIndex === b[i].frameIndex &&
    JSON.stringify(candidate.bounds) === JSON.stringify(b[i].bounds));
}
