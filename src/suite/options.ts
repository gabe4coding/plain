import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { RUN_MODES, type RunMode } from '../core/lock.js';
import { loadConfig } from './config.js';
import type { Engine } from '../core/run-contract.js';
import { CAPTURE_MODES, type CaptureMode, type EngineFlags, type ReporterSpec, type SuiteOptions } from './types.js';

interface ParsedSuiteArgs { command: 'run' | 'mcp' | 'validate'; opts: SuiteOptions; flags: EngineFlags }

/** No spec paths given: each CLI prints its own usage line. */
export class UsageError extends Error {
  constructor() {
    super('usage');
  }
}

type Config = Partial<SuiteOptions & EngineFlags> & { artifacts?: Partial<NonNullable<SuiteOptions['artifacts']>> };

/** Flags whose value may also come from an existing environment variable. */
const ENV_FALLBACKS: Record<string, string> = {
  profile: 'PLAIN_PROFILE', cdp: 'PLAIN_CDP', channel: 'PLAIN_CHANNEL', server: 'PLAIN_APPIUM_URL',
};
const BROWSER_ONLY_FLAGS = ['headless', 'profile', 'channel', 'cdp', 'timing'] as const;

const ARG_OPTIONS = {
  workers: { type: 'string' }, retries: { type: 'string' }, bail: { type: 'string' },
  'last-failed': { type: 'boolean' }, 'max-tokens': { type: 'string' },
  grep: { type: 'string' }, 'grep-invert': { type: 'string' }, tag: { type: 'string', multiple: true },
  list: { type: 'boolean' }, config: { type: 'string' }, reporter: { type: 'string', multiple: true },
  artifacts: { type: 'string' }, screenshot: { type: 'string' }, trace: { type: 'string' },
  'spec-timeout': { type: 'string' }, timing: { type: 'boolean' }, timeout: { type: 'string' },
  headless: { type: 'boolean' }, profile: { type: 'string' }, channel: { type: 'string' }, cdp: { type: 'string' },
  server: { type: 'string' }, mode: { type: 'string' },
} as const;

function captureMode(name: string, value: unknown): CaptureMode {
  if (!CAPTURE_MODES.includes(value as never)) throw new Error(`--${name} must be one of ${CAPTURE_MODES.join(', ')}, got "${value}"`);
  return value as CaptureMode;
}

function integer(name: string, value: unknown, min = 0): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`--${name} must be ${min > 0 ? 'a positive' : 'a non-negative'} number, got "${value}"`);
  }
  return parsed;
}

const optionalPositive = (name: string, value: unknown): number | undefined => value === undefined ? undefined : integer(name, value, 1);
const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const isTrue = (value: unknown): boolean => value === true;

/** `*` matches within a folder, `**` across folders. */
const globToRegex = (glob: string): RegExp => new RegExp(`^${glob.split(/(\*\*\/|\*\*|\*)/g).map((part) =>
  part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')).join('')}$`);

const isYaml = (name: string) => /\.ya?ml$/i.test(name);

