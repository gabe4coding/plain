import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page, Locator } from 'playwright';
import type { Spec, Step } from './spec.js';
import {
  candidates,
  elementById,
  settle,
  snapshot,
  snapshotRegion,
  type Candidate,
  type CandidateKind,
  type Snapshot,
} from './page.js';
import { pickElements, judge, decide, isTooLong, MAX_PICK_CANDIDATES } from './jev.js';

export type Status = 'pass' | 'fail' | 'inconclusive' | 'error' | 'skipped';

export interface StepResult {
  step: string;
  status: Status;
  detail?: string;
}

export function label(step: Step): string {
  switch (step.kind) {
    case 'goto':
      return `goto ${step.url}`;
    case 'fill':
      return `fill "${step.target}"`;
    case 'click':
      return `click "${step.target}"`;
    case 'hover':
      return `hover "${step.target}"`;
    case 'dblclick':
      return `dblclick "${step.target}"`;
    case 'rightclick':
      return `rightclick "${step.target}"`;
    case 'select':
      return `select "${step.value}" in "${step.target}"`;
    case 'check':
      return `check "${step.target}"`;
    case 'uncheck':
      return `uncheck "${step.target}"`;
    case 'upload':
      return `upload ${step.files.length} file(s) to "${step.target}"`;
    case 'scroll':
      return `scroll "${step.target}"`;
    case 'wait':
      return `wait "${step.condition}"`;
    case 'press':
      return `press ${step.key}`;
    case 'drag':
      return `drag "${step.source}" to "${step.target}"`;
    case 'mouse':
      return `mouse to (${step.x}, ${step.y})`;
    case 'expect': {
      const claim = step.expectations.length > 1 ? step.expectations.join(' | ') : step.expectations[0];
      return step.within ? `expect "${claim}" within "${step.within}"` : `expect "${claim}"`;
    }
  }
}

/**
 * Run an action that may trigger a navigation (click on a link-like element, Enter in a form) and, if one
 * starts within a short window, wait for the new document to load. Without this the next step reads the
 * old page while the navigation is in flight and can fire a second navigation on top of it.
 */
async function mayNavigate(page: Page, action: () => Promise<void>): Promise<void> {
  const nav = page
    .waitForEvent('framenavigated', { timeout: 1500, predicate: (f) => f === page.mainFrame() })
    .then(() => page.waitForLoadState('load'))
    .catch(() => {}); // no navigation started — that's fine
  await action();
  await nav;
}

