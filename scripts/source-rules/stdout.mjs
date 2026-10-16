// stdout is the MCP JSON-RPC channel in agent mode and the jsonl report in a run: one stray line corrupts it, and
// MCP hosts drop it with no error. Only the reporters and the CLI commands that print a result write to stdout. A
// child process can write to it too: a fork inherits stdout unless it gets `stdio` or `silent` on the same line, and
// a spawn inherits it with `'inherit'` or fd 1 as its stdout. The rule reads one line at a time, so these pass it:
// an alias (`const log = console.log`, `const { log } = console`, `const { stdout } = process` or `node:process`), a
// write to fd 1 (`fs.writeSync(1, ...)`, `/dev/stdout`), a `stdio` array on more than one line, and the dependencies.
const STDOUT_METHOD = 'log|info|debug|dir|dirxml|table|group|groupCollapsed|count|timeLog|timeEnd';

export default {
  name: 'stdout',
  files: /^(src|bin)\/.*\.[cm]?[jt]s$/,
  allow: [
    'src/suite/reporters/text.ts', // the text reporter
    'src/suite/reporters/jsonl.ts', // the jsonl reporter
    'src/suite/select.ts', // --list
    'src/suite/validate.ts', // validate
    'src/computer/cli.ts', // plan and do
  ],
  pattern: new RegExp([
    // console.log(, console.log (, console?.log(, console.info?.(, console['log'](
    new RegExp(`\\bconsole\\s*(\\??\\.\\s*(${STDOUT_METHOD})\\b|\\[\\s*['"\`](${STDOUT_METHOD})['"\`]\\s*\\])\\s*(\\?\\.)?\\s*\\(`),
    /\bprocess\.stdout\b(?!\.(isTTY|columns|rows)\b)/,
    /\bfork\((?!.*\b(stdio|silent)\b)/,
    /\bstdio:\s*(['"]inherit['"]|\[\s*[^,\]]+,\s*(['"]inherit['"]|1\b))/,
  ].map((part) => part.source).join('|')),
  message: 'stdout carries the MCP messages and the jsonl report: log with console.error, and send the stdout of a '
    + "child process to stderr: { stdio: ['ignore', 2, 2] }, plus 'ipc' for a fork",
  examples: {
    hit: [
      "console.log('opened', app);",
      'console.info(`setup done`);',
      'console.debug(state);',
      "console.log ('opened');",
      "console?.log('opened');",
      'console.info?.(state);',
      "console['log']('opened');",
      'console[`table`](rows);',
      "process.stdout.write(line + '\\n');",
      'child.stdout.pipe(process.stdout);',
      'const child = fork(path, [file]);',
      "spawn('npx', args, { stdio: 'inherit' });",
      "fork(path, [file], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });",
      "spawn('adb', args, { stdio: ['ignore', 'inherit', 2] });",
      "spawn('adb', args, { stdio: [0, 1, 2] });",
    ],
    miss: [
      "console.error('opened', app);",
      "console.warn('deprecated');",
      "console['error']('opened');",
      'console?.error?.(state);',
      "process.stderr.write(line + '\\n');",
      'if (process.stdout.isTTY) color = true;',
      "const child = fork(path, [file], { stdio: ['ignore', 2, 2, 'ipc'] });",
      'const child = fork(path, [file], { silent: true });',
      "spawn('npx', args, { stdio: ['pipe', 'pipe', 'inherit'] });",
      "spawnSync(node, args, { stdio: ['ignore', 2, 2] });",
      'const logs = catalog.log(entry);',
    ],
  },
};
