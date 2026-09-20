import { StepKind } from './step-kind.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const nonEmptyString = z.string().min(1);
const optional = z.boolean().optional();
const target = nonEmptyString;

// Schemas are the source of truth for normalized data and its TypeScript types.
export const StepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(StepKind.goto), url: nonEmptyString, optional }),
  z.object({ kind: z.literal(StepKind.fill), target, value: z.string(), optional }),
  z.object({ kind: z.literal(StepKind.click), target, optional }),
  z.object({ kind: z.literal(StepKind.hover), target, optional }),
  z.object({ kind: z.literal(StepKind.dblclick), target, optional }),
  z.object({ kind: z.literal(StepKind.rightclick), target, optional }),
  z.object({ kind: z.literal(StepKind.select), target, value: nonEmptyString, optional }),
  z.object({ kind: z.literal(StepKind.check), target, optional }),
  z.object({ kind: z.literal(StepKind.uncheck), target, optional }),
  z.object({ kind: z.literal(StepKind.upload), target, files: z.array(nonEmptyString).min(1), optional }),
  z.object({ kind: z.literal(StepKind.scroll), target, optional }),
  z.object({ kind: z.literal(StepKind.wait), condition: nonEmptyString, optional }),
  z.object({ kind: z.literal(StepKind.press), key: nonEmptyString, optional }),
  z.object({ kind: z.literal(StepKind.drag), source: nonEmptyString, target, optional }),
  // Negative y is the escape hatch for exit-intent triggers above the viewport.
  z.object({ kind: z.literal(StepKind.mouse), x: z.number(), y: z.number(), optional }),
  z.object({ kind: z.literal(StepKind.expect), expectations: z.array(nonEmptyString).min(1), within: nonEmptyString.optional(), optional }),
]);
export type Step = z.infer<typeof StepSchema>;

export const SpecSchema = z.object({
  name: nonEmptyString,
  url: nonEmptyString,
  dir: z.string(), // directory used to resolve upload paths
  dialogs: z.enum(['accept', 'dismiss']),
  auth: z.object({ user: nonEmptyString, pass: nonEmptyString }).optional(),
  geolocation: z.object({ lat: z.number(), lon: z.number() }).optional(),
  // MCP-built specs have no env block; loadSpec supplies {} for file-based specs.
  env: z.record(z.string(), z.unknown()).optional(),
  hooks: nonEmptyString.optional(), // absolute path after loading
  steps: z.array(StepSchema), // an MCP session starts with no steps
});
export type Spec = z.infer<typeof SpecSchema>;

const FileSpecSchema = SpecSchema.omit({ dir: true, steps: true }).extend({
  dialogs: SpecSchema.shape.dialogs.nullish().transform((value) => value ?? 'accept'),
  steps: z.array(z.unknown()).min(1),
});

function parseData<T extends z.ZodType>(schema: T, raw: unknown, where: string): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.length ? ` "${issue.path.join('.')}"` : '';
    fail(`${where}:${field} ${issue.message}`);
  }
  return result.data;
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

const MappingSchema = z.record(z.string(), z.unknown());
const STEP_KINDS = StepSchema.options.map((schema) => schema.shape.kind.value);

// YAML/MCP use one action key; normalize that syntax before schema validation.
export function parseStep(path: string, i: number, raw: unknown): Step {
  const where = `${path}: step ${i}`;
  const obj = parseData(MappingSchema, raw, where);
  const keys = Object.keys(obj).filter((key) => key !== 'optional');
  if (keys.length !== 1) fail(`${where} must have exactly one key (plus optional "optional"), got [${keys.join(', ')}]`);
  const [kind] = keys;
  if (!STEP_KINDS.some((key) => key === kind))
    fail(`${where} has unknown key "${kind}" (expected one of ${STEP_KINDS.join(', ')})`);

  const val = obj[kind];
  let fields: Record<string, unknown>;
  switch (kind) {
    case StepKind.goto: fields = { url: val }; break;
    case StepKind.click: case StepKind.hover: case StepKind.dblclick: case StepKind.rightclick:
    case StepKind.check: case StepKind.uncheck: case StepKind.scroll:
      fields = { target: val }; break;
    case StepKind.wait: fields = { condition: val }; break;
    case StepKind.press: fields = { key: val }; break;
    case StepKind.expect: {
      const scoped = typeof val !== 'string' && !Array.isArray(val);
      const expectation = scoped ? parseData(MappingSchema, val, `${where} "expect"`) : { that: val };
      fields = {
        expectations: typeof expectation.that === 'string' ? [expectation.that] : expectation.that,
        ...(expectation.within === undefined ? {} : { within: expectation.within }),
      };
      break;
    }
    default: fields = parseData(MappingSchema, val, `${where} "${kind}"`);
  }
  // Preserve the existing flag convention: only literal true enables optional execution.
  return parseData(StepSchema, { ...fields, kind, optional: obj.optional === true }, where);
}

export function loadSpec(path: string): Spec {
  const raw = parseData(FileSpecSchema, parse(readFileSync(path, 'utf8')), path);
  const auth = raw.auth && {
    user: resolveEnvRef(path, 'auth.user', raw.auth.user),
    pass: resolveEnvRef(path, 'auth.pass', raw.auth.pass),
  };
  return {
    ...raw,
    dir: dirname(path),
    auth,
    env: resolveEnvBlock(path, 'env', raw.env ?? {}),
    hooks: raw.hooks === undefined ? undefined : resolve(dirname(path), raw.hooks),
    steps: raw.steps.map((step, i) => parseStep(path, i, step)),
  };
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
