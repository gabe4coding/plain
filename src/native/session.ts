import { intelligence, resolveTargets, judgeState, askSettled, HiddenTargetError, type Intelligence, type Frame, type ResolvedTarget } from '../core/automation.js';
import { timedInto, dumpDebug, errorMessage, noted, type StepResult, type Status } from '../core/results.js';
import { readAnswer } from '../core/read.js';
import type { Step, StepSource } from '../core/spec.js';
import { claimSlot, isTargetEntry, RECORD_AT, recordedStateNote, saveRecordedState, sha256, targetSlot, type LockAttempt, type LockRef, type TargetEntry } from '../core/lock.js';
import { parameterize, type RunValues } from '../core/parameters.js';
import { layoutRelations } from '../core/layout.js';
import { decideAll } from '../jev/decide.js';
import { evidenceForGroups } from '../jev/evidence.js';
import { evidenceRoutes, prepareRoutes, promptGroups, routeNeedsLayout, type DescribedStep } from '../core/evidence.js';

/** What a desktop or mobile platform implements; Jev targeting and judging stay in NativeSession. */
export interface NativeAdapter<T, K extends string> {
  /**
   * `regionPick`: the capture only picks a region, so an approximate frame may do. `spatial`: candidates carry
   * bounds and the snapshot a layout (src/core/layout.ts), with the frame's coordinate space.
   */
  capture(kind: K | 'region', within?: T, options?: CaptureOptions): Promise<Frame<T>>;
  /** The next target capture is exact: a pick from an approximate one was rejected or hidden. */
  preferExact?(): void;
  /** Target captures may be approximate (iOS fast targets): they never serve as a step's `changed` baseline. */
  readonly approximateTargets?: boolean;
  /** A capture that skips the platform's wait for an idle UI, or null where that is not faster. */
  captureEarly?(kind: K | 'region', within?: T, options?: CaptureOptions): Promise<Frame<T> | null>;
  /** Whether the element is a secure text field: a value typed into it is a secret. */
  secret?(element: T): boolean;
  press(key: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface CaptureOptions { regionPick?: boolean; spatial?: boolean }

type Assertion = Extract<Step, { kind: 'expect' | 'wait' }>;
export type NativeStep = { kind: string; optional?: boolean };

const isAssertion = <S extends NativeStep>(step: S): step is S & Assertion => step.kind === 'expect' || step.kind === 'wait';

/** Right after a step the UI may still be busy, so an early capture can save time. Later it only adds calls. */
const EARLY_WINDOW_MS = 1000;
/** A key or click that opens a window returns before the window exists: an empty capture is looked at again. */
const APPEAR_MS = 2000;
const APPEAR_POLL_MS = 150;
const MAX_WAIT_POLLS = 8;
const WAIT_POLL_MS = 250;
/** In no-judge, an `expect` is compared with its recorded passing state for at most this long. */
const EXPECT_REPLAY_MS = 3000;

/**
 * A native candidate as the lock records it (src/core/lock.ts): its description without the value and the state
 * flags that a step changes (a typed text, `[checked]`). Role, name and the ` in <container>` context stay.
 */
export const nativeIdentity = (desc: string): string =>
  desc.replace(/ value="(?:[^"\\]|\\.)*"/g, '').replace(/ \[[^\]]*\]/g, '');

/**
 * The role and name of an identity, without its ` in <container>` context. An Android container is often named by
 * all the text it holds (a contact list), which a run that adds a row changes.
 */
export const nativeShortIdentity = (identity: string): string => /^\S+(?: "(?:[^"\\]|\\.)*")?/.exec(identity)?.[0] ?? identity;

/** A native lock entry's locator: the identity, and for one of several twins its place among them. */
interface NativeLocator { identity: string; ordinal?: number; of?: number }

/**
 * A recorded passing state: the tree text and layout, not the window URL (it holds a process id), with the run's
 * values as placeholders (src/core/parameters.ts), and the layout's relations, not its bounds (a bound moves by
 * a point between two captures of the same screen).
 */
