import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StepSource } from './spec.js';
import { DUMP_DIR, errorMessage, type StepResult } from './results.js';

/*
 * Run modes and lock files (docs/running.mdx "Run modes"). A passing run records what each step needed from Jev:
 * the locator of every picked element, and for every claim a hash of the state Jev judged true. One sidecar per
 * source file (`login.yaml` → `login.lock.json`), committed next to the specs.
 *   judge         Jev picks and judges every step; a passing attempt writes the lock.
 *   no-judge      no Jev call: a pick replays its locator, a claim passes only on its recorded state. A miss is
 *                 inconclusive. Never writes.
 *   auto-healing  a pick replays its locator; Jev picks when the locator misses or the step fails with it, and the
 *                 healed locator is written when the attempt passes. Jev judges every claim.
 * The lock holds no secret and no run data: a claim keeps a hash only, and every value a run filled in is written
 * back as its placeholder (src/core/parameters.ts), in keys, locators and the hashed states alike.
 */
export const LOCK_VERSION = 2;
/** A version 1 file still has the same locators. Its claim hashes predate the uncut-tree hash. */
const READABLE_LOCK_VERSIONS = new Set([1, LOCK_VERSION]);
export const LOCK_UPGRADE_NOTICE = 're-record to upgrade lock file';
export const RUN_MODES = ['judge', 'no-judge', 'auto-healing'] as const;
export type RunMode = typeof RUN_MODES[number];

/** What identifies one entry: the step's source and kind, and which of its descriptions (a target or the claims). */
export interface LockRef { at: StepSource; kind: string; slot: string }

/**
 * An element: an engine's locator (src/browser/record-locator.ts) and its readable form. `layout`: a spatial
 * target ("the button on the left") holds only while the layout it was picked from has the same relations
 * (`layoutRelations` in src/core/layout.ts).
 * `marginal`: Jev picked it below the recording confidence; no-judge replays it, auto-healing asks Jev again.
 */
export interface TargetEntry { locator: unknown; text: string; layout?: string; marginal?: true }
/** A claim that passed: the state Jev judged, hashed, and whether the judgment saw rendered geometry. */
export interface ClaimEntry { state: string; spatial: boolean }
export type LockEntry = TargetEntry | ClaimEntry;

export const isTargetEntry = (entry: LockEntry): entry is TargetEntry => 'locator' in entry;

/**
 * Replaying a decision in later runs needs more certainty than acting once (0.5): a pick below this is recorded as
 * marginal, so auto-healing asks Jev again each run; no-judge, with no Jev, replays it. The score is the
 * confidence, or the probability without one.
 */
export const RECORD_AT = 0.9;


export const lockPath = (file: string): string => {
  const { dir, name } = path.parse(file);
  return path.join(dir, `${name}.lock.json`);
};
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const targetSlot = (target: string): string => `target:${target}`;
/** The claims of an `expect` or the condition of a `wait`, with the region they are scoped to. */
export const claimSlot = (claims: string[], within?: string): string =>
  `claims:${JSON.stringify(within === undefined ? claims : [claims, within])}`;

/** `[index, kind, slot]` as JSON. The slot holds placeholders, not values: one entry per step whatever the data. */
export const entryKey = (ref: LockRef): string => JSON.stringify([ref.at.index, ref.kind, ref.slot]);

const isEntry = (value: unknown): value is LockEntry => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return ('locator' in entry && typeof entry.text === 'string') ||
    (typeof entry.state === 'string' && typeof entry.spatial === 'boolean');
};

/** The entries of a sidecar, or null when it is unreadable or of another version. Version 1 is readable. */
export function parseLock(text: string): { entries: Map<string, LockEntry>; version: number } | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (raw === null || typeof raw !== 'object') return null;
  const file = raw as Record<string, unknown>;
  if (typeof file.version !== 'number' || !READABLE_LOCK_VERSIONS.has(file.version) ||
    file.entries === null || typeof file.entries !== 'object' || Array.isArray(file.entries)) return null;
  const out = new Map<string, LockEntry>();
  for (const [key, value] of Object.entries(file.entries)) if (isEntry(value)) out.set(key, value);
  return { entries: out, version: file.version };
}

const indexOf = (key: string): number => {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === 'number' ? parsed[0] : -1;
  } catch {
    return -1;
  }
};

