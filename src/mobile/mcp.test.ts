import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

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
  const child = spawn(process.execPath, [cli, '--server', 'http://127.0.0.1:9', 'mcp'], { cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'] });
  // Also after a test timeout, which leaves the test body waiting: a live server would keep `node --test` running.
  t.after(() => {
    child.kill('SIGKILL');
    rmSync(scratch, { recursive: true, force: true });
  });
  const lines: string[] = [];
  const replies = new Map<number, { resolve: (message: unknown) => void; reject: (error: Error) => void }>();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      lines.push(line);
      try {
        const message = JSON.parse(line) as { id?: number };
        if (message.id !== undefined) replies.get(message.id)?.resolve(message);
      } catch { /* asserted below, with the whole output */ }
    }
  });
  // 'close' comes after the last stdout chunk, which 'exit' does not wait for.
  const closed = once(child, 'close');
  child.once('close', (code) => {
    for (const { reject } of replies.values()) reject(new Error(`server closed (code ${code}) before replying:\n${stderr}`));
  });
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (id: number, method: string, params: object) =>
    new Promise<{ result?: { isError?: boolean; content?: { text: string }[] } }>((resolve, reject) => {
      replies.set(id, { resolve: resolve as (message: unknown) => void, reject });
      send({ id, method, params });
    });

  await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plain-test', version: '0' } });
  send({ method: 'notifications/initialized' });
  const opened = await request(2, 'tools/call', {
    name: 'open',
    arguments: { platform: 'android', device: 'emulator-5554', app: '${hooks.missing}', hooks: 'hooks.mjs' },
  });
  assert.equal(opened.result?.isError, true, JSON.stringify(opened));
  assert.match(opened.result?.content?.[0]?.text ?? '', /hooks\.missing/);
  replies.clear();
  child.stdin.end();
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('still running 10 s after end of input')), 10000).unref());
  await Promise.race([closed, timeout]);
  if (buffer) lines.push(buffer);
  const notJsonRpc = lines.filter((line) => {
    try {
      return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc !== '2.0';
    } catch {
      return true;
    }
  });
  assert.deepEqual(notJsonRpc, [], `stdout lines that are not JSON-RPC:\n${lines.join('\n')}`);
  for (const text of ['setup log', 'setup info', 'setup write', 'teardown log']) assert.ok(stderr.includes(text), `${text} not on stderr:\n${stderr}`);
});
