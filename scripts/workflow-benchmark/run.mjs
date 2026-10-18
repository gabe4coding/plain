// Paid, opt-in end-to-end benchmark. See docs/benchmarks/browser-workflows.md.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { platform, arch, cpus } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { generateText, tool, jsonSchema } from 'ai';
import { chromium } from 'playwright';
import { USER_ENV_FILE } from '../../dist/jev/provider.js';
import { startFixtures, taskNames } from './fixtures.mjs';
import { costs } from './accounting.mjs';
import { readArtifact } from './artifacts.mjs';

globalThis.AI_SDK_LOG_WARNINGS = false; // Stored per generation below, without repetitive stderr noise.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(arg('out', '/tmp/plain-workflow-benchmark'));
const baseline = resolve(arg('baseline', '/tmp/plain-cost-analysis/baseline/node_modules/@playwright/mcp/cli.js'));
const models = arg('models', 'openai/gpt-5.6-luna,openai/gpt-5.6-terra,openai/gpt-6-astra').split(',');
const tasks = arg('tasks', taskNames.join(',')).split(',');
const repeats = Number(arg('repeats', '3'));
const seed = Number(arg('seed', '210926'));
const budget = Number(arg('budget', '25'));
const comparison = arg('comparison', 'playwright');
if (!['playwright', 'batch'].includes(comparison)) throw new Error('comparison must be playwright or batch');
const controlArm = comparison === 'batch' ? 'plain-unbatched' : 'playwright';
const arms = ['plain', controlArm];
const maxTurns = 20;
const trialTimeoutMs = 180_000;
const stopped = new AbortController();
process.once('SIGINT', () => stopped.abort(new Error('Benchmark interrupted')));
for (const file of [resolve(root, '.env'), USER_ENV_FILE]) if (existsSync(file)) process.loadEnvFile(file);
if (!process.env.AI_GATEWAY_API_KEY || !process.env.TYPESAFE_API_KEY) throw new Error('Both AI_GATEWAY_API_KEY and TYPESAFE_API_KEY are required.');
if (existsSync(resolve(out, 'manifest.json'))) throw new Error('Use a new output directory; never overwrite or silently resume results.');
if (!Number.isInteger(repeats) || repeats < 1 || !Number.isFinite(budget) || budget <= 0) throw new Error('Invalid repeats or budget');
mkdirSync(out, { recursive: true });
const catalog = await (await fetch('https://ai-gateway.vercel.sh/v1/models')).json();
const pricing = Object.fromEntries(models.map(id => { const entry = catalog.data.find(m => m.id === id); if (!entry) throw new Error(`Unknown model ${id}`); return [id, entry.pricing]; }));
writeFileSync(resolve(out, 'pricing.json'), JSON.stringify({ retrievedAt: new Date().toISOString(), source: 'https://ai-gateway.vercel.sh/v1/models', pricing, jev: { model: 'jev-1.14.0', inputPerMillion: 0.042, outputPerMillion: 0, source: 'https://docs.typesafe.ai/models' } }, null, 2));