/** Files as given, the YAML files under a directory, or the YAML files a glob matches; each group sorted. */
export function expandFiles(positionals: string[], cwd = process.cwd()): string[] {
  return positionals.flatMap((input) => {
    const resolved = path.resolve(cwd, input);
    if (!input.includes('*')) {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return [input];
      const files = fs.readdirSync(resolved, { recursive: true }) as string[];
      return files.filter((name) => isYaml(name) && fs.statSync(path.resolve(resolved, name)).isFile())
        .map((name) => path.join(input, name)).sort();
    }
    const prefix = input.slice(0, input.indexOf('*'));
    const root = path.resolve(cwd, prefix.slice(0, prefix.lastIndexOf('/') + 1) || '.');
    if (!fs.existsSync(root)) return [];
    const pattern = globToRegex(input.replaceAll(path.sep, '/').replace(/^\.\//, ''));
    const display = (name: string) => {
      const file = path.join(root, name);
      return (path.isAbsolute(input) ? file : path.relative(cwd, file)).replaceAll(path.sep, '/');
    };
    return (fs.readdirSync(root, { recursive: true }) as string[])
      .filter((name) => isYaml(name) && fs.statSync(path.join(root, name)).isFile())
      .map(display)
      .filter((name) => pattern.test(name))
      .sort();
  });
}

/** Every value: CLI flag, then an existing PLAIN_* variable, then the config file, then the default. */
export function parseSuiteArgs(argv: string[], engine: Engine, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(),
  readConfig: typeof loadConfig = loadConfig): ParsedSuiteArgs {
  // A bare `--bail` means `--bail=1`.
  const args = argv.map((arg, i) => arg === '--bail' && !/^\d+$/.test(argv[i + 1] ?? '') ? '--bail=1' : arg);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: ARG_OPTIONS });
  const command = positionals[0] === 'mcp' ? 'mcp' : positionals[0] === 'validate' ? 'validate' : 'run';
  // The MCP server reads no config file and takes no suite options.
  const { config, ignored } = engineConfig(command === 'mcp' ? {} : readConfig(cwd, values.config) as Config, engine);
  const setting = (key: string, cli: unknown, fallback: unknown): unknown =>
    cli ?? (ENV_FALLBACKS[key] ? env[ENV_FALLBACKS[key]] : undefined) ?? (config as Record<string, unknown>)[key] ?? fallback;

  const inputs = command === 'run' ? positionals : positionals.slice(1);
  if (command === 'mcp' && positionals.length !== 1) throw new Error('mcp takes no positional arguments');
  const paths = inputs.length ? inputs : command === 'run' ? config.files ?? [] : [];
  if (!paths.length && command !== 'mcp') throw new UsageError();

  const workers = integer('workers', setting('workers', values.workers, 1), 1);
  const profile = asString(setting('profile', values.profile, undefined))?.replace(/^~(?=\/|$)/, homedir());
  const cdp = asString(setting('cdp', values.cdp, undefined));
  // Worker conflicts fail here, before any spec loads or a browser opens.
  if (workers > 1 && engine !== 'browser') throw new Error('--workers > 1 is not supported for desktop or mobile');
  if (workers > 1 && (profile || cdp)) {
    throw new Error('plain: --workers > 1 needs isolated browsers; --profile opens one persistent profile (cannot be opened twice) ' +
      'and --cdp attaches to one shared browser context. Run those with --workers 1.');
  }

  const reporters = (values.reporter ?? config.reporters ?? [{ name: engine === 'browser' ? 'text' : 'jsonl' }]).map(reporterSpec);
  const artifacts = artifactOptions(engine, values, config);
  const files = expandFiles(paths, cwd);
  if (command !== 'mcp' && files.length === 0) throw new Error('no YAML files matched the given paths');
  const mode = setting('mode', values.mode, 'auto-healing');
  if (!RUN_MODES.includes(mode as RunMode)) throw new Error(`--mode must be one of ${RUN_MODES.join(', ')}, got "${mode}"`);

  const opts: SuiteOptions = {
    files,
    workers,
    retries: integer('retries', setting('retries', values.retries, 0)),
    bail: integer('bail', setting('bail', values.bail, 0)),
    lastFailed: isTrue(values['last-failed']),
    maxTokens: optionalPositive('max-tokens', setting('maxTokens', values['max-tokens'], undefined)),
    grep: asString(setting('grep', values.grep, undefined)),
    grepInvert: asString(setting('grepInvert', values['grep-invert'], undefined)),
    tags: values.tag ?? config.tags ?? [],
    list: isTrue(values.list),
    reporters,
    timing: engine === 'browser' && isTrue(setting('timing', values.timing, false)),
    artifacts,
    specTimeout: optionalPositive('spec-timeout', setting('specTimeout', values['spec-timeout'], undefined)),
    mode: mode as RunMode,
  };

  const timeout = String(setting('timeout', values.timeout, '15000'));
  checkTimeout(engine, timeout);
  const flags: EngineFlags = {
    timeout,
    headless: isTrue(setting('headless', values.headless, false)),
    profile,
    cdp,
    channel: asString(setting('channel', values.channel, undefined)),
    server: asString(setting('server', values.server, undefined)),
  };
  const browserOnly = BROWSER_ONLY_FLAGS.find((name) => values[name] !== undefined);
  if (engine !== 'browser' && browserOnly) throw new Error(`--${browserOnly} is browser-only`);
  if (engine !== 'mobile' && values.server) throw new Error('--server is mobile-only');
  if (ignored.length) console.error(`plain: ${engine} ignores these config values: ${ignored.join(', ')}`);
  return { command, opts, flags };
}

