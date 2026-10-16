import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { DUMP_DIR, errorMessage, isFailure } from '../core/results.js';
import type { Artifact, CaptureTarget, Engine, SpecInfo } from '../core/run-contract.js';
import type { RunObserver, SuiteOptions } from './types.js';

interface Capture {
  dir: string;
  artifacts: Artifact[];
  dumps: { source: string; step: number }[];
  tracing?: BrowserContext['tracing'];
}

const MARKER = '.plain-results';
/** Stays below common file name limits, with room for a suffix. */
const MAX_SLUG = 180;

const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Makes `root` ours: never a folder that holds the project (the cwd or a parent, home, the filesystem root, or one
 * with a spec in it), never one plain did not create. Then deletes only what an earlier run made: spec folders
 * that hold nothing but attempt-N folders.
 */
function prepareResultsFolder(root: string, cwd: string, specFiles: string[]): void {
  if (root === path.parse(root).root || root === os.homedir() || isInside(cwd, root)) {
    throw new Error(`${root} cannot hold artifacts: it is the working folder, one of its parents, the home folder or the filesystem root`);
  }
  const spec = specFiles.find((file) => isInside(path.resolve(cwd, file), root));
  if (spec) throw new Error(`${root} cannot hold artifacts: it contains the spec ${spec}`);
  const marker = path.join(root, MARKER);
  if (fs.existsSync(root)) {
    const owned = fs.existsSync(marker) && fs.lstatSync(marker).isFile();
    if (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory() || (!owned && fs.readdirSync(root).length)) {
      throw new Error(`${root} exists and was not created by plain`);
    }
    if (owned) {
      for (const entry of fs.readdirSync(root)) {
        const folder = path.join(root, entry);
        if (!fs.lstatSync(folder).isDirectory()) continue;
        const isAttempt = (child: string) => /^attempt-\d+$/.test(child) && fs.lstatSync(path.join(folder, child)).isDirectory();
        const onlyAttempts = fs.readdirSync(folder).every(isAttempt);
        if (onlyAttempts) fs.rmSync(folder, { recursive: true, force: true });
      }
    }
  } else {
    fs.mkdirSync(root, { recursive: true });
  }
  fs.writeFileSync(marker, 'plain results\n');
}

/**
 * Captures failure-step screenshots, a final screenshot, browser traces and copies of Jev dumps into one folder per
 * spec and attempt. `engine` lets the suite reject native tracing before a session opens.
 */
