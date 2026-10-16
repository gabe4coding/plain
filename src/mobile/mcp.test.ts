import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpStdio } from '../core/mcp-stdio.test.js';

// The mobile server over stdio, as a plugin host runs it: stdout is the JSON-RPC channel, so a hooks module that
// writes to stdout must not reach it. `${hooks.missing}` stops `open` after setup and before Appium, so no device
// or server is needed, and teardown still runs.
test('hooks output goes to stderr: every stdout line of the MCP server stays JSON-RPC', { timeout: 30000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'plain-mobile-mcp-'));
  writeFileSync(join(scratch, 'hooks.mjs'), [
    "export function setup() { console.log('setup log'); console.info('setup info'); process.stdout.write('setup write\\n'); return {}; }",
    "export function teardown() { console.log('teardown log'); }",
  ].join('\n'));
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const server = mcpStdio(t, [cli, '--server', 'http://127.0.0.1:9', 'mcp'], { cwd: scratch });
  // Registered after the server, so the kill runs first.
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  await server.initialize();
  const opened = await server.request('tools/call', {
    name: 'open',
    arguments: { platform: 'android', device: 'emulator-5554', app: '${hooks.missing}', hooks: 'hooks.mjs' },
  });
  assert.equal(opened.result?.isError, true, JSON.stringify(opened));
  assert.match(opened.result?.content?.[0]?.text ?? '', /hooks\.missing/);
  await server.end(10000);
  assert.deepEqual(server.notJsonRpc(), [], `stdout lines that are not JSON-RPC:\n${server.lines.join('\n')}`);
  const stderr = server.stderr();
  for (const text of ['setup log', 'setup info', 'setup write', 'teardown log']) assert.ok(stderr.includes(text), `${text} not on stderr:\n${stderr}`);
});
