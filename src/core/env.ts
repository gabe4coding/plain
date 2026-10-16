/**
 * The PLAIN_* switches, read on each call and never when a module loads: each CLI loads the `.env` files
 * (loadEnvFiles in src/jev/provider.ts) after its imports have run. scripts/source-rules/env.mjs keeps
 * `process.env` in this module and a few others.
 */
export const switchOn = (name: `PLAIN_${string}`): boolean => process.env[name] !== '0';