function resolveUrl(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  // ponytail: treat `url` as the app's base directory, not just its origin — a plain WHATWG
  // `new URL(path, base)` join drops the base's own path for any path starting with "/", which
  // sends "goto: /" to the origin's root instead of back to the app under test.
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`;
  const rel = path.startsWith('/') ? path.slice(1) : path;
  return new URL(rel, baseWithSlash).toString();
}

/** Dump debug data to a temp file for a rejection/timeout/fail detail line, and return its path. */
function dumpDebug(kind: string, data: unknown): string {
  const dir = path.join(os.tmpdir(), 'jev-e2e');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${kind}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** Top 3 candidates by probability, formatted for a pick-rejection detail line. */
function topGuesses(probabilities: Record<string, number>, candidates: Candidate[]): string {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, p]) => `${k === 'none' ? 'none' : candidates.find((c) => String(c.id) === k)?.desc} (p=${p.toFixed(2)})`)
    .join(' | ');
}

interface Resolved {
  locator: Locator | null;
  detail: string;
  tokens: number;
  usedJev: boolean;
  confidence?: number;
}

// Resolves several targets of the same kind in one pass: css= targets resolve directly, the rest
// share ONE settle + ONE candidate scan + ONE pickElements() request (one request = one Jev call —
// only the first Jev-resolved entry carries usedJev/tokens, matching pickElements()'s own contract).
// Results come back in the same order as `targets`.
async function resolveLocators(page: Page, kind: CandidateKind, targets: string[]): Promise<Resolved[]> {
  const results: Resolved[] = new Array(targets.length);
  const jevIndices: number[] = [];
  const jevTargets: string[] = [];

  targets.forEach((target, i) => {
    if (target.startsWith('css=')) {
      const selector = target.slice(4);
      results[i] = { locator: page.locator(selector), detail: `→ css=${selector}`, tokens: 0, usedJev: false };
    } else {
      jevIndices.push(i);
      jevTargets.push(target);
    }
  });

  if (jevTargets.length > 0) {
    // Let debounced autocompletes, modals etc. finish rendering before we look (networkidle fires too early:
    // it sees the quiet gap *before* a debounced request starts).
    await settle(page).catch(() => {});
    const cands = await candidates(page, kind, MAX_PICK_CANDIDATES);
    const picks = await pickElements(cands, jevTargets, { url: page.url(), title: await page.title() });

    jevIndices.forEach((origIndex, j) => {
      const { id, probability, confidence, probabilities, tokens } = picks[j];
      const score = confidence ?? probability;
      const accepted = id !== null && decide(score, 'pick') === 'pass';
      const usedJev = j === 0; // one request for the whole batch — only the first result carries it
      const cPart = confidence !== undefined ? ` c=${confidence.toFixed(2)}` : '';

      if (!accepted) {
        // Show what Jev was torn between — the wording of the step is the lever to fix this.
        const file = dumpDebug('pick', { instruction: jevTargets[j], probabilities, confidence, candidates: cands });
        const detail = `${id === null ? 'no matching element' : 'low confidence'} (${cands.length} candidates)${cPart} — top: ${topGuesses(probabilities, cands)} — candidates: ${file}`;
        results[origIndex] = { locator: null, detail, tokens, usedJev, confidence };
        return;
      }

      const cand = cands.find((c) => c.id === id)!;
      results[origIndex] = {
        locator: elementById(page, id as number, cand.frameIndex),
        detail: `→ ${cand.desc} (p=${probability.toFixed(2)}${cPart})`,
        tokens,
        usedJev,
        confidence,
      };
    });
  }

  return results;
}

async function resolveLocator(page: Page, kind: CandidateKind, target: string): Promise<Resolved> {
  return (await resolveLocators(page, kind, [target]))[0];
}

export interface StepContext {
  // The active page, which can be replaced mid-run by a popup listener (see runner.ts).
  // Read this property live every time — do not cache it.
  readonly page: Page;
  spec: Spec;
  timeout: number;
  events: string[];
  track: (tokens: number) => void;
}

function trackResolved(ctx: StepContext, r: Resolved): void {
  if (r.usedJev) ctx.track(r.tokens);
}

// Resolve `target` under `kind`, account for the Jev call, and either report "inconclusive" or run
// `act` on the resolved locator — the resolve → account → branch triple every element-acting step shares.
async function withResolved(
  ctx: StepContext,
  kind: CandidateKind,
  target: string,
  stepLabel: string,
  act: (loc: Locator) => Promise<string | void>
): Promise<StepResult> {
  const r = await resolveLocator(ctx.page, kind, target);
  trackResolved(ctx, r);
  if (!r.locator) return { step: stepLabel, status: 'inconclusive', detail: r.detail };
  const extra = await act(r.locator);
  return { step: stepLabel, status: 'pass', detail: extra ? `${r.detail} ${extra}` : r.detail };
}

// The too-long-state halving retry (moved out of jev.ts's judge(), which no longer knows about
// aria) plus the shared token accounting — every judge() call site goes through this. One request
// judges every claim (each still its own Noul question, so its own probability).
async function judgeSnapshot(ctx: StepContext, snap: Snapshot, claims: string[]): Promise<{ probabilities: number[] }> {
  let s = snap;
  for (;;) {
    try {
      const { url, title, aria } = s;
      const { probabilities, tokens } = await judge({ url, title, aria, events: ctx.events }, claims);
      ctx.track(tokens);
      return { probabilities };
    } catch (err) {
      // A char cap can't guarantee the model's token limit (dense tables ≈ 2x tokens per char): halve and retry.
      if (!isTooLong(err) || s.aria.length < 4000) throw err;
      const half = s.aria.slice(0, Math.floor(s.aria.length / 2));
      s = { ...s, aria: half };
      console.error(`jev-e2e: state too long for the model, aria cut to ${half.length} chars — scope the expect with \`within\` for precision`);
    }
  }
}

