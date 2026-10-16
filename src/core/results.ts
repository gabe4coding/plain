import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StepKind } from './step-kind.js';
import type { Step } from './spec.js';
import type { Candidate } from './candidate.js';

export const StatusSchema = z.enum(['pass', 'fail', 'inconclusive', 'error', 'skipped']);
export type Status = z.infer<typeof StatusSchema>;

/** Every status but pass and skipped: it stops a run and fails the spec. */
export const isFailure = (status: Status): boolean => status !== 'pass' && status !== 'skipped';

/**
 * The status hooks teardown gets, from the step results so far: the first failure, as a spec run stops there;
 * `pass` when no step failed, also when no step ran. In agent mode steps go on after a failure, and a later pass
 * must not hide it.
 */
export const overallStatus = (results: readonly { status: Status }[]): Status =>
  results.find((result) => isFailure(result.status))?.status ?? 'pass';

/** Where rejected picks and failed claims are dumped; the artifacts observer copies from here. */
export const DUMP_DIR = path.join(os.tmpdir(), 'plain');

export const StepResultSchema = z.object({
  step: z.string(),
  status: StatusSchema,
  detail: z.string().optional(),
  ms: z.record(z.string(), z.number()).optional(),
  /** A target acted on its recorded locator (src/core/lock.ts): no Jev pick for it. */
  replayed: z.boolean().optional(),
  /** A recorded locator missed or failed, and Jev picked the element again (auto-healing). */
  healed: z.boolean().optional(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

/** One run of one spec, by any engine. */
export interface TestResult { name: string; status: Status; steps: StepResult[]; jevCalls: number; totalTokens: number }

export { errorMessage } from './error-message.js';

/** A step detail with a note in parentheses at its end: "→ button "Go" (healed; …)". */
export const noted = (detail: string | undefined, note: string): string => `${detail ? `${detail} ` : ''}(${note})`;

/** Adds the time `fn` takes to ms[phase]; a phase adds up over the calls of one step. */
export async function timedInto<T>(ms: Record<string, number>, phase: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    ms[phase] = (ms[phase] ?? 0) + (Date.now() - start);
  }
}

/** Phase timings for --timing, `total` first: "total=3985 settle=512 jev=1830". */
export function formatMs(ms: Record<string, number>): string {
  const keys = Object.keys(ms);
  const ordered = keys.includes('total') ? ['total', ...keys.filter((key) => key !== 'total')] : keys;
  return ordered.map((key) => `${key}=${ms[key]}`).join(' ');
}

export function label(step: Step): string {
  const base = baseLabel(step);
  return step.origin ? `${step.origin} › ${base}` : base;
}

function baseLabel(step: Step): string {
  switch (step.kind) {
    case StepKind.goto: return `goto ${step.url}`;
    case StepKind.select: return `select "${step.value}" in "${step.target}"`;
    case StepKind.upload: return `upload ${step.files.length} file(s) to "${step.target}"`;
    case StepKind.wait: return `wait "${step.condition}"${step.within ? ` within "${step.within}"` : ''}`;
    case StepKind.press: return `press ${step.key}`;
    case StepKind.drag: return `drag "${step.source}" to "${step.target}"`;
    case StepKind.mouse: return `mouse to (${step.x}, ${step.y})`;
    case StepKind.expect: {
      const claim = step.expectations.length > 1 ? step.expectations.join(' | ') : step.expectations[0];
      return step.within ? `expect "${claim}" within "${step.within}"` : `expect "${claim}"`;
    }
    default: return `${step.kind} "${step.target}"`;
  }
}

let dumpCount = 0;

/** Writes what Jev saw to a temp file, for the detail line of a rejected pick or a failed claim. Returns its path. */
export function dumpDebug(kind: string, data: unknown): string {
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  // The pid and a counter keep concurrent specs from overwriting each other's dumps.
  const file = path.join(DUMP_DIR, `${Date.now()}-${process.pid}-${++dumpCount}-${kind}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** The three most likely candidates, for the detail line of a rejected pick. */
export function topGuesses(probabilities: Record<string, number>, candidates: Candidate[]): string {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, p]) => `${key === 'none' ? 'none' : candidates.find((c) => String(c.id) === key)?.desc} (p=${p.toFixed(2)})`)
    .join(' | ');
}
