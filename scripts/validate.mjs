#!/usr/bin/env node
// The validation loop every change goes through before a pull request (skill: .claude/skills/validating-changes,
// also .agents/skills/ for Codex). It runs the gates in order and stops at the first failure:
//   1. npm run verify          key-free: build (strict tsc), tests, docs, source rules, examples, plugin install smoke
//   2. node scripts/e2e.mjs    live Jev, local site: specs with expected statuses, MCP record and replay
//   3. claims eval --gate      live Jev, saved pages: false passes must stay 0
//   4. agent evals             real claude -p and codex exec runs; only when the MCP tools, their results or the
//                              browser skill changed (--agents on|off forces it)
//   5. routing evals           fresh claude -p and codex exec agents must find the rules behind the routes of the
//                              agent notes; only when a note, a skill or the eval changed (--routing on|off forces it)
// Then it lists the area evals the changed files call for, which need a judgment (compare with main), and writes
// the stamp scripts/pr-gate.mjs checks. Live steps need a Jev key; agent and routing evals need the claude and codex
// CLIs. The full output also goes to a file, and the end repeats each check's result lines (test counts, e2e
// totals, retry notes, false passes, agent runs passed) and the file's path.
//
//   node scripts/validate.mjs [--base origin/main] [--agents auto|on|off] [--routing auto|on|off]
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { workingTree, writeStamp } from './validation-stamp.mjs';

const { values } = parseArgs({ options: {
  base: { type: 'string', default: 'origin/main' },
  agents: { type: 'string', default: 'auto' },
  routing: { type: 'string', default: 'auto' },
} });
if (!['auto', 'on', 'off'].includes(values.agents)) throw new Error('--agents must be auto, on or off');
if (!['auto', 'on', 'off'].includes(values.routing)) throw new Error('--routing must be auto, on or off');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// What an agent sees of the browser engine: tool shapes, results and the skill that teaches them.
const AGENT_SURFACE = [/^src\/browser\/mcp\.ts$/, /^src\/core\/(mcp-result|read|aria-changes|snapshot-view)\.ts$/,
  /^plugins\/plain\/skills\//];
// What an agent reads to find a rule: the agent notes (CLAUDE.md, also AGENTS.md, at any depth), the skills of this
// repo, and the routing eval itself.
const NOTES_SURFACE = [/(^|\/)(CLAUDE|AGENTS)\.md$/, /^CODING_STANDARDS\.md$/, /^\.(claude|agents)\/skills\//,
  /^scripts\/(routing-cases\.json|eval-routing\.mjs|agent-cli\.mjs)$/];
// Area evals: a change here can make Jev's answers or the step time worse without failing a gate. Each hint says
// how its two runs (main, then the branch) are compared: only some scripts take --compare.
const AREA_EVALS = [
  [/^src\/(jev\/(pick|describe|ask)|browser\/(candidates|locate)|core\/automation)\.ts$/,
    'node scripts/benchmark-picks.mjs --runs 3 --out <file>   (no --compare: diff the two files; picks must not get worse)'],
  [/^src\/(jev\/(judge|decide|ask)|browser\/(judge-page|page)|core\/automation)\.ts$/,
    'node scripts/benchmark-claims.mjs --runs 3   (--out on main, --compare on the branch: false passes 0, no new false fails)'],
  [/^src\/core\/read\.ts$/, 'node scripts/benchmark-read.mjs --runs 2 --smart --out <file>   (no --compare: diff the two files)'],
  [/^src\/(core\/lock|browser\/(record-locator|locate)|native\/session)\.ts$/,
    'node scripts/benchmark-locators.mjs --out <file>   (no --compare: coverage must not drop; wrong hits must stay 0)'],
  [/^src\/computer\/planner\.ts$/,
    'node scripts/benchmark-planner.mjs --runs 3   (--out on main, --compare on the branch; change only when it improves)'],
  [/^src\/browser\/(activity|settled-ask|steps|session|runner)\.ts$/,
    'node scripts/benchmark-steps.mjs --e2e --mode judge --runs 3   (--out on main, --compare on the branch; ' +
    'local site; step overhead must not grow)'],
  [/^src\/core\/snapshot-view\.ts$/, 'node scripts/benchmark-snapshots.mjs   (no --out: compare the two printed results)'],
  [/^src\/(computer|native)\//, 'npm run test:computer:mac   (on macOS; permissions: docs/development.mdx, "Desktop on macOS")'],
  [/^src\/(mobile|native)\//, 'npm run test:mobile:android and npm run test:mobile:ios   ' +
    '(device, Appium and env vars: docs/development.mdx, "Verification")'],
  [/^examples\/[^/]+\.yaml$/, 'node dist/cli.js --headless <scratch copy of examples>/<each changed example>   ' +
    '(live demo sites; a run writes a lock file next to the spec)'],
];

function changedFiles() {
  const base = git(['merge-base', values.base, 'HEAD']);
  const committed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n');
  const working = git(['status', '--porcelain', '--untracked-files=all']).split('\n').map((line) => line.slice(3).split(' -> ').at(-1));
  return [...new Set([...committed, ...working])].filter(Boolean);
}

// The lines that hold a check's result: node --test counts (TAP or spec reporter), the doc and example checks, the
// suite totals, e2e totals and retry notes, the claims gate, and the agent and routing eval tallies.
const RESULT_LINE = new RegExp('^(?:[#ℹ] (?:tests|pass|fail) \\d+|docs ok:|agent notes ok:|All examples validate|' +
  '\\d+ (?:example )?problem\\(s\\)|\\d+ passed, \\d+ failed|specs: \\d+|no-judge: \\d+/\\d+ specs|note: |E2E (?:passed|FAILED)|' +
  'claims: \\d+|FALSE PASS|GATE FAILED|\\d+/\\d+ (?:agent|routing) runs passed|(?:Answers and t|T)ranscripts of the failed runs)');
const ANSI = /\x1b\[[0-9;]*m/g;
const logFile = join(mkdtempSync(join(tmpdir(), 'plain-validate-')), 'output.txt');
const log = createWriteStream(logFile);
const results = [];

function run(label, command, args) {
  const header = `\n=== ${label}: ${command} ${args.join(' ')}`;
  console.log(header);
  log.write(`${header}\n`);
  const kept = [];
  results.push([label, kept]);
  const keep = (text) => kept.push(...text.split('\n').map((line) => line.replace(ANSI, '').trim()).filter((line) => RESULT_LINE.test(line)));
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: root, stdio: ['inherit', 'pipe', 'pipe'] });
    for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let partial = '';
      from.setEncoding('utf8');
      from.on('data', (chunk) => {
        to.write(chunk);
        log.write(chunk);
        const lines = (partial + chunk).split('\n');
        partial = lines.pop();
        keep(lines.join('\n'));
      });
      from.on('end', () => keep(partial));
    }
    child.on('close', (code) => done(code === 0));
  });
}

