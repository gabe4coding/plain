import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from 'yaml';

export type Step =
  | { kind: 'goto'; url: string; optional?: boolean }
  | { kind: 'fill'; target: string; value: string; optional?: boolean }
  | { kind: 'click'; target: string; optional?: boolean }
  | { kind: 'hover'; target: string; optional?: boolean }
  | { kind: 'dblclick'; target: string; optional?: boolean }
  | { kind: 'rightclick'; target: string; optional?: boolean }
  | { kind: 'select'; target: string; value: string; optional?: boolean }
  | { kind: 'check'; target: string; optional?: boolean }
  | { kind: 'uncheck'; target: string; optional?: boolean }
  | { kind: 'upload'; target: string; files: string[]; optional?: boolean }
  | { kind: 'scroll'; target: string; optional?: boolean }
  | { kind: 'wait'; condition: string; optional?: boolean }
  | { kind: 'press'; key: string; optional?: boolean }
  | { kind: 'expect'; expectation: string; within?: string; optional?: boolean };

export interface Spec {
  name: string;
  url: string;
  dir: string; // directory the spec file lives in — `upload.files` paths resolve relative to this
  dialogs: 'accept' | 'dismiss';
  steps: Step[];
}

function fail(msg: string): never {
  throw new Error(`invalid spec: ${msg}`);
}

const STEP_KINDS =
  'goto, fill, click, hover, dblclick, rightclick, select, check, uncheck, upload, scroll, wait, press, expect';

export function loadSpec(path: string): Spec {
  const raw = parse(readFileSync(path, 'utf8'));
  if (raw === null || typeof raw !== 'object') fail(`${path}: top level must be a mapping`);
  if (typeof raw.name !== 'string' || !raw.name) fail(`${path}: missing "name"`);
  if (typeof raw.url !== 'string' || !raw.url) fail(`${path}: missing "url"`);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail(`${path}: "steps" must be a non-empty list`);
  const dialogs = raw.dialogs ?? 'accept';
  if (dialogs !== 'accept' && dialogs !== 'dismiss') fail(`${path}: "dialogs" must be "accept" or "dismiss"`);

  const steps: Step[] = raw.steps.map((s: unknown, i: number): Step => {
    if (s === null || typeof s !== 'object') fail(`${path}: step ${i} must be a mapping`);
    const obj = s as Record<string, unknown>;
    // ponytail: `optional` is a sibling flag, not a step kind — strip it before the
    // "exactly one key" check instead of teaching every case about a second key.
    const optional = obj.optional === true;
    const keys = Object.keys(obj).filter((k) => k !== 'optional');
    if (keys.length !== 1) fail(`${path}: step ${i} must have exactly one key (plus optional "optional"), got [${keys.join(', ')}]`);
    const [key] = keys;
    const val = obj[key];
    switch (key) {
      case 'goto':
        if (typeof val !== 'string' || !val) fail(`${path}: step ${i} "goto" must be a non-empty string`);
        return { kind: 'goto', url: val, optional };
      case 'fill': {
        if (val === null || typeof val !== 'object') fail(`${path}: step ${i} "fill" must be a mapping`);
        const f = val as Record<string, unknown>;
        if (typeof f.target !== 'string' || !f.target) fail(`${path}: step ${i} "fill.target" must be a non-empty string`);
        if (typeof f.value !== 'string') fail(`${path}: step ${i} "fill.value" must be a string`);
        return { kind: 'fill', target: f.target, value: f.value, optional };
      }
      case 'click':
        if (typeof val !== 'string' || !val) fail(`${path}: step ${i} "click" must be a non-empty string`);
        return { kind: 'click', target: val, optional };
      case 'hover':
        if (typeof val !== 'string' || !val) fail(`${path}: step ${i} "hover" must be a non-empty string`);
        return { kind: 'hover', target: val, optional };
      case 'dblclick':
        if (typeof val !== 'string' || !val) fail(`${path}: step ${i} "dblclick" must be a non-empty string`);
        return { kind: 'dblclick', target: val, optional };
      case 'rightclick':
        if (typeof val !== 'string' || !val) fail(`${path}: step ${i} "rightclick" must be a non-empty string`);
        return { kind: 'rightclick', target: val, optional };
      case 'select': {
        if (val === null || typeof val !== 'object') fail(`${path}: step ${i} "select" must be a mapping`);
        const s2 = val as Record<string, unknown>;
        if (typeof s2.target !== 'string' || !s2.target) fail(`${path}: step ${i} "select.target" must be a non-empty string`);
        if (typeof s2.value !== 'string' || !s2.value) fail(`${path}: step ${i} "select.value" must be a non-empty string`);
        return { kind: 'select', target: s2.target, value: s2.value, optional };
      }
      case 'check':
        if (typeof val !== 'string' || !val) fail(`${path}: step ${i} "check" must be a non-empty string`);
        return { kind: 'check', target: val, optional };
      case 'uncheck':
        if (typeof val !== 'string' || !val) fail(`${path}: step ${i} "uncheck" must be a non-empty string`);
        return { kind: 'uncheck', target: val, optional };
      case 'upload': {
        if (val === null || typeof val !== 'object') fail(`${path}: step ${i} "upload" must be a mapping`);
        const u = val as Record<string, unknown>;
        if (typeof u.target !== 'string' || !u.target) fail(`${path}: step ${i} "upload.target" must be a non-empty string`);
        if (!Array.isArray(u.files) || u.files.length === 0 || !u.files.every((f) => typeof f === 'string' && f))
          fail(`${path}: step ${i} "upload.files" must be a non-empty list of strings`);
        return { kind: 'upload', target: u.target, files: u.files as string[], optional };
      }
      case 'scroll':
        if (typeof val !== 'string' || !val) fail(`${path}: step ${i} "scroll" must be a non-empty string`);
        return { kind: 'scroll', target: val, optional };
      case 'wait':
        if (typeof val !== 'string' || !val) fail(`${path}: step ${i} "wait" must be a non-empty string`);
        return { kind: 'wait', condition: val, optional };
      case 'press':
        if (typeof val !== 'string' || !val) fail(`${path}: step ${i} "press" must be a non-empty string`);
        return { kind: 'press', key: val, optional };
      case 'expect': {
        if (typeof val === 'string' && val) return { kind: 'expect', expectation: val, optional };
        if (val !== null && typeof val === 'object') {
          const e = val as Record<string, unknown>;
          if (typeof e.that !== 'string' || !e.that) fail(`${path}: step ${i} "expect.that" must be a non-empty string`);
          if (typeof e.within !== 'string' || !e.within) fail(`${path}: step ${i} "expect.within" must be a non-empty string`);
          return { kind: 'expect', expectation: e.that, within: e.within, optional };
        }
        fail(`${path}: step ${i} "expect" must be a non-empty string or a { that, within } mapping`);
      }
      default:
        fail(`${path}: step ${i} has unknown key "${key}" (expected one of ${STEP_KINDS})`);
    }
  });

  return { name: raw.name, url: raw.url, dir: dirname(path), dialogs, steps };
}
