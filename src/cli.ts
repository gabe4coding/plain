#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadSpec } from './spec.js';
import { runSpec, closeSharedBrowser, type RunOptions } from './runner.js';
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
  },
  allowPositionals: true,
});

if (positionals.length === 0) {
  console.error(
    'usage: plainwright [--headless] [--timeout <ms>] [--profile <dir>] [--cdp <url>] [--channel chrome] [--timing] <spec.yaml> [more.yaml ...] | mcp'
  );
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

  for (const file of positionals) {
    try {
      const spec = loadSpec(file);
      const result = await runSpec(spec, opts);
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
    } catch (err) {
      allPassed = false;
      console.log(`✘ ${file}`);
      console.log(`  error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await closeSharedBrowser();

  if (values.timing && Object.keys(runMs).length) {
    console.log(`ms run ${formatMs(runMs)}`);
  }

  process.exit(allPassed ? 0 : 1);
}