async function runDrag(ctx: StepContext, step: Extract<Step, { kind: 'drag' }>, stepLabel: string): Promise<StepResult> {
  const [rs, rt] = await resolveLocators(ctx.page, 'click', [step.source, step.target]);
  trackResolved(ctx, rs);
  trackResolved(ctx, rt);
  if (!rs.locator) {
    return { step: stepLabel, status: 'inconclusive', detail: rs.detail };
  }
  if (!rt.locator) {
    return { step: stepLabel, status: 'inconclusive', detail: rt.detail };
  }
  // ponytail: locator.dragTo() only synthesizes mouse events. Sites whose drag-and-drop
  // is wired to native HTML5 dragstart/dragover/drop (e.g. the-internet's
  // /drag_and_drop) never see it, so the swap silently doesn't happen. Use the manual
  // hover/mousedown/hover/hover/mouseup sequence Playwright's own docs recommend for
  // that case instead — there's no cheap, site-agnostic way to tell from inside this
  // generic step whether dragTo() actually took visual effect.
  await rs.locator.hover();
  await ctx.page.mouse.down();
  await rt.locator.hover();
  await rt.locator.hover();
  await ctx.page.mouse.up();
  return { step: stepLabel, status: 'pass', detail: `${rs.detail} → ${rt.detail}` };
}

async function runWait(ctx: StepContext, step: Extract<Step, { kind: 'wait' }>, stepLabel: string): Promise<StepResult> {
  if (step.condition.startsWith('css=')) {
    await ctx.page.waitForSelector(step.condition.slice(4), { state: 'visible', timeout: ctx.timeout });
    return { step: stepLabel, status: 'pass' };
  }
  const MAX_POLLS = 8; // ponytail: hard cap on Jev polls per wait, floor against a condition that never holds
  const deadline = Date.now() + ctx.timeout;
  let polls = 0;
  let lastProbability = 0;
  let lastSnap: Snapshot | null = null;
  let passed = false;
  while (polls < MAX_POLLS && Date.now() < deadline) {
    await settle(ctx.page).catch(() => {});
    const snap = await snapshot(ctx.page);
    const { probabilities } = await judgeSnapshot(ctx, snap, [step.condition]);
    const probability = probabilities[0];
    polls++;
    lastProbability = probability;
    lastSnap = snap;
    if (decide(probability, 'expect') === 'pass') {
      passed = true;
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1500, remaining)));
  }
  if (passed) {
    return { step: stepLabel, status: 'pass', detail: `p=${lastProbability.toFixed(2)} after ${polls} poll(s)` };
  }
  const file = dumpDebug('wait', { condition: step.condition, probability: lastProbability, state: lastSnap });
  return {
    step: stepLabel,
    status: 'inconclusive',
    detail: `p=${lastProbability.toFixed(2)} after ${polls} poll(s) — state: ${file}`,
  };
}

