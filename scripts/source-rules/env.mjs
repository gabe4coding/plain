// The CLIs load the `.env` files after their imports have run, so a value read from the environment while a module
// loads ignores them. Only the allowed modules touch `process.env`; everywhere else, the accessors they export are
// called on each use and never while the module loads, unless the module first calls `loadEnvFiles();` (imported from
// src/jev/provider.ts) at module scope, as the CLI entry modules do: the calls after it see the .env files. The rule
// finds the reads of `process.env` one line at a time, and the imports of `process` and the accessor calls with the
// TypeScript parser, so these pass it: an alias of `process` other than `= process` at the end of a line
// (`globalThis.process`, `process as T`), a computed key (`process[key]`), a dynamic `import('node:process')`, an
// accessor called through a local alias (`const on = switchOn`), with a computed name (`env['switchOn']()`), from a
// module function that is called while the module loads, or in a callback that runs at once but is no IIFE or array
// method callback (`Array.from(list, () => switchOn('PLAIN_X'))`), and every call in the allowed modules: the rule
// does not read them.
import ts from 'typescript';

/** `process.env`, `process?.env`, `process['env']`, `{ env } = process` (also its last line) or an alias. */
const ENV_READ = new RegExp([
  /\bprocess\s*(\??\.\s*env\b|(\?\.\s*)?\[\s*['"`]env['"`]\s*\])/,
  /(^|[^=!<>])=\s*process\s*;?\s*$/,
].map((part) => part.source).join('|'));
const PROCESS_MODULE = /^(node:)?process$/;
/** The accessors of the allowed modules that read the environment. */
const ACCESSORS = ['switchOn', 'apiKey', 'readEnabled', 'changesEnabled', 'changesNote', 'provider', 'selectProvider'];
/** The array methods that call their callback before they return. */
const CALLS_BACK = new Set(['every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'forEach',
  'map', 'reduce', 'reduceRight', 'some', 'sort', 'toSorted']);
const PROVIDER_MODULE = /(^|\/)jev\/provider\.js$/;
const COMMENT = /^\s*(\/\/|\/\*|\*)/;
const AT_LOAD = 'this runs when the module loads, before the CLIs load the .env files: call it inside a function';

/**
 * True when the function `node` runs where it stands: `(() => {...})()`, `(function () {...}).call(this)` or the
 * callback of an array method (`ALL.filter(() => ...)`). A generator body runs later, on `next()`.
 */
function runsAtOnce(node) {
  if ((!ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) || node.asteriskToken) return false;
  let outer = node;
  while (ts.isParenthesizedExpression(outer.parent)) outer = outer.parent;
  const { parent } = outer;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    return parent.expression === outer
      || (ts.isPropertyAccessExpression(parent.expression) && CALLS_BACK.has(parent.expression.name.text));
  }
  return ts.isPropertyAccessExpression(parent) && parent.expression === outer
    && (parent.name.text === 'call' || parent.name.text === 'apply')
    && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
}

/** True when `child` of `node` runs only when it is called: a function body or parameter, or an instance field. */
function runsLater(node, child) {
  if (ts.isFunctionLike(node) && !runsAtOnce(node)) return child === node.body || node.parameters.includes(child);
  if (ts.isPropertyDeclaration(node) && child === node.initializer) {
    return !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
  }
  return false;
}

/** True when the import `statement` of `process` brings in `env`, the whole module or its default export. */
function importsEnv(statement) {
  const clause = statement.importClause;
  if (!PROCESS_MODULE.test(statement.moduleSpecifier.text) || !clause || clause.isTypeOnly) return false;
  const bindings = clause.namedBindings;
  return Boolean(clause.name) || (bindings !== undefined && (ts.isNamespaceImport(bindings)
    || bindings.elements.some((element) => !element.isTypeOnly && (element.propertyName ?? element.name).text === 'env')));
}

/**
 * The lines of the module at `path` that import `env` from `process` (`imports`), and of the accessor calls that run
 * when the module loads, before it loads the .env files (`calls`).
 */
function parse(text, path) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  // `import { switchOn as on }` calls the accessor `on`, `import * as env` calls `env.switchOn`.
  const names = new Set(ACCESSORS);
  const namespaces = new Set();
  const loaders = new Set();
  const imports = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (importsEnv(statement)) imports.push(lineOf(statement));
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    for (const { name, propertyName } of bindings && ts.isNamedImports(bindings) ? bindings.elements : []) {
      const imported = (propertyName ?? name).text;
      if (ACCESSORS.includes(imported)) names.add(name.text);
      if (imported === 'loadEnvFiles' && PROVIDER_MODULE.test(statement.moduleSpecifier.text)) loaders.add(name.text);
    }
  }
  // A module that loads the .env files at module scope, as the CLI entry modules do: the calls after that see them.
  const loaded = file.statements.find((statement) => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression)
    && loaders.has(statement.expression.expression.text))?.end ?? Infinity;
  const isAccessor = (callee) => (ts.isIdentifier(callee) && names.has(callee.text))
    || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
      && namespaces.has(callee.expression.text) && ACCESSORS.includes(callee.name.text));
  const calls = [];
  const visit = (node, later) => {
    if (!later && node.pos < loaded && ts.isCallExpression(node) && isAccessor(node.expression)) {
      calls.push(lineOf(node.expression));
    }
    ts.forEachChild(node, (child) => visit(child, later || runsLater(node, child)));
  };
  visit(file, false);
  return { imports, calls };
}

