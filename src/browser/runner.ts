import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Spec } from '../core/spec.js';
import { interpolate } from '../core/interpolate.js';
import { parametersOf } from '../core/parameters.js';
import { startHooks, type HooksRunner } from '../core/hooks.js';
import { errorMessage, isFailure, label, type Status, type StepResult, type TestResult } from '../core/results.js';
import { observerCalls } from '../core/observe.js';
import { specDeadline } from '../core/spec-deadline.js';
import type { CaptureTarget, SessionObserver, SpecInfo } from '../core/run-contract.js';
import { runStepSafely } from './steps.js';
import { prepareEvidence } from './evidence.js';
import { openSession, type Session } from './session.js';
import type { RunOptions } from './run-options.js';

/** A capture can hang on a page that a step cut by the spec timeout still holds. */
const SCREENSHOT_TIMEOUT_MS = 10_000;

/**
 * Hooks child → browser session → setup → steps (interpolated with env and setup data) → teardown → save state →
 * close. A setup error ends the run with a single `setup` step and no teardown; a teardown error makes it `error`.
 */
export async function runSpec(spec: Spec, opts: RunOptions, observer?: SessionObserver<Page>, info?: SpecInfo): Promise<TestResult> {
  const deadline = specDeadline(spec.timeout ?? opts.specTimeout);
  const steps: StepResult[] = [];
  let jevCalls = 0;
  let totalTokens = 0;
  let overall: Status = 'pass';
  const track = (tokens: number): void => {
    jevCalls++;
    totalTokens += tokens;
  };
  const resultWith = (status: Status): TestResult => ({ name: spec.name, status, steps, jevCalls, totalTokens });

  // Started before the browser opens, so a broken hooks module fails fast.
  const hooks: HooksRunner | null = spec.hooks ? await startHooks(spec.hooks) : null;
  let session: Session;
  try {
    session = await openSession(spec, opts, track);
  } catch (error) {
    hooks?.close();
    throw error;
  }

  const target = captureTarget(session, !!opts.cdp);
  const { lock, ...specInfo }: SpecInfo = info ?? { file: spec.name, name: spec.name, tags: spec.tags ?? [], attempt: 0 };
  session.ctx.lock = lock;
  const observe = observerCalls(observer, specInfo);
  const record = async (result: StepResult): Promise<void> => {
    const index = steps.push(result) - 1;
    await observe('stepEnd', { index, result, target });
  };
  await observe('sessionOpen', { target });

  /** What setup returned: `${hooks.*}` in the steps, `data` in teardown. */
  let data: Record<string, unknown> = {};
  if (hooks?.has.setup) {
    try {
      data = await hooks.setup(spec);
      await record({ step: 'setup', status: 'pass' });
    } catch (error) {
      // Nothing ran yet, so there is nothing for teardown to release.
      await record({ step: 'setup', status: 'error', detail: errorMessage(error) });
      await observe('sessionClose', { status: 'error', target });
      await session.close();
      hooks.close();
      return resultWith('error');
    }
  }

  try {
    let runSteps = spec.steps;
    try {
      const interpolated = interpolate({ url: spec.url, steps: spec.steps }, { env: spec.env ?? {}, hooks: data }, spec.name);
      session.ctx.spec = { ...spec, url: interpolated.url };
      session.ctx.parameters = parametersOf({ env: spec.env ?? {}, hooks: data });
      runSteps = interpolated.steps;
      prepareEvidence(session.ctx, runSteps);
    } catch (error) {
      overall = 'error';
      await record({ step: 'interpolate', status: 'error', detail: errorMessage(error) });
      runSteps = [];
    }

    for (const [index, step] of runSteps.entries()) {
      session.ctx.upcoming = runSteps.slice(index + 1);
      // The timeout is outside runStepSafely: an optional step cut by it ends `error`, not `skipped`.
      let result = await deadline.step(() => runStepSafely(session.ctx, step), () => label(step));
      lock?.endStep(result);
      const notes = session.drainNotes();
      if (notes.length) result = { ...result, detail: [result.detail, ...notes].filter(Boolean).join(' | ') };
      await record(result);
      if (isFailure(result.status)) {
        overall = result.status;
        break;
      }
    }
  } finally {
    if (hooks) {
      try {
        if (hooks.has.teardown) {
          await hooks.teardown({ spec, data, result: { status: overall, steps } });
          await record({ step: 'teardown', status: 'pass' });
        }
      } catch (error) {
        overall = 'error';
        await record({ step: 'teardown', status: 'error', detail: errorMessage(error) });
      } finally {
        hooks.close();
      }
    }
    // Saved only when the steps and teardown passed: a failed run must not overwrite a good state file.
    if (overall === 'pass' && spec.browser?.saveState !== undefined) {
      try {
        await saveStorageState(session, path.resolve(spec.dir, spec.browser.saveState));
      } catch (error) {
        overall = 'error';
        await record({ step: 'saveState', status: 'error', detail: errorMessage(error) });
      }
    }
    await observe('sessionClose', { status: overall, target });
    await session.close();
  }
  return resultWith(overall);
}

function captureTarget(session: Session, cdp: boolean): CaptureTarget<Page> {
  return {
    engine: 'browser',
    cdp,
    page: () => session.ctx.page,
    screenshot: async (file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await session.ctx.page.screenshot({ path: file, timeout: SCREENSHOT_TIMEOUT_MS });
    },
  };
}

async function saveStorageState(session: Session, file: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await session.ctx.page.context().storageState({ path: file });
}
