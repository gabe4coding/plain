#!/usr/bin/env node
// Live end-to-end gate: the real CLI and the real MCP server, with real Jev picks and judgments, against the local
// site in e2e/site.mjs (no remote site, so a failure is plain's or Jev's, never the network's).
//
// 1. Specs: runs e2e/*.yaml in one suite run and checks each final status. A spec tagged `expect-fail` must end
//    `fail` (a pass there is a false pass); every other spec must pass. A pass on a retry counts, and is listed.
//    The specs run from a scratch copy of e2e/, in --mode judge: every pick and claim goes to Jev, and the lock
//    files land in the copy, never in the repository.
// 2. No-judge replay: the same copies run again in --mode no-judge on the locks the judge run wrote. No Jev call
//    may happen, every spec that passed in judge must pass, and no `expect-fail` spec may pass (a recorded state
//    must never turn a failure into a pass).
// 3. Agent path: an MCP session opens the login page, logs in with one `batch`, checks the result with `ask` and
//    `read`, saves the flow (the password as an env reference, never the literal) with its lock file, and the saved
//    spec must pass when the CLI runs it with that variable set: in no-judge on the saved lock, then in judge.
//
//   node scripts/e2e.mjs [--retries 1] [--only <substring of a spec file>] [--skip-mcp]
//
// Needs a Jev key and a build (npm run build). Exit 1 when any check fails.
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AUTH, startSite, USER } from '../e2e/site.mjs';

const { values } = parseArgs({ options: {
  retries: { type: 'string', default: '1' },
  only: { type: 'string' },
  'skip-mcp': { type: 'boolean', default: false },
} });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist/cli.js');
const scratch = mkdtempSync(join(tmpdir(), 'plain-e2e-'));
const problems = [];
const notes = [];

const site = await startSite();
const env = { ...process.env, PLAIN_E2E_SITE: site.url, PLAIN_E2E_AUTH_PASS: AUTH.pass };
// Async on purpose: the site is served from this process, so a sync child would block every request it makes.
// --mode judge unless a check says otherwise: every pick goes to Jev (a replayed locator would test the lock, not Jev).
const runCli = (args, extraEnv = {}, mode = 'judge') => new Promise((done, fail) => spawn(process.execPath,
  [cli, '--headless', '--mode', mode, ...args], { cwd: root, env: { ...env, ...extraEnv }, stdio: 'inherit' })
  .on('error', fail).on('exit', (code) => done(code)));
// The specs run from a copy, so the lock files the judge run writes stay out of the repository.
const specDir = join(scratch, 'e2e');
cpSync(join(root, 'e2e'), specDir, { recursive: true });

try {
  await checkSpecs();
  if (!values['skip-mcp']) await checkAgentPath(Number(values.retries) + 1);
} finally {
  await site.close();
  rmSync(scratch, { recursive: true, force: true });
}

