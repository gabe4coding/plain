import path from 'node:path';
import type { Locator } from 'playwright';
import { StepKind } from '../core/step-kind.js';
import type { Step } from '../core/spec.js';
import { intelligence, type Snapshot } from '../core/automation.js';
import { label, dumpDebug, noted, type Status, type StepResult } from '../core/results.js';
import { ask } from '../jev/ask.js';
import { decide, decideAll } from '../jev/decide.js';
import { explainFailure, imageBackend } from '../jev/explain.js';
import { SPLIT_TEXT_HINT, splitTextHint } from './split-text.js';
import { waitForMutation } from './page.js';
import { type CandidateKind } from './candidates.js';
import { mayNavigate, settlePage, waitHold } from './activity.js';
import { resolveLocators, resolveOne } from './locate.js';
import { judgeClaims, judgeRegion, judgeSettled, observe, stateHash, type Observed } from './judge-page.js';
import { claimSlot, isTargetEntry, recordedStateNote, saveRecordedState, type LockRef } from '../core/lock.js';
import { parameterize } from '../core/parameters.js';
import { sleep, timed, type StepContext } from './context.js';
import { prepareEvidence, scrollEdge } from './evidence.js';
import { actionError } from './action-error.js';

type StepOf<K extends Step['kind']> = Extract<Step, { kind: K }>;

/** Waits at most this many Jev answers for a `wait` condition. */
const MAX_WAIT_POLLS = 8;
/** A page that keeps mutating without changing what Jev sees must not spin the wait loop. */
const MIN_POLL_GAP_MS = 250;
const MAX_IDLE_BETWEEN_POLLS_MS = 1500;
/** Typing usually fires a debounced request (autocomplete, validation) after ~300-400 ms. */
const FILL_GRACE_MS = 200;
const FILL_HOLD_MS = 500;

/**
 * runStep that never throws: an error becomes the result, and an optional step that misses is skipped. In
 * auto-healing, a step that did not pass with a replayed locator runs once more with every target picked by Jev;
 * its records replace the replayed ones when it passes.
 */
export async function runStepSafely(ctx: StepContext, step: Step, prepare: (step: Step) => Step = (s) => s): Promise<StepResult> {
  const once = async (): Promise<StepResult> => {
    try {
      return await runStep(ctx, prepare(step));
    } catch (error) {
      return { step: label(step), status: 'error', detail: actionError(error) };
    }
  };
  let result = await once();
  // From the context, not the result: a step whose action threw has an error result without the flag. A claim
  // that Jev judged false is not healed: it would only be judged again at full cost.
  const claim = step.kind === StepKind.expect || step.kind === StepKind.wait;
  if (result.status !== 'pass' && !claim && ctx.locked?.replayed && ctx.lock?.mode === 'auto-healing') {
    const failed = result.detail;
    ctx.lock.restartStep();
    ctx.healing = true;
    try {
      result = await once();
    } finally {
      ctx.healing = false;
    }
    const note = `replayed locator failed: ${failed ?? result.status}`;
    result = result.status === 'pass'
      ? { ...result, healed: true, detail: noted(result.detail, `healed; ${note}`) }
      : { ...result, detail: noted(result.detail, `Jev could not heal; ${note}`) };
  }
  const missed = result.status === 'inconclusive' || result.status === 'error';
  return step.optional && missed ? { ...result, status: 'skipped' } : result;
}

/** Runs one step; the result's `ms` holds its phase timings and `total`. */
export async function runStep(ctx: StepContext, step: Step): Promise<StepResult> {
  ctx.ms = {};
  ctx.step = step;
  ctx.locked = { replayed: 0, healed: [] };
  prepareEvidence(ctx, [step]);
  const start = Date.now();
  if (!settlesFirst(step)) await timed(ctx, 'settle', () => waitHold(ctx.page));
  const result = await runKind(ctx, step);
  ctx.ms.total = Date.now() - start;
  const { replayed, healed } = ctx.locked;
  // A target whose recorded locator missed went to Jev: the step is healed when it passes. A target resolved again
  // in the step (a re-rendered `within` region) misses again with the same reason.
  const heal = healed.length && result.status === 'pass'
    ? { healed: true, detail: noted(result.detail, `healed; ${[...new Set(healed)].join('; ')}`) } : {};
  return { ...result, ...(replayed ? { replayed: true } : {}), ...heal, ms: { ...ctx.ms } };
}

/**
 * Whether the step's first look goes through settledAsk, which waits out the last action's hold itself while
 * Jev works. Every other step waits it out before it starts.
 */
