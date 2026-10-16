import { interpolate } from '../core/interpolate.js';
import type { Step } from '../core/spec.js';
import { label, type StepResult } from '../core/results.js';
import { NativeSession } from '../native/session.js';
import { runNativeSpec } from '../native/run-spec.js';
import type { SessionObserver, SpecInfo } from '../core/run-contract.js';
import { parseComputerStep, type ComputerSpec } from './spec.js';
import type { ComputerAction, ComputerAdapter, ComputerKind } from './adapter.js';

const BROWSER_ONLY = new Set(['goto', 'select', 'upload']);
const SCROLL_DIRECTION = /^(up|down):\s*/;
const SCROLL_LINES = 3;

/** The candidates a desktop step picks from. */
function candidateKind(kind: Step['kind']): ComputerKind {
  if (kind === 'fill') return 'fill';
  if (kind === 'check' || kind === 'uncheck') return 'check';
  if (kind === 'scroll' || kind === 'hover') return kind;
  return 'click';
}

export class ComputerSession<T = unknown> extends NativeSession<T, ComputerKind, Step, ComputerAdapter<T>> {
  parse(raw: unknown) { return parseComputerStep(raw); }
  label(step: Step) { return label(step); }

  protected async act(step: Step, stepLabel: string): Promise<StepResult> {
    if (step.kind === 'press') {
      await this.timed('act', () => this.adapter.press(step.key));
      return { step: stepLabel, status: 'pass' };
    }
    if (step.kind === 'mouse') {
      await this.timed('act', () => this.adapter.mouse(step.x, step.y));
      return { step: stepLabel, status: 'pass' };
    }
    if (step.kind === 'drag') {
      const [source, target] = await this.find('click', [step.source, step.target]);
      if (source.element === null || target.element === null) {
        return { step: stepLabel, status: 'inconclusive', detail: `${source.detail} → ${target.detail}` };
      }
      const [from, to] = [source.element, target.element];
      await this.timed('act', () => this.adapter.drag(from, to));
      return { step: stepLabel, status: 'pass' };
    }
    if (!('target' in step) || BROWSER_ONLY.has(step.kind)) throw new Error(`${step.kind} is browser-only`);

    // `scroll: "down: the list"`: the direction prefix is not part of the target.
    const target = step.kind === 'scroll' ? step.target.replace(SCROLL_DIRECTION, '') : step.target;
    const [resolved] = await this.find(candidateKind(step.kind), [target]);
    if (resolved.element === null) return { step: stepLabel, status: 'inconclusive', detail: resolved.detail };
    const element = resolved.element;
    const value = step.kind === 'fill' ? step.value
      : step.kind === 'scroll' ? String(step.target.startsWith('up:') ? -SCROLL_LINES : SCROLL_LINES)
        : undefined;
    const action = step.kind as ComputerAction;
    this.noteFill(step, element);
    await this.timed('act', () => this.adapter.act(action, element, value));
    return { step: stepLabel, status: 'pass', detail: resolved.detail };
  }
}

export function runComputerSpec<T>(spec: ComputerSpec, session: ComputerSession<T>, observer?: SessionObserver, info?: SpecInfo, specTimeout?: number) {
  return runNativeSpec(spec, session as ComputerSession, async (vars) => {
    const resolved = interpolate({ app: spec.app, steps: spec.steps }, vars, spec.name);
    await session.adapter.open({ app: resolved.app }, true);
    return resolved.steps;
  }, observer, info, specTimeout);
}
