import type { LoadOptions } from '../core/spec.js';
import { errorMessage, type TestResult } from '../core/results.js';
import { loadEnvFiles } from '../jev/provider.js';
import { warmUp } from '../jev/ask.js';
import type { Engine, SessionObserver, SpecInfo } from '../core/run-contract.js';
import { parseSuiteArgs, UsageError } from './options.js';
import { checkSpecTimeoutFlag } from './spec-timeout.js';
import { runSuite } from './run-suite.js';
import { printValidation } from './validate.js';
import type { SuiteEngine } from './types.js';

type ServerFlags = { server?: string };

export interface NativeCliEngine<S> {
  serve(timeout: number, values: ServerFlags): Promise<void>;
  load(file: string, opts?: LoadOptions): S;
  run(spec: S, timeout: number, values: ServerFlags, observer?: SessionObserver, info?: SpecInfo, specTimeout?: number): Promise<TestResult>;
  meta(spec: S): { name: string; tags: string[]; timeoutMs?: number };
}

/** The desktop and mobile CLI: `mcp`, `validate`, or spec files run one after another (one input device). */
export async function nativeCli<S>(bin: string, usage: string, engineName: Extract<Engine, 'desktop' | 'mobile'>, platform: NativeCliEngine<S>) {
  loadEnvFiles();
  try {
    const { command, opts, flags } = parseSuiteArgs(process.argv.slice(2), engineName);
    checkSpecTimeoutFlag(opts.specTimeout);
    const values = { server: flags.server as string | undefined };
    const timeout = Number(flags.timeout);
    if (command === 'mcp') {
      warmUp();
      return await platform.serve(timeout, values);
    }
    const engine: SuiteEngine<S> = {
      engine: engineName,
      load: platform.load,
      meta: platform.meta,
      run: (spec, observer, info) => platform.run(spec, timeout, values, observer, info, opts.specTimeout),
      maxWorkers: 1,
    };
    if (command === 'validate') process.exitCode = printValidation(engine, opts.files);
    else process.exitCode = (await runSuite(engine, opts)).status === 'pass' ? 0 : 1;
  } catch (error) {
    const message = error instanceof UsageError
      ? `usage: ${bin} [--timeout 15000] ${usage}[suite options] mcp | validate <files...> | <spec.yaml|dir|glob> [more ...]`
      : errorMessage(error);
    console.error(`${bin}: ${message}`);
    process.exitCode = 2;
  }
}
