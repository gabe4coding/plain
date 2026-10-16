// Checks the source files against the rules in scripts/source-rules/: each rule turns a coding standard that a
// writer can break with no compiler error into a failing check. One rule per file, `<name>.mjs`, so two pull
// requests that add rules never edit the same list. A rule module default-exports:
//   name     the rule id: the file name without `.mjs`, the prefix of each problem and the key in baseline.json
//   files    a RegExp that a repo-relative path must match
//   skip     a RegExp of paths to leave out; the default leaves out tests, `null` keeps them
//   allow    path prefixes where a hit is allowed: the rule's own allowlist, visible in review
//   pattern  a RegExp tested on each code line (a line that is only a JS comment is not code); or
//   check    (text, path) => [{ line, message? }], for what one line cannot show
//   message  what to do instead, shown after each hit that gives no message of its own
//   ratchet  true: the hits are counted against scripts/source-rules/baseline.json; more hits than the baseline
//            fail, fewer print the new baseline to commit
// The RegExps take no `g` or `y` flag: those make `test` keep state between lines. The files are the tracked ones
// and the untracked ones git does not ignore, so a new file is checked before `git add`; a symbolic link is not
// checked, its target is. The rule files themselves are never checked: they hold the patterns they look for.
//   node scripts/check-source.mjs              # this checkout
//   node scripts/check-source.mjs --root <dir> # another checkout
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const RULES_DIR = 'scripts/source-rules';
export const BASELINE_FILE = `${RULES_DIR}/baseline.json`;
const TEST_FILE = /\.test\.[cm]?[jt]s$/;
// `//`, a `/*` closed with nothing after it or left open, a `*` or `*/` that continues a block comment. A `*` with
// no space after it is a generator method.
const COMMENT_LINE = /^\s*(\/\/|\/\*(?!.*\*\/\s*\S)|\*(\s|\/|$))/;
const STATEFUL_FLAGS = /[gy]/;

/** True when `rule` checks the file at `path`. */
export function applies(rule, path) {
  const skip = rule.skip === undefined ? TEST_FILE : rule.skip;
  if (path.startsWith(`${RULES_DIR}/`) || !rule.files.test(path) || skip?.test(path)) return false;
  return !(rule.allow ?? []).some((prefix) => path.startsWith(prefix));
}

/** The hits of `rule` in one file, as { line, message }. */
export function ruleHits(rule, path, text) {
  if (rule.check) {
    return rule.check(text, path).map((hit) => ({ line: hit.line, message: hit.message ?? rule.message }));
  }
  return text.split('\n').flatMap((code, i) =>
    !COMMENT_LINE.test(code) && rule.pattern.test(code) ? [{ line: i + 1, message: rule.message }] : []);
}

/** What is wrong with the rule exported by `file` (a file name in RULES_DIR), or null. */
export function ruleProblem(rule, file) {
  const regExps = [rule?.files, rule?.skip, rule?.pattern].filter((value) => value instanceof RegExp);
  if (rule?.name !== basename(file, '.mjs')) return `name must be "${basename(file, '.mjs')}", the file name`;
  if (!(rule.files instanceof RegExp)) return 'files must be a RegExp';
  if (rule.skip != null && !(rule.skip instanceof RegExp)) return 'skip must be a RegExp or null';
  if (rule.allow !== undefined && !(Array.isArray(rule.allow) && rule.allow.every((p) => typeof p === 'string'))) {
    return 'allow must be an array of path prefixes';
  }
  if ((rule.pattern instanceof RegExp) === (typeof rule.check === 'function')) {
    return 'needs pattern (a RegExp) or check (a function), not both';
  }
  if (typeof rule.message !== 'string') return 'needs message';
  if (regExps.some((regExp) => STATEFUL_FLAGS.test(regExp.flags))) return 'a RegExp must not have the g or y flag';
  return null;
}

/**
 * The problems (each `path:line: [rule] message`) and the notes of `rules` over `files`. `read(path)` gives a file's
 * text; `baseline` maps each ratchet rule to its allowed hit count.
 */
export function evaluate(rules, files, read, baseline) {
  const problems = [];
  const notes = [];
  for (const rule of rules) {
    const hits = files.filter((path) => applies(rule, path)).flatMap((path) =>
      ruleHits(rule, path, read(path)).map(({ line, message }) => `${path}:${line}: [${rule.name}] ${message}`));
    if (!rule.ratchet) {
      problems.push(...hits);
      continue;
    }
    const allowed = baseline[rule.name];
    if (allowed === undefined) {
      problems.push(`${BASELINE_FILE}: [${rule.name}] no baseline: add "${rule.name}": ${hits.length}`);
    } else if (hits.length > allowed) {
      problems.push(...hits, `${BASELINE_FILE}: [${rule.name}] ${hits.length} hits, baseline ${allowed}: `
        + 'remove the new hit, do not raise the baseline');
    } else if (hits.length < allowed) {
      notes.push(`[${rule.name}] ${hits.length} hits, baseline ${allowed}: set "${rule.name}": ${hits.length} `
        + `in ${BASELINE_FILE}`);
    }
  }
  const names = new Set(rules.filter((rule) => rule.ratchet).map((rule) => rule.name));
  for (const name of Object.keys(baseline).filter((key) => !names.has(key))) {
    problems.push(`${BASELINE_FILE}: [${name}] no ratchet rule has this name: remove it`);
  }
  return { problems, notes };
}

/** The rule modules of `root`, sorted by file name. */
async function loadRules(root) {
  const dir = join(root, RULES_DIR);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort();
  return Promise.all(files.map(async (name) => {
    const rule = (await import(pathToFileURL(join(dir, name)).href)).default;
    const problem = ruleProblem(rule, name);
    if (problem) throw new Error(`${RULES_DIR}/${name}: ${problem}`);
    return rule;
  }));
}

async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' } } });
  const root = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const listed = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' });
  // A deleted file stays listed until it is staged, a submodule is listed as a folder, and a symbolic link (the
  // AGENTS.md notes) would count its target's hits twice.
  const files = [...new Set(listed.split('\0'))]
    .filter((path) => path && lstatSync(join(root, path), { throwIfNoEntry: false })?.isFile()).sort();
  const baselinePath = join(root, BASELINE_FILE);
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
  const rules = await loadRules(root);
  const texts = new Map();
  const read = (path) => {
    if (!texts.has(path)) texts.set(path, readFileSync(join(root, path), 'utf8'));
    return texts.get(path);
  };
  const { problems, notes } = evaluate(rules, files, read, baseline);

  for (const note of notes) console.log(note);
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} problem(s). Each rule and its reason is in ${RULES_DIR}/.`);
    process.exit(1);
  }
  console.log(`source rules ok: ${rules.length} rule(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
