import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { Spec } from '../core/spec.js';
import { installSettleObserver } from './page.js';
import { holdActivity } from './activity.js';
import { browserContextOptions } from './context-options.js';
import { MAX_EVENTS, isConsoleNoise, noiseNote, pushCollapsed, shortNote } from './notes.js';
import type { StepContext } from './context.js';
import type { RunOptions } from './run-options.js';

/** A browser page with the listeners every step relies on. A spec run has one; the MCP server keeps one alive. */
export interface Session {
  ctx: StepContext;
  downloadsDir: string;
  /** Notes since the last call: dialogs, popups, downloads, page and console errors. */
  drainNotes(): string[];
  close(): Promise<void>;
}

/**
 * One Chromium per launch configuration for the whole process; each spec gets its own context. The launch
 * promise is shared, so concurrent first callers (--workers > 1) wait for the same launch.
 */
let shared: { key: string; browser: Promise<Browser> } | null = null;

const launchOptions = (opts: RunOptions) => ({
  headless: !opts.headed,
  channel: opts.channel,
  handleSIGINT: opts.handleSignals,
  handleSIGTERM: opts.handleSignals,
  handleSIGHUP: opts.handleSignals,
});

/** The shared browser, relaunched when the configuration changed or it died. */
export async function sharedBrowser(opts: RunOptions): Promise<Browser> {
  const key = `${!opts.headed}|${opts.channel ?? ''}|${opts.handleSignals ?? true}`;
  if (shared && shared.key === key) {
    const browser = await shared.browser;
    if (browser.isConnected()) return browser;
  }
  // Awaited only when there is a browser to replace: on the first call this stays synchronous up to the
  // assignment below, so concurrent callers see the launch in progress.
  if (shared) await closeSharedBrowser();
  const entry = { key, browser: chromium.launch(launchOptions(opts)) };
  shared = entry;
  entry.browser.catch(() => {
    if (shared === entry) shared = null; // a failed launch is not cached: the next call retries
  });
  return entry.browser;
}

export async function closeSharedBrowser(): Promise<void> {
  const closing = shared;
  shared = null;
  if (closing) await (await closing.browser).close().catch(() => {});
}

/**
 * Attaches to the user's running browser, launches a persistent profile, or opens a context in the shared
 * browser (the default). Attached, it opens its own tab and only disconnects: the user's Chrome stays open.
 */
async function openPage(spec: Spec, opts: RunOptions): Promise<{ page: Page; close: () => Promise<void> }> {
  const contextOptions = browserContextOptions(spec, opts);
  if (opts.cdp) {
    const browser = await chromium.connectOverCDP(opts.cdp);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const tab = await context.newPage();
    return {
      page: tab,
      close: async () => {
        await tab.close().catch(() => {});
        await browser.close(); // on a connected browser this only disconnects
      },
    };
  }
  if (opts.profile) {
    const context = await chromium.launchPersistentContext(opts.profile, { ...launchOptions(opts), ...contextOptions });
    return { page: context.pages()[0] ?? (await context.newPage()), close: () => context.close() };
  }
  const browser = await sharedBrowser(opts);
  const context = await browser.newContext(contextOptions);
  return { page: await context.newPage(), close: () => context.close() };
}

export async function openSession(spec: Spec, opts: RunOptions, track: (tokens: number) => void): Promise<Session> {
  const opened = await openPage(spec, opts);
  // Each session has its own folder, so specs never see each other's downloads.
  const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-downloads-'));

  // The active page: a popup replaces it (see `attach`).
  let page = opened.page;
  page.setDefaultTimeout(opts.timeout);
  // Over CDP the context is the user's own browser: observe our tab only.
  await installSettleObserver(opts.cdp ? page : page.context());

  const acceptDialogs = spec.dialogs !== 'dismiss';
  const pendingNotes: string[] = [];
  /** Console noise since the last drain, reported as one note; it never reaches `events`, so Jev never sees it. */
  let noise = 0;
  /** What every judgment sees, so "a file was downloaded" or "a JavaScript error happened" can be judged. */
  const events: string[] = [];

  function note(message: string): void {
    const short = shortNote(message);
    pushCollapsed(pendingNotes, short);
    pushCollapsed(events, short);
    if (events.length > MAX_EVENTS) events.shift();
  }

  /** Wires the listeners on the first page and on every popup that becomes the active page. */
  function attach(target: Page): void {
    target.on('dialog', async (dialog) => {
      note(`dialog(${dialog.type()}): "${dialog.message()}" → ${acceptDialogs ? 'accepted' : 'dismissed'}`);
      await (acceptDialogs ? dialog.accept() : dialog.dismiss());
    });
    target.on('popup', async (popup) => {
      const release = holdActivity(target); // the next step waits until the new tab is the active page
      try {
        popup.setDefaultTimeout(opts.timeout);
        await popup.waitForLoadState('load').catch(() => {});
        note(`→ switched to new tab ${popup.url()}`);
        attach(popup);
        page = popup;
      } finally {
        release();
      }
    });
    target.on('download', async (download) => {
      const release = holdActivity(target); // the click that started it waits until the note is written
      try {
        const destination = path.join(downloadsDir, download.suggestedFilename());
        await download.saveAs(destination);
        note(`download: "${download.suggestedFilename()}" saved to ${destination}`);
      } finally {
        release();
      }
    });
    target.on('pageerror', (error) => note(`pageerror: ${error.message}`));
    target.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (isConsoleNoise(message.text(), message.location().url, target.url())) noise++;
      else note(`console.error: ${message.text()}`);
    });
  }
  attach(page);

  const ctx: StepContext = { get page() { return page; }, spec, timeout: opts.timeout, events, track, ms: {} };
  return {
    ctx,
    downloadsDir,
    drainNotes: () => {
      const notes = pendingNotes.splice(0);
      if (noise) notes.push(noiseNote(noise));
      noise = 0;
      return notes;
    },
    close: async () => {
      try {
        await opened.close();
      } finally {
        fs.rmSync(downloadsDir, { recursive: true, force: true }); // even if the context failed to close
      }
    },
  };
}
