// Integration test of the pre-PR hook: a throwaway repository with a linked worktree, the hook run from the main
// checkout (as Claude Code runs it in a worktree session) with the hook input pointing at the worktree.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t',
  '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', env }).trim();

let root, main, worktree, other;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plain-pr-gate-')));
  main = join(root, 'main');
  worktree = join(main, '.claude', 'worktrees', 'feature');
  other = join(root, 'other');
  mkdirSync(join(main, 'scripts'), { recursive: true });
  for (const file of ['pr-gate.mjs', 'validation-stamp.mjs']) copyFileSync(join(here, file), join(main, 'scripts', file));
  writeFileSync(join(main, '.gitignore'), '.claude/\n');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  writeFileSync(join(worktree, 'change.txt'), 'x\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'change');
  stamp(worktree);
  mkdirSync(other);
  git(other, 'init', '-q');
});

after(() => rmSync(root, { recursive: true, force: true }));

/** Record a passing validation of HEAD's files in the checkout's own git dir. */
function stamp(dir) {
  const file = git(dir, 'rev-parse', '--path-format=absolute', '--git-path', 'plain-validated.json');
  writeFileSync(file, JSON.stringify({ tree: git(dir, 'rev-parse', 'HEAD^{tree}'), at: 'now' }));
}

/** Run the main checkout's hook from `processCwd`, as Claude Code and Codex do, and return its exit code and stderr. */
function gate(input, processCwd = main) {
  const run = spawnSync(process.execPath, [join(main, 'scripts', 'pr-gate.mjs')],
    { cwd: processCwd, input: JSON.stringify(input), encoding: 'utf8', env });
  return { code: run.status, stderr: run.stderr };
}

const create = { command: 'gh pr create --fill' };

test('passes a validated worktree although the hook runs in the main checkout', () => {
  assert.deepEqual(gate({ cwd: worktree, tool_input: create }), { code: 0, stderr: '' });
});

test('checks the input cwd, not the process cwd', () => {
  const { code, stderr } = gate({ cwd: main, tool_input: create }, worktree);
  assert.equal(code, 2);
  assert.match(stderr, /no passing validation for this worktree/);
  assert.match(stderr, /cd <that worktree> && gh pr create/);
});

test('follows each cd before the command, and a workdir, to the worktree', () => {
  assert.equal(gate({ cwd: main, tool_input: { command: 'git status && cd .claude/worktrees/feature && gh pr create' } })
    .code, 0);
  assert.equal(gate({ cwd: main, tool_input: { command: 'cd .claude/worktrees/feature && gh pr create' } }).code, 0);
  assert.equal(gate({ cwd: main, tool_input: { command: `cd "${worktree}"; gh pr create` } }).code, 0);
  assert.equal(gate({ cwd: main, tool_input: { ...create, workdir: worktree } }).code, 0);
  assert.equal(gate({ cwd: worktree, tool_input: { command: `cd ${main} && gh pr create` } }).code, 2);
});

test('blocks a worktree whose HEAD changed after the validation', () => {
  writeFileSync(join(worktree, 'late.txt'), 'y\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'late');
  try {
    const { code, stderr } = gate({ cwd: worktree, tool_input: create });
    assert.equal(code, 2);
    assert.match(stderr, /changed since the last passing validation/);
  } finally {
    git(worktree, 'reset', '-q', '--hard', 'HEAD~1');
  }
});

test('ignores other commands and other repositories, and blocks outside a checkout', () => {
  assert.equal(gate({ cwd: main, tool_input: { command: 'gh pr view' } }).code, 0);
  assert.equal(gate({ cwd: other, tool_input: create }).code, 0);
  const { code, stderr } = gate({ cwd: join(root, 'missing'), tool_input: create });
  assert.equal(code, 2);
  assert.match(stderr, /is not a git checkout/);
});
