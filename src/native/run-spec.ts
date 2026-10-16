import { parametersOf } from '../core/parameters.js';
import fs from 'node:fs';
import path from 'node:path';
import { startHooks, type HooksRunner, type HookSpec } from '../core/hooks.js';
import type { PlaceholderValues } from '../core/interpolate.js';
import { isFailure, overallStatus, type Status, type StepResult, type TestResult } from '../core/results.js';
import { observerCalls } from '../core/observe.js';
import { specDeadline } from '../core/spec-deadline.js';
import type { CaptureTarget, SessionObserver, SpecInfo } from '../core/run-contract.js';
import type { NativeAdapter, NativeSession, NativeStep } from './session.js';

type NativeSpec<S> = HookSpec & { env: Record<string, unknown>; hooks?: string; goal?: string; steps: S[]; tags?: string[]; timeout?: number };

/**
 * hooks setup → `open` (interpolates, attaches the app or device, returns the resolved steps) → steps → teardown →
 * close. Observers see the session only once `open` has attached it.
 */
export async function runNativeSpec<S extends NativeStep, P extends NativeSpec<S>>(spec: P,
  session: NativeSession<unknown, string, S, NativeAdapter<unknown, string>>, open: (vars: PlaceholderValues) => Promise<S[]>,
  observer?: SessionObserver, info?: SpecInfo, specTimeout?: number): Promise<TestResult> {
  const deadline = specDeadline(spec.timeout ?? specTimeout, performance.now());
  const steps: StepResult[] = [];
  const { lock, ...specInfo }: SpecInfo = info ?? { file: spec.name, name: spec.name, tags: spec.tags ?? [], attempt: 0 };
  session.lock = lock;
  session.goal = spec.goal;
  const observe = observerCalls(observer, specInfo);
  const target: CaptureTarget = {
    engine: 'platform' in spec ? 'mobile' : 'desktop',
    screenshot: async (file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, await session.adapter.screenshot());
    },
  };
  let opened = false;
  const record = async (result: StepResult): Promise<void> => {
    const index = steps.push(result) - 1;
    if (opened) await observe('stepEnd', { index, result, target });
  };

  let status: Status = 'pass';
  let hooks: HooksRunner<P> | undefined;
  let data: Record<string, unknown> = {};
  let setupDone = false;
  try {
    if (spec.hooks) {
      hooks = await startHooks<P>(spec.hooks);
      if (hooks.has.setup) data = await hooks.setup(spec);
    }
    setupDone = true;
    const runSteps = await open({ env: spec.env, hooks: data });
    session.parameters = parametersOf({ env: spec.env, hooks: data });
    session.prepareEvidence(runSteps);
    opened = true;
    await observe('sessionOpen', { target });
    for (const step of runSteps) {
      const result = await deadline.step(() => session.run(step), () => session.label(step));
      lock?.endStep(result);
      await record(result);
      if (isFailure(result.status)) {
        status = result.status;
        break;
      }
    }
  } catch (error) {
    status = 'error';
    await record({ step: setupDone ? 'open/interpolate' : 'setup', status, detail: String(error) });
  } finally {
    try {
      if (setupDone && hooks?.has.teardown) await hooks.teardown({ spec, data, result: { status: overallStatus(steps), steps } });
    } catch (error) {
      status = 'error';
      await record({ step: 'teardown', status, detail: String(error) });
    } finally {
      hooks?.close();
      if (opened) await observe('sessionClose', { status, target });
      try {
        await session.adapter.close();
      } catch (error) {
        status = 'error';
        steps.push({ step: 'close', status, detail: String(error) });
      }
    }
  }
  return { name: spec.name, status, steps, jevCalls: session.calls, totalTokens: session.tokens };
}
