import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mcpStdio } from '../core/mcp-stdio.test.js';

// Drives the real server over stdio, as a plugin host does. CSS targets avoid paid model calls.
let client: Client;
const scratch = mkdtempSync(join(tmpdir(), 'plain-mcp-test-'));
async function startServer(name: string): Promise<Client> {
  const started = new Client({ name, version: '0' });
  await started.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../cli.js', import.meta.url)), '--headless', '--timeout', '500', 'mcp'] }));
  return started;
}
before(async () => { client = await startServer('plain-test'); });
after(async () => { await client.close(); rmSync(scratch, { recursive: true, force: true }); });

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  assert.ok(!res.isError, res.content[0]?.text);
  assert.ok(res.structuredContent, `${name} must return structuredContent`);
  assert.deepEqual(res.structuredContent, JSON.parse(res.content[0].text));
  return res.structuredContent;
}

const PAGE =
  'data:text/html,' +
  encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"></head><body><main><table><tr><td>Hotel Roma</td><td>€120</td></tr></table></main><footer><a href="/x">Footer link</a></footer></body></html>`
  );

test('snapshot within a css= region returns only that subtree', async () => {
  await call('open', { url: PAGE });
  const snap = await call('snapshot', { within: 'css=main' });
  assert.match(snap.aria as string, /Hotel Roma/);
  assert.doesNotMatch(snap.aria as string, /Footer link/);
  assert.match(snap.region as string, /css=main/);
});

test('a css= region matching several elements is reported, not a strict-mode dump', async () => {
  await call('open', { url: PAGE });
  const snap = await call('snapshot', { within: 'css=td' });
  assert.equal(snap.found, false);
  assert.match(snap.detail as string, /css=td matched 2 elements; make the selector match exactly one/);
  const step = await call('step', { step: { click: 'css=td' } });
  assert.equal(step.status, 'inconclusive');
});

test('evaluate returns the JSON value of a page expression', async () => {
  const r = await call('evaluate', { js: '[...document.querySelectorAll("td")].map(td => td.innerText)' });
  assert.deepEqual(r.value, ['Hotel Roma', '€120']);
  const listed = await client.listTools();
  assert.ok(listed.tools.some((t) => t.name === 'evaluate'));
  assert.equal(listed.tools.find((t) => t.name === 'ask')?.annotations?.readOnlyHint, true);
});

test('structured evaluate results preserve objects, scalars and null', async () => {
  for (const [js, value] of [
    ['({ nested: { items: [1, null, false] }, omitted: undefined })', { nested: { items: [1, null, false] } }],
    ['"hello"', 'hello'], ['0', 0], ['false', false], ['null', null], ['undefined', null],
  ] as const) {
    assert.deepEqual((await call('evaluate', { js })).value, value);
  }
  const error = await client.callTool({ name: 'evaluate', arguments: { js: 'throw new Error("fixture failure")' } });
  assert.equal(error.isError, true);
  assert.equal(error.structuredContent, undefined);
  assert.match((error.content as { text: string }[])[0].text, /fixture failure/);
});

test('compact browser snapshots preserve scoped data without Jev and expose coverage', async () => {
  const r = await call('snapshot', { mode: 'compact', within: 'css=main', maxChars: 500 });
  assert.equal(r.mode, 'compact');
  assert.match((r.observed as { aria: string }).aria, /Hotel Roma/);
  assert.doesNotMatch((r.observed as { aria: string }).aria, /Footer link/);
  assert.equal(r.jevTokens, 0);
  assert.equal((r.coverage as { sourceTruncated: boolean }).sourceTruncated, false);
  assert.ok((r.ms as { total: number }).total >= 0);
});

const html = (body: string) => 'data:text/html,' + encodeURIComponent(`<!doctype html><body>${body}</body>`);

test('batch preflights all steps and placeholders before any action; enforces bounds', async () => {
  await call('open', { url: html('<input id="name">') });
  const first = { fill: { target: 'css=#name', value: 'must not happen' } };
  for (const steps of [[], Array(17).fill(first), [first, { unknown: 'action' }], [first, { fill: { target: 'css=#name', value: '${hooks.missing}' } }]]) {
    const r = await client.callTool({ name: 'batch', arguments: { steps } });
    assert.equal(r.isError, true);
    assert.equal((await call('evaluate', { js: 'document.querySelector("input").value' })).value, '');
  }
});

