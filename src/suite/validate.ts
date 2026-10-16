import { errorMessage } from '../core/results.js';
import type { SuiteEngine } from './types.js';

export interface ValidationResult { file: string; error?: string; warnings: string[] }

/**
 * Loads each file (includes expanded, schemas checked) and checks its placeholders, without a key, a session or the
 * hooks module. An absent `$VAR` leaf is a warning here, where a run fails on it. A literal credential (a secret
 * `fill` value, `auth` or `env` key) is a warning too: a run uses it, but it belongs in the environment.
 */
export function validate<S>(engine: SuiteEngine<S>, files: string[]): ValidationResult[] {
  return files.map((file) => {
    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    try {
      const spec = engine.load(file, { onMissingEnv: warn, onLiteralSecret: warn });
      checkPlaceholders(spec);
      return { file, warnings };
    } catch (error) {
      return { file, error: errorMessage(error), warnings };
    }
  });
}

/** `validate` for the CLIs: ✔ / ✘ / ! lines on stdout. Returns the exit code. */
export function printValidation<S>(engine: SuiteEngine<S>, files: string[]): number {
  const results = validate(engine, files);
  const output = formatValidation(results);
  if (output) console.log(output);
  return results.some((result) => result.error) ? 1 : 0;
}

export function formatValidation(results: ValidationResult[]): string {
  return results.flatMap(({ file, error, warnings }) => [
    error === undefined ? `✔ ${file}` : `✘ ${file}: ${error}`,
    ...warnings.map((warning) => `! ${file}: ${warning}`),
  ]).join('\n');
}

/**
 * Checks every field the runners interpolate (browser `url`, desktop `app`, the mobile target, the steps).
 * `${hooks.*}` is known only after setup runs; `${env.*}` must name a leaf of the env block.
 */
function checkPlaceholders(spec: unknown): void {
  if (spec === null || typeof spec !== 'object') return;
  const { url, steps, env, app, platform, device, capabilities } = spec as Record<string, unknown>;
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{([^}]+)\}/g)) checkPlaceholder(match[1], env);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === 'object') {
      // A step's `at` is its source path, never interpolated.
      for (const [key, child] of Object.entries(value)) if (!(key === 'at' && 'kind' in value)) visit(child);
    }
  };
  for (const field of [url, app, platform, device, capabilities, steps]) visit(field);
}

function checkPlaceholder(expression: string, env: unknown): void {
  const [namespace, ...keys] = expression.split('.');
  if (namespace === 'hooks') return;
  if (namespace !== 'env') throw new Error(`\${${expression}} uses an unknown namespace (use \${env.*} or \${hooks.*})`);
  let leaf: unknown = env;
  for (const key of keys) {
    if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf) || !Object.hasOwn(leaf, key)) {
      leaf = undefined;
      break;
    }
    leaf = (leaf as Record<string, unknown>)[key];
  }
  if (leaf === undefined || leaf === null || typeof leaf === 'object') {
    throw new Error(`\${${expression}} is not defined (use \${env.*} from the spec's env block)`);
  }
}
