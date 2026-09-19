const CLICK_SELECTOR = 'a, button, input, select, textarea, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [role=listbox] li, [role=menuitemradio], [onclick]';
const FILL_SELECTOR = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]';
const SELECT_SELECTOR = 'select';
const CHECK_SELECTOR = 'input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch]';
const UPLOAD_SELECTOR = 'input[type=file]';
const REGION_SELECTOR = 'main, section, article, dialog, nav, header, footer, aside, form, table, [role=region], [role=dialog], [role=main], [role=tabpanel], [role=list]';
const SELECTORS = {
    click: CLICK_SELECTOR,
    hover: `${CLICK_SELECTOR}, img, svg, figure`, // hover targets are often plain images with no clickable signal
    fill: FILL_SELECTOR,
    select: SELECT_SELECTOR,
    check: CHECK_SELECTOR,
    upload: UPLOAD_SELECTOR,
    region: REGION_SELECTOR,
};
/** Wait until the DOM stops mutating for `quietMs` (debounced autocompletes, modals), giving up after `maxMs`. */
export function settle(page, quietMs = 500, maxMs = 3000) {
    return page.evaluate(({ quietMs, maxMs }) => new Promise((resolve) => {
        let timer = setTimeout(done, quietMs);
        const obs = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(done, quietMs);
        });
        const cap = setTimeout(done, maxMs);
        obs.observe(document.body, { childList: true, subtree: true, attributes: true });
        function done() {
            obs.disconnect();
            clearTimeout(timer);
            clearTimeout(cap);
            resolve();
        }
    }), { quietMs, maxMs });
}
/**
 * Runs inside the page/frame. Walks the whole document — including open shadow roots — collecting
 * elements that match `selector`. For `includeExtras` (the `click` kind), also collects React-style
 * clickables that match no selector: cursor:pointer, [tabindex], [contenteditable], summary, label.
 * Selector-matched elements are ordered first (DOM order), extras after, then the list is capped.
 */
