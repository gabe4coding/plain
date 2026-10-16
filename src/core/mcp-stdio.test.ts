// Shared test client; the .test name keeps it out of the package (package.json "files" skips *.test.js).
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { TestContext } from 'node:test';

type Reply = { id: number; result?: { isError?: boolean; content?: { text: string }[] }; error?: unknown };

const REPLY_MS = 15000;

/**
 * An MCP server over stdio, driven with raw JSON-RPC lines, for tests that need the stdout lines themselves or the
 * end of input. A request fails when the server closes first or sends no reply in `replyMs`, so a broken server
 * fails the test instead of hanging it. The child is killed after the test, also after a test timeout, which
 * leaves the test body waiting: a live server would keep `node --test` running.
 */
export function mcpStdio(t: TestContext, args: string[], { cwd, replyMs = REPLY_MS }: { cwd?: string; replyMs?: number } = {}) {
  const child = spawn(process.execPath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const lines: string[] = [];
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  let buffer = '';
  let stderr = '';
  let nextId = 1;
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  // A write after the server died fails with EPIPE; the pending request then rejects on 'close' with the stderr.
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      lines.push(line);
      try {
        const message = JSON.parse(line) as Reply;
        if (message.id !== undefined) pending.get(message.id)?.resolve(message);
      } catch { /* a line that is not JSON: notJsonRpc() reports it */ }
    }
  });
  // 'close' comes after the last stdout chunk, which 'exit' does not wait for.
  const closed = once(child, 'close') as Promise<[number | null]>;
  child.once('close', (code) => {
    if (buffer) lines.push(buffer);
    for (const { reject } of pending.values()) reject(new Error(`server closed (code ${code}) before replying:\n${stderr}`));
  });
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (method: string, params: object) => new Promise<Reply>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`no reply to ${method} in ${replyMs} ms:\n${stderr}`)), replyMs);
    const settle = <T>(done: (value: T) => void) => (value: T) => { clearTimeout(timer); pending.delete(id); done(value); };
    pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    send({ id, method, params });
  });
  return {
    lines,
    stderr: () => stderr,
    request,
    async initialize() {
      const reply = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plain-test', version: '0' } });
      send({ method: 'notifications/initialized' });
      return reply;
    },
    /** Ends the input and waits for the server to close, at most `ms`; returns the exit code. */
    async end(ms: number) {
      child.stdin.end();
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still running ${ms / 1000} s after end of input`)), ms); });
      try {
        const [code] = await Promise.race([closed, late]);
        return code;
      } finally { clearTimeout(timer); }
    },
    /** The stdout lines that are not JSON-RPC 2.0 messages. */
    notJsonRpc: () => lines.filter((line) => {
      try {
        return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc !== '2.0';
      } catch {
        return true;
      }
    }),
  };
}
