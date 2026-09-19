import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page, type Locator } from 'playwright';
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
import { pickElement, judge, decide, isTooLong, MAX_PICK_CANDIDATES } from './jev.js';

export type Status = 'pass' | 'fail' | 'inconclusive' | 'error' | 'skipped';

export interface StepResult {
  step: string;
  status: Status;
  detail?: string;
}

export interface TestResult {
  name: string;
  status: Status;
  steps: StepResult[];
  jevCalls: number;
  totalTokens: number;
}

function label(step: Step): string {
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
    case 'expect':
      return step.within ? `expect "${step.expectation}" within "${step.within}"` : `expect "${step.expectation}"`;
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
}

async function resolveLocator(page: Page, kind: CandidateKind, target: string): Promise<Resolved> {
  if (target.startsWith('css=')) {
    const selector = target.slice(4);
    return { locator: page.locator(selector), detail: `→ css=${selector}`, tokens: 0, usedJev: false };
  }

  // Let debounced autocompletes, modals etc. finish rendering before we look (networkidle fires too early:
  // it sees the quiet gap *before* a debounced request starts).
  await settle(page).catch(() => {});
  const cands = await candidates(page, kind, MAX_PICK_CANDIDATES);
  const { id, probability, probabilities, tokens } = await pickElement(cands, target);
  const accepted = id !== null && decide(probability, 'pick') === 'pass';

  if (!accepted) {
    // Show what Jev was torn between — the wording of the step is the lever to fix this.
    const file = dumpDebug('pick', { instruction: target, probabilities, candidates: cands });
    const detail = `${id === null ? 'no matching element' : 'low confidence'} (${cands.length} candidates) — top: ${topGuesses(probabilities, cands)} — candidates: ${file}`;
    return { locator: null, detail, tokens, usedJev: true };
  }

  const cand = cands.find((c) => c.id === id)!;
  return {
    locator: elementById(page, id as number, cand.frameIndex),
    detail: `→ ${cand.desc} (p=${probability.toFixed(2)})`,
    tokens,
    usedJev: true,
  };
}

const MAX_EVENTS = 30; // ponytail: cap what's sent to Jev as `events` — a long spec shouldn't grow this unbounded

