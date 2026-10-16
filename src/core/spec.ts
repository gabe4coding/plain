import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { StepKind } from './step-kind.js';
import { expandIncludes, splitSource } from './include.js';
import { unknownKey } from './unknown-key.js';

const nonEmptyString = z.string().min(1);
const optional = z.boolean().optional();
const origin = z.string().optional();
/** Where a step was written (absolute file, index in it): the lock key. Set by the loaders, never by YAML. */
const StepSourceSchema = z.object({ file: z.string(), index: z.number().int() });
export type StepSource = z.infer<typeof StepSourceSchema>;
const at = StepSourceSchema.optional();
const target = nonEmptyString;

/** `tags: smoke` or `tags: [smoke, checkout]`; always a list after loading. */
export const TagsSchema = z.union([nonEmptyString.transform((tag) => [tag]), z.array(nonEmptyString)]).optional();

export const StepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(StepKind.goto), url: nonEmptyString, optional, origin, at }),
  z.object({ kind: z.literal(StepKind.fill), target, value: z.string(), optional, origin, at }),
  z.object({ kind: z.literal(StepKind.click), target, optional, origin, at }),
  z.object({ kind: z.literal(StepKind.hover), target, optional, origin, at }),
  z.object({ kind: z.literal(StepKind.dblclick), target, optional, origin, at }),
  z.object({ kind: z.literal(StepKind.rightclick), target, optional, origin, at }),
  z.object({ kind: z.literal(StepKind.select), target, value: nonEmptyString, optional, origin, at }),
  z.object({ kind: z.literal(StepKind.check), target, optional, origin, at }),
  z.object({ kind: z.literal(StepKind.uncheck), target, optional, origin, at }),
  z.object({ kind: z.literal(StepKind.upload), target, files: z.array(nonEmptyString).min(1), optional, origin, at }),
  z.object({ kind: z.literal(StepKind.scroll), target, optional, origin, at }),
  z.object({ kind: z.literal(StepKind.wait), condition: nonEmptyString, within: nonEmptyString.optional(), optional, origin, at }),
  z.object({ kind: z.literal(StepKind.press), key: nonEmptyString, optional, origin, at }),
  z.object({ kind: z.literal(StepKind.drag), source: nonEmptyString, target, optional, origin, at }),
  // A negative y reaches above the viewport, for exit-intent triggers.
  z.object({ kind: z.literal(StepKind.mouse), x: z.number(), y: z.number(), optional, origin, at }),
  z.object({
    kind: z.literal(StepKind.expect), expectations: z.array(nonEmptyString).min(1), within: nonEmptyString.optional(),
    optional, origin, at,
  }),
]);
export type Step = z.infer<typeof StepSchema>;

export const SpecSchema = z.object({
  name: nonEmptyString,
  url: nonEmptyString,
  /** Upload paths resolve against it. */
  dir: z.string(),
  dialogs: z.enum(['accept', 'dismiss']),
  /** What the whole flow is for: picks see it, claims never do. */
  goal: nonEmptyString.optional(),
  auth: z.object({ user: nonEmptyString, pass: nonEmptyString }).strict().optional(),
  geolocation: z.object({ lat: z.number(), lon: z.number() }).strict().optional(),
  tags: TagsSchema,
  timeout: z.number().int().positive().optional(),
  browser: z.object({
    viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
    device: nonEmptyString.optional(),
    locale: nonEmptyString.optional(),
    timezone: nonEmptyString.optional(),
    colorScheme: z.enum(['light', 'dark']).optional(),
    storageState: nonEmptyString.optional(),
    saveState: nonEmptyString.optional(),
  }).strict().optional(),
  /** Absent in an MCP session; `{}` for a spec file without one. */
  env: z.record(z.string(), z.unknown()).optional(),
  /** An absolute path after loading. */
  hooks: nonEmptyString.optional(),
  steps: z.array(StepSchema),
});
export type Spec = z.infer<typeof SpecSchema>;

const FileSpecSchema = SpecSchema.omit({ dir: true, steps: true }).extend({
  dialogs: SpecSchema.shape.dialogs.nullish().transform((value) => value ?? 'accept'),
  steps: z.array(z.unknown()).min(1),
}).strict();

export interface LoadOptions {
  onMissingEnv?: (message: string) => void;
  /** A credential written in the spec file: a `fill` of a secret target, or a secret `auth`/`env` key, with a literal value. */
  onLiteralSecret?: (message: string) => void;
}

