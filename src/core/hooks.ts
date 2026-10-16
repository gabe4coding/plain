import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Spec } from './spec.js';
import type { Status, StepResult } from './results.js';

export interface HookSpec { name: string; steps: unknown[] }

interface TeardownArgs<S> { spec: S; data: Record<string, unknown>; result: { status: Status; steps: StepResult[] } }

/**
 * What a hooks module may export; both are optional. Hooks run in their own child process, so their arguments
 * are JSON only: no `page`. What `setup` returns is any JSON object (no dataset shape imposed); its leaves are
 * the spec's `${hooks.*}` placeholders and teardown's `data`.
 */
export interface HooksModule<S extends HookSpec = Spec> {
  setup?: (args: { spec: S }) => unknown;
  teardown?: (args: TeardownArgs<S>) => unknown;
}

export type HooksRunner<S extends HookSpec = Spec> = {
  has: { setup: boolean; teardown: boolean };
  setup(spec: S): Promise<Record<string, unknown>>;
  teardown(args: TeardownArgs<S>): Promise<void>;
  close(): void;
};

type ChildReply = { type: string; ok?: boolean; data?: Record<string, unknown>; message?: string; has?: { setup: boolean; teardown: boolean } };

/**
 * Imports and checks a hooks module in its own child process (src/core/hooks-child.ts), one per spec run: module
 * state never leaks between specs, and concurrent specs never share a module instance. One request is in
 * flight at a time, so the child's next message is always the reply. The child's stdout is this process's stderr
 * and its stdin is closed: stdout carries the MCP messages and the jsonl report, and stdin the MCP requests.
 */
export async function startHooks<S extends HookSpec = Spec>(file: string): Promise<HooksRunner<S>> {
  const child: ChildProcess = fork(fileURLToPath(new URL('./hooks-child.js', import.meta.url)), [file], { stdio: ['ignore', 2, 2, 'ipc'] });

  let pending: { resolve: (reply: ChildReply) => void; reject: (error: Error) => void } | null = null;
  const settle = (fn: (waiting: NonNullable<typeof pending>) => void) => {
    if (pending) fn(pending);
    pending = null;
  };
  child.on('message', (reply: ChildReply) => settle((waiting) => waiting.resolve(reply)));
  const onGone = (reason: string) => settle((waiting) => waiting.reject(new Error(`hooks child for ${file} ${reason}`)));
  child.on('exit', (code) => onGone(`exited (code ${code}) before responding`));
  child.on('error', (error) => onGone(`failed: ${error.message}`));
  const request = (message?: Record<string, unknown>): Promise<ChildReply> => {
    const reply = new Promise<ChildReply>((resolve, reject) => (pending = { resolve, reject }));
    if (message) child.send(message);
    return reply;
  };

  const ready = await request(); // 'ready' or 'error', as soon as the module is imported and checked
  if (ready.type === 'error') {
    child.kill();
    throw new Error(ready.message);
  }

  return {
    has: ready.has ?? { setup: false, teardown: false },
    async setup(spec) {
      const reply = await request({ type: 'setup', spec });
      if (!reply.ok) throw new Error(reply.message);
      return reply.data ?? {};
    },
    async teardown(args) {
      const reply = await request({ type: 'teardown', ...args });
      if (!reply.ok) throw new Error(reply.message);
    },
    close: () => void child.kill(),
  };
}

/** The `${hooks.a.b}` placeholders `data` offers, for the MCP `open` result: never the values, which may be secrets. */
export function placeholderPaths(data: Record<string, unknown>, prefix = 'hooks'): string[] {
  return Object.entries(data).flatMap(([key, value]) => value && typeof value === 'object' && !Array.isArray(value)
    ? placeholderPaths(value as Record<string, unknown>, `${prefix}.${key}`)
    : ['${' + prefix + '.' + key + '}']);
}