function nativeStateHash(snapshot: Frame<unknown>['snapshot'], parameters: RunValues): string {
  const generic = (text: string) => parameterize(text, parameters);
  return sha256(JSON.stringify([generic(snapshot.title), generic(snapshot.aria),
    snapshot.layout === undefined ? null : generic(layoutRelations(snapshot.layout))]));
}

/**
 * Jev targeting, expect/wait polling and phase timing for the desktop and mobile engines. A subclass parses,
 * labels and performs its platform's actions.
 */
export abstract class NativeSession<T, K extends string, S extends NativeStep, A extends NativeAdapter<T, K>> {
  calls = 0;
  tokens = 0;
  /** What the whole flow is for (spec `goal:`, MCP `open {goal}`): every pick sees it, claims never do. */
  goal?: string;
  /** The first whole-screen capture of the current step, before it acted: the MCP `changed` diffs against it. */
  firstSnapshot?: Frame<T>['snapshot'];
  /** The current step fills a secure text field: the MCP `save` writes an `${env.*}` placeholder, never its value. */
  filledSecret = false;
  /** This attempt's lock (src/core/lock.ts); spec runs only, never an MCP session. */
  lock?: LockAttempt;
  /** The values this run filled in, written back as placeholders in what the lock records (src/core/parameters.ts). */
  parameters: RunValues = [];
  /** The step running now: its source and kind key the lock. */
  private current?: { kind: string; at?: StepSource };
  /**
   * What the current step did with the lock: targets replayed, and for each target Jev healed, why its recorded
   * element missed (or why the replayed element failed, when the step ran again).
   */
  private locked: { replayed: number; healed: string[] } = { replayed: 0, healed: [] };
  /** The step runs again after it failed with a replayed element: every target goes to Jev. */
  private healing = false;
  /** Returned as the result's `ms`. */
  protected phaseMs: Record<string, number> = {};
  private lastStepEnd = 0;
  /** Which prompts need geometry (src/core/evidence.ts), queued per spec and per step. */
  private routes = evidenceRoutes();

  constructor(readonly adapter: A, readonly timeout = 15000, protected ai: Intelligence = intelligence) {}

  abstract parse(raw: unknown): S;
  abstract label(step: S): string;
  protected validate(step: S): S { return step; }
  /** Every step kind but expect and wait. */
  protected abstract act(step: S, stepLabel: string): Promise<StepResult>;

  protected timed<R>(phase: string, fn: () => Promise<R>) { return timedInto(this.phaseMs, phase, fn); }

  private track(tokens: number) {
    this.calls++;
    this.tokens += tokens;
  }

  /** The UI was just driven outside a step (the app was opened): the next step may find it busy. */
  noteActivity() { this.lastStepEnd = Date.now(); }

  step(raw: unknown): Promise<StepResult> { return this.run(this.parse(raw)); }

  /** Queues the steps' descriptions, so the first step that needs a route classifies all of them in one request. */
  prepareEvidence(steps: DescribedStep[]) { prepareRoutes(this.routes, steps.flatMap(promptGroups)); }

  /** Injected intelligence without `ask` (tests) never routes: every prompt keeps the accessibility tree alone. */
  private needsLayout(prompts: string[]): Promise<boolean> {
    const request = this.ai.ask;
    if (!request || !prompts.length) return Promise.resolve(false);
    return routeNeedsLayout(this.routes, prompts, (groups) =>
      this.timed('jev', () => evidenceForGroups(groups, request, (tokens) => this.track(tokens))).then((result) => result.spatial));
  }