const SECRET_WORD = /passw(or)?d|passphrase|passcode|secret|token|api.?key|credential/i;
/** `pin` as a word or a name part (`PIN`, `user_pin`, `pinCode`, `userPin`), never inside a word (`spinner`, `opinion`). */
const PIN = /(?:^|[^A-Za-z])[Pp][Ii][Nn](?![a-z])|[a-z]Pin(?![a-z])/;
/** A fill target that names a credential. */
const isSecretTarget = (text: string) => SECRET_WORD.test(text) || PIN.test(text);
/** An `auth`/`env` key that names a credential: also `pass`, `db_pass`, `userPass`. */
const isSecretKey = (key: string) => isSecretTarget(key) || /pass$/i.test(key);

/**
 * Loads a browser spec file. Every schema is strict: an unknown key (top level, `auth`, `geolocation`, `browser`,
 * a step or its mapping) is an error naming the closest known key. `env` takes any keys.
 */
export function loadSpec(path: string, opts?: LoadOptions): Spec {
  const raw = parseData(FileSpecSchema, parse(readFileSync(path, 'utf8')), path);
  const spec: Spec = {
    ...raw,
    dir: dirname(path),
    auth: raw.auth && (resolveEnvBlock(path, 'auth', raw.auth, opts) as typeof raw.auth),
    env: resolveEnvBlock(path, 'env', raw.env ?? {}, opts),
    hooks: raw.hooks === undefined ? undefined : resolve(dirname(path), raw.hooks),
    steps: loadSteps(raw.steps, path, (step, file, index) => parseStep(file, index, step), opts),
  };
  checkSpecTimeout(spec, path);
  return spec;
}

/** Loads a desktop or mobile spec file: hooks resolved next to it, `$VAR` env leaves resolved, steps parsed. */
export function loadNativeSpec<R extends { hooks?: string; env: Record<string, unknown>; steps: unknown[] }, S extends { kind: string }>(file: string,
  schema: z.ZodType<R>, parseOne: (raw: unknown, where: string, index: number) => S, opts?: LoadOptions) {
  const raw = parseData(schema, parse(readFileSync(file, 'utf8')), file);
  const dir = dirname(resolve(file));
  const env = resolveEnvBlock(file, 'env', raw.env, opts);
  checkSpecTimeout(raw as { timeout?: number }, file);
  return {
    ...raw,
    dir,
    hooks: raw.hooks ? resolve(dir, raw.hooks) : undefined,
    env,
    steps: loadSteps(raw.steps, file, parseOne, opts),
  };
}

/** Expands includes and parses each step. Errors name the file and index where the step was written. */
function loadSteps<S extends { kind: string }>(rawSteps: unknown[], file: string,
  parseOne: (raw: unknown, where: string, index: number) => S, opts?: LoadOptions): S[] {
  return expandIncludes(rawSteps, file).map((expanded, i) => {
    const { step, source } = splitSource(expanded);
    const where = source?.file ?? file;
    const index = source?.index ?? i;
    const parsed = withOrigin(step, (raw) => parseOne(raw, where, index));
    checkFillSecret(parsed, `${where}: step ${index}`, opts);
    return withSource(parsed, file, source, i);
  });
}

/** A `${...}` part comes from the env block or a hook. Any text around it is typed as written in the spec. */
function checkFillSecret(step: { kind: string }, where: string, opts?: LoadOptions): void {
  if (step.kind !== StepKind.fill || !('target' in step && 'value' in step)) return;
  const { target, value } = step;
  if (typeof target !== 'string' || typeof value !== 'string' || !value.replace(/\$\{[^}]*\}/g, '').trim()) return;
  if (isSecretTarget(target)) {
    opts?.onLiteralSecret?.(`${where} fills "${target}" with a literal secret (use \${env.*} and a $VAR in the env block)`);
  }
}

const MappingSchema = z.record(z.string(), z.unknown());
export const STEP_KINDS = StepSchema.options.map((schema) => schema.shape.kind.value);
/** Step kinds written as `kind: <value>`, and the field the value fills. */
const SINGLE_VALUE_FIELD: Record<string, string> = {
  goto: 'url', press: 'key', click: 'target', hover: 'target', dblclick: 'target',
  rightclick: 'target', check: 'target', uncheck: 'target', scroll: 'target',
};
const LOADER_FIELDS = ['kind', 'optional', 'origin', 'at'];
/** The keys of `kind: {...}` for the kinds written as a mapping; `wait` and `expect` take `that` and `within`. */
const MAPPING_FIELDS: Record<string, string[]> = Object.fromEntries(StepSchema.options.map((schema) =>
  [schema.shape.kind.value, Object.keys(schema.shape).filter((key) => !LOADER_FIELDS.includes(key))]));
