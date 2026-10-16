import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineConfig, expandFiles, parseSuiteArgs, UsageError } from './options.js';

const parsed = (args: string[], engine: 'browser' | 'desktop' | 'mobile' = 'browser', env: NodeJS.ProcessEnv = {}) =>
  parseSuiteArgs([...args, 'case.yaml'], engine, env, '/tmp/plain-options-absent');

test('parses all suite flags and browser flags', () => {
  const { opts, flags } = parsed(['--workers', '4', '--retries', '0', '--bail', '0', '--grep', 'one',
    '--grep-invert', 'two', '--tag', 'smoke', '--tag', 'checkout', '--reporter', 'text', '--reporter', 'jsonl',
    '--timeout', '9000', '--headless', '--timing', '--channel', 'chrome']);
  assert.equal(opts.workers, 4);
  assert.equal(opts.retries, 0);
  assert.equal(opts.bail, 0);
  assert.deepEqual(opts.tags, ['smoke', 'checkout']);
  assert.deepEqual(opts.reporters.map((r) => r.name), ['text', 'jsonl']);
  assert.equal(opts.grep, 'one');
  assert.equal(opts.grepInvert, 'two');
  assert.equal(opts.timing, true);
  assert.equal(flags.timeout, '9000');
  assert.equal(flags.headless, true);
  assert.equal(flags.channel, 'chrome');
  assert.equal(parsed(['--bail']).opts.bail, 1);
  assert.equal(parsed(['--last-failed']).opts.lastFailed, true);
  assert.equal(parsed(['--list']).opts.list, true);
  assert.equal(parsed(['--max-tokens', '8']).opts.maxTokens, 8);
  assert.equal(parsed(['--spec-timeout', '500']).opts.specTimeout, 500);
  assert.equal(parsed(['--screenshot', 'on-failure', '--trace', 'on-failure']).opts.artifacts, undefined);
  assert.equal(parsed(['--server', 'http://localhost:4723'], 'mobile').flags.server, 'http://localhost:4723');
});

test('CLI overrides existing env fallback; env overrides defaults', () => {
  const env = { PLAIN_PROFILE: '/env/profile', PLAIN_CHANNEL: 'chrome', PLAIN_CDP: 'http://env' };
  assert.equal(parsed(['--profile', '/cli/profile', '--timeout', '8000'], 'browser', env).flags.profile, '/cli/profile');
  assert.equal(parsed([], 'browser', env).flags.channel, 'chrome');
  assert.equal(parsed([], 'browser', env).flags.cdp, 'http://env');
  assert.equal(parsed([]).flags.timeout, '15000');
  // The only place the mobile CLI gets PLAIN_APPIUM_URL from.
  const appium = { PLAIN_APPIUM_URL: 'http://env-appium' };
  assert.equal(parsed([], 'mobile', appium).flags.server, 'http://env-appium');
  assert.equal(parsed(['--server', 'http://cli-appium'], 'mobile', appium).flags.server, 'http://cli-appium');
});

