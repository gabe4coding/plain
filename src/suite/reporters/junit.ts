import path from 'node:path';
import type { Attempt, RunObserver, RunReport, SpecReport } from '../types.js';
import { writeReport } from './file.js';
import { stepLine } from './text.js';
import { isFailure, type Status } from '../../core/results.js';

/** XML 1.0 allows tabs/newlines, printable BMP characters, and valid supplementary code points. */
export function escapeXml(value: string): string {
  return value.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}
const attr = (value: string | number): string => escapeXml(String(value))
  .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
const seconds = (ms: number): string => String(ms / 1000);

function properties(values: Record<string, string | number>): string {
  return '    <properties>\n' + Object.entries(values)
    .map(([name, value]) => `      <property name="${attr(name)}" value="${attr(value)}"/>`).join('\n')
    + '\n    </properties>';
}

function failureOf(attempt: Attempt | undefined, spec: SpecReport): { message: string; type: string; detail: string } {
  if (spec.loadError !== undefined) return { message: spec.name, type: 'error', detail: spec.loadError };
  if (attempt?.error !== undefined) return { message: spec.name, type: 'error', detail: attempt.error };
  const status = attempt?.status ?? spec.status;
  const step = attempt?.steps.find((step) => step.status === status)
    ?? attempt?.steps.find((step) => isFailure(step.status));
  return { message: step?.step ?? spec.name, type: status, detail: step?.detail ?? '' };
}

function testCase(spec: SpecReport, report: RunReport): string {
  const final = spec.attempts.at(-1);
  const duration = spec.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0);
  const classname = path.relative(process.cwd(), path.resolve(spec.file));
  const lines = [`    <testcase classname="${attr(classname)}" name="${attr(spec.name)}" time="${seconds(duration)}">`];
  lines.push(properties({
    jevCalls: spec.attempts.reduce((sum, attempt) => sum + attempt.jevCalls, 0),
    tokens: spec.attempts.reduce((sum, attempt) => sum + attempt.totalTokens, 0),
    provider: report.provider, model: report.model, attempts: spec.attempts.length,
  }));
  const crashed = spec.loadError !== undefined || final?.error !== undefined;
  if (spec.status === 'skipped') {
    lines.push(`      <skipped message="${attr(spec.skipReason ?? 'skipped')}"/>`);
  } else if (spec.status !== 'pass' || crashed) {
    const { message, type, detail } = failureOf(final, spec);
    const tag = spec.status === 'error' || crashed ? 'error' : 'failure';
    lines.push(`      <${tag} message="${attr(message)}" type="${attr(type)}">${escapeXml(detail)}</${tag}>`);
  }
  for (const attempt of spec.attempts.slice(0, -1)) {
    if (!isFailure(attempt.status)) continue;
    const { message, type, detail } = failureOf(attempt, spec);
    // Surefire: flakyError/flakyFailure before a pass, rerunError/rerunFailure otherwise, the body in stackTrace.
    const kind = attempt.status === 'error' ? 'Error' : 'Failure';
    const tag = (spec.status === 'pass' ? 'flaky' : 'rerun') + kind;
    lines.push(`      <${tag} message="${attr(message)}" type="${attr(type)}"><stackTrace>${escapeXml(detail)}</stackTrace></${tag}>`);
  }
  const output: string[] = [];
  for (const attempt of spec.attempts) {
    if (spec.attempts.length > 1) output.push(`attempt ${attempt.attempt + 1}:`);
    if (attempt.error !== undefined) output.push(`  error: ${attempt.error}`);
    output.push(...attempt.steps.map(stepLine));
  }
  for (const attempt of spec.attempts) {
    for (const artifact of attempt.artifacts) output.push(`[[ATTACHMENT|${path.resolve(artifact.path)}]]`);
  }
  lines.push(`      <system-out>${escapeXml(output.join('\n'))}</system-out>`, '    </testcase>');
  return lines.join('\n');
}

export function junitXml(report: RunReport): string {
  const countOf = (...statuses: Status[]) => report.specs.filter((spec) => statuses.includes(spec.status)).length;
  const counts = `tests="${report.specs.length}" failures="${countOf('fail', 'inconclusive')}" errors="${countOf('error')}" ` +
    `skipped="${countOf('skipped')}" time="${seconds(report.durationMs)}"`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="plain ${attr(report.engine)}" ${counts}>`,
    `  <testsuite name="plain" timestamp="${attr(report.startedAt)}" ${counts}>`,
    properties({ jevCalls: report.totals.jevCalls, tokens: report.totals.tokens, replayed: report.totals.replayed, healed: report.totals.healed,
      provider: report.provider, model: report.model, attempts: report.specs.reduce((sum, spec) => sum + spec.attempts.length, 0) }),
    ...report.specs.map((spec) => testCase(spec, report)),
    '  </testsuite>', '</testsuites>', '',
  ].join('\n');
}

export function junitReporter(file: string): RunObserver {
  return {
    async runEnd({ report }) {
      await writeReport(file, junitXml(report));
    },
  };
}
