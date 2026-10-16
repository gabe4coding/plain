// Checks the source files against the rules in scripts/source-rules/: each rule turns a coding standard that a
// writer can break with no compiler error into a failing check. One rule per file, `<name>.mjs`, so two pull
// requests that add rules never edit the same list. A rule module default-exports these keys and no others:
//   name      the rule id: the file name without `.mjs`, the prefix of each problem and the key in baseline.json
//   files     a RegExp that a repo-relative path must match
//   skip      optional: a RegExp of more paths to leave out; test files are always left out, unless `tests`
//   tests     optional: true also checks the test files
//   allow     optional: where a hit is allowed, each an exact file path or a folder ending in `/`: the rule's own
//             allowlist, visible in review. An entry that names no file the rule checks fails
//   pattern   a RegExp tested on each line (in a JS or TS file, a line that is only a comment is not code); or
//   check     (text, path) => [{ line, message? }], for what one line cannot show
//   message   what to do instead, shown after each hit that gives no message of its own
//   ratchet   optional: true counts the hits against the rule's whole number in scripts/source-rules/baseline.json;
//             more hits than the baseline fail, fewer print the new baseline to commit
//   examples  { hit: [...], miss: [...] }, neither empty: lines for a pattern rule, { path, text } for a check
//             rule. Each hit example must hit and each miss example must not, so a rule that can no longer find
//             its violation fails instead of passing in silence
// A rule that checks no file fails too. The RegExps take no `g` or `y` flag: those make `test` keep state between
// lines. The files are the tracked ones and the untracked ones git does not ignore, so a new file is checked before
// `git add`; a symbolic link is not checked, its target is. The rule files themselves are never checked: they hold
// the patterns they look for. scripts/source-rules/ holds only rule files and baseline.json.
//   node scripts/check-source.mjs              # this checkout
//   node scripts/check-source.mjs --root <dir> # another checkout
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const RULES_DIR = 'scripts/source-rules';
export const BASELINE_FILE = `${RULES_DIR}/baseline.json`;
const RULE_KEYS = new Set(['name', 'files', 'skip', 'tests', 'allow', 'pattern', 'check', 'message', 'ratchet',
  'examples']);
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const JS_FILE = /\.[cm]?[jt]sx?$/;
// `//`, a `/*` closed with nothing after it or left open, a `*` or `*/` that continues a block comment. A `*` with
// no space after it is a generator method.
const COMMENT_LINE = /^\s*(\/\/|\/\*(?!.*\*\/\s*\S)|\*(\s|\/|$))/;
const STATEFUL_FLAGS = /[gy]/;

/** The text of a thrown value: a rule's check can throw anything. */
const textOf = (error) => (error instanceof Error ? error.message : String(error));

/** True when `entry` of a rule's allow list covers the file at `path`. */
const allows = (entry, path) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry);

/** True when `rule` looks at the file at `path`, before its allow list. */
function inScope(rule, path) {
  if (path.startsWith(`${RULES_DIR}/`) || !rule.files.test(path)) return false;
  return (rule.tests || !TEST_FILE.test(path)) && !rule.skip?.test(path);
}

/** True when `rule` checks the file at `path`. */
export function applies(rule, path) {
  return inScope(rule, path) && !(rule.allow ?? []).some((entry) => allows(entry, path));
}

/** The hits of `rule` in one file, as { line, message }. Throws when a check gives a malformed result. */
export function ruleHits(rule, path, text) {
  if (rule.check) {
    let hits;
    try {
      hits = rule.check(text, path);
    } catch (error) {
      throw new Error(`check on ${path} threw: ${textOf(error)}`);
    }
    if (!Array.isArray(hits) || !hits.every((hit) => Number.isInteger(hit?.line) && hit.line > 0
      && (hit.message === undefined || typeof hit.message === 'string'))) {
      throw new Error(`check on ${path} must return [{ line, message? }] with line a positive integer`);
    }
    return hits.map((hit) => ({ line: hit.line, message: hit.message ?? rule.message }));
  }
  const js = JS_FILE.test(path);
  return text.split('\n').flatMap((code, i) =>
    !(js && COMMENT_LINE.test(code)) && rule.pattern.test(code) ? [{ line: i + 1, message: rule.message }] : []);
}

/** True when `list` is a non-empty array whose items all pass `valid`. */
const nonEmpty = (list, valid) => Array.isArray(list) && list.length > 0 && list.every(valid);

/** What is wrong with the rule exported by `file` (a file name in RULES_DIR), or null. */
export function ruleProblem(rule, file) {
  const name = basename(file, '.mjs');
  if (rule === null || typeof rule !== 'object') return 'needs a default export: the rule object';
  const unknown = Object.keys(rule).filter((key) => !RULE_KEYS.has(key));
  if (unknown.length) return `unknown key ${unknown.join(', ')}: the keys are ${[...RULE_KEYS].join(', ')}`;
  if (rule.name !== name) return `name must be "${name}", the file name`;
  if (!(rule.files instanceof RegExp)) return 'files must be a RegExp';
  if (rule.skip !== undefined && !(rule.skip instanceof RegExp)) return 'skip must be a RegExp';
  if (rule.tests !== undefined && typeof rule.tests !== 'boolean') return 'tests must be true or false';
  if (rule.allow !== undefined && !nonEmpty(rule.allow, (entry) => typeof entry === 'string' && entry)) {
    return 'allow must be a non-empty array of file paths and folders ending in /';
  }
  const isPattern = rule.pattern instanceof RegExp;
  if (isPattern === (typeof rule.check === 'function')) {
    return 'needs pattern (a RegExp) or check (a function), not both';
  }
  if (typeof rule.message !== 'string' || !rule.message) return 'needs message';
  if (rule.ratchet !== undefined && typeof rule.ratchet !== 'boolean') return 'ratchet must be true or false';
  const example = isPattern ? (line) => typeof line === 'string'
    : (item) => typeof item?.path === 'string' && typeof item.text === 'string';
  if (!nonEmpty(rule.examples?.hit, example) || !nonEmpty(rule.examples?.miss, example)) {
    return `examples must be { hit: [...], miss: [...] }, neither empty, of ${isPattern ? 'lines' : '{ path, text }'}`;
  }
  if ([rule.files, rule.skip, rule.pattern].some((regExp) => regExp && STATEFUL_FLAGS.test(regExp.flags))) {
    return 'a RegExp must not have the g or y flag';
  }
  return null;
}