function settlesFirst(step: Step): boolean {
  if (step.kind === StepKind.goto || step.kind === StepKind.press || step.kind === StepKind.mouse) return false;
  if (step.kind === StepKind.scroll && scrollEdge(step.target)) return false;
  const targets = step.kind === StepKind.expect ? [step.within ?? '']
    : step.kind === StepKind.wait ? [step.condition]
      : step.kind === StepKind.drag ? [step.source, step.target]
        : [step.target];
  return targets.some((target) => !target.startsWith('css='));
}

async function runKind(ctx: StepContext, step: Step): Promise<StepResult> {
  const stepLabel = label(step);
  const pass = (detail?: string): StepResult =>
    detail === undefined ? { step: stepLabel, status: 'pass' } : { step: stepLabel, status: 'pass', detail };
  const onTarget = (kind: CandidateKind, target: string, act: (element: Locator) => Promise<string | void>) =>
    withResolved(ctx, kind, target, stepLabel, act);

  switch (step.kind) {
    case StepKind.goto:
      await timed(ctx, 'action', () => ctx.page.goto(resolveUrl(ctx.spec.url, step.url), { waitUntil: 'load' }));
      return pass();
    case StepKind.press:
      await mayNavigate(ctx, () => ctx.page.keyboard.press(step.key));
      return pass();
    case StepKind.mouse:
      await timed(ctx, 'action', () => ctx.page.mouse.move(step.x, step.y));
      return pass();
    case StepKind.click:
      return onTarget(StepKind.click, step.target, (element) => mayNavigate(ctx, () => element.click()));
    case StepKind.dblclick:
      return onTarget(StepKind.click, step.target, (element) => mayNavigate(ctx, () => element.dblclick()));
    case StepKind.rightclick:
      return onTarget(StepKind.click, step.target, (element) => mayNavigate(ctx, () => element.click({ button: 'right' })));
    case StepKind.fill:
      return onTarget(StepKind.fill, step.target, (element) =>
        mayNavigate(ctx, () => element.fill(step.value), FILL_GRACE_MS, FILL_HOLD_MS));
    case StepKind.hover:
      return onTarget(StepKind.hover, step.target, (element) => timed(ctx, 'action', () => element.hover()));
    case StepKind.select:
      return onTarget(StepKind.select, step.target, (element) => timed(ctx, 'action', () => selectOption(element, step.value)));
    case StepKind.check:
    case StepKind.uncheck:
      return onTarget(StepKind.check, step.target, (element) =>
        timed(ctx, 'action', () => setChecked(element, step.kind === StepKind.check)));
    case StepKind.upload: {
      const files = step.files.map((file) => path.resolve(ctx.spec.dir, file));
      return onTarget(StepKind.upload, step.target, (element) => timed(ctx, 'action', () => element.setInputFiles(files)));
    }
    case StepKind.scroll: {
      const edge = scrollEdge(step.target);
      if (edge) return pass(await scrollToEdge(ctx, edge));
      return onTarget(StepKind.click, step.target, async (element) => {
        await timed(ctx, 'action', () => element.scrollIntoViewIfNeeded());
        await timed(ctx, 'settle', () => settlePage(ctx.page));
      });
    }
    case StepKind.drag:
      return runDrag(ctx, step, stepLabel);
    case StepKind.wait:
      return runWait(ctx, step, stepLabel);
    case StepKind.expect:
      return runExpect(ctx, step, stepLabel);
  }
}

/** Resolves `target`, then acts on it; inconclusive when Jev finds no element. `act` may add to the detail. */
async function withResolved(ctx: StepContext, kind: CandidateKind, target: string, stepLabel: string,
  act: (element: Locator) => Promise<string | void>): Promise<StepResult> {
  const resolved = await resolveOne(ctx, kind, target);
  if (!resolved.element) return { step: stepLabel, status: 'inconclusive', detail: resolved.detail };
  const extra = await act(resolved.element);
  return { step: stepLabel, status: 'pass', detail: extra ? `${resolved.detail} ${extra}` : resolved.detail };
}