  /**
   * Runs one step. In auto-healing, a step that did not pass with a replayed element runs once more with every
   * target picked by Jev; its records replace the replayed ones when it passes.
   */
  async run(step: S): Promise<StepResult> {
    const start = Date.now();
    this.phaseMs = {};
    this.current = step as { kind: string; at?: StepSource };
    this.locked = { replayed: 0, healed: [] };
    const once = async (): Promise<StepResult> => {
      this.firstSnapshot = undefined;
      this.filledSecret = false;
      try {
        const valid = this.validate(step);
        this.prepareEvidence([valid]);
        return isAssertion(valid) ? await this.assert(valid) : await this.act(valid, this.label(valid));
      } catch (error) {
        return { step: this.label(step), status: 'error', detail: errorMessage(error) };
      }
    };
    let result = await once();
    // A claim that Jev judged false is not healed: it would only be judged again at full cost.
    if (result.status !== 'pass' && !isAssertion(step) && this.locked.replayed && this.lock?.mode === 'auto-healing') {
      const failed = result.detail;
      this.lock.restartStep();
      // The result is the second attempt's, and it picks every target with Jev: nothing replayed.
      this.locked.replayed = 0;
      this.healing = true;
      try {
        result = await once();
      } finally {
        this.healing = false;
      }
      const note = `replayed element failed: ${failed ?? result.status}`;
      if (result.status === 'pass') this.locked.healed = [note];
      else result = { ...result, detail: noted(result.detail, `Jev could not heal; ${note}`) };
    }
    if (step.optional && (result.status === 'error' || result.status === 'inconclusive')) result.status = 'skipped';
    this.lastStepEnd = Date.now();
    this.current = undefined;
    const { replayed, healed } = this.locked;
    // A target whose recorded element missed went to Jev, or the step ran again: the step is healed when it passes.
    const heal = healed.length && result.status === 'pass'
      ? { healed: true, detail: noted(result.detail, `healed; ${[...new Set(healed)].join('; ')}`) } : {};
    return { ...result, ...(replayed ? { replayed: true } : {}), ...heal, ms: { total: this.lastStepEnd - start, ...this.phaseMs } };
  }

  private refOf(slot: string): LockRef | undefined {
    const step = this.current;
    return step?.at && this.lock ? { at: step.at, kind: step.kind, slot } : undefined;
  }

  /** A description or claim with this run's values as placeholders. */
  private generic(text: string): string {
    return parameterize(text, this.parameters);
  }

