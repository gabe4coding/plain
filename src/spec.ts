import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
  | { kind: 'drag'; source: string; target: string; optional?: boolean }
  | { kind: 'mouse'; x: number; y: number; optional?: boolean }
  | { kind: 'expect'; expectations: string[]; within?: string; optional?: boolean };

export interface Spec {
  name: string;
  url: string;
  dir: string; // directory the spec file lives in — `upload.files` paths resolve relative to this
  dialogs: 'accept' | 'dismiss';
  auth?: { user: string; pass: string };
  geolocation?: { lat: number; lon: number };
  // Optional so an MCP-built Spec (which has no env block) still satisfies this type; loadSpec
  // always fills it in (default `{}`) for a spec loaded from a file.
  env?: Record<string, unknown>;
  hooks?: string; // absolute path to the hooks module, resolved relative to the spec file
  steps: Step[];
}

function fail(msg: string): never {
  throw new Error(`invalid spec: ${msg}`);
}

// `$VAR` in an auth value means "read process.env.VAR" so a credential never sits in the spec file
// itself. A plain string (e.g. the-internet's public demo creds) passes through unchanged.
function resolveEnvRef(path: string, field: string, value: string): string {
  if (!value.startsWith('$')) return value;
  const name = value.slice(1);
  const resolved = process.env[name];
  if (!resolved) fail(`${path}: "${field}" references $${name} but that env var is not set`);
  return resolved;
}

// `env` mirrors auth/geolocation's `$VAR` convention but at arbitrary depth, since setup data
// (dataset lookups, feature flags, ...) is naturally nested (`env.user.name`, not `env["user.name"]`).
function resolveEnvBlock(path: string, field: string, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const childField = `${field}.${key}`;
    if (typeof value === 'string') out[key] = resolveEnvRef(path, childField, value);
    else if (value !== null && typeof value === 'object' && !Array.isArray(value))
      out[key] = resolveEnvBlock(path, childField, value as Record<string, unknown>);
    else out[key] = value;
  }
  return out;
}

// `expect`/`expect.that` takes one claim (a string) or several (a list) — always normalized to a
// non-empty string array so steps.ts judges every claim in one Jev request.
function parseExpectations(path: string, i: number, val: unknown, field: string): string[] {
  if (typeof val === 'string') {
    if (!val) fail(`${path}: step ${i} "${field}" must be a non-empty string`);
    return [val];
  }
  if (Array.isArray(val)) {
    if (val.length === 0 || !val.every((v) => typeof v === 'string' && v))
      fail(`${path}: step ${i} "${field}" must be a non-empty list of non-empty strings`);
    return val as string[];
  }
  fail(`${path}: step ${i} "${field}" must be a non-empty string or a non-empty list of strings`);
}

const STEP_KINDS =
  'goto, fill, click, hover, dblclick, rightclick, select, check, uncheck, upload, scroll, wait, press, drag, mouse, expect';

// `path` is only used for error messages — it lets a step from any source (a spec file, or a raw
// object handed in over MCP) report the same "invalid spec" errors loadSpec always has.
export function parseStep(path: string, i: number, raw: unknown): Step {
  if (raw === null || typeof raw !== 'object') fail(`${path}: step ${i} must be a mapping`);
  const obj = raw as Record<string, unknown>;
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
    case 'drag': {
      if (val === null || typeof val !== 'object') fail(`${path}: step ${i} "drag" must be a mapping`);
      const d = val as Record<string, unknown>;
      if (typeof d.source !== 'string' || !d.source) fail(`${path}: step ${i} "drag.source" must be a non-empty string`);
      if (typeof d.target !== 'string' || !d.target) fail(`${path}: step ${i} "drag.target" must be a non-empty string`);
      return { kind: 'drag', source: d.source, target: d.target, optional };
    }
    case 'mouse': {
      if (val === null || typeof val !== 'object') fail(`${path}: step ${i} "mouse" must be a mapping`);
      const m = val as Record<string, unknown>;
      // y may be negative — that's the escape hatch for exit-intent triggers past the viewport's top edge.
      if (typeof m.x !== 'number') fail(`${path}: step ${i} "mouse.x" must be a number`);
      if (typeof m.y !== 'number') fail(`${path}: step ${i} "mouse.y" must be a number`);
      return { kind: 'mouse', x: m.x, y: m.y, optional };
    }
    case 'expect': {
      if (typeof val === 'string' || Array.isArray(val)) {
        return { kind: 'expect', expectations: parseExpectations(path, i, val, 'expect'), optional };
      }
      if (val !== null && typeof val === 'object') {
        const e = val as Record<string, unknown>;
        const expectations = parseExpectations(path, i, e.that, 'expect.that');
        if (e.within === undefined) return { kind: 'expect', expectations, optional };
        if (typeof e.within !== 'string' || !e.within) fail(`${path}: step ${i} "expect.within" must be a non-empty string`);
        return { kind: 'expect', expectations, within: e.within, optional };
      }
      fail(`${path}: step ${i} "expect" must be a non-empty string, a list of strings, or a { that, within } mapping`);
    }
    default:
      fail(`${path}: step ${i} has unknown key "${key}" (expected one of ${STEP_KINDS})`);
  }
}

