import type { Page } from 'playwright';
import type { Status, TestResult } from '../core/results.js';
import type { LoadOptions } from '../core/spec.js';
import type { RunMode } from '../core/lock.js';
import type { Artifact, Engine, SessionObserver, SpecInfo } from '../core/run-contract.js';

export type StopReason = 'bail' | 'max-tokens';
export const CAPTURE_MODES = ['off', 'on-failure', 'always'] as const;
export type CaptureMode = typeof CAPTURE_MODES[number];

/** One execution of one spec. */
export interface Attempt extends TestResult {
  attempt: number;
  durationMs: number;
  artifacts: Artifact[];
  /** `${error}` when `engine.run` threw (hooks module missing, browser launch failed...): no steps ran. */
  error?: string;
}

export interface SpecReport {
  file: string;
  name: string;
  tags: string[];
  status: Status;
  /** Passed on a retry; counts as a pass. */
  flaky: boolean;
  attempts: Attempt[];
  loadError?: string;
  skipReason?: StopReason;
}

export interface RunReport {
  engine: Engine;
  provider: string;
  model: string;
  startedAt: string;
  durationMs: number;
  specs: SpecReport[];
  totals: { jevCalls: number; tokens: number; passed: number; failed: number; flaky: number; skipped: number; replayed: number; healed: number };
  stopped?: StopReason;
  status: RunStatus;
}

/** A run passes only when every spec passed. */
export type RunStatus = Extract<Status, 'pass' | 'fail'>;

/** The engine's session events, with the browser page typed for tracing, plus the suite's run and spec events. */
export interface RunObserver extends SessionObserver<Page> {
  runStart?(event: { engine: Engine; specs: { file: string; name: string; tags: string[] }[] }): Promise<void>;
  specEnd?(event: { report: SpecReport }): Promise<void>;
  runEnd?(event: { report: RunReport }): Promise<void>;
}

/** What each engine gives the shared suite runner. */
export interface SuiteEngine<S> {
  engine: Engine;
  load(file: string, opts?: LoadOptions): S;
  meta(spec: S): { name: string; tags: string[]; timeoutMs?: number };
  run(spec: S, observer: RunObserver | undefined, info: SpecInfo): Promise<TestResult>;
  maxWorkers: number;
  close?(): Promise<void>;
}

export interface Loaded<S> { file: string; spec: S; name: string; tags: string[]; timeoutMs?: number }

export interface ReporterSpec { name: string; output?: string }

export interface SuiteOptions {
  files: string[];
  workers: number;
  retries: number;
  bail: number;
  lastFailed: boolean;
  maxTokens?: number;
  grep?: string;
  grepInvert?: string;
  tags: string[];
  list: boolean;
  reporters: ReporterSpec[];
  timing: boolean;
  artifacts?: { dir: string; screenshot: CaptureMode; trace: CaptureMode };
  specTimeout?: number;
  /** judge, no-judge or auto-healing (src/core/lock.ts). */
  mode?: RunMode;
}

export type EngineFlags = Record<string, string | boolean | undefined>;