  /**
   * Resolves targets of one kind. With a lock that replays, a target whose recorded description matches exactly one
   * candidate acts on it; the others share one Jev request, and each accepted pick is recorded.
   */
  async find(kind: K | 'region', targets: string[], regionPick = false): Promise<ResolvedTarget<T>[]> {
    const lock = this.lock;
    const results: ResolvedTarget<T>[] = new Array(targets.length);
    let asked = targets.map((_, i) => i);
    /** Why the recorded element of each target that goes to Jev missed. */
    const missed = new Map<number, string>();
    if (lock?.replays && !this.healing && this.current?.at) {
      const entries = targets.map((target) => {
        const entry = lock.lookup(this.refOf(targetSlot(this.generic(target)))!);
        return entry && isTargetEntry(entry) && !(entry.marginal && lock.judges) ? entry : undefined;
      });
      // A spatial entry waits for its recorded layout: right after a tap, a sliding view is still moving.
      const layoutReady = (frame: Frame<T>) => entries.every((entry) => entry?.layout === undefined ||
        sha256(layoutRelations(this.generic(frame.snapshot.layout ?? ''), nativeShortIdentity((entry.locator as NativeLocator).identity))) === entry.layout);
      const frame = entries.some(Boolean)
        ? await this.replayFrame(kind, regionPick, entries.some((entry) => entry?.layout !== undefined), layoutReady) : undefined;
      asked = [];
      for (const [i, entry] of entries.entries()) {
        const replayed = entry && frame ? this.replayTarget(frame, entry) : { element: null, detail: entry === undefined
          ? 'no recorded element for this step' : 'nothing on the screen' };
        if (replayed.element !== null) {
          results[i] = { element: replayed.element, detail: replayed.detail, tokens: 0, usedJev: false, ...(frame!.approximate ? { approximate: true } : {}) };
          this.locked.replayed++;
        } else if (lock.judges) {
          asked.push(i);
          // Only a recorded element that missed is healed: with no entry or a marginal pick, Jev picks as in judge mode.
          if (entry) missed.set(i, replayed.detail);
        } else {
          results[i] = { element: null, detail: `no-judge: ${replayed.detail}; run with --mode auto-healing or judge to record it`, tokens: 0, usedJev: false };
        }
      }
      if (!asked.length) return results;
    }
    const { frame, resolved } = await this.pick(kind, asked.map((i) => targets[i]), regionPick);
    for (const [j, target] of resolved.entries()) {
      const i = asked[j];
      results[i] = target;
      const miss = missed.get(i);
      if (miss !== undefined && target.element !== null) this.locked.healed.push(miss);
      const ref = this.refOf(targetSlot(this.generic(targets[i])));
      if (!ref || !target.candidate || target.element === null || !lock?.judges) continue;
      const identity = this.generic(nativeIdentity(target.candidate.desc));
      // Twins (Starts and Ends both "5 Oct 2026" in one container) are told apart by their order in the tree.
      const twins = frame.candidates.filter((c) => this.generic(nativeIdentity(c.desc)) === identity);
      const order = twins.length > 1 ? { ordinal: twins.indexOf(target.candidate), of: twins.length } : {};
      const relations = frame.snapshot.layout === undefined ? undefined : layoutRelations(this.generic(frame.snapshot.layout), nativeShortIdentity(identity));
      if (relations !== undefined) saveRecordedState(sha256(relations), { target: identity, relations });
      lock.record(ref, { locator: { identity, ...order }, text: this.generic(target.candidate.desc),
        ...(relations === undefined ? {} : { layout: sha256(relations) }),
        ...((target.score ?? 0) < RECORD_AT ? { marginal: true as const } : {}) });
    }
    return results;
  }

  /** A settled capture to replay recorded elements in; looked at again for a moment while it is empty or not `ready`. */
  private async replayFrame(kind: K | 'region', regionPick: boolean, spatial: boolean, ready: (frame: Frame<T>) => boolean): Promise<Frame<T>> {
    const deadline = Date.now() + Math.min(APPEAR_MS, this.timeout);
    const options = regionPick || spatial ? { ...(regionPick ? { regionPick } : {}), ...(spatial ? { spatial } : {}) } : undefined;
    for (;;) {
      const frame = await this.timed('capture', () => this.adapter.capture(kind, undefined, options));
      if (!frame.approximate) this.firstSnapshot ??= frame.snapshot;
      if ((frame.candidates.length && ready(frame)) || Date.now() >= deadline) return frame;
      await this.timed('idle', () => new Promise((resolve) => setTimeout(resolve, APPEAR_POLL_MS)));
    }
  }

  /**
   * The candidate a recorded identity names, in the recorded layout for a spatial target: the one with its role
   * and name when no other has them (as a browser locator prefers role and name), else the one with the whole
   * identity, a twin among as many twins as were recorded.
   */
  private replayTarget(frame: Frame<T>, entry: TargetEntry): { element: T | null; detail: string } {
    const { identity, ordinal, of } = entry.locator as NativeLocator;
    const relations = layoutRelations(this.generic(frame.snapshot.layout ?? ''), nativeShortIdentity(identity));
    if (entry.layout !== undefined && sha256(relations) !== entry.layout) {
      const file = dumpDebug('lock-layout', { target: identity, relations });
      return { element: null, detail: `the layout differs from the one ${entry.text} was picked in (spatial target) — layout: ${file}${recordedStateNote(entry.layout)}` };
    }
    const identities = frame.candidates.map((c) => this.generic(nativeIdentity(c.desc)));
    const short = nativeShortIdentity(identity);
    const named = frame.candidates.filter((_, i) => nativeShortIdentity(identities[i]) === short);
    if (of === undefined && named.length === 1) {
      const element = frame.elements.get(named[0].id);
      if (element !== undefined) return { element, detail: `→ ${named[0].desc} (replayed)` };
    }
    const found = frame.candidates.filter((_, i) => identities[i] === identity);
    // A twin is replayed only among as many twins as were recorded: one more or one fewer may shift the order.
    const expected = of ?? 1;
    if (found.length !== expected) {
      return { element: null, detail: `recorded element ${entry.text} matched ${found.length} elements, ${expected} expected` };
    }
    const chosen = found[ordinal ?? 0];
    const element = frame.elements.get(chosen.id);
    return element === undefined ? { element: null, detail: 'candidate handle missing' } : { element, detail: `→ ${chosen.desc} (replayed)` };
  }

