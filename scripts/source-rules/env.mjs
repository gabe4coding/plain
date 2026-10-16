// The CLIs load the `.env` files after their imports have run, so a value read from the environment while a module
// loads ignores them. Only the allowed modules touch `process.env`; everywhere else, the accessors they export are
// called on each use and never while the module loads.

/** `process.env`, `process['env']`, `{ env } = process` (also its last line), an alias or an import of it. */
const ENV_READ = /\bprocess\s*(\.\s*env\b|\[\s*['"`]env['"`]\s*\])|=\s*process\s*;?\s*$|(\{[^}]*\benv\b[^}]*\}|\*\s+as\s+\w+)\s+from\s+['"](node:)?process['"]/;
/** The accessors of the allowed modules that read the environment. */
const ACCESSOR_CALL = /\b(switchOn|apiKey|readEnabled|changesEnabled|changesNote)\s*\(/;
const COMMENT = /^\s*(\/\/|\/\*|\*)/;
/** A module-scope statement whose body runs later, when it is called. */
const DEFINITION = /^(export\s+)?(default\s+)?(declare\s+)?(async\s+)?(function|class|interface|type|enum|import)\b/;
const AT_LOAD = 'this runs when the module loads, before the CLIs load the .env files: call it inside a function';

/** Each environment read, and each accessor call in a module-scope statement outside a function. */
function check(text) {
  const hits = [];
  let deferred = true;
  text.split('\n').forEach((line, i) => {
    if (COMMENT.test(line)) return;
    // A line at column 0 starts the next module-scope statement; one that starts with a closing bracket ends one.
    if (/^[^\s}\])]/.test(line)) deferred = DEFINITION.test(line);
    if (ENV_READ.test(line)) {
      hits.push({ line: i + 1 });
    } else if (!deferred && ACCESSOR_CALL.test(line.split(/=>|\bfunction\b/)[0])) {
      hits.push({ line: i + 1, message: AT_LOAD });
    }
    if (/=>|\bfunction\b/.test(line)) deferred = true;
  });
  return hits;
}

export default {
  name: 'env',
  files: /^src\/.*\.ts$/,
  allow: [
    'src/core/env.ts', // the PLAIN_* switches
    'src/jev/provider.ts', // the .env files, the provider and its keys
    'src/core/spec.ts', // `$VAR` in a spec
    'src/suite/options.ts', // the PLAIN_* flag fallbacks
    'src/mobile/discovery.ts', // the Android SDK path
  ],
  check,
  message: 'read the environment through src/core/env.ts (switchOn) or src/jev/provider.ts (apiKey), on each call, '
    + 'or get it as an argument: the CLIs load the .env files after the modules load. A module that must read '
    + 'process.env itself goes in the allow list of scripts/source-rules/env.mjs, with its reason',
  examples: {
    hit: [
      { path: 'src/core/read.ts', text: "export const READ_ENABLED = process.env.PLAIN_READ !== '0';" },
      { path: 'src/jev/ask.ts', text: 'function client() {\n  return new Client({ apiKey: process.env.KEY });\n}' },
      { path: 'src/a.ts', text: "const key = process['env'].KEY;" },
      { path: 'src/a.ts', text: 'const {\n  env,\n} = process;' },
      { path: 'src/a.ts', text: "import { argv, env } from 'node:process';" },
      { path: 'src/a.ts', text: "import * as proc from 'process';" },
      { path: 'src/a.ts', text: "export const READ = readEnabled();" },
      { path: 'src/a.ts', text: "const DESCRIPTION = 'Runs steps.' +\n  changesNote().replace('the action', 'the batch');" },
      { path: 'src/a.ts', text: "if (switchOn('PLAIN_X')) register();" },
    ],
    miss: [
      { path: 'src/a.ts', text: "export const readEnabled = (): boolean => switchOn('PLAIN_READ');" },
      { path: 'src/a.ts', text: "export const note = (): string => !changesEnabled() ? '' :\n  ' The result has `changed`.';" },
      { path: 'src/a.ts', text: "export function serve() {\n  if (readEnabled()) register();\n}" },
      { path: 'src/a.ts', text: "class Client {\n  key = apiKey('typesafe');\n}" },
      { path: 'src/a.ts', text: "const env = { ...base, PLAIN_READ: '0' };\nfunction run(env: NodeJS.ProcessEnv) {}" },
      { path: 'src/a.ts', text: '// reads process.env.VAR\nconst { envFile } = options;\nprocess.exitCode = 2;' },
    ],
  },
};