/**
 * One config file can serve all three CLIs, so a config value the running engine cannot use is dropped and named in
 * `ignored` (the caller prints one note). The same value as a CLI flag stays an invocation error. Environment
 * fallbacks are not config and are not reported.
 */
export function engineConfig(config: Config, engine: Engine): { config: Config; ignored: string[] } {
  const kept: Record<string, unknown> & Config = { ...config };
  const ignored: string[] = [];
  const drop = (key: string, shown = key): void => {
    delete kept[key];
    ignored.push(shown);
  };
  if (engine !== 'browser') {
    for (const key of BROWSER_ONLY_FLAGS) if (kept[key] !== undefined) drop(key);
    if (Number(kept.workers) > 1) drop('workers', `workers: ${kept.workers}`);
    if (kept.timeout !== undefined && Number(kept.timeout) === 0) drop('timeout', 'timeout: 0');
    const { trace, ...artifacts } = kept.artifacts ?? {};
    if (trace !== undefined && trace !== 'off') {
      if (Object.keys(artifacts).length) kept.artifacts = artifacts as Config['artifacts'];
      else delete kept.artifacts;
      ignored.push(`artifacts.trace: ${trace}`);
    }
  }
  if (engine !== 'mobile' && kept.server !== undefined) drop('server');
  return { config: kept, ignored };
}

/** `junit:out/junit.xml` → `{ name: 'junit', output: 'out/junit.xml' }`. */
function reporterSpec(value: string | ReporterSpec): ReporterSpec {
  if (typeof value !== 'string') return value;
  return { name: value.split(':', 1)[0], output: value.includes(':') ? value.slice(value.indexOf(':') + 1) : undefined };
}

/** Capture is off until a folder is set; the modes alone change nothing. Desktop and mobile have no trace. */
function artifactOptions(engine: Engine, values: { artifacts?: string; screenshot?: string; trace?: string }, config: Config) {
  const dir = asString(values.artifacts ?? config.artifacts?.dir);
  const screenshot = captureMode('screenshot', values.screenshot ?? config.artifacts?.screenshot ?? 'on-failure');
  const trace = captureMode('trace', values.trace ?? config.artifacts?.trace ?? (engine === 'browser' ? 'on-failure' : 'off'));
  if (!dir && (values.screenshot !== undefined || values.trace !== undefined)) {
    console.error('plain: --screenshot and --trace have no effect without --artifacts <dir>');
  }
  return dir ? { dir, screenshot, trace } : undefined;
}

/** In the browser 0 is Playwright's "no timeout"; desktop and mobile need a positive value. */
function checkTimeout(engine: Engine, timeout: string): void {
  const ms = Number(timeout);
  if (Number.isFinite(ms) && (engine === 'browser' ? ms >= 0 : ms > 0)) return;
  throw new Error(engine === 'browser' ? `--timeout must be a number of milliseconds, got "${timeout}"` : '--timeout must be a positive number of milliseconds');
}
