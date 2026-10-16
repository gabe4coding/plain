#!/usr/bin/env node
import { loadSpec, type Spec } from './core/spec.js';
import { errorMessage } from './core/results.js';
import { runSpec } from './browser/runner.js';
import { closeSharedBrowser } from './browser/session.js';
import type { RunOptions } from './browser/run-options.js';
import { provider, loadEnvFiles, MODEL_BY_PROVIDER } from './jev/provider.js';
import { warmUp } from './jev/ask.js';
import { parseSuiteArgs, UsageError } from './suite/options.js';
import { runSuite } from './suite/run-suite.js';
import { printValidation } from './suite/validate.js';
import { checkSpecTimeoutFlag } from './suite/spec-timeout.js';
import type { SuiteEngine } from './suite/types.js';

const USAGE = 'usage: plain [--headless] [--timeout <ms>] [--profile <dir>] [--cdp <url>] [--channel chrome] [--timing] ' +
  '[--workers N] [suite options] <spec.yaml|dir|glob> [more ...] | validate <files...> | mcp';

loadEnvFiles();
try {
  const { command, opts, flags } = parseSuiteArgs(process.argv.slice(2), 'browser');
  checkSpecTimeoutFlag(opts.specTimeout);
  const runOpts: RunOptions = {
    headed: !flags.headless,
    timeout: Number(flags.timeout),
    profile: flags.profile as string | undefined,
    cdp: flags.cdp as string | undefined,
    channel: flags.channel as string | undefined,
    specTimeout: opts.specTimeout,
  };
  if (command === 'mcp') {
    try {
      const chosen = provider();
      console.error(`plain: Jev via ${chosen} (${MODEL_BY_PROVIDER[chosen]})`);
    } catch (error) {
      console.error(errorMessage(error)); // the server still starts; the first Jev call reports it again
    }
    warmUp();
    await (await import('./browser/mcp.js')).serveMcp(runOpts); // the MCP SDK loads only when serving
  } else {
    const engine: SuiteEngine<Spec> = {
      engine: 'browser',
      load: loadSpec,
      meta: (spec) => ({ name: spec.name, tags: spec.tags ?? [], timeoutMs: spec.timeout }),
      run: (spec, observer, info) => runSpec(spec, runOpts, observer, info),
      maxWorkers: Infinity,
      close: closeSharedBrowser,
    };
    if (command === 'validate') process.exitCode = printValidation(engine, opts.files);
    else process.exitCode = (await runSuite(engine, opts)).status === 'pass' ? 0 : 1;
  }
} catch (error) {
  console.error(error instanceof UsageError ? USAGE : errorMessage(error));
  process.exitCode = 2;
}