/** The examples of `rule` that give the wrong result, as problem texts. */
function exampleProblems(rule) {
  const hits = rule.pattern
    ? (line) => rule.pattern.test(line)
    : ({ path, text }) => ruleHits(rule, path, text).length > 0;
  const show = (example) => JSON.stringify(rule.pattern ? example : example.path);
  const missed = rule.examples.hit.filter((example) => !hits(example));
  return [
    ...missed.map((example) => `hit example ${show(example)} has no hit`),
    ...rule.examples.miss.filter(hits).map((example) => `miss example ${show(example)} hits`),
  ];
}

/** What is wrong with one rule itself, and its hits in `files`. */
function ruleResult(rule, files, read) {
  const examples = exampleProblems(rule);
  if (examples.length) return { problems: examples, hits: [] };
  const scope = files.filter((path) => inScope(rule, path));
  if (!scope.length) return { problems: ['checks no file: fix files, skip or tests'], hits: [] };
  const problems = (rule.allow ?? []).filter((entry) => !scope.some((path) => allows(entry, path)))
    .map((entry) => `allow entry "${entry}" names no file this rule checks: remove it`);
  const hits = scope.filter((path) => applies(rule, path)).flatMap((path) =>
    ruleHits(rule, path, read(path)).map(({ line, message }) => `${path}:${line}: [${rule.name}] ${message}`));
  return { problems, hits };
}

/**
 * The problems (each `path:line: [rule] message`) and the notes of `rules` over `files`. `read(path)` gives a file's
 * text; `baseline` maps each ratchet rule to its allowed hit count.
 */
export function evaluate(rules, files, read, baseline) {
  const problems = [];
  const notes = [];
  for (const rule of rules) {
    let result;
    try {
      result = ruleResult(rule, files, read);
    } catch (error) {
      result = { problems: [textOf(error)], hits: [] };
    }
    // A broken rule reports only itself: its hits and counts mean nothing until it is fixed.
    problems.push(...result.problems.map((text) => `${RULES_DIR}/${rule.name}.mjs: [${rule.name}] ${text}`));
    if (result.problems.length) continue;
    const { hits } = result;
    if (!rule.ratchet) {
      problems.push(...hits);
      continue;
    }
    const allowed = baseline[rule.name];
    if (allowed === undefined) {
      problems.push(`${BASELINE_FILE}: [${rule.name}] no baseline: add "${rule.name}": ${hits.length}`);
    } else if (!Number.isInteger(allowed) || allowed < 0) {
      problems.push(`${BASELINE_FILE}: [${rule.name}] the baseline must be a whole number of 0 or more`);
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

/** The rule modules of `root`, sorted by file name, and the problems of the files that hold none. */
async function loadRules(root) {
  const dir = join(root, RULES_DIR);
  if (!existsSync(dir)) return { rules: [], problems: [] };
  const entries = readdirSync(dir).sort();
  const problems = entries.filter((name) => !name.endsWith('.mjs') && name !== basename(BASELINE_FILE))
    .map((name) => `${RULES_DIR}/${name}: only rule files (<name>.mjs) and ${basename(BASELINE_FILE)} go here`);
  const loaded = await Promise.all(entries.filter((name) => name.endsWith('.mjs')).map(async (name) => {
    try {
      const rule = (await import(pathToFileURL(join(dir, name)).href)).default;
      const problem = ruleProblem(rule, name);
      return problem ? { problem: `${RULES_DIR}/${name}: ${problem}` } : { rule };
    } catch (error) {
      return { problem: `${RULES_DIR}/${name}: cannot load: ${textOf(error)}` };
    }
  }));
  return {
    rules: loaded.flatMap(({ rule }) => (rule ? [rule] : [])),
    problems: [...problems, ...loaded.flatMap(({ problem }) => (problem ? [problem] : []))],
  };
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
  const { rules, problems: loadProblems } = await loadRules(root);
  const texts = new Map();
  const read = (path) => {
    if (!texts.has(path)) texts.set(path, readFileSync(join(root, path), 'utf8'));
    return texts.get(path);
  };
  const { problems: ruleProblems, notes } = evaluate(rules, files, read, baseline);
  const problems = [...loadProblems, ...ruleProblems];

  for (const note of notes) console.log(note);
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} problem(s). Each rule and its reason is in ${RULES_DIR}/.`);
    process.exit(1);
  }
  console.log(`source rules ok: ${rules.length} rule(s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
