import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Each CLI loads the `.env` files after its imports have run, so a switch read when a module loads misses them.
const dir = mkdtempSync(join(tmpdir(), 'plain-env-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const switchedOff = join(dir, 'off');
const plain = join(dir, 'default');
mkdirSync(switchedOff);
mkdirSync(plain);
writeFileSync(join(switchedOff, '.env'), 'PLAIN_READ=0\nPLAIN_CHANGES=0\n');

const inherited = Object.entries(process.env).filter(([name, value]) =>
  value !== undefined && !/^(PLAIN|JEV)_/.test(name)) as [string, string][];
// No key: warmUp sends no request. The user env file is looked for in the empty scratch folder.
const env = { ...Object.fromEntries(inherited), TYPESAFE_API_KEY: '', AI_GATEWAY_API_KEY: '', XDG_CONFIG_HOME: dir };

const engines = [
  { name: 'browser', entry: '../cli.js', args: ['--headless', 'mcp'] },
  { name: 'desktop', entry: '../computer/cli.js', args: ['mcp'] },
  { name: 'mobile', entry: '../mobile/cli.js', args: ['mcp'] },
];

/** The tool names and descriptions of one MCP server started in `cwd`. */
async function toolsIn(entry: string, args: string[], cwd: string) {
  const client = new Client({ name: 'plain-env-test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [fileURLToPath(new URL(entry, import.meta.url)), ...args], cwd, env, stderr: 'ignore',
  }));
  try {
    const { tools } = await client.listTools();
    const described = (name: string) => tools.find((tool) => tool.name === name)?.description ?? '';
    return { names: tools.map((tool) => tool.name), step: described('step'), all: tools.map((tool) => tool.description).join('\n') };
  } finally {
    await client.close();
  }
}

for (const { name, entry, args } of engines) {
  test(`${name} MCP server: PLAIN_READ=0 and PLAIN_CHANGES=0 in .env turn off read and changed`, async () => {
    const on = await toolsIn(entry, args, plain);
    assert.ok(on.names.includes('read'), on.names.join(', '));
    assert.match(on.step, /`changed`/);
    const off = await toolsIn(entry, args, switchedOff);
    assert.ok(!off.names.includes('read'), `read is listed: ${off.names.join(', ')}`);
    assert.doesNotMatch(off.all, /`changed`/); // the browser batch description too
  });
}
