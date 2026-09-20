#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadSpec, type Spec } from './spec.js';
import { runSpec, closeSharedBrowser, mapLimitSettled, type RunOptions, type TestResult } from './runner.js';
import { serveMcp } from './mcp.js';
import { formatMs } from './steps.js';
import { provider, MODEL_BY_PROVIDER, USER_ENV_FILE } from './jev.js';
import { homedir } from 'node:os';

// ponytail: cwd .env first, then the user file; a variable already set in the environment is never overridden
for (const file of ['.env', USER_ENV_FILE]) {
  try {
    process.loadEnvFile(file);
  } catch {
    /* no such file — fine */
  }
}

const { values, positionals } = parseArgs({
  options: {
    headless: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '15000' },
    profile: { type: 'string' },
    cdp: { type: 'string' },
    channel: { type: 'string' },
    timing: { type: 'boolean', default: false },
    workers: { type: 'string', default: '1' },
  },
  allowPositionals: true,
});

if (positionals.length === 0) {
  console.error(
    'usage: plainwright [--headless] [--timeout <ms>] [--profile <dir>] [--cdp <url>] [--channel chrome] [--timing] [--workers N] <spec.yaml> [more.yaml ...] | mcp'
  );
  process.exit(2);
}

const workers = Math.max(1, parseInt(values.workers, 10));
if (Number.isNaN(workers)) {
  console.error(`plainwright: --workers must be a number, got "${values.workers}"`);
  process.exit(2);
}

const opts: RunOptions = {
  headed: !values.headless,
  timeout: Number(values.timeout),
  // ponytail: env fallbacks so a plugin install, whose arguments are fixed, can still be pointed at a
  // profile or a running Chrome from ~/.config/plainwright/.env
  profile: (values.profile ?? process.env.PLAINWRIGHT_PROFILE)?.replace(/^~(?=\/|$)/, homedir()), // .env files don't expand ~
  cdp: values.cdp ?? process.env.PLAINWRIGHT_CDP,
  channel: values.channel ?? process.env.PLAINWRIGHT_CHANNEL,
};

if (workers > 1 && (opts.profile || opts.cdp)) {
  console.error(
    'plainwright: --workers > 1 needs isolated browsers; --profile opens one persistent profile (cannot be opened twice) and --cdp attaches to one shared browser context. Run those with --workers 1.'
  );
  process.exit(2);
}

try {
  const p = provider();
  console.error(`plainwright: Jev via ${p} (${MODEL_BY_PROVIDER[p]})`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  // MCP mode keeps serving: the first Jev call returns this message as a tool error, where the agent can read it.
  if (positionals[0] !== 'mcp') process.exit(2);
}

if (positionals[0] === 'mcp') {
  await serveMcp(opts); // stays alive until the transport closes
} else {
  const icon = (status: string): string => {
    if (status === 'pass') return '✔';
    if (status === 'inconclusive') return '?';
    if (status === 'skipped') return '»'; // ponytail: optional step that didn't land, run continued
    return '✘'; // fail or error
  };

  let allPassed = true;

  // Sums another step/spec's `ms` phases into `target`, in place — used to roll step ms up to a
  // per-spec total and per-spec totals up to a per-run total.
  const addMs = (target: Record<string, number>, source: Record<string, number>): void => {
    for (const [k, v] of Object.entries(source)) target[k] = (target[k] ?? 0) + v;
  };

  const runMs: Record<string, number> = {};

  // Each spec's work (load + run) is wrapped so it never rejects — a per-spec failure becomes data
  // (`error`), not a thrown promise — and submitted through the worker pool. Printing then iterates
  // the per-item promises in input order, printing each as soon as it resolves: with --workers 1 the
  // single worker runs specs strictly one after another, so output stays byte-identical to before;
  // with more workers, later specs keep running while an earlier one is still being printed.
  type SpecOutcome = { file: string; spec?: Spec; result?: TestResult; error?: unknown };
  const outcomes = mapLimitSettled(positionals, workers, async (file): Promise<SpecOutcome> => {
    try {
      const spec = loadSpec(file);
      const result = await runSpec(spec, opts);
      return { file, spec, result };
    } catch (error) {
      return { file, error };
    }
  });

  for (const outcome of outcomes) {
    const { file, spec, result, error } = await outcome;
    if (!spec || !result) {
      allPassed = false;
      console.log(`✘ ${file}`);
      console.log(`  error: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (result.status !== 'pass') allPassed = false;
    console.log(`${icon(result.status)} ${spec.name}  (${result.jevCalls} Jev calls, ${result.totalTokens} tokens)`);
    const specMs: Record<string, number> = {};
    for (const s of result.steps) {
      console.log(`  ${icon(s.status)} ${s.step}${s.detail ? ' ' + s.detail : ''}`);
      if (values.timing && s.ms) {
        console.log(`    ms ${formatMs(s.ms)}`);
        addMs(specMs, s.ms);
      }
    }
    if (values.timing && Object.keys(specMs).length) {
      console.log(`  ms spec ${formatMs(specMs)}`);
      addMs(runMs, specMs);
    }
  }

  await closeSharedBrowser();

  if (values.timing && Object.keys(runMs).length) {
    console.log(`ms run ${formatMs(runMs)}`);
  }

  process.exit(allPassed ? 0 : 1);
}
