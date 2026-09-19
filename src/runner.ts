import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page, type Locator } from 'playwright';
import type { Spec, Step } from './spec.js';
import { candidates, elementById, settle, snapshot, snapshotRegion, type CandidateKind, type Snapshot } from './page.js';
import { pickElement, judge, decide } from './jev.js';

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
  const cands = await candidates(page, kind);
  const { id, probability, probabilities, tokens } = await pickElement(cands, target);
  const accepted = id !== null && decide(probability, 'pick') === 'pass';

  if (!accepted) {
    // Show what Jev was torn between — the wording of the step is the lever to fix this.
    const top = Object.entries(probabilities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, p]) => `${k === 'none' ? 'none' : cands.find((c) => String(c.id) === k)?.desc} (p=${p.toFixed(2)})`);
    const dir = path.join(os.tmpdir(), 'jev-e2e');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-pick.json`);
    fs.writeFileSync(file, JSON.stringify({ instruction: target, probabilities, candidates: cands }, null, 2));
    const detail = `${id === null ? 'no matching element' : 'low confidence'} (${cands.length} candidates) — top: ${top.join(' | ')} — candidates: ${file}`;
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

export async function runSpec(spec: Spec, opts: { headed: boolean; timeout: number }): Promise<TestResult> {
  const browser = await chromium.launch({ headless: !opts.headed });
  const steps: StepResult[] = [];
  let jevCalls = 0;
  let totalTokens = 0;
  let overall: Status = 'pass';

  try {
    // `page` is the *active* page — a popup can replace it mid-run (see the 'popup' handler below),
    // so every step below must read this variable rather than capturing the initial page.
    let page = await browser.newPage();
    page.setDefaultTimeout(opts.timeout);

    const acceptDialogs = spec.dialogs !== 'dismiss';
    let pendingNotes: string[] = [];

    // ponytail: registered once, on the initial page, per the spec — good enough for one popup/dialog
    // per run; a dialog firing on a *second* popup would be missed, add a per-page listener if that's needed.
    page.on('dialog', async (dialog) => {
      pendingNotes.push(`dialog(${dialog.type()}): "${dialog.message()}" → ${acceptDialogs ? 'accepted' : 'dismissed'}`);
      if (acceptDialogs) await dialog.accept();
      else await dialog.dismiss();
    });
    page.on('popup', async (popup) => {
      popup.setDefaultTimeout(opts.timeout);
      await popup.waitForLoadState('load').catch(() => {});
      pendingNotes.push(`→ switched to new tab ${popup.url()}`);
      page = popup;
    });

    for (const step of spec.steps) {
      pendingNotes = [];
      const stepLabel = label(step);
      let result: StepResult;
      try {
        if (step.kind === 'goto') {
          const url = resolveUrl(spec.url, step.url);
          await page.goto(url, { waitUntil: 'load' });
          result = { step: stepLabel, status: 'pass' };
        } else if (step.kind === 'press') {
          await mayNavigate(page, () => page.keyboard.press(step.key));
          result = { step: stepLabel, status: 'pass' };
        } else if (step.kind === 'click') {
          const r = await resolveLocator(page, 'click', step.target);
          if (r.usedJev) {
            jevCalls++;
            totalTokens += r.tokens;
          }
          if (!r.locator) {
            result = { step: stepLabel, status: 'inconclusive', detail: r.detail };
          } else {
            await mayNavigate(page, () => r.locator!.click());
            result = { step: stepLabel, status: 'pass', detail: r.detail };
          }
        } else if (step.kind === 'fill') {
          const r = await resolveLocator(page, 'fill', step.target);
          if (r.usedJev) {
            jevCalls++;
            totalTokens += r.tokens;
          }
          if (!r.locator) {
            result = { step: stepLabel, status: 'inconclusive', detail: r.detail };
          } else {
            await r.locator.fill(step.value);
            // Typing usually fires a debounced request (autocomplete, validation); settle() alone can find
            // a quiet DOM before that request even starts. Give one triggered response a moment to land.
            await page
              .waitForResponse((res) => ['xhr', 'fetch'].includes(res.request().resourceType()), { timeout: 1500 })
              .catch(() => {});
            result = { step: stepLabel, status: 'pass', detail: r.detail };
          }
        } else if (step.kind === 'hover') {
          const r = await resolveLocator(page, 'hover', step.target);
          if (r.usedJev) {
            jevCalls++;
            totalTokens += r.tokens;
          }
          if (!r.locator) {
            result = { step: stepLabel, status: 'inconclusive', detail: r.detail };
          } else {
            await r.locator.hover();
            result = { step: stepLabel, status: 'pass', detail: r.detail };
          }
        } else if (step.kind === 'dblclick' || step.kind === 'rightclick') {
          const r = await resolveLocator(page, 'click', step.target);
          if (r.usedJev) {
            jevCalls++;
            totalTokens += r.tokens;
          }
          if (!r.locator) {
            result = { step: stepLabel, status: 'inconclusive', detail: r.detail };
          } else {
            const locator = r.locator;
            await mayNavigate(page, () => (step.kind === 'dblclick' ? locator.dblclick() : locator.click({ button: 'right' })));
            result = { step: stepLabel, status: 'pass', detail: r.detail };
          }
        } else if (step.kind === 'select') {
          const r = await resolveLocator(page, 'select', step.target);
          if (r.usedJev) {
            jevCalls++;
            totalTokens += r.tokens;
          }
          if (!r.locator) {
            result = { step: stepLabel, status: 'inconclusive', detail: r.detail };
          } else {
            try {
              await r.locator.selectOption({ label: step.value });
            } catch {
              await r.locator.selectOption(step.value);
            }
            result = { step: stepLabel, status: 'pass', detail: r.detail };
          }
        } else if (step.kind === 'check' || step.kind === 'uncheck') {
          const r = await resolveLocator(page, 'check', step.target);
          if (r.usedJev) {
            jevCalls++;
            totalTokens += r.tokens;
          }
          if (!r.locator) {
            result = { step: stepLabel, status: 'inconclusive', detail: r.detail };
          } else {
            if (step.kind === 'check') await r.locator.check();
            else await r.locator.uncheck();
            result = { step: stepLabel, status: 'pass', detail: r.detail };
          }
        } else if (step.kind === 'upload') {
          const r = await resolveLocator(page, 'upload', step.target);
          if (r.usedJev) {
            jevCalls++;
            totalTokens += r.tokens;
          }
          if (!r.locator) {
            result = { step: stepLabel, status: 'inconclusive', detail: r.detail };
          } else {
            const paths = step.files.map((f) => path.resolve(spec.dir, f));
            await r.locator.setInputFiles(paths);
            result = { step: stepLabel, status: 'pass', detail: r.detail };
          }
        } else if (step.kind === 'scroll') {
          if (step.target === 'top' || step.target === 'bottom') {
            await page.evaluate((pos) => window.scrollTo(0, pos === 'top' ? 0 : document.body.scrollHeight), step.target);
            await settle(page).catch(() => {});
            result = { step: stepLabel, status: 'pass' };
          } else {
            const r = await resolveLocator(page, 'click', step.target);
            if (r.usedJev) {
              jevCalls++;
              totalTokens += r.tokens;
            }
            if (!r.locator) {
              result = { step: stepLabel, status: 'inconclusive', detail: r.detail };
            } else {
              await r.locator.scrollIntoViewIfNeeded();
              await settle(page).catch(() => {});
              result = { step: stepLabel, status: 'pass', detail: r.detail };
            }
          }
        } else if (step.kind === 'wait') {
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
              const { url, title, aria } = snap;
              const { probability, tokens } = await judge({ url, title, aria }, step.condition);
              jevCalls++;
              totalTokens += tokens;
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
              const dir = path.join(os.tmpdir(), 'jev-e2e');
              fs.mkdirSync(dir, { recursive: true });
              const file = path.join(dir, `${Date.now()}-wait.json`);
              fs.writeFileSync(file, JSON.stringify({ condition: step.condition, probability: lastProbability, state: lastSnap }, null, 2));
              result = {
                step: stepLabel,
                status: 'inconclusive',
                detail: `p=${lastProbability.toFixed(2)} after ${polls} poll(s) — state: ${file}`,
              };
            }
          }
        } else {
          // expect
          await settle(page).catch(() => {}); // SPA route changes resolve 'load' instantly; wait for the content
          const judgeSnap = async (snap: Snapshot): Promise<StepResult> => {
            const { url, title, aria } = snap;
            const { probability, tokens } = await judge({ url, title, aria }, step.expectation);
            jevCalls++;
            totalTokens += tokens;
            const status = decide(probability, 'expect');
            let detail = `p=${probability.toFixed(2)} @ ${page.url()}`;
            if (snap.truncated) detail += ' (aria truncated at 60k chars)';
            if (status !== 'pass') {
              // Dump what Jev saw so the author can tune the expectation against the real state.
              const dir = path.join(os.tmpdir(), 'jev-e2e');
              fs.mkdirSync(dir, { recursive: true });
              const file = path.join(dir, `${Date.now()}-expect.json`);
              fs.writeFileSync(file, JSON.stringify({ expectation: step.expectation, probability, state: snap }, null, 2));
              detail += ` — state: ${file}`;
            }
            return { step: stepLabel, status, detail };
          };
          if (step.within) {
            const r = await resolveLocator(page, 'region', step.within);
            if (r.usedJev) {
              jevCalls++;
              totalTokens += r.tokens;
            }
            if (!r.locator) {
              result = { step: stepLabel, status: 'inconclusive', detail: r.detail };
            } else {
              result = await judgeSnap(await snapshotRegion(page, r.locator));
            }
          } else {
            result = await judgeSnap(await snapshot(page));
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
