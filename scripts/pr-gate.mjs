#!/usr/bin/env node
// PreToolUse hook (Claude Code .claude/settings.json, Codex .codex/hooks.json): blocks `gh pr create` unless
// scripts/validate.mjs passed on exactly the files of HEAD. Every other command passes through untouched.
// Exit 2 with a reason on stderr is the block signal both agents understand.
//
// The hook checks the checkout the command runs in, not its own working directory: in a git worktree, Claude Code
// runs the hook from the main checkout. That checkout is the hook input's `cwd` (sent by Claude Code and Codex),
// then a `workdir` in the tool input when there is one, then each `cd <dir> &&` before `gh pr create`.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commonDir, headTree, readStamp } from './validation-stamp.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
let hook;
try { hook = JSON.parse(input); } catch { process.exit(0); }
const command = String(hook?.tool_input?.command ?? '');
const create = command.search(/\bgh\s+pr\s+create\b/);
if (create < 0) process.exit(0);

const dir = targetDir();
const repo = (path) => realpathSync(commonDir(path));
let tree, stamp;
try {
  // A pull request of another repository is not this gate's business.
  if (repo(dir) !== repo(dirname(dirname(fileURLToPath(import.meta.url))))) process.exit(0);
  tree = headTree(dir);
  stamp = readStamp(dir);
} catch {
  console.error(`Blocked: ${dir} is not a git checkout, so the validation stamp cannot be checked. Run gh pr create ` +
    'from the worktree of the branch.');
  process.exit(2);
}
if (stamp?.tree === tree) process.exit(0);
console.error(stamp
  ? `Blocked: HEAD's files changed since the last passing validation (${stamp.at}). Run the validating-changes skill ` +
    '(node scripts/validate.mjs) on the committed files, then open the pull request.'
  : `Blocked: no passing validation for this worktree (${dir}). Run the validating-changes skill ` +
    '(node scripts/validate.mjs) before you open a pull request. The gate checks the checkout the command runs ' +
    'in, not the --head branch: if the branch was validated in another worktree, run `cd <that worktree> && ' +
    'gh pr create` there.');
process.exit(2);

function targetDir() {
  let at = resolve(String(hook.cwd ?? process.cwd()), String(hook.tool_input?.workdir ?? '.'));
  const cd = /(?:^|&&|;)\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))\s*(?=&&|;)/g;
  for (const m of command.slice(0, create).matchAll(cd)) {
    at = resolve(at, (m[1] ?? m[2] ?? m[3]).replace(/^~(?=\/|$)/, homedir()));
  }
  return at;
}
