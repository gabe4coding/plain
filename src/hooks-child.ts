// Child process entry for one spec run's hooks module (forked by `startHooks` in runner.ts). Runs
// the hooks module in its own process so module-level state never leaks between specs and
// concurrent specs (--workers) never share a module instance. Only JSON crosses the IPC channel, so
// a function or class instance in what `setup` returns is silently dropped — return plain data only.
import { pathToFileURL } from 'node:url';
import type { HooksModule } from './runner.js';

const file = process.argv[2];
let hooks: HooksModule = {};

function send(msg: Record<string, unknown>): void {
  process.send?.(msg);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

process.on('disconnect', () => process.exit(0)); // an orphaned child dies with its parent

process.on('message', async (msg: { type: string; [key: string]: unknown }) => {
  if (msg.type === 'setup') {
    try {
      const returned = hooks.setup ? await hooks.setup({ spec: msg.spec as never }) : undefined;
      if (returned !== undefined && (returned === null || typeof returned !== 'object')) {
        throw new Error('setup must return an object');
      }
      send({ type: 'setup', ok: true, data: returned ?? {} });
    } catch (err) {
      send({ type: 'setup', ok: false, message: errorMessage(err) });
    }
  } else if (msg.type === 'teardown') {
    try {
      if (hooks.teardown) {
        await hooks.teardown({ spec: msg.spec as never, data: msg.data as Record<string, unknown>, result: msg.result as never });
      }
      send({ type: 'teardown', ok: true });
    } catch (err) {
      send({ type: 'teardown', ok: false, message: errorMessage(err) });
    }
  }
});

(async () => {
  try {
    hooks = await import(pathToFileURL(file).href);
    if (hooks.setup !== undefined && typeof hooks.setup !== 'function') throw new Error(`${file}: "setup" must be a function`);
    if (hooks.teardown !== undefined && typeof hooks.teardown !== 'function') throw new Error(`${file}: "teardown" must be a function`);
    send({ type: 'ready', has: { setup: typeof hooks.setup === 'function', teardown: typeof hooks.teardown === 'function' } });
  } catch (err) {
    send({ type: 'error', message: errorMessage(err) });
  }
})();
