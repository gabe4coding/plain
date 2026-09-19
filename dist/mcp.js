import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { stringify } from 'yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseStep } from './spec.js';
import { openSession } from './runner.js';
import { runStep, label, resolveLocators } from './steps.js';
import { snapshot } from './page.js';
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
guesses with probabilities — rephrase and retry.`;
export async function serveMcp(opts) {
    let session = null;
    const spec = { name: 'jev-e2e session', url: '', dir: process.cwd(), dialogs: 'accept', steps: [] };
    const transcript = [];
    let totalTokens = 0;
    const track = (tokens) => void (totalTokens += tokens);
    const server = new McpServer({ name: 'jev-e2e', version: '1.0.0' });
    function ok(data) {
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
    server.registerTool('open', { description: 'Open the persistent browser session (first call) or navigate it to a new URL.', inputSchema: { url: z.string() } }, async ({ url }) => {
        if (!session) {
            session = await openSession(spec, opts, track);
            spec.url = url;
        }
        const result = await runStep(session.ctx, { kind: 'goto', url });
        if (result.status === 'error')
            throw new Error(result.detail ?? 'goto failed');
        transcript.push({ goto: url }); // so `save` replays the navigation too
        const title = await session.ctx.page.title();
        return ok({ url: session.ctx.page.url(), title, notes: session.drainNotes() });
    });
    server.registerTool('step', { description: STEP_DESCRIPTION, inputSchema: { step: z.record(z.string(), z.unknown()) } }, async ({ step }) => {
        if (!session)
            throw new Error('call open first');
        const parsed = parseStep('mcp', transcript.length, step);
        const before = totalTokens;
        let result;
        try {
            result = await runStep(session.ctx, parsed);
        }
        catch (err) {
            result = { step: label(parsed), status: 'error', detail: err instanceof Error ? err.message : String(err) };
        }
        if (result.status === 'pass')
            transcript.push(step); // failed attempts are exploration, not spec
        return ok({ status: result.status, detail: result.detail, notes: session.drainNotes(), url: session.ctx.page.url(), jevTokens: totalTokens - before });
    });
    server.registerTool('find', {
        description: "Dry run of a step target: tells you what Jev would pick, without acting.",
        inputSchema: { kind: z.enum(['click', 'hover', 'fill', 'select', 'check', 'upload', 'region']), target: z.string() },
    }, async ({ kind, target }) => {
        if (!session)
            throw new Error('call open first');
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
    server.registerTool('save', { description: 'Save the steps that passed so far in this session as a YAML spec the batch runner can replay (failed or inconclusive attempts are left out).', inputSchema: { path: z.string(), name: z.string().optional() } }, async ({ path, name }) => {
        const yaml = stringify({ name: name ?? spec.name, url: spec.url, steps: transcript });
        const filePath = resolve(path);
        writeFileSync(filePath, yaml);
        return ok({ path: filePath, steps: transcript.length });
    });
    const transport = new StdioServerTransport();
    const shutdown = async () => {
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