  /** Resolves targets of one kind with one Jev request. */
  private async pick(kind: K | 'region', targets: string[], regionPick = false) {
    const deadline = Date.now() + Math.min(APPEAR_MS, this.timeout);
    const spatial = await this.needsLayout(targets);
    const pick = (frame: Frame<T>) => resolveTargets({
      candidates: frame.candidates,
      state: { ...frame.snapshot, ...(this.goal ? { goal: this.goal } : {}), ...(frame.coordinates ? { coordinates: frame.coordinates } : {}) },
      element: (candidate) => {
        const element = frame.elements.get(candidate.id);
        if (element === undefined) throw new Error('Candidate handle missing');
        return element;
      },
    }, targets, this.ai);

    for (;;) {
      const { frame, result } = await this.settled({ kind, ask: pick, discard: (unused) => this.trackResolved(unused), regionPick, spatial });
      if (frame.candidates.length === 0 && Date.now() < deadline) {
        await this.timed('idle', () => new Promise((resolve) => setTimeout(resolve, APPEAR_POLL_MS)));
        continue;
      }
      const resolved = result!;
      this.trackResolved(resolved);
      return { frame, resolved: frame.approximate ? resolved.map((target) => ({ ...target, approximate: true })) : resolved };
    }
  }

  async snapshot(within?: string) {
    return this.inRegion(within, async (region) => (await this.timed('capture', () => this.adapter.capture('region', region))).snapshot);
  }

  /** The MCP `ask` tool: judges claims once against the settled UI or a region of it; no polling, not recorded. */
  async ask(claims: string[], within?: string) {
    this.phaseMs = {};
    this.prepareEvidence([{ kind: 'expect', expectations: claims, within }]);
    const { frame, result } = await this.inRegion(within, async (region) =>
      this.settled({ kind: 'region', within: region, ask: this.judge(claims), discard: (unused) => this.track(unused.tokens),
        spatial: await this.needsLayout(claims) }));
    this.track(result!.tokens);
    return { snapshot: frame.snapshot, probabilities: result!.probabilities, ms: this.phaseMs };
  }

  /** The MCP `read` tool: the tree lines that answer `question`; not recorded. */
  async read(question: string, within?: string) {
    const snapshot = await this.snapshot(within);
    const result = await readAnswer(snapshot, question, this.ai.ask);
    this.track(result.tokens);
    return result;
  }

  /**
   * The element a region description names; throws when Jev finds none. `allowApproximate`: the adapter may pick it from an
   * approximate capture (a rejected pick there is asked again from an exact one); the first look inside the
   * region then confirms it shows something, or throws HiddenTargetError.
   */
  protected async region(within: string, allowApproximate = false) {
    let [resolved] = await this.find('region', [within], allowApproximate);
    if (resolved.approximate && resolved.element === null) {
      this.retarget();
      [resolved] = await this.find('region', [within]);
    }
    if (resolved.element === null) throw new Error(resolved.detail);
    return resolved.element;
  }

  /** Notes whether a fill step's picked element is a secure text field. */
  protected noteFill(step: S, element: T) {
    this.filledSecret = step.kind === 'fill' && this.adapter.secret?.(element) === true;
  }

