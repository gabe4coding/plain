#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadSpec } from './spec.js';
import { runSpec } from './runner.js';
import { provider, MODEL_BY_PROVIDER } from './jev.js';

// ponytail: cwd .env only; pass --env-file for another path
try {
  process.loadEnvFile();
} catch {
  /* no .env — fine */
}

try {
  const p = provider();
  console.error(`jev-e2e: Jev via ${p} (${MODEL_BY_PROVIDER[p]})`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

const { values, positionals } = parseArgs({
  options: {
    headless: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '15000' },
  },
  allowPositionals: true,
});

if (positionals.length === 0) {
  console.error('usage: jev-e2e [--headless] [--timeout <ms>] <spec.yaml> [more.yaml ...]');
  process.exit(2);
}

const opts = { headed: !values.headless, timeout: Number(values.timeout) };

function icon(status: string): string {
  if (status === 'pass') return '✔';
  if (status === 'inconclusive') return '?';
  if (status === 'skipped') return '»'; // ponytail: optional step that didn't land, run continued
  return '✘'; // fail or error
}

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