for (const note of notes) console.log(`note: ${note}`);
if (problems.length) {
  console.error(`\nE2E FAILED:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nE2E passed.');

async function checkSpecs() {
  const files = readdirSync(specDir).filter((n) => n.endsWith('.yaml'))
    .filter((n) => !values.only || n.includes(values.only)).map((n) => join(specDir, n));
  if (!files.length) return void problems.push(`no e2e spec matches --only ${values.only}`);
  const reportFile = join(scratch, 'report.json');
  // The exit code is not the verdict: the expect-fail spec fails on purpose. The report is.
  await runCli(['--retries', values.retries, '--reporter', 'text', '--reporter', `json:${reportFile}`, ...files]);
  let report;
  try { report = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { return void problems.push('the suite run wrote no JSON report'); }
  for (const spec of report.specs) {
    const expected = spec.tags.includes('expect-fail') ? 'fail' : 'pass';
    const error = spec.loadError ?? spec.attempts.at(-1)?.error;
    if (spec.status !== expected || (expected === 'fail' && spec.flaky)) {
      problems.push(`${spec.file}: expected ${expected}, got ${spec.flaky ? 'pass on a retry' : spec.status}${error ? ` (${error})` : ''}`);
    } else if (spec.flaky) {
      notes.push(`${spec.file} passed only on a retry (flaky): look at its first attempt`);
    }
  }
  console.log(`specs: ${report.specs.length}, jev calls ${report.totals.jevCalls}, tokens ${report.totals.tokens}` +
    ` (all attempts: with --retries ${values.retries}, a spec that does not pass runs again)`);
  await checkNoJudge(files, report);
}

async function checkNoJudge(files, judged) {
  const reportFile = join(scratch, 'no-judge.json');
  await runCli(['--reporter', 'text', '--reporter', `json:${reportFile}`, ...files], {}, 'no-judge');
  let report;
  try { report = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { return void problems.push('the no-judge run wrote no JSON report'); }
  if (report.totals.jevCalls !== 0) problems.push(`no-judge made ${report.totals.jevCalls} Jev calls; it must make none`);
  const passedInJudge = new Set(judged.specs.filter((spec) => spec.status === 'pass').map((spec) => spec.file));
  const missed = [];
  for (const spec of report.specs) {
    if (spec.tags.includes('expect-fail')) {
      if (spec.status === 'pass') problems.push(`${spec.file}: expect-fail spec passed in no-judge (false pass)`);
    } else if (passedInJudge.has(spec.file) && spec.status !== 'pass') {
      const step = spec.attempts.at(-1)?.steps.find((s) => s.status !== 'pass' && s.status !== 'skipped');
      missed.push(`${spec.file.split('/').pop()}: ${step ? `${step.step} — ${step.detail}` : spec.status}`);
    }
  }
  const replayable = [...passedInJudge].filter((file) => !report.specs.find((s) => s.file === file)?.tags.includes('expect-fail'));
  console.log(`no-judge: ${replayable.length - missed.length}/${replayable.length} specs replayed with no Jev call, ` +
    `${report.totals.replayed} steps replayed`);
  for (const miss of missed) problems.push(`no-judge did not replay ${miss}`);
}

async function checkAgentPath(attempts) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const failure = await agentSession(join(scratch, `recorded-${attempt}.yaml`)).catch((error) => String(error));
    if (!failure) {
      if (attempt > 1) notes.push('the MCP session passed only on a retry (flaky)');
      return;
    }
    console.error(`MCP session attempt ${attempt} failed: ${failure}`);
    if (attempt === attempts) problems.push(`MCP session: ${failure}`);
  }
}

/** One agent-style session; resolves to undefined when every check holds, else to what went wrong. */
async function agentSession(saved) {
  const client = new Client({ name: 'plain-e2e', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, '--headless', 'mcp'], env, stderr: 'inherit' }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name} returned an error: ${result.content[0]?.text}`);
    return result.structuredContent;
  };
  try {
    await call('open', { url: `${site.url}/login`, goal: 'log in as the test user' });
    const batch = await call('batch', { steps: [
      { fill: { target: 'the Username field', value: USER.name } },
      { fill: { target: 'the Password field', value: USER.pass } },
      { click: 'the Login button' },
    ] });
    if (batch.status !== 'pass') return `batch ended ${batch.status} at step ${batch.stoppedAt}: ${JSON.stringify(batch.results.at(-1))}`;
    const asked = await call('ask', { claims: ['the Secure Area heading is shown', 'the login form is shown'] });
    const answers = asked.answers.map((a) => a.answer).join(',');
    if (answers !== 'yes,no') return `ask answered ${answers}, expected yes,no: ${JSON.stringify(asked.answers)}`;
    const claim = await call('step', { step: { expect: 'the Secure Area heading is shown' } });
    if (claim.status !== 'pass') return `expect ended ${claim.status}: ${claim.detail}`;
    const read = await call('read', { question: 'What does the status message say?' });
    if (!/logged into a secure area/i.test(JSON.stringify(read))) return `read did not return the status message: ${JSON.stringify(read)}`;
    const save = await call('save', { path: saved, name: 'recorded login' });
    if (readFileSync(saved, 'utf8').includes(USER.pass) || save.env?.password !== '$PASSWORD') {
      return `save wrote the password, not an env reference: ${JSON.stringify(save)}`;
    }
    if (!save.lock || readFileSync(save.lock, 'utf8').includes(USER.pass)) return `save wrote no lock file, or one with the password: ${JSON.stringify(save)}`;
    await call('open', { url: `${site.url}/boxes` }); // after save: not part of the replayed spec
    const { aria } = await call('snapshot', {});
    if (!aria.includes('- /url: https://ads.example/aclk…') || aria.includes('Xy7Xy7')) return `snapshot did not cut the long ad link: ${aria}`;
    await call('open', { url: `${site.url}/spatial` });
    const spatial = await call('ask', { claims: ['the button on the left is B and the button on the right is A',
      'the button on the left is A and the button on the right is B'] });
    const spatialAnswers = spatial.answers.map((answer) => answer.answer).join(',');
    if (spatialAnswers !== 'yes,no') return `spatial ask answered ${spatialAnswers}, expected yes,no`;
  } finally {
    await client.close();
  }
  const replayed = await runCli(['--reporter', 'text', saved], { PASSWORD: USER.pass }, 'no-judge');
  if (replayed !== 0) return `the saved spec did not pass in no-judge on its saved lock (exit ${replayed})`;
  const code = await runCli(['--reporter', 'text', saved], { PASSWORD: USER.pass });
  return code === 0 ? undefined : `the saved spec did not pass on replay (exit ${code})`;
}