async function runExpect(ctx: StepContext, step: Extract<Step, { kind: 'expect' }>, stepLabel: string): Promise<StepResult> {
  const judgeExpectations = async (snap: Snapshot): Promise<StepResult> => {
    const { probabilities } = await judgeSnapshot(ctx, snap, step.expectations);
    const decisions = probabilities.map((p) => decide(p, 'expect'));
    // fail beats inconclusive beats pass: one broken claim fails the step even if the rest hold.
    const status: Status = decisions.includes('fail') ? 'fail' : decisions.includes('inconclusive') ? 'inconclusive' : 'pass';
    let detail = `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} @ ${ctx.page.url()}`;
    if (snap.truncated) detail += ' (aria truncated at 60k chars)';
    if (status !== 'pass') {
      // Dump what Jev saw so the author can tune the expectations against the real state.
      const file = dumpDebug('expect', { expectations: step.expectations, probabilities, state: snap });
      detail += ` — state: ${file}`;
    }
    return { step: stepLabel, status, detail };
  };
  if (step.within) {
    const r = await resolveLocator(ctx.page, 'region', step.within);
    trackResolved(ctx, r);
    if (!r.locator) {
      return { step: stepLabel, status: 'inconclusive', detail: r.detail };
    }
    return judgeExpectations(await snapshotRegion(ctx.page, r.locator));
  }
  await settle(ctx.page).catch(() => {}); // SPA route changes resolve 'load' instantly; wait for the content
  return judgeExpectations(await snapshot(ctx.page));
}

export async function runStep(ctx: StepContext, step: Step): Promise<StepResult> {
  const stepLabel = label(step);
  switch (step.kind) {
    case 'goto': {
      const url = resolveUrl(ctx.spec.url, step.url);
      await ctx.page.goto(url, { waitUntil: 'load' });
      return { step: stepLabel, status: 'pass' };
    }
    case 'press': {
      await mayNavigate(ctx.page, () => ctx.page.keyboard.press(step.key));
      return { step: stepLabel, status: 'pass' };
    }
    case 'drag':
      return runDrag(ctx, step, stepLabel);
    case 'mouse': {
      await ctx.page.mouse.move(step.x, step.y);
      return { step: stepLabel, status: 'pass' };
    }
    case 'click':
      return withResolved(ctx, 'click', step.target, stepLabel, (loc) => mayNavigate(ctx.page, () => loc.click()));
    case 'fill':
      return withResolved(ctx, 'fill', step.target, stepLabel, async (loc) => {
        await loc.fill(step.value);
        // Typing usually fires a debounced request (autocomplete, validation); settle() alone can find
        // a quiet DOM before that request even starts. Give one triggered response a moment to land.
        await ctx.page
          .waitForResponse((res) => ['xhr', 'fetch'].includes(res.request().resourceType()), { timeout: 1500 })
          .catch(() => {});
      });
    case 'hover':
      return withResolved(ctx, 'hover', step.target, stepLabel, (loc) => loc.hover());
    case 'dblclick':
    case 'rightclick': {
      const dbl = step.kind === 'dblclick';
      return withResolved(ctx, 'click', step.target, stepLabel, (loc) =>
        mayNavigate(ctx.page, () => (dbl ? loc.dblclick() : loc.click({ button: 'right' })))
      );
    }
    case 'select':
      return withResolved(ctx, 'select', step.target, stepLabel, async (loc) => {
        try {
          await loc.selectOption({ label: step.value });
        } catch {
          await loc.selectOption(step.value);
        }
      });
    case 'check':
    case 'uncheck': {
      const doCheck = step.kind === 'check';
      return withResolved(ctx, 'check', step.target, stepLabel, (loc) => (doCheck ? loc.check() : loc.uncheck()));
    }
    case 'upload':
      return withResolved(ctx, 'upload', step.target, stepLabel, (loc) => {
        const paths = step.files.map((f) => path.resolve(ctx.spec.dir, f));
        return loc.setInputFiles(paths);
      });
    case 'scroll': {
      if (step.target === 'top' || step.target === 'bottom') {
        await ctx.page.evaluate((pos) => window.scrollTo(0, pos === 'top' ? 0 : document.body.scrollHeight), step.target);
        await settle(ctx.page).catch(() => {});
        return { step: stepLabel, status: 'pass' };
      }
      return withResolved(ctx, 'click', step.target, stepLabel, async (loc) => {
        await loc.scrollIntoViewIfNeeded();
        await settle(ctx.page).catch(() => {});
      });
    }
    case 'wait':
      return runWait(ctx, step, stepLabel);
    case 'expect':
      return runExpect(ctx, step, stepLabel);
  }
}