test('batch resolves each action after DOM replacement, serializes concurrent reads and saves flat hook placeholders', async () => {
  const hooks = join(scratch, 'hooks.mjs');
  writeFileSync(hooks, 'export function setup() { return { name: "Ada" }; }');
  await call('open', { hooks, url: html(`<button onclick="setTimeout(()=>document.querySelector('main').innerHTML='<input id=name>',50)">Next</button><main></main>`) });
  const steps = [{ click: 'css=button' }, { fill: { target: 'css=#name', value: '${hooks.name}' } }];
  const [result, read] = await Promise.all([
    call('batch', { steps }),
    call('evaluate', { js: 'document.querySelector("input")?.value ?? null' }),
  ]);
  assert.equal(result.status, 'pass');
  assert.equal(result.completed, 2);
  assert.equal(result.remaining, 0);
  assert.equal(result.stoppedAt, null);
  assert.equal(result.jevTokens, 0);
  assert.deepEqual((result.results as { index: number }[]).map(r => r.index), [0, 1]);
  assert.equal(read.value, 'Ada');
  const path = join(scratch, 'batch.yaml');
  await call('save', { path });
  const saved = parse(readFileSync(path, 'utf8'));
  assert.deepEqual(saved.steps.slice(-2), steps);
  assert.equal(saved.hooks, './hooks.mjs');
});

test('batch stops at a failed action, retains prior effects and records only the passing prefix', async () => {
  await call('open', { url: html('<input id="name"><button disabled>Unavailable</button>') });
  const path = join(scratch, 'partial.yaml');
  const before = await call('save', { path });
  const first = { fill: { target: 'css=#name', value: 'kept' } };
  const result = await call('batch', { steps: [first, { click: 'css=button' }, { fill: { target: 'css=#name', value: 'must not happen' } }] });
  assert.equal(result.status, 'error');
  assert.equal(result.completed, 1);
  assert.equal(result.stoppedAt, 1);
  assert.equal(result.remaining, 1);
  assert.equal((result.results as unknown[]).length, 2);
  assert.equal((await call('evaluate', { js: 'document.querySelector("input").value' })).value, 'kept');
  const after = await call('save', { path });
  assert.equal(after.steps, (before.steps as number) + 1);
  assert.deepEqual(parse(readFileSync(path, 'utf8')).steps.at(-1), first);
  // A rejected batch must not poison the session queue.
  assert.equal((await call('step', { step: { fill: { target: 'css=#name', value: 'recovered' } } })).status, 'pass');
});

test('batch stops on an optional skipped target instead of silently running dependent steps', async () => {
  // No actionable candidates: the natural-language resolver returns inconclusive without Jev.
  await call('open', { url: html('<p>Before</p>') });
  assert.equal((await call('step', { step: { click: 'the missing button', optional: true } })).status, 'skipped');
  const result = await call('batch', { steps: [{ click: 'the missing button', optional: true }, { goto: 'about:blank' }] });
  assert.equal(result.status, 'skipped');
  assert.equal(result.stoppedAt, 0);
  assert.equal(result.completed, 0);
  assert.equal(result.remaining, 1);
  assert.equal((await call('evaluate', { js: 'document.querySelector("p").textContent' })).value, 'Before');
});

