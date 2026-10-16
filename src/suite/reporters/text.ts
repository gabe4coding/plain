import { formatMs, isFailure, type Status, type StepResult } from '../../core/results.js';
import type { RunObserver, SpecReport } from '../types.js';

const ICONS = { pass: '✔', fail: '✘', inconclusive: '?', error: '✘', skipped: '»' } satisfies Record<Status, string>;
const icon = (status: Status): string => ICONS[status];
export const stepLine = (step: StepResult): string =>
  `  ${icon(step.status)} ${step.step}${step.detail ? ' ' + step.detail : ''}`;
/** A stored error is `${error}` (the native CLIs reprint it); the text reporter shows only its message. */
function shownError(stored?: string): string {
  if (stored === undefined) return 'no result';
  const match = /^([A-Za-z_][\w$]*): ([\s\S]*)$/.exec(stored);
  return match && match[1].endsWith('Error') ? match[2] : stored;
}
const addMs = (target: Record<string, number>, source: Record<string, number>): void => {
  for (const [phase, ms] of Object.entries(source)) target[phase] = (target[phase] ?? 0) + ms;
};

export function textReporter(timing: boolean): RunObserver {
  const runMs: Record<string, number> = {};
  return {
    async specEnd({ report }: { report: SpecReport }) {
      if (report.status === 'skipped' && !report.attempts.length) {
        console.log(`» ${report.file}  (skipped${report.skipReason ? `: ${report.skipReason}` : ''})`);
        return;
      }
      const final = report.attempts.at(-1);
      // A spec that failed to load or threw before its first step: the file and the error.
      if (!final || final.error !== undefined) {
        console.log(`✘ ${report.file}`);
        console.log(`  error: ${shownError(final ? final.error : report.loadError)}`);
        return;
      }
      const flaky = report.flaky ? `flaky, passed on attempt ${final.attempt + 1}; ` : '';
      console.log(`${icon(final.status)} ${report.name}  (${flaky}${final.jevCalls} Jev calls, ${final.totalTokens} tokens)`);
      if (report.flaky) {
        for (const attempt of report.attempts.slice(0, -1)) {
          if (attempt.error !== undefined) console.log(`  attempt ${attempt.attempt + 1}: error: ${shownError(attempt.error)}`);
          for (const step of attempt.steps) {
            if (isFailure(step.status)) {
              console.log(`  attempt ${attempt.attempt + 1}: ${stepLine(step).trimStart()}`);
            }
          }
        }
      }
      const specMs: Record<string, number> = {};
      for (const step of final.steps) {
        console.log(stepLine(step));
        if (timing && step.ms) {
          console.log(`    ms ${formatMs(step.ms)}`);
          addMs(specMs, step.ms);
        }
      }
      if (timing && Object.keys(specMs).length) {
        console.log(`  ms spec ${formatMs(specMs)}`);
        addMs(runMs, specMs);
      }
    },
    async runEnd({ report }) {
      if (timing && Object.keys(runMs).length) console.log(`ms run ${formatMs(runMs)}`);
      // A summary line only for runs with retries or a stop. Every spec counts, skipped ones and load errors too.
      const needsSummary = report.specs.some((spec) => spec.flaky || spec.attempts.length > 1 || spec.skipReason);
      if (needsSummary && report.specs.length > 1) {
        const { passed, failed, flaky, skipped, jevCalls, tokens, replayed, healed } = report.totals;
        const locked = (replayed ? `, ${replayed} replayed` : '') + (healed ? `, ${healed} healed` : '');
        const seconds = (report.durationMs / 1000).toFixed(2);
        console.log(`${passed} passed, ${failed} failed, ${flaky} flaky, ${skipped} skipped  (${jevCalls} Jev calls, ${tokens} tokens${locked}, ${seconds}s)`);
      }
    },
  };
}
