import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import type { Spec } from './spec.js';
import { runStep, label, type StepContext, type StepResult, type Status } from './steps.js';

export interface TestResult {
  name: string;
  status: Status;
  steps: StepResult[];
  jevCalls: number;
  totalTokens: number;
}

const MAX_EVENTS = 30; // ponytail: cap what's sent to Jev as `events` — a long spec shouldn't grow this unbounded

export interface Session {
  ctx: StepContext;
  drainNotes(): string[];
  close(): Promise<void>;
}

// Launches the browser/context/page for one spec and wires up the listeners every step relies on
// (dialogs, popups, downloads, console/page errors). Shared by the batch runner below and by the
// MCP server, which keeps one Session alive across many tool calls instead of one spec.
export async function openSession(
  spec: Spec,
  opts: { headed: boolean; timeout: number },
  track: (tokens: number) => void
): Promise<Session> {
  const browser = await chromium.launch({ headless: !opts.headed });

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

  const ctx: StepContext = { get page() { return page; }, spec, timeout: opts.timeout, events, track };

  return {
    ctx,
    drainNotes(): string[] {
      const notes = pendingNotes;
      pendingNotes = [];
      return notes;
    },
    close: () => browser.close(),
  };
}

export async function runSpec(spec: Spec, opts: { headed: boolean; timeout: number }): Promise<TestResult> {
  const steps: StepResult[] = [];
  let jevCalls = 0;
  let totalTokens = 0;
  let overall: Status = 'pass';

  // Every Jev call site accounts for itself through one of these two, so no step branch inlines the counters.
  function track(tokens: number): void {
    jevCalls++;
    totalTokens += tokens;
  }

  const session = await openSession(spec, opts, track);
  try {
    for (const step of spec.steps) {
      let result: StepResult;
      try {
        result = await runStep(session.ctx, step);
      } catch (err) {
        result = { step: label(step), status: 'error', detail: err instanceof Error ? err.message : String(err) };
      }

      const notes = session.drainNotes();
      if (notes.length) {
        result = { ...result, detail: [result.detail, ...notes].filter(Boolean).join(' | ') };
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
    await session.close();
  }

  return { name: spec.name, status: overall, steps, jevCalls, totalTokens };
}