  protected retarget() {
    this.phaseMs.retargeted = 1;
    this.adapter.preferExact?.();
  }

  /** Runs `look` inside the region `within` names, picked fast where the adapter can; a covered one is picked again. */
  private async inRegion<R>(within: string | undefined, look: (region: T | undefined) => Promise<R>): Promise<R> {
    if (!within) return look(undefined);
    const region = await this.region(within, true);
    try {
      return await look(region);
    } catch (error) {
      if (!(error instanceof HiddenTargetError)) throw error;
      this.retarget();
      return look(await this.region(within));
    }
  }

  /**
   * Captures the settled UI and asks Jev about it. Right after the previous step, where the adapter offers an
   * early capture (Android), Jev already works on it while the adapter waits for the UI to go idle.
   */
  private async settled<R>({ kind, within, ask, discard, skip, regionPick = false, spatial = false }: {
    kind: K | 'region';
    within?: T;
    ask: (frame: Frame<T>) => Promise<R>;
    discard: (result: R) => void;
    skip?: (frame: Frame<T>) => boolean;
    regionPick?: boolean;
    spatial?: boolean;
  }) {
    const recent = Date.now() - this.lastStepEnd < EARLY_WINDOW_MS;
    const captureEarly = recent ? this.adapter.captureEarly?.bind(this.adapter) : undefined;
    const { frame, result, reasked } = await askSettled({
      early: captureEarly && (() => this.timed('capture', () => captureEarly(kind, within, spatial ? { spatial } : undefined))),
      settled: async () => {
        const options = regionPick || spatial ? { ...(regionPick ? { regionPick } : {}), ...(spatial ? { spatial } : {}) } : undefined;
        const frame = await this.timed('capture', () => this.adapter.capture(kind, within, options));
        if (within === undefined && !frame.approximate) this.firstSnapshot ??= frame.snapshot;
        return frame;
      },
      same: sameFrame,
      ask,
      discard,
      skip,
      waitAnswer: (fn) => this.timed('jev', fn),
    });
    if (reasked) this.phaseMs.reasked = (this.phaseMs.reasked ?? 0) + 1;
    return { frame, result };
  }

  /**
   * `expect` judges once; `wait` polls until the claim holds. Both judge a region alone when `within` names one.
   * An unchanged UI after a clear "no" is not asked again.
   */
  private async assert(step: S & Assertion, force = false): Promise<StepResult> {
    const claims = step.kind === 'expect' ? step.expectations : [step.condition];
    const ref = this.refOf(claimSlot(claims.map((claim) => this.generic(claim)), step.within === undefined ? undefined : this.generic(step.within)));
    if (ref && this.lock && !this.lock.judges && !force) return this.replayClaims(step, ref, claims);
    const deadline = Date.now() + this.timeout;
    let polls = 0;
    let lastSnapshotJson = '';
    let probabilities: number[] = [];
    let status: Status = 'inconclusive';
    let lastSnapshot;
    let region = step.within ? await this.region(step.within, true) : undefined;
    const spatial = await this.needsLayout(claims);
    const unchangedSinceNo = (frame: Frame<T>) => JSON.stringify(frame.snapshot) === lastSnapshotJson && status === 'fail';
    do {
      let looked;
      try {
        looked = await this.settled({
          kind: 'region', within: region, ask: this.judge(claims), discard: (unused) => this.track(unused.tokens), skip: unchangedSinceNo, spatial,
        });
      } catch (error) {
        // A region picked from an approximate capture turned out covered: pick it once more from an exact one.
        if (!(error instanceof HiddenTargetError) || this.phaseMs.retargeted || !step.within) throw error;
        this.retarget();
        region = await this.region(step.within);
        continue;
      }
      const { frame, result: judged } = looked;
      lastSnapshot = frame.snapshot;
      if (judged) {
        this.track(judged.tokens);
        probabilities = judged.probabilities;
        polls++;
        status = decideAll(probabilities);
      }
      lastSnapshotJson = JSON.stringify(lastSnapshot);
      if (step.kind === 'expect' || status === 'pass' || Date.now() >= deadline || polls >= MAX_WAIT_POLLS) break;
      const pause = Math.min(WAIT_POLL_MS, Math.max(0, deadline - Date.now()));
      await this.timed('idle', () => new Promise((resolve) => setTimeout(resolve, pause)));
    } while (Date.now() < deadline);
    if (step.kind === 'wait' && status !== 'pass') status = 'inconclusive';
    if (status === 'pass' && ref && lastSnapshot && this.lock?.judges) {
      const hash = nativeStateHash(lastSnapshot, this.parameters);
      this.lock.record(ref, { state: hash, spatial });
      saveRecordedState(hash, { claims, state: lastSnapshot });
    }
    const debug = status === 'pass' ? '' : ` — state: ${dumpDebug(step.kind, { claims, probabilities, state: lastSnapshot })}`;
    const detail = `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} after ${polls} poll(s)${debug}`;
    return { step: this.label(step), status, detail };
  }