const CLAIM_FIELDS = ['that', 'within'];

/** Parses one step as YAML and MCP write it: one action key, plus an optional `optional`. */
export function parseStep(path: string, i: number, raw: unknown): Step {
  const where = `${path}: step ${i}`;
  const mapping = parseData(MappingSchema, raw, where);
  const kind = stepKind(mapping, where, STEP_KINDS);
  const fields = stepFields(kind, mapping[kind], `${where} "${kind}"`);
  return parseData(StepSchema, { ...fields, kind, optional: mapping.optional === true }, where);
}

/**
 * The step's one action key. Any other key than `optional` is an error that names it, with the closest of
 * `suggest` when one is near; `at` and `origin` only come from the loader. Shared by the browser, desktop and
 * mobile parsers, for spec files and MCP `step`/`batch`.
 */
export function stepKind(mapping: Record<string, unknown>, where: string, kinds: readonly string[], suggest = kinds): string {
  rejectReserved(mapping, where);
  rejectUnknownKeys(mapping, [...kinds, 'optional'], where, [...suggest, 'optional']);
  const actions = Object.keys(mapping).filter((key) => key !== 'optional');
  if (actions.length !== 1) fail(`${where} must have exactly one action key (plus optional "optional"), got [${actions.join(', ')}]`);
  return actions[0];
}

function rejectReserved(mapping: Record<string, unknown>, where: string): void {
  for (const reserved of ['at', 'origin']) {
    if (reserved in mapping) fail(`${where}: "${reserved}" is reserved for the loader`);
  }
}

/** Throws on the first key of a mapping that is not in `allowed`. Not a mapping: left to the schema. */
export function rejectUnknownKeys(value: unknown, allowed: readonly string[], where: string, suggest = allowed): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const key = Object.keys(value).find((name) => !allowed.includes(name));
  if (key !== undefined) fail(`${where}: ${unknownKey(key, suggest)}`);
}

function stepFields(kind: string, value: unknown, where: string): Record<string, unknown> {
  const field = SINGLE_VALUE_FIELD[kind];
  if (field) return { [field]: value };
  if (kind === StepKind.wait) {
    // `wait: <claim>`, or `wait: {that, within}` to poll one region.
    const wait = typeof value === 'string' ? { that: value } : parseData(MappingSchema, value, where);
    rejectReserved(wait, where);
    rejectUnknownKeys(wait, CLAIM_FIELDS, where);
    return { condition: wait.that, ...(wait.within === undefined ? {} : { within: wait.within }) };
  }
  if (kind === StepKind.expect) {
    const scoped = typeof value !== 'string' && !Array.isArray(value);
    const expect = scoped ? parseData(MappingSchema, value, where) : { that: value };
    rejectReserved(expect, where);
    rejectUnknownKeys(expect, CLAIM_FIELDS, where);
    return {
      expectations: typeof expect.that === 'string' ? [expect.that] : expect.that,
      ...(expect.within === undefined ? {} : { within: expect.within }),
    };
  }
  const fields = parseData(MappingSchema, value, where);
  rejectReserved(fields, where);
  rejectUnknownKeys(fields, MAPPING_FIELDS[kind], where);
  return fields;
}

/**
 * Only include expansion sets `origin`. It is taken off before the step is parsed, so `parseStep` keeps
 * rejecting it, and put back on the parsed step for its label.
 */
export function withOrigin<S>(raw: unknown, parse: (raw: unknown) => S): S {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !('origin' in raw)) return parse(raw);
  const { origin, ...rest } = raw as Record<string, unknown>;
  if (typeof origin !== 'string' || !origin) fail('origin must be a non-empty string');
  return { ...parse(rest), origin };
}

/** Puts the step's source (absolute file, index in it) on the parsed step: the lock key. */
function withSource<S>(parsed: S, root: string, source: { file?: string; index: number } | undefined, i: number): S {
  const file = source?.file === undefined ? resolve(root) : resolve(dirname(resolve(root)), source.file);
  return { ...parsed, at: { file, index: source?.index ?? i } };
}

