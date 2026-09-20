import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Drives the real server over stdio, as a plugin host does. Only css= regions and evaluate: no Jev, no key.
let client: Client;
before(async () => {
  client = new Client({ name: 'plainwright-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./cli.js', import.meta.url)), '--headless', 'mcp'] }));
});
after(() => client.close());

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  assert.ok(!res.isError, res.content[0]?.text);
  return JSON.parse(res.content[0].text);
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

test('evaluate returns the JSON value of a page expression', async () => {
  const r = await call('evaluate', { js: '[...document.querySelectorAll("td")].map(td => td.innerText)' });
  assert.deepEqual(r.value, ['Hotel Roma', '€120']);
  const listed = await client.listTools();
  assert.ok(listed.tools.some((t) => t.name === 'evaluate'));
});