export function loadSpec(path: string): Spec {
  const raw = parse(readFileSync(path, 'utf8'));
  if (raw === null || typeof raw !== 'object') fail(`${path}: top level must be a mapping`);
  if (typeof raw.name !== 'string' || !raw.name) fail(`${path}: missing "name"`);
  if (typeof raw.url !== 'string' || !raw.url) fail(`${path}: missing "url"`);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) fail(`${path}: "steps" must be a non-empty list`);
  const dialogs = raw.dialogs ?? 'accept';
  if (dialogs !== 'accept' && dialogs !== 'dismiss') fail(`${path}: "dialogs" must be "accept" or "dismiss"`);

  let auth: Spec['auth'];
  if (raw.auth !== undefined) {
    if (raw.auth === null || typeof raw.auth !== 'object') fail(`${path}: "auth" must be a mapping`);
    const a = raw.auth as Record<string, unknown>;
    if (typeof a.user !== 'string' || !a.user) fail(`${path}: "auth.user" must be a non-empty string`);
    if (typeof a.pass !== 'string' || !a.pass) fail(`${path}: "auth.pass" must be a non-empty string`);
    auth = { user: resolveEnvRef(path, 'auth.user', a.user), pass: resolveEnvRef(path, 'auth.pass', a.pass) };
  }

  let geolocation: Spec['geolocation'];
  if (raw.geolocation !== undefined) {
    if (raw.geolocation === null || typeof raw.geolocation !== 'object') fail(`${path}: "geolocation" must be a mapping`);
    const g = raw.geolocation as Record<string, unknown>;
    if (typeof g.lat !== 'number') fail(`${path}: "geolocation.lat" must be a number`);
    if (typeof g.lon !== 'number') fail(`${path}: "geolocation.lon" must be a number`);
    geolocation = { lat: g.lat, lon: g.lon };
  }

  let env: Record<string, unknown> = {};
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== 'object') fail(`${path}: "env" must be a mapping`);
    env = resolveEnvBlock(path, 'env', raw.env as Record<string, unknown>);
  }

  let hooks: Spec['hooks'];
  if (raw.hooks !== undefined) {
    if (typeof raw.hooks !== 'string' || !raw.hooks) fail(`${path}: "hooks" must be a non-empty string`);
    hooks = resolve(dirname(path), raw.hooks);
  }

  const steps: Step[] = raw.steps.map((s: unknown, i: number): Step => parseStep(path, i, s));

  return { name: raw.name, url: raw.url, dir: dirname(path), dialogs, auth, geolocation, env, hooks, steps };
}

// Deep-walks `value`, replacing every `${a.b.c}` in any string with the leaf it names under
// `vars.env`/`vars.hooks` (the spec's env block, and whatever the hooks module's setup returned).
// Pure and side-effect-free: returns a new value, never mutates `value`.
export function interpolate<T>(value: T, vars: { env: Record<string, unknown>; hooks: Record<string, unknown> }, where: string): T {
  if (typeof value === 'string') {
    if (!value.includes('${')) return value;
    return value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
      const [namespace, ...rest] = expr.split('.');
      let leaf: unknown = namespace === 'env' || namespace === 'hooks' ? vars[namespace] : undefined;
      for (const key of rest) {
        if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf)) { leaf = undefined; break; }
        leaf = (leaf as Record<string, unknown>)[key];
      }
      if (leaf === undefined || leaf === null || typeof leaf === 'object')
        fail(
          `${where}: \${${expr}} is not defined (use \${env.*} from the spec's env block or \${hooks.*} from what setup returned)`
        );
      return String(leaf);
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars, where)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolate(v, vars, where);
    return out as unknown as T;
  }
  return value;
}