/**
 * `$VAR` in an env or auth value reads process.env.VAR, so no credential sits in the spec file. Any depth: setup
 * data is often nested (`env.user.name`). A plain string passes through unchanged. Under a secret key (`secret`),
 * every leaf is a credential (`apiKeys: {stripe: ...}`).
 */
function resolveEnvBlock(path: string, field: string, raw: Record<string, unknown>, opts?: LoadOptions,
  secret = false): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const childField = `${field}.${key}`;
    const childSecret = secret || isSecretKey(key);
    if (Array.isArray(value) && opts?.onLiteralSecret) checkListSecrets(path, childField, value, childSecret, opts.onLiteralSecret);
    else if (childSecret && isLiteral(value) && !String(value).startsWith('$')) {
      opts?.onLiteralSecret?.(literalSecretMessage(path, childField));
    }
    if (typeof value === 'string') resolved[key] = resolveEnvRef(path, childField, value, opts);
    else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      resolved[key] = resolveEnvBlock(path, childField, value as Record<string, unknown>, opts, childSecret);
    } else resolved[key] = value;
  }
  return resolved;
}

/**
 * A `$NAME` inside a list stays text, so every secret value at any depth of a list is literal. `seen`: a YAML alias
 * can make a list contain itself.
 */
function checkListSecrets(path: string, field: string, value: unknown, secret: boolean, warn: (message: string) => void,
  seen = new Set<object>()): void {
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return;
    seen.add(value);
  }
  if (Array.isArray(value)) value.forEach((item, i) => checkListSecrets(path, `${field}.${i}`, item, secret, warn, seen));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      checkListSecrets(path, `${field}.${key}`, child, secret || isSecretKey(key), warn, seen);
    }
  } else if (secret && isLiteral(value)) warn(literalSecretMessage(path, field));
}

const isLiteral = (value: unknown): boolean => typeof value === 'number' || (typeof value === 'string' && value !== '');

const literalSecretMessage = (path: string, field: string) =>
  `${path}: "${field}" holds a literal secret (use a $VAR value to read it from the environment)`;

function resolveEnvRef(path: string, field: string, value: string, opts?: LoadOptions): string {
  if (!value.startsWith('$')) return value;
  const name = value.slice(1);
  const resolved = process.env[name];
  if (resolved) return resolved;
  const message = `${path}: "${field}" references $${name} but that env var is not set`;
  if (!opts?.onMissingEnv) fail(message);
  opts.onMissingEnv(message);
  return value;
}

export function checkSpecTimeout(spec: { timeout?: number }, file: string): void {
  if (spec.timeout !== undefined && (!Number.isSafeInteger(spec.timeout) || spec.timeout <= 0)) {
    throw new Error(`invalid spec: ${file}: timeout must be a positive safe integer`);
  }
}

/** Throws when a desktop or mobile step uses the browser-only `css=` escape hatch. */
export function rejectCss(step: object, what: string): void {
  const fields = step as Record<string, unknown>;
  const targets = ['target', 'source', 'within', 'condition'].flatMap((key) => key in fields ? [String(fields[key])] : []);
  if (targets.some((value) => value.startsWith('css='))) throw new Error(`css= is browser-only; describe a ${what} accessibility element`);
}

function parseData<T extends z.ZodType>(schema: T, raw: unknown, where: string): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    // A typo in a key also leaves the real key missing: the typo is the better message.
    const issue = result.error.issues.find((one) => one.code === 'unrecognized_keys') ?? result.error.issues[0];
    const field = issue.path.length ? ` "${issue.path.join('.')}"` : '';
    if (issue.code === 'unrecognized_keys') fail(`${where}${field}: ${unknownKey(issue.keys[0], keysAt(schema, issue.path))}`);
    fail(`${where}:${field} ${issue.message}`);
  }
  return result.data;
}

/** The keys of the object schema at `path`, through optional, nullable, default and array wrappers. */
function keysAt(schema: z.ZodType, path: PropertyKey[]): string[] {
  const objectOf = (node: unknown): z.ZodObject | undefined => {
    while (node && !(node instanceof z.ZodObject)) {
      const unwrap = (node as { unwrap?: () => unknown }).unwrap;
      node = typeof unwrap === 'function' ? unwrap.call(node) : undefined;
    }
    return node as z.ZodObject | undefined;
  };
  let object = objectOf(schema);
  for (const key of path) {
    if (typeof key !== 'number') object = objectOf(object?.shape[String(key)]);
  }
  return object ? Object.keys(object.shape) : [];
}

function fail(message: string): never {
  throw new Error(`invalid spec: ${message}`);
}
