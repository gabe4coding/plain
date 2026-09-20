import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { interpolate } from './spec.js';
import { runStep, label } from './steps.js';
const MAX_EVENTS = 30; // ponytail: cap what's sent to Jev as `events` — a long spec shouldn't grow this unbounded
// Launches the browser/context/page for one spec and wires up the listeners every step relies on
// (dialogs, popups, downloads, console/page errors). Shared by the batch runner below and by the
// MCP server, which keeps one Session alive across many tool calls instead of one spec.
export async function openSession(spec, opts, track) {
    const browser = await chromium.launch({ headless: !opts.headed });
    const contextOptions = {};
    if (spec.auth)
        contextOptions.httpCredentials = { username: spec.auth.user, password: spec.auth.pass };
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
            const dir = path.join(os.tmpdir(), 'jev-e2e', 'downloads');
            fs.mkdirSync(dir, { recursive: true });
            const dest = path.join(dir, download.suggestedFilename());
            await download.saveAs(dest);
            note(`download: "${download.suggestedFilename()}" saved to ${dest}`);
        });
        p.on('pageerror', (err) => note(`pageerror: ${err.message}`));
        p.on('console', (msg) => {
            if (msg.type() === 'error')
                note(`console.error: ${msg.text()}`);
        });
    }
    attach(page);
    const ctx = { get page() { return page; }, spec, timeout: opts.timeout, events, track };
    return {
        ctx,
        drainNotes() {
            const notes = pendingNotes;
            pendingNotes = [];
            return notes;
        },
        close: () => browser.close(),
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
    if (spec.hooks) {
        hooks = await import(pathToFileURL(spec.hooks).href);
        if (hooks.setup !== undefined && typeof hooks.setup !== 'function')
            throw new Error(`${spec.hooks}: "setup" must be a function`);
        if (hooks.teardown !== undefined && typeof hooks.teardown !== 'function')
            throw new Error(`${spec.hooks}: "teardown" must be a function`);
    }
    const session = await openSession(spec, opts, track);
    // What setup returns, exposed to steps/teardown as `${hooks.*}`/`data` — `{}` when there's no setup.
    let data = {};
    if (hooks.setup) {
        try {
            const returned = await hooks.setup({ spec, page: session.ctx.page });
            if (returned !== undefined) {
                if (returned === null || typeof returned !== 'object')
                    throw new Error('setup must return an object');
                data = returned;
            }
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
