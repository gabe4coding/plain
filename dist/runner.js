import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { interpolate } from './spec.js';
import { runStep, label, StatusSchema, StepResultSchema, holdActivity } from './steps.js';
import { installSettleObserver } from './page.js';
// Imports and validates a hooks module — shared by the batch runner and the MCP server's `open
// {hooks}`, so both fail the same way on a broken module.
export async function loadHooks(file) {
    const hooks = await import(pathToFileURL(file).href);
    if (hooks.setup !== undefined && typeof hooks.setup !== 'function')
        throw new Error(`${file}: "setup" must be a function`);
    if (hooks.teardown !== undefined && typeof hooks.teardown !== 'function')
        throw new Error(`${file}: "teardown" must be a function`);
    return hooks;
}
// Runs `hooks.setup` if present and applies the "setup must return an object" rule — `{}` when
// there's no setup or it returned undefined, so callers always get a usable `${hooks.*}` bag.
export async function runSetup(hooks, args) {
    if (!hooks.setup)
        return {};
    const returned = await hooks.setup(args);
    if (returned === undefined)
        return {};
    if (returned === null || typeof returned !== 'object')
        throw new Error('setup must return an object');
    return returned;
}
export const TestResultSchema = z.object({
    name: z.string(),
    status: StatusSchema,
    steps: z.array(StepResultSchema),
    jevCalls: z.number(),
    totalTokens: z.number(),
});
const MAX_EVENTS = 30; // ponytail: cap what's sent to Jev as `events` — a long spec shouldn't grow this unbounded
// Launches the browser/context/page for one spec and wires up the listeners every step relies on
// (dialogs, popups, downloads, console/page errors). Shared by the batch runner below and by the
// MCP server, which keeps one Session alive across many tool calls instead of one spec.
export const RunOptionsSchema = z.object({
    headed: z.boolean(),
    timeout: z.number(),
    /** Persistent user-data dir: cookies and logins survive between runs. Ignored when `cdp` is set. */
    profile: z.string().optional(),
    /** Attach to a running Chrome over CDP instead of launching one. */
    cdp: z.string().optional(),
    /** Playwright browser channel to launch instead of the bundled Chromium. */
    channel: z.string().optional(),
});
// One Chromium per launch profile for the whole process; each spec gets its own context (isolation
// unchanged) and only the context is closed per spec. Relaunched if headed/channel change or it died.
// The in-flight launch *promise* is memoized (not the resolved Browser): concurrent first callers
// (--workers > 1) then all await the same launch instead of each starting its own Chromium.
let shared = null;
export async function sharedBrowser(opts) {
    const key = `${!opts.headed}|${opts.channel ?? ''}`;
    if (shared && shared.key === key) {
        const b = await shared.browser;
        if (b.isConnected())
            return b;
    }
    // ponytail: only await closeSharedBrowser() when there's actually something to replace — on the
    // very first call `shared` is still null here, so this stays synchronous up to the assignment
    // below and concurrent callers see it before racing off to launch their own browser.
    if (shared)
        await closeSharedBrowser();
    if (!shared) {
        const entry = { key, browser: chromium.launch({ headless: !opts.headed, channel: opts.channel }) };
        shared = entry;
        entry.browser.catch(() => {
            if (shared === entry)
                shared = null; // don't cache a failed launch — let the next call retry
        });
    }
    return shared.browser;
}
export async function closeSharedBrowser() {
    const s = shared;
    shared = null;
    if (s)
        await (await s.browser).close().catch(() => { });
}
/** Runs `fn` over `items` with at most `limit` in flight; each item's promise settles independently, in
 *  input order — so a caller can await them one by one while later ones keep running in the background. */