/** Each check that ran, with its result lines, and where the full output is. */
async function report() {
  console.log(`\nResults:\n${results.map(([label, kept]) => `  ${label}\n${kept.map((line) => `    ${line}`).join('\n') ||
    '    (no result line)'}`).join('\n')}\nFull output: ${logFile}`);
  await new Promise((closed) => log.end(closed));
}

const changed = changedFiles();
const touches = (surface) => changed.some((f) => surface.some((re) => re.test(f)));
const agentEvals = values.agents === 'on' || (values.agents === 'auto' && touches(AGENT_SURFACE));
const routingEvals = values.routing === 'on' || (values.routing === 'auto' && touches(NOTES_SURFACE));
const steps = [
  ['key-free gate', 'npm', ['run', 'verify']],
  ['live e2e', process.execPath, ['scripts/e2e.mjs']],
  ['claims gate', process.execPath, ['scripts/benchmark-claims.mjs', '--gate']],
  ...(agentEvals ? [['agent evals', process.execPath, ['scripts/eval-agent.mjs']]] : []),
  ...(routingEvals ? [['routing evals', process.execPath, ['scripts/eval-routing.mjs']]] : []),
];
for (const [label, command, args] of steps) {
  if (!(await run(label, command, args))) {
    console.error(`\nVALIDATION FAILED at "${label}". Fix the cause; do not weaken the check. No stamp written.`);
    await report();
    process.exit(1);
  }
}

const areaEvals = AREA_EVALS.filter(([re]) => changed.some((f) => re.test(f))).map(([, how]) => how);
writeStamp(workingTree(), { base: values.base, ran: steps.map(([label]) => label), areaEvals });
console.log(`\nVALIDATION PASSED: ${steps.map(([label]) => label).join(', ')}.` +
  (agentEvals ? '' : ' Agent evals not needed: no MCP tool, result or browser skill change.') +
  (routingEvals ? '' : ' Routing evals not needed: no agent note change.'));
await report();
if (areaEvals.length) console.log(`\nArea evals still to run and compare (the skill says how):\n${areaEvals.map((how) => `  - ${how}`).join('\n')}`);
console.log('\nThen finish the review steps of the validating-changes skill. The stamp covers the current files: ' +
  'if you change a file after this, run this again before the pull request.');