function collectCandidatesInPage(args) {
    const { selector, includeExtras, skipVisibility, max, startId } = args;
    function visible(el) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0)
            return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
    }
    const enabled = (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    function truncate(s, n) {
        s = s.trim().replace(/\s+/g, ' ');
        return s.length > n ? s.slice(0, n) + '…' : s;
    }
    function describe(el) {
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type');
        const role = el.getAttribute('role');
        let head = tag;
        if (type)
            head += `[type=${type}]`;
        if (role)
            head += `[role=${role}]`;
        const parts = [head];
        const text = el.innerText ?? el.textContent ?? '';
        const value = el.value;
        if (text && text.trim())
            parts.push(`"${truncate(text, 60)}"`);
        else if (value)
            parts.push(`value="${truncate(value, 60)}"`);
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel)
            parts.push(`aria-label="${truncate(ariaLabel, 60)}"`);
        const placeholder = el.getAttribute('placeholder');
        if (placeholder)
            parts.push(`placeholder="${truncate(placeholder, 60)}"`);
        const alt = el.getAttribute('alt');
        if (alt)
            parts.push(`alt="${truncate(alt, 60)}"`);
        const title = el.getAttribute('title');
        if (title)
            parts.push(`title="${truncate(title, 60)}"`);
        const name = el.getAttribute('name');
        if (name)
            parts.push(`name="${name}"`);
        const id = el.getAttribute('id');
        if (id)
            parts.push(`id="${id}"`);
        const href = el.getAttribute('href');
        if (href) {
            try {
                parts.push(`href=${new URL(href, location.href).pathname}`);
            }
            catch {
                parts.push(`href=${href}`);
            }
        }
        return parts.join(' ');
    }
    // `[draggable=true]` catches HTML5 drag-and-drop sources/targets — the-internet's /drag_and_drop
    // boxes are plain <div draggable="true"> with `cursor: move`, not `pointer`, so isPointer() alone
    // would never surface them for a `drag` step.
    const EXTRA_SELECTOR = '[tabindex]:not([tabindex="-1"]), [contenteditable=true], summary, label, [draggable=true]';
    const matched = [];
    const extras = [];
    // `cursor` is inherited: only the outermost pointer element is the clickable (the card), not every
    // span/svg/path inside it — those would only bloat the list toward the 255-option ceiling.
    const isPointer = (el) => window.getComputedStyle(el).cursor === 'pointer';
    function visit(el) {
        if (el.hasAttribute('data-jev-id'))
            el.removeAttribute('data-jev-id');
        if (el.matches(selector))
            matched.push(el);
        else if (includeExtras && !(el instanceof SVGElement) && (el.matches(EXTRA_SELECTOR) || (isPointer(el) && !(el.parentElement && isPointer(el.parentElement))))) {
            extras.push(el);
        }
        if (el.shadowRoot)
            for (const c of Array.from(el.shadowRoot.children))
                visit(c);
        for (const c of Array.from(el.children))
            visit(c);
    }
    if (document.body)
        for (const c of Array.from(document.body.children))
            visit(c);
    const keep = (el) => (skipVisibility || visible(el)) && enabled(el);
    const final = [...matched.filter(keep), ...extras.filter(keep)].slice(0, max);
    const descs = final.map((el, i) => {
        el.setAttribute('data-jev-id', String(startId + i));
        return describe(el);
    });
    // Identical descriptions (three "img alt=User Avatar", two bare checkboxes) get an ordinal in DOM order,
    // so "the first …" / "the leftmost …" has exactly one answer.
    const counts = new Map();
    for (const d of descs)
        counts.set(d, (counts.get(d) ?? 0) + 1);
    const seen = new Map();
    return descs.map((d) => {
        if ((counts.get(d) ?? 0) < 2)
            return d;
        const n = (seen.get(d) ?? 0) + 1;
        seen.set(d, n);
        return `${d} #${n}`;
    });
}
function frameLabel(frame) {
    const name = frame.name();
    if (name)
        return name;
    try {
        return new URL(frame.url()).pathname || frame.url();
    }
    catch {
        return frame.url();
    }
}
export async function candidates(page, kind, max) {
    const selector = SELECTORS[kind];
    const includeExtras = kind === 'click' || kind === 'hover';
    const skipVisibility = kind === 'upload';
    const out = [];
    const frames = page.frames();
    for (let frameIndex = 0; frameIndex < frames.length && out.length < max; frameIndex++) {
        const frame = frames[frameIndex];
        const startId = out.length;
        let descs;
        try {
            descs = await frame.evaluate(collectCandidatesInPage, {
                selector,
                includeExtras,
                skipVisibility,
                max: max - out.length,
                startId,
            });
        }
        catch {
            continue; // detached or cross-origin frame — skip, never fatal
        }
        const prefix = frameIndex === 0 ? '' : `[iframe ${frameLabel(frame)}] `;
        for (const desc of descs)
            out.push({ id: out.length, desc: prefix + desc, frameIndex });
    }
    return out;
}
export function elementById(page, id, frameIndex = 0) {
    return page.frames()[frameIndex].locator(`[data-jev-id="${id}"]`);
}
const ARIA_MAX_CHARS = 60_000; // ponytail: hard truncate, no smart summarization — ≈15k tokens, ≈$0.0006/call
function capAria(s) {
    return s.length > ARIA_MAX_CHARS ? { aria: s.slice(0, ARIA_MAX_CHARS), truncated: true } : { aria: s, truncated: false };
}
function toSnapshot(page, title, ariaFull) {
    const { aria, truncated } = capAria(ariaFull);
    return { url: page.url(), title, aria, truncated };
}
export async function snapshot(page) {
    const frames = page.frames();
    const iframeFrames = frames.slice(1);
    const [title, bodyAria, iframeArias] = await Promise.all([
        page.title(),
        page.locator('body').ariaSnapshot(),
        // detached or cross-origin — skip, never fatal
        Promise.all(iframeFrames.map((f) => f.locator('body').ariaSnapshot().catch(() => null))),
    ]);
    let full = bodyAria;
    iframeFrames.forEach((frame, i) => {
        const frameAria = iframeArias[i];
        if (frameAria !== null)
            full += `\n--- iframe ${frameLabel(frame)} ---\n${frameAria}`;
    });
    return toSnapshot(page, title, full);
}
/** Same as `snapshot()` but scoped to one region locator, for `expect: { that, within }`. */
export async function snapshotRegion(page, locator) {
    const [title, ariaFull] = await Promise.all([page.title(), locator.ariaSnapshot()]);
    return toSnapshot(page, title, ariaFull);
}