/** Each environment read or import, and each accessor call that runs when the module loads. */
function check(text, path) {
  const { imports, calls: atLoad } = parse(text, path);
  const reads = [...new Set([...text.split('\n')
    .flatMap((line, i) => (!COMMENT.test(line) && ENV_READ.test(line) ? [i + 1] : [])), ...imports])];
  const calls = [...new Set(atLoad)].filter((line) => !reads.includes(line));
  return [...reads.map((line) => ({ line })), ...calls.map((line) => ({ line, message: AT_LOAD }))]
    .sort((a, b) => a.line - b.line);
}

const LOAD_ENV = "import { loadEnvFiles } from './jev/provider.js';\nloadEnvFiles();\n";

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
      { path: 'src/a.ts', text: 'const key = process?.env.KEY;' },
      { path: 'src/a.ts', text: "const key = process?.['env'].KEY;" },
      { path: 'src/a.ts', text: 'const {\n  env,\n} = process;' },
      { path: 'src/a.ts', text: "import { argv, env } from 'node:process';" },
      { path: 'src/a.ts', text: "import * as proc from 'process';" },
      { path: 'src/a.ts', text: "import proc from 'node:process';\nconst key = proc.env.KEY;" },
      { path: 'src/a.ts', text: "import proc, { argv } from 'process';" },
      { path: 'src/a.ts', text: "import {\n  argv,\n  env,\n} from 'node:process';" },
      { path: 'src/a.ts', text: "import proc\n  from 'node:process';" },
      { path: 'src/a.ts', text: "export const READ = readEnabled();" },
      { path: 'src/a.ts', text: "const DESCRIPTION = 'Runs steps.' +\n  changesNote().replace('the action', 'the batch');" },
      { path: 'src/a.ts', text: "if (switchOn('PLAIN_X')) register();" },
      { path: 'src/a.ts', text: 'export const P = provider();' },
      { path: 'src/a.ts', text: 'const chosen = selectProvider();' },
      { path: 'src/a.ts', text: "(() => {\n  if (switchOn('PLAIN_X')) register();\n})();" },
      { path: 'src/a.ts', text: "(function () {\n  if (switchOn('PLAIN_X')) register();\n})();" },
      { path: 'src/a.ts', text: "(function () {\n  if (switchOn('PLAIN_X')) register();\n}).call(this);" },
      { path: 'src/a.ts', text: 'export const TOOLS = ALL.filter((tool) => switchOn(tool.flag));' },
      { path: 'src/a.ts', text: "class Client {\n  static key = apiKey('typesafe');\n}" },
      { path: 'src/a.ts', text: "class Hooks {\n  static {\n    if (switchOn('PLAIN_X')) register();\n  }\n}" },
      { path: 'src/a.ts', text: 'const f = () => 1; export const R = readEnabled();' },
      { path: 'src/a.ts', text: "import { switchOn as on } from './env.js';\nexport const X = on('PLAIN_X');" },
      { path: 'src/a.ts', text: "import * as env from './env.js';\nexport const X = env.switchOn('PLAIN_X');" },
      { path: 'src/cli.ts', text: `const chosen = provider();\n${LOAD_ENV}` },
      { path: 'src/a.ts', text: "function loadEnvFiles() {}\nloadEnvFiles();\nexport const KEY = apiKey('typesafe');" },
    ],
    miss: [
      { path: 'src/a.ts', text: "export const readEnabled = (): boolean => switchOn('PLAIN_READ');" },
      { path: 'src/a.ts', text: "export const note = (): string => !changesEnabled() ? '' :\n  ' The result has `changed`.';" },
      { path: 'src/a.ts', text: "export function serve() {\n  if (readEnabled()) register();\n}" },
      { path: 'src/a.ts', text: "class Client {\n  key = apiKey('typesafe');\n  static get chosen() { return provider(); }\n}" },
      { path: 'src/a.ts', text: "const tools = { list() { return switchOn('PLAIN_X') ? [read] : []; } };" },
      { path: 'src/a.ts', text: "(async () => {\n  process.on('message', () => {\n    if (switchOn('PLAIN_X')) register();\n  });\n})();" },
      { path: 'src/a.ts', text: "const flags = (function* () {\n  yield switchOn('PLAIN_X');\n})();" },
      { path: 'src/a.ts', text: 'export const chosen = services.provider();\nconst same = value === process;' },
      { path: 'src/a.ts', text: "import { argv } from 'node:process';\nimport type Proc from './proc.js';" },
      { path: 'src/a.ts', text: "import type proc from 'node:process';\nimport {\n  argv,\n  type env,\n} from 'process';" },
      { path: 'src/cli.ts', text: `${LOAD_ENV}try {\n  const chosen = provider();\n} catch {}` },
      { path: 'src/a.ts', text: "const env = { ...base, PLAIN_READ: '0' };\nfunction run(env: NodeJS.ProcessEnv) {}" },
      { path: 'src/a.ts', text: '// reads process.env.VAR\nconst { envFile } = options;\nprocess.exitCode = 2;' },
    ],
  },
};
