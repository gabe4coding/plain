#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadSpec } from './spec.js';
import { runSpec } from './runner.js';
import { serveMcp } from './mcp.js';
import { provider, MODEL_BY_PROVIDER, USER_ENV_FILE } from './jev.js';

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
  },
  allowPositionals: true,
});

if (positionals.length === 0) {
  console.error('usage: plainwright [--headless] [--timeout <ms>] <spec.yaml> [more.yaml ...] | mcp');
  process.exit(2);
}

const opts = { headed: !values.headless, timeout: Number(values.timeout) };

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

  for (const file of positionals) {
    try {
      const spec = loadSpec(file);
      const result = await runSpec(spec, opts);
      if (result.status !== 'pass') allPassed = false;
      console.log(`${icon(result.status)} ${spec.name}  (${result.jevCalls} Jev calls, ${result.totalTokens} tokens)`);
      for (const s of result.steps) {
        console.log(`  ${icon(s.status)} ${s.step}${s.detail ? ' ' + s.detail : ''}`);
      }
    } catch (err) {
      allPassed = false;
      console.log(`✘ ${file}`);
      console.log(`  error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  process.exit(allPassed ? 0 : 1);
}