export async function runSpec(spec: Spec, opts: { headed: boolean; timeout: number }): Promise<TestResult> {
  const browser = await chromium.launch({ headless: !opts.headed });
  const steps: StepResult[] = [];
  let jevCalls = 0;
  let totalTokens = 0;
  let overall: Status = 'pass';

  // Every Jev call site accounts for itself through one of these two, so no step branch inlines the counters.
  function track(tokens: number): void {
    jevCalls++;
    totalTokens += tokens;
  }
  function trackResolved(r: Resolved): void {
    if (r.usedJev) track(r.tokens);
  }

  try {
    const contextOptions: Parameters<typeof browser.newContext>[0] = {};
    if (spec.auth) contextOptions.httpCredentials = { username: spec.auth.user, password: spec.auth.pass };
    if (spec.geolocation) {
      contextOptions.geolocation = { latitude: spec.geolocation.lat, longitude: spec.geolocation.lon };
      contextOptions.permissions = ['geolocation'];
    }
    const context = await browser.newContext(contextOptions);

    // `page` is the *active* page — a popup can replace it mid-run (see the 'popup' handler below),
    // so every step below must read this variable rather than capturing the initial page.
    let page = await context.newPage();
    page.setDefaultTimeout(opts.timeout);

    const acceptDialogs = spec.dialogs !== 'dismiss';
    let pendingNotes: string[] = [];
    // Visible to Jev on every `expect`/`wait` (see the `events` field passed to judge() below), so
    // "a JavaScript error happened" or "a file was downloaded" become answerable from state Jev sees.
    const events: string[] = [];

    function note(msg: string): void {
      pendingNotes.push(msg);
      events.push(msg);
      if (events.length > MAX_EVENTS) events.shift();
    }

    // Registered on the initial page and, from the 'popup' handler below, on every popup that becomes
    // active — fixes the earlier limitation where only the first page had listeners.
    function attach(p: Page): void {
      p.on('dialog', async (dialog) => {
        note(`dialog(${dialog.type()}): "${dialog.message()}" → ${acceptDialogs ? 'accepted' : 'dismissed'}`);
        if (acceptDialogs) await dialog.accept();
        else await dialog.dismiss();
      });
      p.on('popup', async (popup) => {
        popup.setDefaultTimeout(opts.timeout);
        await popup.waitForLoadState('load').catch(() => {});
        note(`→ switched to new tab ${popup.url()}`);
        attach(popup);
        page = popup;
      });
      p.on('download', async (download) => {
        const dir = path.join(os.tmpdir(), 'jev-e2e', 'downloads');
        fs.mkdirSync(dir, { recursive: true });
        const dest = path.join(dir, download.suggestedFilename());
        await download.saveAs(dest);
        note(`download: "${download.suggestedFilename()}" saved to ${dest}`);
      });
      p.on('pageerror', (err) => note(`pageerror: ${err.message}`));
      p.on('console', (msg) => {
        if (msg.type() === 'error') note(`console.error: ${msg.text()}`);
      });
    }
    attach(page);

    // Resolve `target` under `kind`, account for the Jev call, and either report "inconclusive" or run
    // `act` on the resolved locator — the resolve → account → branch triple every element-acting step shares.
    async function withResolved(
      kind: CandidateKind,
      target: string,
      stepLabel: string,
      act: (loc: Locator) => Promise<string | void>
    ): Promise<StepResult> {
      const r = await resolveLocator(page, kind, target);
      trackResolved(r);
      if (!r.locator) return { step: stepLabel, status: 'inconclusive', detail: r.detail };
      const extra = await act(r.locator);
      return { step: stepLabel, status: 'pass', detail: extra ? `${r.detail} ${extra}` : r.detail };
    }

    // The too-long-state halving retry (moved out of jev.ts's judge(), which no longer knows about
    // aria) plus the shared token accounting — every judge() call site goes through this.
    async function judgeSnapshot(snap: Snapshot, claim: string): Promise<{ probability: number }> {
      let s = snap;
      for (;;) {
        try {
          const { url, title, aria } = s;
          const { probability, tokens } = await judge({ url, title, aria, events }, claim);
          track(tokens);
          return { probability };
        } catch (err) {
          // A char cap can't guarantee the model's token limit (dense tables ≈ 2x tokens per char): halve and retry.
          if (!isTooLong(err) || s.aria.length < 4000) throw err;
          const half = s.aria.slice(0, Math.floor(s.aria.length / 2));
          s = { ...s, aria: half };
          console.error(`jev-e2e: state too long for the model, aria cut to ${half.length} chars — scope the expect with \`within\` for precision`);
        }
      }
    }

    for (const step of spec.steps) {
      pendingNotes = [];
      const stepLabel = label(step);
      let result: StepResult;
      try {
        switch (step.kind) {
          case 'goto': {
            const url = resolveUrl(spec.url, step.url);
            await page.goto(url, { waitUntil: 'load' });
            result = { step: stepLabel, status: 'pass' };
            break;
          }
          case 'press': {
            await mayNavigate(page, () => page.keyboard.press(step.key));
            result = { step: stepLabel, status: 'pass' };
            break;
          }
          case 'drag': {
            const rs = await resolveLocator(page, 'click', step.source);
            trackResolved(rs);
            if (!rs.locator) {
              result = { step: stepLabel, status: 'inconclusive', detail: rs.detail };
              break;
            }
            const rt = await resolveLocator(page, 'click', step.target);
            trackResolved(rt);
            if (!rt.locator) {
              result = { step: stepLabel, status: 'inconclusive', detail: rt.detail };
              break;
            }
            // ponytail: locator.dragTo() only synthesizes mouse events. Sites whose drag-and-drop
            // is wired to native HTML5 dragstart/dragover/drop (e.g. the-internet's
            // /drag_and_drop) never see it, so the swap silently doesn't happen. Use the manual
            // hover/mousedown/hover/hover/mouseup sequence Playwright's own docs recommend for
            // that case instead — there's no cheap, site-agnostic way to tell from inside this
            // generic step whether dragTo() actually took visual effect.
            await rs.locator.hover();
            await page.mouse.down();
            await rt.locator.hover();
            await rt.locator.hover();
            await page.mouse.up();
            result = { step: stepLabel, status: 'pass', detail: `${rs.detail} → ${rt.detail}` };
            break;
          }
          case 'mouse': {
            await page.mouse.move(step.x, step.y);
            result = { step: stepLabel, status: 'pass' };
            break;
          }
          case 'click': {
            result = await withResolved('click', step.target, stepLabel, (loc) => mayNavigate(page, () => loc.click()));
            break;
          }
          case 'fill': {
            result = await withResolved('fill', step.target, stepLabel, async (loc) => {
              await loc.fill(step.value);
              // Typing usually fires a debounced request (autocomplete, validation); settle() alone can find
              // a quiet DOM before that request even starts. Give one triggered response a moment to land.
              await page
                .waitForResponse((res) => ['xhr', 'fetch'].includes(res.request().resourceType()), { timeout: 1500 })
                .catch(() => {});
            });
            break;
          }
          case 'hover': {
            result = await withResolved('hover', step.target, stepLabel, (loc) => loc.hover());
            break;
          }
          case 'dblclick':
          case 'rightclick': {
            const dbl = step.kind === 'dblclick';
            result = await withResolved('click', step.target, stepLabel, (loc) =>
              mayNavigate(page, () => (dbl ? loc.dblclick() : loc.click({ button: 'right' })))
            );
            break;
          }
          case 'select': {
            result = await withResolved('select', step.target, stepLabel, async (loc) => {
              try {
                await loc.selectOption({ label: step.value });
              } catch {
                await loc.selectOption(step.value);
              }
            });
            break;
          }
          case 'check':
          case 'uncheck': {
            const doCheck = step.kind === 'check';
            result = await withResolved('check', step.target, stepLabel, (loc) => (doCheck ? loc.check() : loc.uncheck()));
            break;
          }
          case 'upload': {
            result = await withResolved('upload', step.target, stepLabel, (loc) => {
              const paths = step.files.map((f) => path.resolve(spec.dir, f));
              return loc.setInputFiles(paths);
            });
            break;
          }
          case 'scroll': {
            if (step.target === 'top' || step.target === 'bottom') {
              await page.evaluate((pos) => window.scrollTo(0, pos === 'top' ? 0 : document.body.scrollHeight), step.target);
              await settle(page).catch(() => {});
              result = { step: stepLabel, status: 'pass' };
            } else {
              result = await withResolved('click', step.target, stepLabel, async (loc) => {
                await loc.scrollIntoViewIfNeeded();
                await settle(page).catch(() => {});
              });
            }
            break;
          }
          case 'wait': {
            if (step.condition.startsWith('css=')) {
              await page.waitForSelector(step.condition.slice(4), { state: 'visible', timeout: opts.timeout });
              result = { step: stepLabel, status: 'pass' };
            } else {
              const MAX_POLLS = 8; // ponytail: hard cap on Jev polls per wait, floor against a condition that never holds
              const deadline = Date.now() + opts.timeout;
              let polls = 0;
              let lastProbability = 0;
              let lastSnap: Snapshot | null = null;
              let passed = false;
              while (polls < MAX_POLLS && Date.now() < deadline) {
                await settle(page).catch(() => {});
                const snap = await snapshot(page);
                const { probability } = await judgeSnapshot(snap, step.condition);
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
                result = { step: stepLabel, status: 'pass', detail: `p=${lastProbability.toFixed(2)} after ${polls} poll(s)` };
              } else {
                const file = dumpDebug('wait', { condition: step.condition, probability: lastProbability, state: lastSnap });
                result = {
                  step: stepLabel,
                  status: 'inconclusive',
                  detail: `p=${lastProbability.toFixed(2)} after ${polls} poll(s) — state: ${file}`,
                };
              }
            }
            break;
          }
          case 'expect': {
            const judgeExpectation = async (snap: Snapshot): Promise<StepResult> => {
              const { probability } = await judgeSnapshot(snap, step.expectation);
              const status = decide(probability, 'expect');
              let detail = `p=${probability.toFixed(2)} @ ${page.url()}`;
              if (snap.truncated) detail += ' (aria truncated at 60k chars)';
              if (status !== 'pass') {
                // Dump what Jev saw so the author can tune the expectation against the real state.
                const file = dumpDebug('expect', { expectation: step.expectation, probability, state: snap });
                detail += ` — state: ${file}`;
              }
              return { step: stepLabel, status, detail };
            };
            if (step.within) {
              const r = await resolveLocator(page, 'region', step.within);
              trackResolved(r);
              if (!r.locator) {
                result = { step: stepLabel, status: 'inconclusive', detail: r.detail };
              } else {
                result = await judgeExpectation(await snapshotRegion(page, r.locator));
              }
            } else {
              await settle(page).catch(() => {}); // SPA route changes resolve 'load' instantly; wait for the content
              result = await judgeExpectation(await snapshot(page));
            }
            break;
          }
        }
      } catch (err) {
        result = { step: stepLabel, status: 'error', detail: err instanceof Error ? err.message : String(err) };
      }

      if (pendingNotes.length) {
        result = { ...result, detail: [result.detail, ...pendingNotes].filter(Boolean).join(' | ') };
      }

      // ponytail: `optional: true` steps tolerate inconclusive/error (e.g. an intermittent
      // cookie banner) — report as skipped and keep going instead of failing the whole spec.
      if (step.optional && (result.status === 'inconclusive' || result.status === 'error')) {
        result = { ...result, status: 'skipped' };
        steps.push(result);
        continue;
      }

      steps.push(result);
      if (result.status !== 'pass') {
        overall = result.status;
        break;
      }
    }
  } finally {
    await browser.close();
  }

  return { name: spec.name, status: overall, steps, jevCalls, totalTokens };
}