/** Deterministic sidecar text: entries in step order, 2-space JSON, trailing newline, no timestamps. */
export function formatLock(entries: Map<string, LockEntry>): string {
  const keys = [...entries.keys()].sort((a, b) => indexOf(a) - indexOf(b) || (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({ version: LOCK_VERSION, entries: Object.fromEntries(keys.map((key) => [key, entries.get(key)])) }, null, 2) + '\n';
}

export interface LockIO {
  read(file: string): string | undefined;
  write(file: string, text: string): void;
}
const fileIO: LockIO = {
  read: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  write: (file, text) => fs.writeFileSync(file, text),
};

interface Sidecar { entries: Map<string, LockEntry>; version: number; dirty: boolean }

/** One per run: every sidecar read once, changed in memory as attempts pass, written once by write(). */
export class LockStore {
  private files = new Map<string, Sidecar>();
  constructor(readonly mode: RunMode, private io: LockIO = fileIO) {}

  private sidecar(source: string): Sidecar {
    const file = lockPath(source);
    let sidecar = this.files.get(file);
    if (!sidecar) {
      const text = this.io.read(file);
      const parsed = text === undefined ? null : parseLock(text);
      sidecar = { entries: parsed?.entries ?? new Map(), version: parsed?.version ?? LOCK_VERSION, dirty: false };
      this.files.set(file, sidecar);
      if (parsed?.version === 1) console.error(`plain: ${LOCK_UPGRADE_NOTICE}: ${file}`);
    }
    return sidecar;
  }

  get(ref: LockRef): LockEntry | undefined {
    return this.sidecar(ref.at.file).entries.get(entryKey(ref));
  }

  versionOf(source: string): number {
    return this.sidecar(source).version;
  }

  set(ref: LockRef, entry: LockEntry): void {
    const sidecar = this.sidecar(ref.at.file);
    const key = entryKey(ref);
    const old = sidecar.entries.get(key);
    if (old && JSON.stringify(old) === JSON.stringify(entry)) return;
    sidecar.entries.set(key, entry);
    sidecar.dirty = true;
  }

  /**
   * A handle for one attempt of one spec. An auto-healing retry asks Jev for every target and records again: the
   * attempt before it failed, perhaps on a replayed element that acted but was wrong.
   */
  attempt(attempt = 0): LockAttempt {
    return new LockAttempt(this, this.mode, this.mode === 'no-judge' || (this.mode === 'auto-healing' && attempt === 0));
  }

  /** Writes every changed sidecar; returns those files. Two processes writing one sidecar: the last one wins. */
  write(): string[] {
    if (this.mode === 'no-judge') return [];
    const done: string[] = [];
    for (const [file, sidecar] of [...this.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!sidecar.dirty) continue;
      try {
        this.io.write(file, formatLock(sidecar.entries));
        done.push(file);
        sidecar.dirty = false;
      } catch (error) {
        console.error(`plain: lock: ${file}: ${errorMessage(error)}`);
      }
    }
    return done;
  }
}

interface Pending { ref: LockRef; entry: LockEntry }

/**
 * One attempt of one spec. A step records what it used with record(); endStep() keeps the records of a passing
 * step; finish() writes them to the store when the whole attempt passed (judge and auto-healing only).
 */
export class LockAttempt {
  private kept: Pending[] = [];
  private step: Pending[] = [];
  private closed = false;
  replayed = 0;
  healed = 0;

  /** `replays`: steps replay recorded entries (no-judge, and the first attempt in auto-healing). */
  constructor(private store: LockStore, readonly mode: RunMode, readonly replays: boolean) {}

  /** Whether Jev may be asked (judge, auto-healing). */
  get judges(): boolean { return this.mode !== 'no-judge'; }

  lookup(ref: LockRef): LockEntry | undefined {
    return this.replays && !this.closed ? this.store.get(ref) : undefined;
  }

  /** Version 1 claim hashes are not comparable with the uncut-tree hash. A miss is judged again. */
  staleClaims(source: string): boolean {
    return this.replays && !this.closed && this.store.versionOf(source) === 1;
  }

  /** What Jev decided in this step, kept if the step and the attempt pass. */
  record(ref: LockRef, entry: LockEntry): void {
    if (this.judges && !this.closed) this.step.push({ ref, entry });
  }

  /** The records of the passed steps so far: what MCP `save` writes. */
  get recorded(): readonly { ref: LockRef; entry: LockEntry }[] { return this.kept; }

  /** Drops this step's records: the step runs again (a heal). */
  restartStep(): void {
    this.step = [];
  }

  /** Ends a step: its records are kept when it passed; replayed and healed steps are counted. */
  endStep(result: Pick<StepResult, 'status' | 'replayed' | 'healed'>): void {
    if (result.status === 'pass') this.kept.push(...this.step);
    this.step = [];
    if (result.status === 'pass' && result.healed) this.healed++;
    else if (result.replayed) this.replayed++;
  }

  finish(passed: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (passed && this.judges) for (const { ref, entry } of this.kept) this.store.set(ref, entry);
  }
}

/**
 * The text of a recorded passing state, kept on this machine only (the debug folder, never the lock file), so a
 * no-judge claim that misses can name both states: what was recorded, and what it saw.
 */
export const recordedStatePath = (state: string): string => path.join(DUMP_DIR, 'lock-states', `${state}.json`);

export function saveRecordedState(state: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(recordedStatePath(state)), { recursive: true });
    fs.writeFileSync(recordedStatePath(state), JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`plain: lock: cannot save a recorded state: ${errorMessage(error)}`);
  }
}

/** ` — recorded: <file>` when this machine recorded the state, else ''. */
export const recordedStateNote = (state: string): string =>
  fs.existsSync(recordedStatePath(state)) ? ` — recorded: ${recordedStatePath(state)}` : '';