test('directory and glob expansion are sorted, while file positionals keep their order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-options-'));
  fs.mkdirSync(path.join(dir, 'tests', 'deep'), { recursive: true });
  for (const file of ['tests/z.yaml', 'tests/a.yml', 'tests/deep/b.yaml', 'tests/no.txt'])
    fs.writeFileSync(path.join(dir, file), '');
  assert.deepEqual(expandFiles(['tests'], dir), ['tests/a.yml', 'tests/deep/b.yaml', 'tests/z.yaml']);
  assert.deepEqual(expandFiles(['tests/**/*.yaml'], dir), ['tests/deep/b.yaml', 'tests/z.yaml']);
  assert.deepEqual(expandFiles(['./tests/*.yaml'], dir), ['tests/z.yaml']);
  assert.deepEqual(expandFiles([path.join(dir, 'tests', '*.yaml')], dir), [path.join(dir, 'tests', 'z.yaml')]);
  assert.deepEqual(expandFiles(['tests/z.yaml', 'tests/a.yml'], dir), ['tests/z.yaml', 'tests/a.yml']);
  assert.throws(() => parseSuiteArgs(['tests/none/*.yaml'], 'browser', {}, dir), /no YAML files matched/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('artifact settings pass through to lane B; a missing --config file is an error', () => {
  assert.throws(() => parsed(['--config', 'missing.yaml']), /--config.*file not found/);
  const withDir = parsed(['--artifacts', 'out', '--screenshot', 'always', '--trace', 'off']).opts;
  assert.deepEqual(withDir.artifacts, { dir: 'out', screenshot: 'always', trace: 'off' });
  assert.equal(parsed(['--screenshot', 'always']).opts.artifacts, undefined);
  assert.throws(() => parsed(['--screenshot', 'sometimes']), /--screenshot must be one of off, on-failure, always/);
  assert.deepEqual(parsed(['--trace', 'off'], 'desktop').opts.artifacts, undefined);
});

test('worker constraints reject native concurrency and shared browser contexts', () => {
  assert.throws(() => parsed(['--workers', '2'], 'desktop'), /--workers > 1/);
  assert.throws(() => parsed(['--workers', '2'], 'mobile'), /--workers > 1/);
  assert.throws(() => parsed(['--workers', '2', '--profile', '/tmp/p']), /--workers > 1/);
  assert.throws(() => parsed(['--workers', '2', '--cdp', 'http://localhost']), /--workers > 1/);
});

test('config file values apply to every key, below CLI and existing env; mcp never reads it', () => {
  const config = { workers: 3, retries: 2, bail: 1, maxTokens: 900, grep: 'g', grepInvert: 'v', tags: ['smoke'],
    timing: true, specTimeout: 5000, timeout: '8000', headless: true, channel: 'chrome', files: ['from-config.yaml'],
    artifacts: { dir: 'out', screenshot: 'always', trace: 'off' } };
  const read = () => config as never;
  const { opts, flags } = parseSuiteArgs([], 'browser', {}, '/tmp/plain-options-absent', read);
  assert.deepEqual(opts.files, ['from-config.yaml']);
  assert.equal(opts.workers, 3); assert.equal(opts.retries, 2); assert.equal(opts.bail, 1); assert.equal(opts.maxTokens, 900);
  assert.equal(opts.grep, 'g'); assert.equal(opts.grepInvert, 'v'); assert.deepEqual(opts.tags, ['smoke']);
  assert.equal(opts.timing, true); assert.equal(opts.specTimeout, 5000);
  assert.deepEqual(opts.artifacts, { dir: 'out', screenshot: 'always', trace: 'off' });
  assert.equal(flags.timeout, '8000'); assert.equal(flags.headless, true); assert.equal(flags.channel, 'chrome');
  const cli = parseSuiteArgs(['--workers', '2', '--grep', 'cli', 'case.yaml'], 'browser', { PLAIN_CHANNEL: 'msedge' },
    '/tmp/plain-options-absent', read);
  assert.equal(cli.opts.workers, 2); assert.equal(cli.opts.grep, 'cli'); assert.deepEqual(cli.opts.files, ['case.yaml']);
  assert.equal(cli.flags.channel, 'msedge');
  let reads = 0;
  parseSuiteArgs(['mcp'], 'browser', {}, '/tmp/plain-options-absent', () => { reads++; return {}; });
  assert.equal(reads, 0);
});

test('one shared config: values an engine cannot use are ignored with one note, the same CLI flags stay errors', (t) => {
  const config = { workers: 4, timing: true, headless: true, profile: '/p', channel: 'chrome', cdp: 'http://cdp', timeout: 0,
    server: 'http://appium', retries: 2, artifacts: { dir: 'out', trace: 'on-failure' } };
  const read = () => structuredClone(config) as never;
  const notes = t.mock.method(console, 'error', () => {});
  const run = (engine: 'browser' | 'desktop' | 'mobile', args = ['case.yaml'], env: NodeJS.ProcessEnv = {}) =>
    parseSuiteArgs(args, engine, env, '/tmp/plain-options-absent', read);

  const desktop = run('desktop');
  assert.equal(desktop.opts.workers, 1); assert.equal(desktop.opts.timing, false); assert.equal(desktop.opts.retries, 2);
  assert.deepEqual(desktop.opts.artifacts, { dir: 'out', screenshot: 'on-failure', trace: 'off' });
  assert.deepEqual(desktop.flags, { timeout: '15000', headless: false, profile: undefined, cdp: undefined,
    channel: undefined, server: undefined });
  assert.deepEqual(notes.mock.calls.map((call) => call.arguments[0]), ['plain: desktop ignores these config values: ' +
    'headless, profile, channel, cdp, timing, workers: 4, timeout: 0, artifacts.trace: on-failure, server']);

  notes.mock.resetCalls();
  assert.equal(run('mobile').flags.server, 'http://appium');
  assert.deepEqual(notes.mock.calls.map((call) => call.arguments[0]), ['plain: mobile ignores these config values: ' +
    'headless, profile, channel, cdp, timing, workers: 4, timeout: 0, artifacts.trace: on-failure']);
  notes.mock.resetCalls();
  const browser = run('browser', ['--workers', '1', 'case.yaml']);
  assert.equal(browser.flags.headless, true); assert.equal(browser.flags.timeout, '0');
  assert.equal(browser.opts.artifacts?.trace, 'on-failure');
  assert.equal(browser.flags.server, undefined);
  assert.deepEqual(notes.mock.calls.map((call) => call.arguments[0]), ['plain: browser ignores these config values: server']);

  // validate and --list read the same config and no longer stop on browser values.
  assert.equal(run('desktop', ['validate', 'case.yaml']).command, 'validate');
  assert.equal(run('mobile', ['--list', 'case.yaml']).opts.list, true);
  // Explicit flags are still invocation errors, with or without the config, and print no note first.
  notes.mock.resetCalls();
  assert.throws(() => run('desktop', ['--workers', '4', 'case.yaml']), /--workers > 1/);
  assert.throws(() => run('mobile', ['--headless', 'case.yaml']), /--headless is browser-only/);
  assert.throws(() => run('desktop', ['--timeout', '0', 'case.yaml']), /--timeout must be a positive/);
  assert.throws(() => run('browser', ['--workers', '1', '--server', 'http://x', 'case.yaml']), /--server is mobile-only/);
  assert.equal(notes.mock.callCount(), 0);
});

test('engineConfig keeps shared values, does not change its input and does not report environment fallbacks', (t) => {
  const shared = { workers: 1, timeout: 9000, retries: 1, artifacts: { dir: 'out', trace: 'off' as const } };
  assert.deepEqual(engineConfig(shared as never, 'desktop'), { config: shared, ignored: [] });
  const input = { headless: true, artifacts: { dir: 'out', trace: 'always' as const } };
  assert.deepEqual(engineConfig(input as never, 'mobile'), { config: { artifacts: { dir: 'out' } },
    ignored: ['headless', 'artifacts.trace: always'] });
  assert.deepEqual(input, { headless: true, artifacts: { dir: 'out', trace: 'always' } });
  assert.deepEqual(engineConfig({ artifacts: { trace: 'on-failure' } } as never, 'desktop'),
    { config: {}, ignored: ['artifacts.trace: on-failure'] }); // no empty `artifacts` left behind
  const notes = t.mock.method(console, 'error', () => {});
  const { flags } = parsed([], 'desktop', { PLAIN_CHANNEL: 'chrome', PLAIN_APPIUM_URL: 'http://appium' });
  assert.equal(flags.channel, 'chrome'); // ignored by the desktop session, as before
  assert.equal(notes.mock.callCount(), 0);
});

test('usage, timeout and engine-only flag errors', () => {
  assert.throws(() => parseSuiteArgs([], 'browser', {}, '/tmp/plain-options-absent'), UsageError);
  assert.throws(() => parseSuiteArgs(['validate'], 'desktop', {}, '/tmp/plain-options-absent'), UsageError);
  assert.equal(parsed(['--timeout', '0']).flags.timeout, '0'); // Playwright's "no timeout", accepted as before
  assert.throws(() => parsed(['--timeout', '0'], 'desktop'), /--timeout must be a positive number of milliseconds/);
  assert.equal(parsed(['--timeout', '1500.5'], 'mobile').flags.timeout, '1500.5');
  assert.throws(() => parsed(['--headless'], 'desktop'), /--headless is browser-only/);
  assert.throws(() => parsed(['--server', 'http://x'], 'desktop'), /--server is mobile-only/);
});

test('--mode is auto-healing on every engine, and comes from config `mode`', () => {
  assert.equal(parsed([]).opts.mode, 'auto-healing');
  assert.equal(parsed(['--mode', 'no-judge']).opts.mode, 'no-judge');
  assert.equal(parsed([], 'desktop').opts.mode, 'auto-healing');
  assert.equal(parsed(['--mode', 'no-judge'], 'mobile').opts.mode, 'no-judge');
  assert.throws(() => parsed(['--mode', 'replay']), /--mode must be one of judge, no-judge, auto-healing/);
  const fromConfig = parseSuiteArgs(['case.yaml'], 'browser', {}, '/tmp/plain-options-absent', () => ({ mode: 'judge' } as never));
  assert.equal(fromConfig.opts.mode, 'judge');
});