export function mapLimitSettled(items, limit, fn) {
    const results = [];
    const settlers = [];
    for (let i = 0; i < items.length; i++) {
        results.push(new Promise((resolve, reject) => (settlers[i] = { resolve, reject })));
    }
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            try {
                settlers[i].resolve(await fn(items[i]));
            }
            catch (err) {
                settlers[i].reject(err);
            }
        }
    }
    for (let i = 0; i < Math.min(limit, items.length); i++)
        worker(); // fire and forget: callers await `results`
    return results;
}
/** Runs `fn` over `items` with at most `limit` in flight; resolves to results in input order. */
export async function mapLimit(items, limit, fn) {
    return Promise.all(mapLimitSettled(items, limit, fn));
}
// Three ways to get a page: attach to the user's running browser, launch a persistent profile, or
// reuse the shared throwaway browser (the default). Returns the page plus how to release it: attaching must
// disconnect (never close the user's Chrome) and only close the tab it opened.
async function openPage(spec, opts) {
    const contextOptions = {};
    if (spec.auth)
        contextOptions.httpCredentials = { username: spec.auth.user, password: spec.auth.pass };
    if (spec.geolocation) {
        contextOptions.geolocation = { latitude: spec.geolocation.lat, longitude: spec.geolocation.lon };
        contextOptions.permissions = ['geolocation'];
    }
    if (opts.cdp) {
        if (spec.auth || spec.geolocation) {
            throw new Error('--cdp attaches to an existing browser context: `auth` and `geolocation` in the spec are not supported there');
        }
        const browser = await chromium.connectOverCDP(opts.cdp);
        const context = browser.contexts()[0] ?? (await browser.newContext());
        const tab = await context.newPage(); // our own tab, so the user's current one is left alone
        return {
            page: tab,
            close: async () => {
                await tab.close().catch(() => { });
                await browser.close(); // on a connected browser this only disconnects
            },
        };
    }
    if (opts.profile) {
        const context = await chromium.launchPersistentContext(opts.profile, { headless: !opts.headed, channel: opts.channel, ...contextOptions });
        return { page: context.pages()[0] ?? (await context.newPage()), close: () => context.close() };
    }
    const browser = await sharedBrowser(opts);
    const context = await browser.newContext(contextOptions);
    return { page: await context.newPage(), close: () => context.close() };
}
export async function openSession(spec, opts, track) {
    const opened = await openPage(spec, opts);
    // Own directory per session so concurrent/consecutive specs never see each other's downloads.
    const downloadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainwright-downloads-'));
    // `page` is the *active* page — a popup can replace it mid-run (see the 'popup' handler below),
    // so every step below must read this variable rather than capturing the initial page.
    let page = opened.page;
    page.setDefaultTimeout(opts.timeout);
    // Over CDP the context is the user's live browser: keep the observer to our own tab, leave theirs alone.
    await installSettleObserver(opts.cdp ? page : page.context());
    const acceptDialogs = spec.dialogs !== 'dismiss';
    let pendingNotes = [];
    // Visible to Jev on every `expect`/`wait` (see the `events` field passed to judge() below), so
    // "a JavaScript error happened" or "a file was downloaded" become answerable from state Jev sees.
    const events = [];
    function note(msg) {
        pendingNotes.push(msg);
        events.push(msg);
        if (events.length > MAX_EVENTS)
            events.shift();
    }
    // Registered on the initial page and, from the 'popup' handler below, on every popup that becomes
    // active — fixes the earlier limitation where only the first page had listeners.
    function attach(p) {
        p.on('dialog', async (dialog) => {
            note(`dialog(${dialog.type()}): "${dialog.message()}" → ${acceptDialogs ? 'accepted' : 'dismissed'}`);
            if (acceptDialogs)
                await dialog.accept();
            else
                await dialog.dismiss();
        });
        p.on('popup', async (popup) => {
            popup.setDefaultTimeout(opts.timeout);
            await popup.waitForLoadState('load').catch(() => { });
            note(`→ switched to new tab ${popup.url()}`);
            attach(popup);
            page = popup;
        });
        p.on('download', async (download) => {
            const release = holdActivity(p); // the click that started it keeps waiting until the note is written
            try {
                // Per-session directory (created in openSession): isolates downloads across specs and runs.
                const dest = path.join(downloadsDir, download.suggestedFilename());
                await download.saveAs(dest);
                note(`download: "${download.suggestedFilename()}" saved to ${dest}`);
            }
            finally {
                release();
            }
        });
        p.on('pageerror', (err) => note(`pageerror: ${err.message}`));
        p.on('console', (msg) => {
            if (msg.type() === 'error')
                note(`console.error: ${msg.text()}`);
        });
    }
    attach(page);
    const ctx = { get page() { return page; }, spec, timeout: opts.timeout, events, track, ms: {} };
    return {
        ctx,
        downloadsDir,
        drainNotes() {
            const notes = pendingNotes;
            pendingNotes = [];
            return notes;
        },
        close: async () => {
            try {
                await opened.close();
            }
            finally {
                fs.rmSync(downloadsDir, { recursive: true, force: true }); // leave nothing behind, even if the context failed to close
            }
        },
    };
}
export async function runSpec(spec, opts) {
    const steps = [];
    let jevCalls = 0;
    let totalTokens = 0;
    let overall = 'pass';
    // Every Jev call site accounts for itself through one of these two, so no step branch inlines the counters.
    function track(tokens) {
        jevCalls++;
        totalTokens += tokens;
    }
    // Imported before the browser opens so a broken hooks module fails fast — no session to clean up yet.
    let hooks = {};
    if (spec.hooks)
        hooks = await loadHooks(spec.hooks);
    const session = await openSession(spec, opts, track);
    // What setup returns, exposed to steps/teardown as `${hooks.*}`/`data` — `{}` when there's no setup.
    let data = {};
    if (hooks.setup) {
        try {
            data = await runSetup(hooks, { spec, page: session.ctx.page });
            steps.push({ step: 'setup', status: 'pass' });
        }
        catch (err) {
            // Nothing ran yet, so there's nothing for teardown to release — just close the browser.
            await session.close();
            return {
                name: spec.name,
                status: 'error',
                steps: [{ step: 'setup', status: 'error', detail: err instanceof Error ? err.message : String(err) }],
                jevCalls,
                totalTokens,
            };
        }
    }
    try {
        let runSteps = spec.steps;
        try {
            const interpolated = interpolate({ url: spec.url, steps: spec.steps }, { env: spec.env ?? {}, hooks: data }, spec.name);
            session.ctx.spec = { ...spec, url: interpolated.url };
            runSteps = interpolated.steps;
        }
        catch (err) {
            overall = 'error';
            steps.push({ step: 'interpolate', status: 'error', detail: err instanceof Error ? err.message : String(err) });
            runSteps = [];
        }
        for (const step of runSteps) {
            let result;
            try {
                result = await runStep(session.ctx, step);
            }
            catch (err) {
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
    }
    finally {
        // Runs whenever setup succeeded (or there was none) — a cleanup failure must never be silent.
        if (hooks.teardown) {
            try {
                await hooks.teardown({ spec, page: session.ctx.page, data, result: { status: overall, steps } });
                steps.push({ step: 'teardown', status: 'pass' });
            }
            catch (err) {
                overall = 'error';
                steps.push({ step: 'teardown', status: 'error', detail: err instanceof Error ? err.message : String(err) });
            }
        }
        await session.close();
    }
    return { name: spec.name, status: overall, steps, jevCalls, totalTokens };
}
