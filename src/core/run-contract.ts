import type { Status, StepResult } from './results.js';
import type { LockAttempt } from './lock.js';

// What a spec run gives an engine and what the engine reports back: every engine imports it, and `src/suite/` adds
// the suite-level observer events on top.

export type Engine = 'browser' | 'desktop' | 'mobile';

export interface Artifact { kind: 'screenshot' | 'trace' | 'dump'; path: string; step?: number }

/**
 * What an observer can capture: a screenshot, and for the browser the page (for tracing). `P` is the page type, so
 * core needs no Playwright import.
 */
export interface CaptureTarget<P = unknown> {
  engine: Engine;
  /** An attached browser context: tracing would also record the user's other tabs. */
  cdp?: boolean;
  screenshot(file: string): Promise<void>;
  page?(): P;
}

export interface SpecInfo {
  file: string;
  name: string;
  tags: string[];
  attempt: number;
  /** This attempt's lock, from the suite; the engine takes it off before observers see the info. */
  lock?: LockAttempt;
}

/** The observer events an engine fires during one spec attempt. */
export interface SessionObserver<P = unknown> {
  /**
   * The target can be captured; fires before the first step. Browser: right after the context opens, before
   * setup. Desktop and mobile: after setup and `open()`, since setup may choose the app or the device. `stepEnd`
   * fires only after it, and `sessionClose` only when it fired.
   */
  sessionOpen?(event: SpecInfo & { target: CaptureTarget<P> }): Promise<void>;
  stepEnd?(event: SpecInfo & { index: number; result: StepResult; target: CaptureTarget<P> }): Promise<void>;
  sessionClose?(event: SpecInfo & { status: Status; target: CaptureTarget<P> }): Promise<Artifact[]>;
}
