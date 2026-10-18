import { homedir } from 'node:os';
import { join } from 'node:path';

export type Provider = 'typesafe' | 'gateway';

const KEY_BY_PROVIDER: Record<Provider, string> = { typesafe: 'TYPESAFE_API_KEY', gateway: 'AI_GATEWAY_API_KEY' };

/** Pinned, not `jev-latest`: the decision thresholds and the phrasing advice apply to this version. */
export const MODEL_BY_PROVIDER: Record<Provider, string> = {
  typesafe: 'jev-1.14.0',
  gateway: 'typesafe-ai/jev',
};

/** A key file outside any project: Codex starts plugin MCP servers without the shell environment. */
export const USER_ENV_FILE = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'plain', '.env');

/** Loads `.env` from the cwd, then the user file. A variable already in the environment is never overridden. */
export function loadEnvFiles(): void {
  for (const file of ['.env', USER_ENV_FILE]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Both files are optional.
    }
  }
}

/** The key of `chosen`, read on each call: the `.env` files load after the modules. */
export const apiKey = (chosen: Provider, env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env[KEY_BY_PROVIDER[chosen]];

export function selectProvider(env: NodeJS.ProcessEnv = process.env): Provider {
  const requested = env.JEV_PROVIDER;
  if (requested !== undefined) {
    if (requested !== 'typesafe' && requested !== 'gateway') {
      throw new Error(`JEV_PROVIDER must be "typesafe" or "gateway", got "${requested}".`);
    }
    if (!apiKey(requested, env)) {
      throw new Error(`JEV_PROVIDER=${requested} requires ${KEY_BY_PROVIDER[requested]} to be set.`);
    }
    return requested;
  }
  if (apiKey('typesafe', env)) return 'typesafe';
  if (apiKey('gateway', env)) return 'gateway';
  throw new Error(
    'Set TYPESAFE_API_KEY (TypeSafe direct) or AI_GATEWAY_API_KEY (Vercel AI Gateway) in the environment, ' +
      `in ${USER_ENV_FILE}, or in a .env file in the current directory.`
  );
}

let selected: Provider | undefined;

/** The provider of this process, chosen on first use: importing this module never needs a key. */
export function provider(): Provider {
  return (selected ??= selectProvider());
}
