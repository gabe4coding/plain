// Shared test fixtures; the .test name keeps them out of the plugin runtime (build-plugins skips *.test.js).
import { isFailure } from '../../core/results.js';
import type { Attempt, RunReport, SpecReport, SuiteOptions } from '../types.js';

export const options: SuiteOptions = { files: ['case.yaml'], workers: 1, retries: 0, bail: 0, lastFailed: false,
  tags: [], list: false, reporters: [{ name: 'text' }], timing: false };

export function attempt(status: Attempt['status'], overrides: Partial<Attempt> = {}): Attempt {
  return { name: 'Checkout', status, steps: [{ step: 'expect "Order complete"', status, detail: 'page detail' }],
    jevCalls: 2, totalTokens: 30, attempt: 0, durationMs: 1250, artifacts: [], ...overrides };
}

export function spec(status: SpecReport['status'], overrides: Partial<SpecReport> = {}): SpecReport {
  return { file: 'tests/checkout.yaml', name: 'Checkout', tags: ['smoke'], status, flaky: false,
    attempts: [attempt(status)], ...overrides };
}

/** Fixed values make reporter tests independent of clocks, models, browsers, and the scheduler. */
export function run(specs: SpecReport[] = [spec('pass')]): RunReport {
  return { engine: 'browser', provider: 'typesafe', model: 'jev-test', startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 5250, specs, status: specs.every((spec) => spec.status === 'pass') ? 'pass' : 'fail',
    totals: {
      jevCalls: specs.flatMap((spec) => spec.attempts).reduce((sum, attempt) => sum + attempt.jevCalls, 0),
      tokens: specs.flatMap((spec) => spec.attempts).reduce((sum, attempt) => sum + attempt.totalTokens, 0),
      passed: specs.filter((spec) => spec.status === 'pass').length,
      failed: specs.filter((spec) => isFailure(spec.status)).length,
      flaky: specs.filter((spec) => spec.flaky).length,
      skipped: specs.filter((spec) => spec.status === 'skipped').length, replayed: 0, healed: 0,
    } };
}

export async function capture(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [], previous = console.log;
  console.log = (...values) => { lines.push(values.join(' ')); };
  try { await fn(); } finally { console.log = previous; }
  return lines;
}