const common = 'Complete the requested task using the browser tools. Work efficiently and verify the visible result before finishing. You may issue multiple tool calls in a turn; they execute in order. Use only the supplied UI tools: no JavaScript, hidden application state, source inspection, direct HTTP calls, hooks, custom file output, or external sites. read_artifact can read snapshot files linked by browser tools. End with finish, including any requested answer. All pages are disposable test fixtures; saving changes is authorized.';
const prompts = {
  plain: common + ' Use open first. Known actions can go directly to step, which finds targets through Jev. Each step contains one action. For discovery use snapshot with mode compact, or mode smart with intent describing the task. The intent argument is valid ONLY in smart mode; omit it in compact/raw modes. Use scoped/raw snapshots to read exact data. Read each result. Rephrase ambiguous targets after a miss. Use natural-language targets, not css= selectors.',
  playwright: common + ' Use browser_navigate first. Action responses link to accessibility snapshot files, available through read_artifact. browser_snapshot returns a snapshot inline when filename is omitted. Use references or accessible selectors for targets. browser_fill_form can fill several fields at once. Use browser_find or a scoped browser_snapshot when needed. Read each result and recover from errors.',
};
prompts['plain-unbatched'] = prompts.plain;
prompts.plain += ' Use batch for sequences of already-known actions, such as filling a form and saving it. A batch stops at its first non-pass. Inspect results before planning actions that depend on new information.';
const allowed = {
  plain: ['open', 'step', 'batch', 'snapshot', 'find'],
  'plain-unbatched': ['open', 'step', 'snapshot', 'find'],
  playwright: ['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_find', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_wait_for', 'browser_handle_dialog', 'browser_hover'],
};
let rng = seed >>> 0;
const random = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; };
const pairs = [];
for (let repeat = 0; repeat < repeats; repeat++) for (const model of models) for (const task of tasks) pairs.push({ model, task, repeat });
for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
const schedule = pairs.flatMap(pair => (random() < 0.5 ? arms : [...arms].reverse()).map(arm => ({ ...pair, arm })));
const sourceFiles = ['run.mjs', 'fixtures.mjs', 'jev-usage.mjs', 'accounting.mjs', 'artifacts.mjs'];
const manifest = { startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceHashes: Object.fromEntries(sourceFiles.map(f => [f, createHash('sha256').update(readFileSync(resolve(here, f))).digest('hex')])), node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0].model, playwright: JSON.parse(readFileSync(resolve(root, 'node_modules/playwright/package.json'))).version, baseline: comparison === 'playwright' ? JSON.parse(readFileSync(resolve(dirname(baseline), 'package.json'))).version : null, baselinePlaywright: comparison === 'playwright' ? JSON.parse(readFileSync(createRequire(baseline).resolve('playwright/package.json'))).version : null, executable: chromium.executablePath(), comparison, arms, models, tasks, repeats, seed, budget, maxTurns, trialTimeoutMs, reasoningEffort: 'low', strictTools: false, maxOutputTokens: 4096, prompts, allowed, schedule };
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
const fixtures = await startFixtures();
let spent = 0;
try {
  for (let index = 0; index < schedule.length; index++) {
    if (spent >= budget || stopped.signal.aborted) { console.log(JSON.stringify({ stopped: stopped.signal.aborted ? 'interrupted' : 'budget', spent })); break; }
    const row = schedule[index];
    const id = `run-${String(index + 1).padStart(3, '0')}`;
    const spec = fixtures.add(id, row.task, row.repeat);
    const jevFile = resolve(out, `${id}-jev.jsonl`);
    const trace = [];
    const main = [];
    const calls = [];
    const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string'));
    for (const key of ['PLAIN_PROFILE', 'PLAIN_CHANNEL', 'PLAIN_CDP', 'TYPESAFE_BASE_URL']) delete env[key];
    env.JEV_PROVIDER = 'typesafe'; env.BENCH_JEV_USAGE = jevFile;
    const args = row.arm !== 'playwright'
      ? ['--import', resolve(here, 'jev-usage.mjs'), resolve(root, 'dist/cli.js'), '--headless', '--channel', 'chromium', '--timeout', '10000', 'mcp']
      : [baseline, '--headless', '--isolated', '--executable-path', chromium.executablePath(), '--viewport-size', '1280x720', '--timeout-action', '10000', '--timeout-navigation', '10000', '--output-dir', resolve(out, `${id}-browser`)];
    const transport = new StdioClientTransport({ command: process.execPath, args, cwd: root, env, stderr: 'pipe' });
    transport.stderr?.on('data', chunk => appendFileSync(resolve(out, `${id}-stderr.log`), chunk));
    const client = new Client({ name: 'workflow-cost-benchmark', version: '1.0' });
    const setupStart = performance.now();
    let start, answer = '', ended = 'turn-limit', setupMs = 0;
    const messages = [{ role: 'user', content: `${spec.task}\nURL: ${spec.url}` }];
    try {
      await client.connect(transport);
      const listed = (await client.listTools()).tools.filter(t => allowed[row.arm].includes(t.name));
      writeFileSync(resolve(out, `${row.arm}-tools.json`), JSON.stringify(listed, null, 2));
      // MCP schemas have genuinely optional properties and free-form step objects. Responses'
      // implicit strict normalization can force unwanted arguments (e.g. intent in a raw snapshot).
      // Preserve the original contract in BOTH arms; each MCP server still validates arguments.
      const tools = Object.fromEntries(listed.map(t => [t.name, tool({ strict: false, description: t.description, inputSchema: jsonSchema(t.inputSchema) })]));
      tools.read_artifact = tool({ strict: false, description: 'Read a snapshot artifact linked by a browser tool; paths are relative to the workspace. Optional zero-based startLine and lineCount select an excerpt.', inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer', minimum: 0 }, lineCount: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['path'], additionalProperties: false }) });
      tools.finish = tool({ strict: false, description: 'Finish the task and report the result or a blocker.', inputSchema: jsonSchema({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }) });
      setupMs = performance.now() - setupStart;
      start = performance.now();
      const signal = AbortSignal.any([AbortSignal.timeout(trialTimeoutMs), stopped.signal]);
      for (let turn = 0; turn < maxTurns; turn++) {
        const genStart = performance.now();
        const result = await generateText({ model: row.model, system: prompts[row.arm], messages, tools, maxOutputTokens: 4096, maxRetries: 0, abortSignal: signal, providerOptions: { openai: { reasoningEffort: 'low' }, gateway: { only: ['openai'] } } });
        const gateway = result.providerMetadata?.gateway;
        const usage = result.usage;
        const price = pricing[row.model];
        main.push({ elapsedMs: performance.now() - genStart, model: result.response.modelId, usage, ...costs(usage, price, gateway?.cost), provider: gateway?.routing?.finalProvider, attempts: gateway?.routing?.totalProviderAttemptCount, warnings: result.warnings });
        trace.push({ turn, text: result.text, calls: result.toolCalls, usage });
        messages.push(...result.response.messages);
        if (!result.toolCalls.length) { answer = result.text; ended = 'text'; break; }
        for (const call of result.toolCalls) {
          if (call.toolName === 'finish') { answer = call.input.answer; ended = 'finish'; break; }
          const toolStart = performance.now();
          let response;
          try {
            if (call.toolName !== 'read_artifact' && !allowed[row.arm].includes(call.toolName)) throw new Error('Tool not allowed in this benchmark arm');
            const serialized = JSON.stringify(call.input);
            if (call.input.hooks || call.input.filename || serialized.includes('css=') || call.input.headed === true) throw new Error('Outside benchmark UI-only protocol');
            if (call.toolName === 'read_artifact') {
              response = { content: [{ type: 'text', text: JSON.stringify(readArtifact(root, resolve(out, `${id}-browser`), call.input)) }] };
            } else response = await client.callTool({ name: call.toolName, arguments: call.input }, undefined, { signal, timeout: trialTimeoutMs });
          } catch (e) { response = { isError: true, content: [{ type: 'text', text: e.message }] }; }
          const value = response.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
          calls.push({ name: call.toolName, input: call.input, elapsedMs: performance.now() - toolStart, responseChars: value.length, isError: !!response.isError });
          trace.push({ tool: call.toolName, input: call.input, response });
          messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value } }] });
          if (signal.aborted) throw new Error('Trial timeout');
        }
        if (ended === 'finish') break;
        if (main.reduce((s, m) => s + (m.reportedCost ?? m.listCost), spent) >= budget) { ended = 'budget'; break; }
      }
    } catch (error) { ended = error.name; trace.push({ error: error.message }); }
    const elapsedMs = performance.now() - (start ?? setupStart);
    const check = fixtures.result(id, answer);
    await client.close().catch(() => {});
    const jev = existsSync(jevFile) ? readFileSync(jevFile, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
    const jevCost = jev.reduce((s, j) => s + (j.usage?.input_tokens ?? 0) * 0.042 / 1e6, 0);
    const mainCost = main.reduce((s, m) => s + (m.reportedCost ?? m.listCost), 0);
    spent += mainCost + jevCost;
    const result = { id, ...row, success: check.success, ended, answer, elapsedMs, setupMs, mainCost, jevCost, totalCost: mainCost + jevCost, noCacheCost: main.reduce((s, m) => s + m.noCacheCost, 0) + jevCost, usageComplete: main.length > 0 && main.every(m => m.usage.inputTokens != null && m.usage.outputTokens != null) && jev.every(j => j.status >= 200 && j.status < 300 && j.usage?.input_tokens != null) && !trace.some(t => t.error), main, jev, calls, events: check.events };
    appendFileSync(resolve(out, 'runs.jsonl'), JSON.stringify(result) + '\n');
    writeFileSync(resolve(out, `${id}-trace.json`), JSON.stringify({ task: spec.task, url: spec.url, trace }, null, 2));
    console.log(JSON.stringify({ run: index + 1, of: schedule.length, ...row, success: check.success, ended, seconds: Math.round(elapsedMs / 1000), dollars: +(mainCost + jevCost).toFixed(6), spent: +spent.toFixed(4) }));
  }
} finally { await fixtures.close(); }