test('canceling a batch allows its in-flight action to finish but prevents later actions', { timeout: 10000 }, async () => {
  let started!: () => void;
  const clicked = new Promise<void>(resolve => { started = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/started') {
      started();
      setTimeout(() => res.end('ok'), 150);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<button onclick="fetch(\'/started\');this.textContent=\'Clicked\'">Start</button><input>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    await call('open', { url: `http://127.0.0.1:${address.port}` });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'batch', arguments: { steps: [
      { click: 'css=button' }, { fill: { target: 'css=input', value: 'must not happen' } },
    ] } }, undefined, { signal: controller.signal });
    const canceled = assert.rejects(pending);
    await clicked;
    controller.abort();
    await canceled;
    const state = await call('evaluate', { js: '({button:document.querySelector("button").textContent,value:document.querySelector("input").value})' });
    assert.deepEqual(state.value, { button: 'Clicked', value: '' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a typed password reaches step changes and snapshots only as a mask', async () => {
  await call('open', { url: html('<form><label>Password <input type="password" id="pw"></label></form>') });
  const step = await call('step', { step: { fill: { target: 'css=#pw', value: 'hunter2' } } });
  assert.equal(step.status, 'pass');
  assert.deepEqual(step.changed, { added: ['- textbox "Password": "[filled]"'], addedOmitted: 0, removed: 1 });
  for (const args of [{}, { within: 'css=form' }, { mode: 'compact' }]) {
    const snap = JSON.stringify(await call('snapshot', args));
    assert.doesNotMatch(snap, /hunter2/);
    assert.match(snap, /textbox \\"Password\\": \\"\[filled\]\\"/);
  }
});

test('save writes values typed into password fields as env references, never as literals', async () => {
  // Its own server: the shared one already holds the passwords of earlier tests.
  const own = await startServer('plain-test-secrets');
  const ownCall = async (name: string, args: Record<string, unknown>) =>
    ((await own.callTool({ name, arguments: args })) as { structuredContent: Record<string, unknown> }).structuredContent;
  try {
    const hooks = join(scratch, 'secret-hooks.mjs');
    writeFileSync(hooks, 'export function setup() { return { pin: "9999" }; }');
    await ownCall('open', { hooks, url: html('<input id="user"><input type="password" id="pw"><input id="confirm">' +
      '<input type="password" id="code"><input type="password" id="pin">') });
    const result = await ownCall('batch', { steps: [
      { fill: { target: 'css=#user', value: 'tomsmith' } },
      { fill: { target: 'css=#pw', value: 'hunter2' } },
      { fill: { target: 'css=#confirm', value: 'hunter2' } },
      { fill: { target: 'css=#code', value: '4321' } },
      { fill: { target: 'css=#pin', value: '${hooks.pin}' } },
    ] });
    assert.equal(result.status, 'pass');
    const path = join(scratch, 'secrets.yaml');
    const saved = await ownCall('save', { path });
    const env = { password: '$PASSWORD', password2: '$PASSWORD_2' };
    assert.deepEqual(saved.env, env);
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(text, /hunter2|4321/);
    const spec = parse(text); // the text-type confirm field gets the reference too: its value was typed as a password
    assert.deepEqual(spec.env, env);
    assert.deepEqual(spec.steps.slice(1).map((step: { fill: { value: string } }) => step.fill.value),
      ['tomsmith', '${env.password}', '${env.password}', '${env.password2}', '${hooks.pin}']);
  } finally {
    await own.close();
  }
});

test('save before any open is an error and leaves an existing spec and its lock as they were', async () => {
  // Its own server: the shared one already holds the steps of earlier tests.
  const own = await startServer('plain-test-empty-save');
  try {
    const path = join(scratch, 'kept.yaml');
    const lock = join(scratch, 'kept.lock.json');
    writeFileSync(path, 'name: kept\n');
    writeFileSync(lock, '{}\n');
    const result = await own.callTool({ name: 'save', arguments: { path } });
    assert.equal(result.isError, true);
    assert.match((result.content as { text: string }[])[0].text, /No successful steps to save/);
    assert.equal(readFileSync(path, 'utf8'), 'name: kept\n');
    assert.equal(readFileSync(lock, 'utf8'), '{}\n');
  } finally {
    await own.close();
  }
});

test('teardown gets the status of a failed step when a passing step follows it', async () => {
  // Its own server: the shared one already holds the steps of earlier tests.
  const own = await startServer('plain-test-teardown-status');
  const ownCall = async (name: string, args: Record<string, unknown>) =>
    ((await own.callTool({ name, arguments: args })) as { structuredContent: Record<string, unknown> }).structuredContent;
  try {
    const out = join(scratch, 'teardown-status.txt');
    const hooks = join(scratch, 'status-hooks.mjs');
    writeFileSync(hooks, `import { appendFileSync } from 'node:fs';
export function teardown({ result }) { appendFileSync(${JSON.stringify(out)}, result.status + '\\n'); }`);
    await ownCall('open', { hooks, url: html('<input id="name"><button disabled>Unavailable</button>') });
    assert.equal((await ownCall('step', { step: { click: 'css=button' } })).status, 'error');
    assert.equal((await ownCall('step', { step: { fill: { target: 'css=#name', value: 'next' } } })).status, 'pass');
    // A second `open {hooks}` releases the first lease: its teardown ends before the call returns.
    await ownCall('open', { hooks, url: html('<input id="name">') });
    assert.equal(readFileSync(out, 'utf8'), 'error\n');
    // Each lease gets only its own steps: the first flow's failure does not fail the second.
    assert.equal((await ownCall('step', { step: { fill: { target: 'css=#name', value: 'again' } } })).status, 'pass');
    await ownCall('open', { hooks, url: html('<p>third flow</p>') });
    assert.equal(readFileSync(out, 'utf8'), 'error\npass\n');
  } finally {
    await own.close();
  }
});

test('step results carry what the action changed; open keeps a goal that save writes', async () => {
  const page = 'data:text/html,' + encodeURIComponent(`<!doctype html><title>Menu</title><button onclick="document.body.insertAdjacentHTML('beforeend','<p>Saved: 3 items</p>')">Save</button>`);
  await call('open', { url: page, goal: 'save the list' });
  const r = await call('step', { step: { click: 'css=button' } });
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.changed, { added: ['- paragraph: "Saved: 3 items"'], addedOmitted: 0, removed: 0 });
  const path = join(scratch, 'goal.yaml');
  await call('save', { path });
  assert.equal(parse(readFileSync(path, 'utf8')).goal, 'save the list');
});

test('the server shuts down when its input ends, with no signal (a host behind npx and a shell)', { timeout: 30000 }, async (t) => {
  // `open` starts Chromium, which can be slow on a cold runner: the test timeout is the limit, not the reply time.
  const server = mcpStdio(t, [fileURLToPath(new URL('../cli.js', import.meta.url)), '--headless', 'mcp'], { replyMs: 30000 });
  await server.initialize();
  // An open page keeps Chromium, and so the server, alive unless end of input stops it.
  const opened = await server.request('tools/call', { name: 'open', arguments: { url: 'data:text/html,<p>open</p>' } });
  assert.ok(!opened.result?.isError, JSON.stringify(opened));
  assert.equal(await server.end(10000), 0);
  assert.deepEqual(server.notJsonRpc(), [], `stdout lines that are not JSON-RPC:\n${server.lines.join('\n')}`);
});
