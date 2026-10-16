#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { errorMessage } from '../core/results.js';
import { loadEnvFiles } from '../jev/provider.js';
import { nativeCli } from '../suite/native-cli.js';
import { Xa11yAdapter } from './adapter.js';
import { ComputerSession, runComputerSpec } from './session.js';
import { loadComputerSpec, parseComputerStep } from './spec.js';
import type { PlanItem } from './planner.js';

const newSession = (timeout: number) => new ComputerSession(new Xa11yAdapter(timeout), timeout);

const [mode] = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
if (mode === 'plan' || mode === 'do') {
  await planOrDo(mode);
} else {
  await nativeCli('plain-computer', 'plan|do "<sentence>" | ', 'desktop', {
    serve: async (timeout) => (await import('./mcp.js')).serveComputerMcp(timeout), // the MCP SDK loads only when serving
    load: loadComputerSpec,
    meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [], timeoutMs: spec.timeout }),
    run: (spec, timeout, _values, observer, info, specTimeout) => runComputerSpec(spec, newSession(timeout), observer, info, specTimeout),
  });
}

/**
 * `plan "<sentence>"` prints the plan Jev makes of a sentence (src/computer/planner.ts); `do` also runs it as a
 * desktop spec in the app it names (or --app). Everything is checked before the first action.
 */
async function planOrDo(mode: 'plan' | 'do') {
  loadEnvFiles();
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      timeout: { type: 'string', default: '15000' },
      app: { type: 'string' },
      yes: { type: 'boolean', default: false },
    } });
    const text = positionals.slice(1).join(' ').trim();
    if (!text) throw new Error(`usage: plain-computer ${mode} [--app NAME] [--yes] [--timeout 15000] "<sentence>"`);
    const { plan } = await import('./planner.js');
    const { items, tokens } = await plan(text);
    if (mode === 'plan') {
      console.log(JSON.stringify({ items, tokens }));
      return;
    }
    const { app, steps } = stepsToRun(items, values.app, values.yes);
    const timeout = Number(values.timeout);
    const result = await runComputerSpec({ name: text, app, dir: process.cwd(), env: {}, steps }, newSession(timeout));
    console.log(JSON.stringify({ ...result, planTokens: tokens }));
    process.exitCode = result.status === 'pass' ? 0 : 1;
  } catch (error) {
    console.error(`plain-computer ${mode}: ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}

/** The app and the steps a plan runs, up to its first `stop`; throws on anything not understood or not allowed. */
function stepsToRun(items: PlanItem[], appFlag: string | undefined, allowRisky: boolean) {
  const unknown = items.filter((item) => item.kind === 'unknown');
  if (unknown.length) throw new Error(`not understood: ${unknown.map((item) => `"${item.text}" (${item.reason})`).join('; ')}`);
  const risky = items.filter((item) => item.kind === 'step' && item.risky);
  if (risky.length && !allowRisky) {
    throw new Error(`hard to undo, rerun with --yes to allow: ${risky.map((item) => JSON.stringify(item.kind === 'step' && item.step)).join('; ')}`);
  }
  const stop = items.findIndex((item) => item.kind === 'stop');
  const run = stop < 0 ? items : items.slice(0, stop);
  const opens = run.filter((item) => item.kind === 'open');
  if (opens.length > 1 || (opens.length && run[0].kind !== 'open')) {
    throw new Error('one app per run: name it first ("open Notes, then ...") or pass --app');
  }
  const app = opens[0]?.kind === 'open' ? opens[0].app : appFlag;
  if (!app) throw new Error('which app? Start with "open <app>" or pass --app');
  const steps = run.flatMap((item, n) => item.kind === 'step' ? [parseComputerStep(item.step, 'do', n)]
    : item.kind === 'ask' ? [parseComputerStep({ expect: item.claim }, 'do', n)]
      : []);
  if (!steps.length) throw new Error('nothing to do after opening the app');
  return { app, steps };
}
