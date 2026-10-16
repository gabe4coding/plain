import { interpolate } from '../core/interpolate.js';
import type { StepResult } from '../core/results.js';
import { NativeSession } from '../native/session.js';
import { runNativeSpec } from '../native/run-spec.js';
import type { SessionObserver, SpecInfo } from '../core/run-contract.js';
import { parseMobileStep, validateMobileStep, mobileLabel, mobileScroll, type MobileStep, type MobileSpec } from './spec.js';
import { HiddenTargetError } from '../core/automation.js';
import type { MobileAdapter, MobileAction } from './adapter.js';
import type { MobileKind } from './tree.js';

/** The candidates a mobile step picks from. */
function candidateKind(kind: MobileStep['kind']): MobileKind {
  if (kind === 'fill') return 'fill';
  if (kind === 'check' || kind === 'uncheck') return 'check';
  if (kind === 'scroll') return 'scroll';
  return 'click';
}

export class MobileSession<T = unknown> extends NativeSession<T, MobileKind, MobileStep, MobileAdapter<T>> {
  parse(raw: unknown) { return parseMobileStep(raw); }
  label(step: MobileStep) { return mobileLabel(step); }
  protected override validate(step: MobileStep) { return validateMobileStep(step); }

  protected async act(step: MobileStep, stepLabel: string): Promise<StepResult> {
    if (step.kind === 'press') {
      await this.timed('act', () => this.adapter.press(step.key));
      return { step: stepLabel, status: 'pass' };
    }
    if (step.kind === 'swipe') {
      let element: T | undefined;
      if (step.within) {
        const [region] = await this.find('region', [step.within]);
        if (region.element === null) return { step: stepLabel, status: 'inconclusive', detail: region.detail };
        element = region.element;
      }
      await this.timed('act', () => this.adapter.gesture('swipe', step.direction, element));
      return { step: stepLabel, status: 'pass' };
    }
    if (step.kind === 'expect' || step.kind === 'wait') return { step: stepLabel, status: 'pass' };

    const scroll = step.kind === 'scroll' ? mobileScroll(step.target) : undefined;
    const target = scroll?.target ?? step.target;
    // An approximate capture also lists covered elements. That lowers Jev's confidence but not its choice, so its
    // pick is used when accepted and visible; a rejected or covered pick is picked again from an exact capture.
    for (let retargeted = false; ; retargeted = true) {
      const [resolved] = await this.find(candidateKind(step.kind), [target]);
      if (resolved.approximate && !retargeted && resolved.element === null) {
        this.retarget();
        continue;
      }
      if (resolved.element === null) return { step: stepLabel, status: 'inconclusive', detail: resolved.detail };
      const element = resolved.element;
      this.noteFill(step, element);
      try {
        if (scroll) {
          await this.timed('act', () => this.adapter.gesture('scroll', scroll.direction, element));
        } else {
          const value = step.kind === 'fill' ? step.value : undefined;
          await this.timed('act', () => this.adapter.act(step.kind as MobileAction, element, value));
        }
        return { step: stepLabel, status: 'pass', detail: resolved.detail };
      } catch (error) {
        if (retargeted || !(error instanceof HiddenTargetError)) throw error;
        // Jev accepted a covered element over a visible one. Logged: the approximate capture assumes this is rare.
        if (resolved.approximate) {
          console.error(`plain-mobile: accepted pick from an approximate capture was covered, picking again from the exact tree: ${target} ${resolved.detail}`);
        }
        this.retarget();
      }
    }
  }
}

export function runMobileSpec<T>(spec: MobileSpec, session: MobileSession<T>, observer?: SessionObserver, info?: SpecInfo, specTimeout?: number) {
  return runNativeSpec(spec, session as MobileSession, async (vars) => {
    const target = { platform: spec.platform, device: spec.device, app: spec.app, capabilities: spec.capabilities };
    const { steps, ...resolvedTarget } = interpolate({ ...target, steps: spec.steps }, vars, spec.name);
    await session.adapter.open(resolvedTarget);
    session.noteActivity();
    return steps;
  }, observer, info, specTimeout);
}
