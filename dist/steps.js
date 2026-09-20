import { StepKind } from './step-kind.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { candidates, elementById, settle, snapshot, snapshotRegion, } from './page.js';
import { pickElements, judge, decide, isTooLong, MAX_CANDIDATES } from './jev.js';
export const StatusSchema = z.enum(['pass', 'fail', 'inconclusive', 'error', 'skipped']);
export const StepResultSchema = z.object({
    step: z.string(),
    status: StatusSchema,
    detail: z.string().optional(),
    ms: z.record(z.string(), z.number()).optional(),
});
// Formats a step's `ms` phase timings for --timing output, e.g. "total=3985 settle=512 jev=1830" —
// `total` first (if present), then the rest in insertion order, only phases actually recorded.
export function formatMs(ms) {
    const keys = Object.keys(ms);
    const ordered = keys.includes('total') ? ['total', ...keys.filter((k) => k !== 'total')] : keys;
    return ordered.map((k) => `${k}=${ms[k]}`).join(' ');
}
export function label(step) {
    switch (step.kind) {
        case StepKind.goto:
            return `goto ${step.url}`;
        case StepKind.fill:
            return `fill "${step.target}"`;
        case StepKind.click:
            return `click "${step.target}"`;
        case StepKind.hover:
            return `hover "${step.target}"`;
        case StepKind.dblclick:
            return `dblclick "${step.target}"`;
        case StepKind.rightclick:
            return `rightclick "${step.target}"`;
        case StepKind.select:
            return `select "${step.value}" in "${step.target}"`;
        case StepKind.check:
            return `check "${step.target}"`;
        case StepKind.uncheck:
            return `uncheck "${step.target}"`;
        case StepKind.upload:
            return `upload ${step.files.length} file(s) to "${step.target}"`;
        case StepKind.scroll:
            return `scroll "${step.target}"`;
        case StepKind.wait:
            return `wait "${step.condition}"`;
        case StepKind.press:
            return `press ${step.key}`;
        case StepKind.drag:
            return `drag "${step.source}" to "${step.target}"`;
        case StepKind.mouse:
            return `mouse to (${step.x}, ${step.y})`;
        case StepKind.expect: {
            const claim = step.expectations.length > 1 ? step.expectations.join(' | ') : step.expectations[0];
            return step.within ? `expect "${claim}" within "${step.within}"` : `expect "${claim}"`;
        }
    }
}
// Adds the elapsed ms of `fn` into ctx.ms[phase] — phases accumulate across multiple calls in the
// same step (e.g. one `settle` per wait poll) since this is a per-step accumulator reset in runStep().
export async function timed(ctx, phase, fn) {
    const start = Date.now();
    const result = await fn();
    ctx.ms[phase] = (ctx.ms[phase] ?? 0) + (Date.now() - start);
    return result;
}
/**
 * Run an action that may trigger a navigation (click on a link-like element, Enter in a form) and, if one
 * starts within a short window, wait for the new document to load. Without this the next step reads the
 * old page while the navigation is in flight and can fire a second navigation on top of it.
 */