  /**
   * no-judge `expect` and `wait`: pass when the screen (or the `within` region) shows the state recorded when Jev
   * judged the claims true; inconclusive otherwise, with the state seen.
   */
  private async replayClaims(step: S & Assertion, ref: LockRef, claims: string[]): Promise<StepResult> {
    const lock = this.lock;
    if (!lock) {
      return { step: this.label(step), status: 'inconclusive',
        detail: 'no-judge: no recorded passing state for this step; run with --mode auto-healing or judge to record it' };
    }
    const entry = lock.lookup(ref);
    if (!entry || isTargetEntry(entry)) {
      return { step: this.label(step), status: 'inconclusive',
        detail: 'no-judge: no recorded passing state for this step; run with --mode auto-healing or judge to record it' };
    }
    let region: T | undefined;
    try {
      region = step.within ? await this.region(step.within, false) : undefined;
    } catch (error) {
      return { step: this.label(step), status: 'inconclusive', detail: errorMessage(error) };
    }
    const deadline = Date.now() + (step.kind === 'expect' ? Math.min(EXPECT_REPLAY_MS, this.timeout) : this.timeout);
    for (;;) {
      const frame = await this.timed('capture', () => this.adapter.capture('region', region, entry.spatial ? { spatial: true } : undefined));
      if (nativeStateHash(frame.snapshot, this.parameters) === entry.state) return { step: this.label(step), status: 'pass', detail: 'the recorded passing state (no-judge)' };
      if (Date.now() >= deadline) {
        if (lock.staleClaims(ref.at.file)) return this.assert(step, true);
        const file = dumpDebug(step.kind, { claims, state: frame.snapshot });
        return { step: this.label(step), status: 'inconclusive',
          detail: `no-judge: the ${region === undefined ? 'screen' : 'region'} differs from the recorded passing state — state: ${file}${recordedStateNote(entry.state)}` };
      }
      await this.timed('idle', () => new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS)));
    }
  }

  private judge(claims: string[]) {
    return (frame: Frame<T>) => judgeState(frame.snapshot, claims, [], this.ai);
  }

  private trackResolved(resolved: { usedJev: boolean; tokens: number }[]) {
    for (const target of resolved) if (target.usedJev) this.track(target.tokens);
  }
}

/** Any platform's session, for the code that is shared by all of them. */
export type AnyNativeSession = NativeSession<unknown, string, NativeStep, NativeAdapter<unknown, string>>;

/** Same tree text, candidates and native handles: an answer about one frame holds for the other. */
function sameFrame<T>(a: Frame<T>, b: Frame<T>): boolean {
  return JSON.stringify(a.snapshot) === JSON.stringify(b.snapshot)
    && JSON.stringify(a.candidates) === JSON.stringify(b.candidates)
    && JSON.stringify([...a.elements]) === JSON.stringify([...b.elements]);
}