export function artifactsObserver(opts: SuiteOptions, engine?: Engine): RunObserver | null {
  const settings = opts.artifacts;
  if (!settings) return null;
  const checkEngine = (runEngine: Engine): void => {
    if (runEngine !== 'browser' && settings.trace !== 'off') throw new Error('--trace is browser-only; use --trace off for desktop or mobile artifacts');
  };
  if (engine) checkEngine(engine);
  const cwd = process.cwd();
  const root = path.resolve(cwd, settings.dir);
  const captures = new WeakMap<CaptureTarget<Page>, Capture>();
  const slugByFile = new Map<string, string>();
  const usedSlugs = new Set<string>();
  const usedAttempts = new Set<string>();
  let ready = false;
  let warned = false;
  let cdpNoted = false;
  const warn = (error: unknown): void => {
    if (warned) return;
    warned = true;
    console.error(`plain: artifacts: ${errorMessage(error)}`);
  };
  const slugFor = (file: string): string => {
    const relative = path.relative(cwd, path.resolve(cwd, file));
    const existing = slugByFile.get(relative);
    if (existing) return existing;
    const cleaned = relative.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, MAX_SLUG);
    const base = !cleaned || cleaned === '.' || cleaned === '..' ? 'spec' : cleaned;
    let slug = base;
    // Case-insensitive: on APFS and NTFS `X/Login.yaml` and `x-login.yaml` would share one folder.
    for (let n = 2; usedSlugs.has(slug.toLowerCase()); n++) slug = `${base}-${n}`;
    usedSlugs.add(slug.toLowerCase());
    slugByFile.set(relative, slug);
    return slug;
  };
  const captureFor = (info: SpecInfo): Capture => {
    const slug = slugFor(info.file);
    let dir = path.join(root, slug, `attempt-${info.attempt}`);
    // The same path given twice can run the same attempt concurrently.
    for (let n = 2; usedAttempts.has(dir); n++) dir = path.join(root, `${slug}-duplicate-${n}`, `attempt-${info.attempt}`);
    usedAttempts.add(dir);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, artifacts: [], dumps: [] };
  };
  const saveArtifact = async (capture: Capture, artifact: Artifact, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
      capture.artifacts.push(artifact);
    } catch (error) {
      warn(error);
      try {
        fs.rmSync(artifact.path, { force: true }); // a failed capture may have left a partial file
      } catch {
        // best effort
      }
    }
  };
  return {
    async runStart(event) {
      ready = false;
      checkEngine(event.engine);
      slugByFile.clear();
      usedSlugs.clear();
      usedAttempts.clear();
      warned = false;
      cdpNoted = false;
      prepareResultsFolder(root, cwd, event.specs.map(({ file }) => file));
      for (const spec of event.specs) slugFor(spec.file);
      ready = true;
    },
    async sessionOpen(event) {
      if (!ready) return;
      let capture: Capture;
      try {
        capture = captureFor(event);
      } catch (error) {
        warn(error);
        return;
      }
      captures.set(event.target, capture);
      if (settings.trace === 'off' || event.target.engine !== 'browser') return;
      if (event.target.cdp) {
        if (!cdpNoted) {
          cdpNoted = true;
          console.error('plain: artifacts: tracing skipped for --cdp (attached browser tabs)');
        }
        return;
      }
      try {
        const tracing = event.target.page!().context().tracing;
        await tracing.start({ screenshots: true, snapshots: true, sources: false });
        capture.tracing = tracing;
      } catch (error) {
        warn(error);
      }
    },
    async stepEnd(event) {
      const capture = captures.get(event.target);
      if (!ready || !capture) return;
      // Every labelled dump in the detail: `state: <file>` (claims), `candidates: <file>` (picks), `layout: <file>`
      // (spatial targets).
      for (const match of (event.result.detail ?? '').matchAll(/\b[a-z]+:\s+(.+?\.json)(?=\s*(?:\||—|$))/g)) {
        const source = match[1];
        if (path.isAbsolute(source) && path.dirname(source) === DUMP_DIR)
          capture.dumps.push({ source, step: event.index });
      }
      const failed = isFailure(event.result.status);
      // Step screenshots are for failures only, even with `always`: a shot per step would slow every step.
      if (settings.screenshot !== 'off' && failed) {
        const file = path.join(capture.dir, `step-${event.index}-${event.result.status}.png`);
        await saveArtifact(capture, { kind: 'screenshot', path: file, step: event.index }, () => event.target.screenshot(file));
      }
    },
    async sessionClose(event) {
      const capture = captures.get(event.target);
      if (!ready || !capture) return [];
      captures.delete(event.target);
      if (settings.screenshot === 'always') {
        const file = path.join(capture.dir, 'final.png');
        await saveArtifact(capture, { kind: 'screenshot', path: file }, () => event.target.screenshot(file));
      }
      if (capture.tracing) {
        const tracing = capture.tracing;
        if (settings.trace === 'always' || event.status !== 'pass') {
          const file = path.join(capture.dir, 'trace.zip');
          await saveArtifact(capture, { kind: 'trace', path: file }, () => tracing.stop({ path: file }));
        } else {
          try {
            await tracing.stop();
          } catch (error) {
            warn(error);
          }
        }
      }
      const copied = new Set<string>();
      for (const { source, step } of capture.dumps) {
        const file = path.join(capture.dir, `step-${step}-${path.basename(source)}`);
        if (copied.has(file)) continue;
        copied.add(file);
        await saveArtifact(capture, { kind: 'dump', path: file, step }, async () => { fs.copyFileSync(source, file); });
      }
      try {
        if (!fs.readdirSync(capture.dir).length) {
          fs.rmdirSync(capture.dir);
          const specDir = path.dirname(capture.dir);
          if (!fs.readdirSync(specDir).length) fs.rmdirSync(specDir);
        }
      } catch (error) {
        warn(error);
      }
      return capture.artifacts;
    },
  };
}
