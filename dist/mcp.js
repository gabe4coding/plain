import { StepKind } from './step-kind.js';
import { writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { z } from 'zod';
import { stringify } from 'yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseStep, interpolate } from './spec.js';
import { openSession, loadHooks, runSetup } from './runner.js';
import { runStep, label, resolveLocators } from './steps.js';
import { snapshot, CandidateKindSchema } from './page.js';
// Leaf paths of `data` as `${hooks.a.b}` placeholders for the `open` response — never the values
// themselves, since leased data can be credentials. Arrays and non-object leaves are leaves.
function placeholderPaths(obj, prefix) {
    const out = [];
    for (const [k, v] of Object.entries(obj)) {
        const path = `${prefix}.${k}`;
        if (v !== null && typeof v === 'object' && !Array.isArray(v))
            out.push(...placeholderPaths(v, path));
        else
            out.push('${' + path + '}');
    }
    return out;
}
const STEP_DESCRIPTION = `Run one step in the persistent browser session (call \`open\` first).

Vocabulary, one example each:
{goto: "/login"}
{fill: {target: "the username field", value: "tomsmith"}}
{click: "the Login button"}
{hover: "the profile avatar"}
{dblclick: "the file icon"}
{rightclick: "the context menu target"}
{select: {target: "the country dropdown", value: "France"}}
{check: "the remember-me checkbox"}
{uncheck: "the newsletter checkbox"}
{upload: {target: "the file input", files: ["/path/to/file.png"]}}
{scroll: "the footer"}
{wait: "the results list is visible"}
{press: "Enter"}
{drag: {source: "the first row's handle", target: "the third row"}}
{expect: ["claim 1", "claim 2"]}  (several claims = one Jev call)
{expect: {that: "a success message is visible", within: "the login form"}}

A \`css=\` prefix on any target bypasses Jev and uses that CSS selector directly.

Rules: describe ONE element with one clear answer — "the earliest available day", never "an
available day". Disambiguate siblings — "the cuisine input (not the where field)". Name things as
the accessibility tree does (heading, button, link, textbox). Expect claims are atomic, one fact
each. status is pass | fail | inconclusive | error; on inconclusive the detail lists the top
guesses with probabilities — rephrase and retry.

When \`open\` was called with \`hooks\`, any string in a step may contain \`\${hooks.a.b}\` placeholders
(the \`open\` response lists the ones available); they are resolved right before the step runs and
kept as written when \`save\` writes the spec, so the saved spec stays dataset-driven. \${env.*} is
not available in this session — add it to the YAML yourself after saving.`;
export async function serveMcp(opts) {
    let session = null;
    const spec = { name: 'plainwright session', url: '', dir: process.cwd(), dialogs: 'accept', steps: [] };
    const transcript = [];
    let totalTokens = 0;
    const track = (tokens) => void (totalTokens += tokens);
    // Hooks module leased by `open {hooks}` — released by runTeardown on the next `open {hooks}` or on shutdown.
    let hooks = {};
    let hooksFile = null;
    let data = {};
    const results = []; // every step result, pass or not, in order — teardown sees the full run
    const server = new McpServer({ name: 'plainwright', version: '1.0.0' });
    function ok(data) {
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    // Releases the current hooks lease: called when the session ends, or when `open` loads a new
    // hooks module while one is already active. Errors propagate — a teardown failure must not be silent.
    async function runTeardown() {
        if (hooks.teardown) {
            await hooks.teardown({
                spec,
                page: session.ctx.page,
                data,
                result: { status: results.at(-1)?.status ?? 'pass', steps: results },
            });
        }
        hooks = {};
        hooksFile = null;
        data = {};
    }
    server.registerTool('open', {
        description: "Open the persistent browser session (first call) or navigate it to a new URL. `hooks`: optional path " +
            "(relative to the server's working directory) of a setup/teardown module, as in a spec's `hooks` key; " +
            'setup runs now, before the navigation, and its result is available to steps as ${hooks.*}. Teardown runs ' +
            'when the session ends or when `open` is called again with `hooks`.',
        inputSchema: { url: z.string(), hooks: z.string().optional() },
    }, async ({ url, hooks: hooksPath }) => {
        if (!session) {
            session = await openSession(spec, opts, track);
            spec.url = url;
        }
        if (hooksPath) {
            const file = resolve(spec.dir, hooksPath);
            if (hooksFile)
                await runTeardown(); // an agent opening a second flow releases the first lease
            try {
                hooks = await loadHooks(file);
                data = await runSetup(hooks, { spec, page: session.ctx.page });
                hooksFile = file;
            }
            catch (err) {
                hooks = {};
                hooksFile = null;
                data = {}; // nothing loaded — nothing for teardown to release
                throw err;
            }
        }
        const result = await runStep(session.ctx, { kind: StepKind.goto, url });
        if (result.status === 'error')
            throw new Error(result.detail ?? 'goto failed');
        transcript.push({ goto: url }); // so `save` replays the navigation too
        const title = await session.ctx.page.title();
        const response = { url: session.ctx.page.url(), title, notes: session.drainNotes() };
        if (hooksFile)
            response.placeholders = placeholderPaths(data, 'hooks');
        return ok(response);
    });
    server.registerTool('step', { description: STEP_DESCRIPTION, inputSchema: { step: z.record(z.string(), z.unknown()) } }, async ({ step }) => {
        if (!session)
            throw new Error('call open first');
        const parsed = parseStep('mcp', transcript.length, step);
        const before = totalTokens;
        let result;
        try {
            const resolved = interpolate(parsed, { env: {}, hooks: data }, 'mcp'); // ${hooks.*} placeholders, resolved just before running
            result = await runStep(session.ctx, resolved);
        }
        catch (err) {
            result = { step: label(parsed), status: 'error', detail: err instanceof Error ? err.message : String(err) };
        }
        results.push(result);
        if (result.status === 'pass')
            transcript.push(step); // failed attempts are exploration, not spec — placeholders kept intact for `save`
        return ok({ status: result.status, detail: result.detail, notes: session.drainNotes(), url: session.ctx.page.url(), jevTokens: totalTokens - before });
    });
    server.registerTool('find', {
        description: "Dry run of a step target: tells you what Jev would pick, without acting.",
        inputSchema: { kind: CandidateKindSchema, target: z.string() },
    }, async ({ kind, target }) => {
        if (!session)
            throw new Error('call open first');
        target = interpolate(target, { env: {}, hooks: data }, 'mcp');
        const before = totalTokens;
        const [r] = await resolveLocators(session.ctx.page, kind, [target]);
        if (r.usedJev)
            track(r.tokens);
        return ok({ found: r.locator !== null, detail: r.detail, confidence: r.confidence, jevTokens: totalTokens - before });
    });
    server.registerTool('snapshot', {
        description: 'Accessibility tree of the current page (url, title, aria). Costly for your context; use only when a step came back inconclusive and rephrasing did not help.',
        inputSchema: { maxChars: z.number().optional() },
    }, async ({ maxChars }) => {
        if (!session)
            throw new Error('call open first');
        const max = maxChars ?? 20000;
        const snap = await snapshot(session.ctx.page);
        return ok({ url: snap.url, title: snap.title, aria: snap.aria.slice(0, max), truncated: snap.truncated });
    });
    server.registerTool('save', {
        description: 'Save the steps that passed so far in this session as a YAML spec the batch runner can replay (failed or ' +
            'inconclusive attempts are left out). The `hooks` module given to `open` is written as a relative path, ' +
            'and ${hooks.*} placeholders are kept as written.',
        inputSchema: { path: z.string(), name: z.string().optional() },
    }, async ({ path, name }) => {
        const filePath = resolve(path);
        const doc = { name: name ?? spec.name, url: spec.url };
        if (hooksFile) {
            let rel = relative(dirname(filePath), hooksFile);
            if (!rel.startsWith('.'))
                rel = './' + rel;
            doc.hooks = rel;
        }
        doc.steps = transcript;
        writeFileSync(filePath, stringify(doc));
        return ok({ path: filePath, steps: transcript.length });
    });
    const transport = new StdioServerTransport();
    const shutdown = async () => {
        try {
            await runTeardown();
        }
        catch (err) {
            console.error('plainwright: teardown failed: ' + (err instanceof Error ? err.message : String(err)));
        }
        await session?.close();
        process.exit(0);
    };
    transport.onclose = () => {
        void shutdown();
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    await server.connect(transport);
}
