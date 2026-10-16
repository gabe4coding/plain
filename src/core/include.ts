import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { errorMessage } from './error-message.js';

/**
 * Where an expanded step was written: its file (relative to the root spec's folder; undefined for the root spec
 * itself) and its index in that file. A symbol key, so the step's own keys stay as written.
 */
const SOURCE = Symbol('plain.include.source');
interface Source { file?: string; index: number }

/** Takes the source off an expanded step, for the loader's error messages. */
export function splitSource(step: unknown): { step: unknown; source?: Source } {
  if (step === null || typeof step !== 'object' || !(SOURCE in step)) return { step };
  const { [SOURCE]: source, ...rest } = step as Record<string | symbol, unknown>;
  return { step: rest, source: source as Source };
}

/**
 * Replaces each `include: <file>` step with the steps of that file, recursively, before validation. A path is
 * relative to the file that names it. A flow holds only `steps:`, so its placeholders resolve against the root
 * spec's env and hooks data.
 */
export function expandIncludes(rawSteps: unknown[], file: string): unknown[] {
  const root = resolve(file);
  const folder = dirname(root);
  const relativeName = (path: string) => relative(folder, path).split(sep).join('/');
  const invalid = (path: string, message: string) => new Error(`invalid spec: ${relativeName(path)}: ${message}`);

  function expand(steps: unknown[], fromFile: string, chain: string[]): unknown[] {
    return steps.flatMap((step, index): unknown[] => {
      if (step === null || typeof step !== 'object' || Array.isArray(step)) return [step];
      const mapping = step as Record<string, unknown>;
      if ('origin' in mapping) throw invalid(fromFile, 'origin: reserved for included steps');
      if ('at' in mapping) throw invalid(fromFile, "at: reserved for the loader (the step source that lock files key on)");
      const location: Source = { file: fromFile === root ? undefined : relativeName(fromFile), index };
      if (!('include' in mapping)) {
        const origin = fromFile === root ? {} : { origin: relativeName(fromFile) };
        return [{ ...mapping, ...origin, [SOURCE]: location }];
      }
      const included = includedFile(mapping, fromFile);
      if (chain.some((file) => sameFile(file, included))) {
        throw new Error(`invalid spec: include cycle: ${[...chain, included].map(relativeName).join(' → ')}`);
      }
      return expand(readFlow(included), included, [...chain, included]);
    });
  }

  function includedFile(mapping: Record<string, unknown>, fromFile: string): string {
    if (mapping.optional === true) throw invalid(fromFile, 'optional: true on include is not supported in v1');
    for (const key of Object.keys(mapping)) {
      if (key !== 'include' && key !== 'optional') throw invalid(fromFile, `include has unexpected key "${key}"`);
    }
    if (typeof mapping.include !== 'string' || !mapping.include.trim()) throw invalid(fromFile, 'include must be a non-empty path');
    return resolve(dirname(fromFile), mapping.include);
  }

  function readFlow(file: string): unknown[] {
    let raw: unknown;
    try {
      raw = parse(readFileSync(file, 'utf8'));
    } catch (error) {
      throw invalid(file, errorMessage(error));
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(file, 'included file must contain only steps:');
    const flow = raw as Record<string, unknown>;
    for (const key of Object.keys(flow)) {
      if (key !== 'steps') throw invalid(file, `included file has unexpected key "${key}" (only steps: is allowed)`);
    }
    if (!Array.isArray(flow.steps)) throw invalid(file, 'steps must be an array');
    return flow.steps;
  }

  return expand(rawSteps, root, [root]);
}

/** Real paths also catch cycles through symlinks. A file that does not exist (a unit test's root) is its own identity. */
function sameFile(a: string, b: string): boolean {
  const identity = (file: string) => {
    try {
      return realpathSync(file);
    } catch {
      return file;
    }
  };
  return identity(a) === identity(b);
}