async function mayNavigate(ctx, action) {
    const page = ctx.page;
    const nav = page
        .waitForEvent('framenavigated', { timeout: 1500, predicate: (f) => f === page.mainFrame() })
        .then(() => page.waitForLoadState('load'))
        .catch(() => { }); // no navigation started — that's fine
    await timed(ctx, 'action', action);
    await timed(ctx, 'post', () => nav);
}
function resolveUrl(base, path) {
    if (/^https?:\/\//.test(path))
        return path;
    // ponytail: treat `url` as the app's base directory, not just its origin — a plain WHATWG
    // `new URL(path, base)` join drops the base's own path for any path starting with "/", which
    // sends "goto: /" to the origin's root instead of back to the app under test.
    const baseWithSlash = base.endsWith('/') ? base : `${base}/`;
    const rel = path.startsWith('/') ? path.slice(1) : path;
    return new URL(rel, baseWithSlash).toString();
}
/** Dump debug data to a temp file for a rejection/timeout/fail detail line, and return its path. */
function dumpDebug(kind, data) {
    const dir = path.join(os.tmpdir(), 'plainwright');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${kind}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
}
/** Top 3 candidates by probability, formatted for a pick-rejection detail line. */
function topGuesses(probabilities, candidates) {
    return Object.entries(probabilities)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, p]) => `${k === 'none' ? 'none' : candidates.find((c) => String(c.id) === k)?.desc} (p=${p.toFixed(2)})`)
        .join(' | ');
}
// What to try instead when a step kind finds nothing at all to choose from.
const NO_CANDIDATES_HINT = {
    [StepKind.check]: ' (no checkbox, radio, switch or aria-pressed toggle); for a plain button or chip use click',
    [StepKind.select]: ' (no native <select>); for a custom dropdown click the control, then click the option',
    [StepKind.upload]: ' (no file input); if the page opens a picker from a button, use css= on the hidden input',
};
// Resolves several targets of the same kind in one pass: css= targets resolve directly, the rest
// share ONE settle + ONE candidate scan + ONE pickElements() request (one request = one Jev call —
// only the first Jev-resolved entry carries usedJev/tokens, matching pickElements()'s own contract).
// Results come back in the same order as `targets`.
export async function resolveLocators(ctx, kind, targets) {
    const page = ctx.page;
    const results = new Array(targets.length);
    const jevIndices = [];
    const jevTargets = [];
    targets.forEach((target, i) => {
        if (target.startsWith('css=')) {
            const selector = target.slice(4);
            results[i] = { locator: page.locator(selector), detail: `→ css=${selector}`, tokens: 0, usedJev: false };
        }
        else {
            jevIndices.push(i);
            jevTargets.push(target);
        }
    });
    if (jevTargets.length > 0) {
        // Let debounced autocompletes, modals etc. finish rendering before we look (networkidle fires too early:
        // it sees the quiet gap *before* a debounced request starts).
        await timed(ctx, 'settle', () => settle(page).catch(() => { }));
        const cands = await timed(ctx, 'candidates', () => candidates(page, kind, MAX_CANDIDATES));
        const title = await page.title();
        const picks = await timed(ctx, 'jev', () => pickElements(cands, jevTargets, { url: page.url(), title }));
        jevIndices.forEach((origIndex, j) => {
            const { id, probability, confidence, probabilities, tokens } = picks[j];
            const score = confidence ?? probability;
            const accepted = id !== null && decide(score, 'pick') === 'pass';
            const usedJev = j === 0; // one request for the whole batch — only the first result carries it
            const cPart = confidence !== undefined ? ` c=${confidence.toFixed(2)}` : '';
            if (!accepted) {
                // Show what Jev was torn between — the wording of the step is the lever to fix this.
                const file = dumpDebug('pick', { instruction: jevTargets[j], probabilities, confidence, candidates: cands });
                const detail = cands.length === 0
                    ? `no candidates: nothing on the page matches a ${kind} target${NO_CANDIDATES_HINT[kind] ?? ''}`
                    : `${id === null ? 'no matching element' : 'low confidence'} (${cands.length} candidates)${cPart} — top: ${topGuesses(probabilities, cands)} — candidates: ${file}`;
                results[origIndex] = { locator: null, detail, tokens, usedJev, confidence };
                return;
            }
            const cand = cands.find((c) => c.id === id);
            results[origIndex] = {
                locator: elementById(page, id, cand.frameIndex),
                detail: `→ ${cand.desc} (p=${probability.toFixed(2)}${cPart})`,
                tokens,
                usedJev,
                confidence,
            };
        });
    }
    return results;
}
async function resolveLocator(ctx, kind, target) {
    return (await resolveLocators(ctx, kind, [target]))[0];
}
function trackResolved(ctx, r) {
    if (r.usedJev)
        ctx.track(r.tokens);
}
// Resolve `target` under `kind`, account for the Jev call, and either report "inconclusive" or run
// `act` on the resolved locator — the resolve → account → branch triple every element-acting step shares.
async function withResolved(ctx, kind, target, stepLabel, act) {
    const r = await resolveLocator(ctx, kind, target);
    trackResolved(ctx, r);
    if (!r.locator)
        return { step: stepLabel, status: 'inconclusive', detail: r.detail };
    const extra = await act(r.locator);
    return { step: stepLabel, status: 'pass', detail: extra ? `${r.detail} ${extra}` : r.detail };
}
// The too-long-state halving retry (moved out of jev.ts's judge(), which no longer knows about
// aria) plus the shared token accounting — every judge() call site goes through this. One request
// judges every claim (each still its own Noul question, so its own probability).
async function judgeSnapshot(ctx, snap, claims) {
    let s = snap;
    for (;;) {
        try {
            const { url, title, aria } = s;
            const { probabilities, tokens } = await timed(ctx, 'jev', () => judge({ url, title, aria, events: ctx.events }, claims));
            ctx.track(tokens);
            return { probabilities };
        }
        catch (err) {
            // A char cap can't guarantee the model's token limit (dense tables ≈ 2x tokens per char): halve and retry.
            if (!isTooLong(err) || s.aria.length < 4000)
                throw err;
            const half = s.aria.slice(0, Math.floor(s.aria.length / 2));
            s = { ...s, aria: half };
            console.error(`plainwright: state too long for the model, aria cut to ${half.length} chars — scope the expect with \`within\` for precision`);
        }
    }
}
// `check`/`uncheck` mean "make it (un)selected", whatever keeps the state: a form control's `checked`
// (following a label to its control), or aria-checked/aria-pressed on a toggle button. Playwright's own
// check() refuses toggle buttons and times out on a label whose checkbox has no size (trivago's filter
// chips), so the state is read here and the element is clicked only when it has to change.
async function setChecked(loc, on) {
    const read = () => loc.evaluate((el) => {
        const control = el instanceof HTMLLabelElement ? el.control : el;
        if (control instanceof HTMLInputElement)
            return control.checked;
        const aria = el.getAttribute('aria-checked') ?? el.getAttribute('aria-pressed');
        return aria === null ? null : aria === 'true';
    });
    const before = await read();
    if (before === null) {
        // No readable state: let Playwright decide whether this is a checkbox at all.
        await (on ? loc.check() : loc.uncheck());
        return `now ${on ? 'checked' : 'unchecked'}`;
    }
    if (before === on)
        return `already ${on ? 'checked' : 'unchecked'}`;
    await loc.click();
    const after = await read().catch(() => null); // a re-render may have replaced the element: not a failure
    if (after !== null && after !== on)
        throw new Error(`clicked, but the element is still ${after ? 'checked' : 'unchecked'}`);
    return `now ${on ? 'checked' : 'unchecked'}`;
}
// `scroll: bottom`, `top`, and the ways an agent writes them ("the bottom of the page", "page end").
function scrollEdge(target) {
    const m = /^(?:the )?(?:page )?(top|bottom|end)(?: of the page)?$/i.exec(target.trim());
    return m ? (m[1].toLowerCase() === 'top' ? 'top' : 'bottom') : null;
}
async function runDrag(ctx, step, stepLabel) {
    const [rs, rt] = await resolveLocators(ctx, StepKind.click, [step.source, step.target]);
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
    const source = rs.locator;
    const dest = rt.locator;
    await timed(ctx, 'action', async () => {
        await source.hover();
        await ctx.page.mouse.down();
        await dest.hover();
        await dest.hover();
        await ctx.page.mouse.up();
    });
    return { step: stepLabel, status: 'pass', detail: `${rs.detail} → ${rt.detail}` };
}
async function runWait(ctx, step, stepLabel) {
    if (step.condition.startsWith('css=')) {
        await ctx.page.waitForSelector(step.condition.slice(4), { state: 'visible', timeout: ctx.timeout });
        return { step: stepLabel, status: 'pass' };
    }
    const MAX_POLLS = 8; // ponytail: hard cap on Jev polls per wait, floor against a condition that never holds
    const deadline = Date.now() + ctx.timeout;
    let polls = 0;
    let lastProbability = 0;
    let lastSnap = null;
    let passed = false;
    while (polls < MAX_POLLS && Date.now() < deadline) {
        await timed(ctx, 'settle', () => settle(ctx.page).catch(() => { }));
        const snap = await timed(ctx, 'snapshot', () => snapshot(ctx.page));
        const { probabilities } = await judgeSnapshot(ctx, snap, [step.condition]);
        const probability = probabilities[0];
        polls++;
        ctx.ms.polls = polls;
        lastProbability = probability;
        lastSnap = snap;
        if (decide(probability, 'expect') === 'pass') {
            passed = true;
            break;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(1500, remaining)));
    }
    if (passed) {
        return { step: stepLabel, status: 'pass', detail: `p=${lastProbability.toFixed(2)} after ${polls} poll(s)` };
    }
    const file = dumpDebug(StepKind.wait, { condition: step.condition, probability: lastProbability, state: lastSnap });
    return {
        step: stepLabel,
        status: 'inconclusive',
        detail: `p=${lastProbability.toFixed(2)} after ${polls} poll(s) — state: ${file}`,
    };
}
async function runExpect(ctx, step, stepLabel) {
    const judgeExpectations = async (snap) => {
        const { probabilities } = await judgeSnapshot(ctx, snap, step.expectations);
        const decisions = probabilities.map((p) => decide(p, 'expect'));
        // fail beats inconclusive beats pass: one broken claim fails the step even if the rest hold.
        const status = decisions.includes('fail') ? 'fail' : decisions.includes('inconclusive') ? 'inconclusive' : 'pass';
        let detail = `p=${probabilities.map((p) => p.toFixed(2)).join(', ')} @ ${ctx.page.url()}`;
        if (snap.truncated)
            detail += ' (aria truncated at 60k chars)';
        if (status !== 'pass') {
            // Dump what Jev saw so the author can tune the expectations against the real state.
            const file = dumpDebug(StepKind.expect, { expectations: step.expectations, probabilities, state: snap });
            detail += ` — state: ${file}`;
        }
        return { step: stepLabel, status, detail };
    };
    if (step.within) {
        const r = await resolveLocator(ctx, 'region', step.within);
        trackResolved(ctx, r);
        if (!r.locator) {
            return { step: stepLabel, status: 'inconclusive', detail: r.detail };
        }
        return judgeExpectations(await timed(ctx, 'snapshot', () => snapshotRegion(ctx.page, r.locator)));
    }
    await timed(ctx, 'settle', () => settle(ctx.page).catch(() => { })); // SPA route changes resolve 'load' instantly; wait for the content
    return judgeExpectations(await timed(ctx, 'snapshot', () => snapshot(ctx.page)));
}
// Resets the per-step timing accumulator, runs the step, and stamps `total` = wall time of the
// whole step (including any resolve/settle/jev/action/post time nested calls add into ctx.ms).
export async function runStep(ctx, step) {
    ctx.ms = {};
    const start = Date.now();
    const result = await runStepInner(ctx, step);
    ctx.ms.total = Date.now() - start;
    return { ...result, ms: { ...ctx.ms } };
}
async function runStepInner(ctx, step) {
    const stepLabel = label(step);
    switch (step.kind) {
        case StepKind.goto: {
            const url = resolveUrl(ctx.spec.url, step.url);
            await timed(ctx, 'action', () => ctx.page.goto(url, { waitUntil: 'load' }));
            return { step: stepLabel, status: 'pass' };
        }
        case StepKind.press: {
            await mayNavigate(ctx, () => ctx.page.keyboard.press(step.key));
            return { step: stepLabel, status: 'pass' };
        }
        case StepKind.drag:
            return runDrag(ctx, step, stepLabel);
        case StepKind.mouse: {
            await timed(ctx, 'action', () => ctx.page.mouse.move(step.x, step.y));
            return { step: stepLabel, status: 'pass' };
        }
        case StepKind.click:
            return withResolved(ctx, StepKind.click, step.target, stepLabel, (loc) => mayNavigate(ctx, () => loc.click()));
        case StepKind.fill:
            return withResolved(ctx, StepKind.fill, step.target, stepLabel, async (loc) => {
                await timed(ctx, 'action', () => loc.fill(step.value));
                // Typing usually fires a debounced request (autocomplete, validation); settle() alone can find
                // a quiet DOM before that request even starts. Give one triggered response a moment to land.
                await timed(ctx, 'post', () => ctx.page.waitForResponse((res) => ['xhr', 'fetch'].includes(res.request().resourceType()), { timeout: 1500 }).catch(() => { }));
            });
        case StepKind.hover:
            return withResolved(ctx, StepKind.hover, step.target, stepLabel, (loc) => timed(ctx, 'action', () => loc.hover()));
        case StepKind.dblclick:
        case StepKind.rightclick: {
            const dbl = step.kind === StepKind.dblclick;
            return withResolved(ctx, StepKind.click, step.target, stepLabel, (loc) => mayNavigate(ctx, () => (dbl ? loc.dblclick() : loc.click({ button: 'right' }))));
        }
        case StepKind.select:
            return withResolved(ctx, StepKind.select, step.target, stepLabel, (loc) => timed(ctx, 'action', async () => {
                try {
                    await loc.selectOption({ label: step.value });
                }
                catch {
                    await loc.selectOption(step.value);
                }
            }));
        case StepKind.check:
        case StepKind.uncheck:
            return withResolved(ctx, StepKind.check, step.target, stepLabel, (loc) => timed(ctx, 'action', () => setChecked(loc, step.kind === StepKind.check)));
        case StepKind.upload:
            return withResolved(ctx, StepKind.upload, step.target, stepLabel, (loc) => {
                const paths = step.files.map((f) => path.resolve(ctx.spec.dir, f));
                return timed(ctx, 'action', () => loc.setInputFiles(paths));
            });
        case StepKind.scroll: {
            const edge = scrollEdge(step.target);
            if (edge) {
                // document.scrollingElement, not body: body.scrollHeight is short of the document on many sites.
                // `instant` so the position read back is final even under `scroll-behavior: smooth`.
                const [from, to] = await timed(ctx, 'action', () => ctx.page.evaluate((edge) => {
                    const el = document.scrollingElement ?? document.documentElement;
                    const from = el.scrollTop;
                    el.scrollTo({ top: edge === 'top' ? 0 : el.scrollHeight, behavior: 'instant' });
                    return [Math.round(from), Math.round(el.scrollTop)];
                }, edge));
                await timed(ctx, 'settle', () => settle(ctx.page).catch(() => { }));
                const detail = from === to
                    ? `did not move (${to}px): already at the ${edge}, or the page scrolls inside an element — scroll that element instead`
                    : `scrolled ${from} → ${to}px`;
                return { step: stepLabel, status: 'pass', detail };
            }
            return withResolved(ctx, StepKind.click, step.target, stepLabel, async (loc) => {
                await timed(ctx, 'action', () => loc.scrollIntoViewIfNeeded());
                await timed(ctx, 'settle', () => settle(ctx.page).catch(() => { }));
            });
        }
        case StepKind.wait:
            return runWait(ctx, step, stepLabel);
        case StepKind.expect:
            return runExpect(ctx, step, stepLabel);
    }
}