/** `url` is the app's base, not just its origin: `goto: /` goes back to the app under test, not to the site's root. */
function resolveUrl(base: string, target: string): string {
  if (/^https?:\/\//.test(target)) return target;
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`;
  const relative = target.startsWith('/') ? target.slice(1) : target;
  return new URL(relative, baseWithSlash).toString();
}

async function selectOption(element: Locator, value: string): Promise<void> {
  try {
    await element.selectOption({ label: value });
  } catch {
    await element.selectOption(value);
  }
}

/**
 * `check`/`uncheck` mean "make it (un)selected", wherever the state lives: a form control's `checked` (through
 * its label) or aria-checked/aria-pressed on a toggle. Playwright's check() refuses toggle buttons and times out
 * on a label whose checkbox has no size, so the state is read here and the element is clicked only to change it.
 */
async function setChecked(element: Locator, on: boolean): Promise<string> {
  const wanted = on ? 'checked' : 'unchecked';
  const read = () => element.evaluate((el) => {
    const control = el instanceof HTMLLabelElement ? el.control : el;
    if (control instanceof HTMLInputElement) return control.checked;
    const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
    return aria === null ? null : aria === 'true';
  });
  const before = await read();
  if (before === null) {
    // No readable state: Playwright decides whether this is a checkbox at all.
    await (on ? element.check() : element.uncheck());
    return `now ${wanted}`;
  }
  if (before === on) return `already ${wanted}`;
  await element.click();
  const after = await read().catch(() => null); // a re-render may have replaced the element
  if (after !== null && after !== on) throw new Error(`clicked, but the element is still ${after ? 'checked' : 'unchecked'}`);
  return `now ${wanted}`;
}

/**
 * Scrolls `document.scrollingElement` (body.scrollHeight is short of the document on many sites), `instant` so
 * the position read back is final even under `scroll-behavior: smooth`. Returns the detail.
 */
async function scrollToEdge(ctx: StepContext, edge: 'top' | 'bottom'): Promise<string> {
  const [from, to] = await timed(ctx, 'action', () => ctx.page.evaluate((edge) => {
    const scroller = document.scrollingElement ?? document.documentElement;
    const start = scroller.scrollTop;
    scroller.scrollTo({ top: edge === 'top' ? 0 : scroller.scrollHeight, behavior: 'instant' });
    return [Math.round(start), Math.round(scroller.scrollTop)];
  }, edge));
  await timed(ctx, 'settle', () => settlePage(ctx.page));
  return from === to
    ? `did not move (${to}px): already at the ${edge}, or the page scrolls inside an element — scroll that element instead`
    : `scrolled ${from} → ${to}px`;
}

/**
 * Hover, mouse down, hover the target twice, mouse up: Playwright's dragTo() only synthesizes mouse events,
 * which native HTML5 dragstart/dragover/drop handlers never see.
 */
async function runDrag(ctx: StepContext, step: StepOf<'drag'>, stepLabel: string): Promise<StepResult> {
  const resolved = await resolveLocators(ctx, StepKind.click, [step.source, step.target]);
  for (const target of resolved) if (target.usedJev) ctx.track(target.tokens);
  const missing = resolved.find((target) => !target.element);
  if (missing) return { step: stepLabel, status: 'inconclusive', detail: missing.detail };
  const [source, destination] = resolved;
  await timed(ctx, 'action', async () => {
    await source.element!.hover();
    await ctx.page.mouse.down();
    await destination.element!.hover();
    await destination.element!.hover();
    await ctx.page.mouse.up();
  });
  return { step: stepLabel, status: 'pass', detail: `${source.detail} → ${destination.detail}` };
}

/**
 * Polls the condition until Jev says it holds, the timeout passes or MAX_WAIT_POLLS answers came back.
 * `within`: one region pick, then each poll sends only that region (the whole tree of a big page costs many
 * tokens per poll); the region is picked again if its element leaves the page.
 * An unchanged state after a clear "no" is not asked again; a grey-zone answer is, since a borderline
 * probability can flip on the next try.
 */
async function runWait(ctx: StepContext, step: StepOf<'wait'>, stepLabel: string, replay = true): Promise<StepResult> {
  if (step.condition.startsWith('css=')) {
    await ctx.page.waitForSelector(step.condition.slice(4), { state: 'visible', timeout: ctx.timeout });
    return { step: stepLabel, status: 'pass' };
  }
  if (replay && replaysClaims(ctx)) return replayClaims(ctx, StepKind.wait, [step.condition], step.within, ctx.timeout, stepLabel,
    () => runWait(ctx, step, stepLabel, false));
  const deadline = Date.now() + ctx.timeout;
  let region: Locator | null = null;
  if (step.within) {
    const resolved = await resolveOne(ctx, 'region', step.within);
    if (!resolved.element) return { step: stepLabel, status: 'inconclusive', detail: resolved.detail };
    region = resolved.element;
  }

  let polls = 0;
  let skipped = 0;
  let lastProbability = 0;
  let lastSnap: Snapshot | null = null;
  let lastKey: string | null = null;
  const keyOf = (observed: Observed) => JSON.stringify([observed.snap, observed.events, observed.fullAria]);
  const unchangedSinceNo = (observed: Observed) => keyOf(observed) === lastKey && decide(lastProbability, 'expect') === 'fail';
  const detail = () => `p=${lastProbability.toFixed(2)} after ${polls} poll(s)${skipped > 0 ? `, ${skipped} unchanged` : ''}`;

  while (polls < MAX_WAIT_POLLS && Date.now() < deadline) {
    const pollStart = Date.now();
    if (region && step.within && await region.count() === 0) { // re-rendered: its data-jev-id is gone
      const resolved = await resolveOne(ctx, 'region', step.within);
      if (!resolved.element) return { step: stepLabel, status: 'inconclusive', detail: resolved.detail };
      region = resolved.element;
    }
    const { state, probabilities, spatial } = region
      ? await judgeRegion(ctx, region, step.condition, unchangedSinceNo)
      : await judgeSettled(ctx, [step.condition], unchangedSinceNo);
    if (probabilities === null) {
      skipped++;
    } else {
      lastKey = keyOf(state);
      lastProbability = probabilities[0];
      lastSnap = state.snap;
      ctx.ms.polls = ++polls;
      if (decide(lastProbability, 'expect') === 'pass') {
        recordClaims(ctx, [step.condition], step.within, state, spatial);
        return { step: stepLabel, status: 'pass', detail: detail() };
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    // A navigation mid-evaluate throws: that counts as a change.
    await timed(ctx, 'idle', () => waitForMutation(ctx.page, Math.min(MAX_IDLE_BETWEEN_POLLS_MS, remaining)).catch(() => {}));
    const tooSoon = MIN_POLL_GAP_MS - (Date.now() - pollStart);
    if (probabilities === null && tooSoon > 0) await sleep(tooSoon);
  }
  const file = dumpDebug(StepKind.wait, { condition: step.condition, probability: lastProbability, state: lastSnap });
  return { step: stepLabel, status: 'inconclusive', detail: `${detail()} — state: ${file}` };
}

/** All claims in one Jev call. */
async function runExpect(ctx: StepContext, step: StepOf<'expect'>, stepLabel: string, replay = true): Promise<StepResult> {
  if (replay && replaysClaims(ctx)) return replayClaims(ctx, StepKind.expect, step.expectations, step.within, Math.min(EXPECT_REPLAY_MS, ctx.timeout), stepLabel,
    () => runExpect(ctx, step, stepLabel, false));
  const judged = await judgeClaims(ctx, step.expectations, step.within);
  if ('detail' in judged) return { step: stepLabel, status: 'inconclusive', detail: judged.detail };

  const { snap, probabilities } = judged;
  const status: Status = decideAll(probabilities);
  if (status === 'pass') recordClaims(ctx, step.expectations, step.within, judged.state, judged.spatial);
  let detail = `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} @ ${ctx.page.url()}`;
  if (judged.longContext) detail += ' (long context)';
  else if (snap.truncated) detail += ' (aria truncated at 60k chars)';
  if (status !== 'pass') {
    const missed = step.expectations.filter((_, i) => decide(probabilities[i], 'expect') !== 'pass');
    // What the verdict used, so the author can tune the claims against that state.
    const seen = judged.longContext && judged.state.fullAria
      ? { ...snap, aria: judged.state.fullAria, truncated: false } : snap;
    const file = dumpDebug(StepKind.expect, { expectations: step.expectations, probabilities, state: seen });
    detail += ` — state: ${file}`;
    const advice = await failureAdvice(ctx, missed, judged.state.fullAria ?? snap.aria, step.within !== undefined);
    if (advice.line) detail += ` — ${advice.line}`;
    if (advice.hint) detail += ` — ${advice.hint}`;
    if (advice.tokens > 0) ctx.track(advice.tokens);
  }
  return { step: stepLabel, status, detail };
}

/** Playwright's own cap for one screenshot. A hung page must not hold the step. */
const SCREENSHOT_TIMEOUT_MS = 10_000;

/**
 * A failed check can name what the viewport shows and when the tree splits the claim's words.
 * Neither line changes `status`. A screenshot or model error leaves the detail without that line.
 */
async function failureAdvice(ctx: StepContext, claims: string[], aria: string, scoped: boolean): Promise<{ line?: string; hint?: string; tokens: number }> {
  const hint = claims.some((claim) => splitTextHint(claim, aria)) ? SPLIT_TEXT_HINT : undefined;
  // A `within` claim is about one region. The screenshot is the whole viewport, so it must not say the claim holds.
  if (scoped) return { hint, tokens: 0 };
  const explained = await explainMisses(ctx, claims);
  return { line: explained?.line, hint, tokens: explained?.tokens ?? 0 };
}

async function explainMisses(ctx: StepContext, claims: string[]): Promise<{ line: string; tokens: number } | null> {
  if (!claims.length) return null;
  let png: Uint8Array;
  try {
    png = await ctx.page.screenshot({ type: 'png', timeout: SCREENSHOT_TIMEOUT_MS });
  } catch {
    return null;
  }
  try {
    if (intelligence.explain) return await intelligence.explain(claims, png);
    const supported = imageBackend();
    if (supported === null) return null;
    return await explainFailure(claims, png, { supported, ask });
  } catch {
    return null;
  }
}

/** In no-judge, a claim is compared with its recorded passing state for at most this long after the page settled. */
const EXPECT_REPLAY_MS = 3000;

/** The claims and region with this run's values as placeholders: one entry per step whatever the data. */
function claimRef(ctx: StepContext, claims: string[], within?: string): LockRef | undefined {
  if (!ctx.step?.at) return undefined;
  const generic = (text: string) => parameterize(text, ctx.parameters ?? []);
  return { at: ctx.step.at, kind: ctx.step.kind, slot: claimSlot(claims.map(generic), within === undefined ? undefined : generic(within)) };
}

const replaysClaims = (ctx: StepContext): boolean => ctx.lock !== undefined && !ctx.lock.judges && ctx.step?.at !== undefined;

/** The state Jev judged true, hashed, for a later no-judge run. */
function recordClaims(ctx: StepContext, claims: string[], within: string | undefined, state: Observed, spatial: boolean): void {
  const ref = claimRef(ctx, claims, within);
  if (!ref || !ctx.lock?.judges) return;
  const hash = stateHash(state, ctx.parameters);
  ctx.lock.record(ref, { state: hash, spatial });
  saveRecordedState(hash, { claims, state: hashedSnap(state), events: state.events });
}

/** The tree the lock hashed. The uncut text is what a later no-judge run compares. */
function hashedSnap(state: Observed): Snapshot {
  return state.fullAria === undefined ? state.snap : { ...state.snap, aria: state.fullAria, truncated: false };
}

/**
 * no-judge `expect` and `wait`: pass when the page (or the `within` region, from its recorded locator) shows the
 * state recorded when Jev judged the claims true, within `windowMs`; inconclusive otherwise, with the state seen.
 */
async function replayClaims(ctx: StepContext, kind: typeof StepKind.expect | typeof StepKind.wait, claims: string[],
  within: string | undefined, windowMs: number, stepLabel: string, reverify: () => Promise<StepResult>): Promise<StepResult> {
  const lock = ctx.lock;
  const ref = claimRef(ctx, claims, within);
  if (!lock || !ref) {
    return { step: stepLabel, status: 'inconclusive',
      detail: 'no-judge: no recorded passing state for this step; run with --mode auto-healing or judge to record it' };
  }
  const entry = lock.lookup(ref);
  if (!entry || isTargetEntry(entry)) {
    return { step: stepLabel, status: 'inconclusive',
      detail: 'no-judge: no recorded passing state for this step; run with --mode auto-healing or judge to record it' };
  }
  let region: Locator | undefined;
  if (within) {
    const resolved = await resolveOne(ctx, 'region', within);
    if (!resolved.element) return { step: stepLabel, status: 'inconclusive', detail: resolved.detail };
    region = resolved.element;
  }
  await timed(ctx, 'settle', () => waitHold(ctx.page));
  const deadline = Date.now() + windowMs;
  for (;;) {
    const observed = await observe(ctx, entry.spatial, region);
    if (stateHash(observed, ctx.parameters) === entry.state) return { step: stepLabel, status: 'pass', detail: 'the recorded passing state (no-judge)' };
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      // A version 1 hash can miss because the uncut tree is hashed. Judge the claim instead of calling the page different.
      const source = ctx.step?.at?.file;
      if (source && lock.staleClaims(source)) return reverify();
      const file = dumpDebug(kind, { claims, state: observed.snap, events: observed.events });
      return { step: stepLabel, status: 'inconclusive',
        detail: `no-judge: the ${region ? 'region' : 'page'} differs from the recorded passing state — state: ${file}${recordedStateNote(entry.state)}` };
    }
    await timed(ctx, 'idle', () => waitForMutation(ctx.page, Math.min(MAX_IDLE_BETWEEN_POLLS_MS, remaining)).catch(() => {}));
  }
}
