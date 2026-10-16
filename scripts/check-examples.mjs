// Checks every spec a user can copy or run, without a key or a session: examples/*.yaml, examples/mobile/*.yaml,
// e2e/*.yaml, and each full spec and config example in the user docs (.claude/skills/writing-docs/SKILL.md
// "Content": full spec examples must pass `validate`, config examples must pass `--list`). Each spec goes to the CLI
// of its engine: `platform:` is mobile, `app:` is desktop, the rest is the browser. A literal secret that `validate`
// warns on fails here, except in a `fill` step of a spec tagged `expect-fail`. Build first (npm run build).
//   node scripts/check-examples.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { literalSecrets } from './example-secrets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = { browser: 'dist/cli.js', desktop: 'dist/computer/cli.js', mobile: 'dist/mobile/cli.js' };
const yamlIn = (dir) => readdirSync(join(root, dir)).filter((n) => n.endsWith('.yaml')).map((n) => join(root, dir, n));
const userDocs = [
  join(root, 'README.md'),
  join(root, 'examples/mobile/README.md'),
  ...readdirSync(join(root, 'docs')).filter((n) => n.endsWith('.mdx')).map((n) => join(root, 'docs', n)),
];
// Keys only a config file has (a spec also has `tags` and `timeout`).
const CONFIG_KEYS = /^(files|workers|retries|bail|maxTokens|grep|grepInvert|reporters|timing|artifacts|specTimeout|headless|profile|channel|cdp|server|mode):/m;
const problems = [];

const engineOf = (text) => /^platform:/m.test(text) ? 'mobile' : /^app:/m.test(text) ? 'desktop' : 'browser';

function run(engine, args, cwd = root, label = args.at(-1)) {
  const out = spawnSync(process.execPath, [join(root, CLI[engine]), ...args], { cwd, encoding: 'utf8' });
  if (out.status !== 0) problems.push(`${label}: ${engine} ${args[0]} failed\n${(out.stdout + out.stderr).trim()}`);
  return out.stdout;
}

function checkSecrets(output, textOf, labelOf = (file) => relative(root, file)) {
  for (const { file, line } of literalSecrets(output, textOf)) problems.push(`${labelOf(file)}: literal secret\n${line}`);
}

function checkConfig(dir, text, data, label) {
  mkdirSync(dir);
  writeFileSync(join(dir, 'plain.config.yaml'), text);
  // --list needs one spec to select; the config's own `files` decides which.
  for (const pattern of [].concat(data.files ?? ['tests/a.yaml'])) {
    const path = pattern.replace(/\*+\/?/g, 'a');
    const file = join(dir, /\.ya?ml$/.test(path) ? path : join(path, 'a.yaml'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'name: a\nurl: https://example.com\nsteps:\n  - goto: /\n');
  }
  run('browser', ['--list', ...(data.files ? [] : ['tests'])], dir, label);
}

for (const [engine, files] of [['browser', [...yamlIn('examples'), ...yamlIn('e2e')]], ['mobile', yamlIn('examples/mobile')]]) {
  checkSecrets(run(engine, ['validate', ...files], root, `${engine} files`), (file) => readFileSync(file, 'utf8'));
}

const scratch = mkdtempSync(join(tmpdir(), 'plain-doc-examples-'));
try {
  let checked = 0;
  for (const doc of userDocs) {
    const src = readFileSync(doc, 'utf8');
    const dir = join(scratch, relative(root, doc).replace(/\W/g, '_'));
    mkdirSync(dir);
    const specs = [];
    for (const match of src.matchAll(/^```ya?ml\n([\s\S]*?)^```/gm)) {
      const text = match[1];
      const before = src.slice(0, match.index);
      const label = `${relative(root, doc)}:${before.split('\n').length}`;
      let data;
      try { data = parseYaml(text); } catch (error) { problems.push(`${label}: YAML does not parse: ${error.message}`); continue; }
      // A steps-only block right after a line that names a file ("`flows/login.yaml` contains...") is a flow
      // that a spec of the same doc includes.
      const flow = /`([\w./-]+\.ya?ml)`[^\n]*\n+$/.exec(before)?.[1];
      if (flow && /^steps:/.test(text) && Object.keys(data).length === 1) {
        mkdirSync(dirname(join(dir, flow)), { recursive: true });
        writeFileSync(join(dir, flow), text);
      } else if (/^steps:/m.test(text) && /^(name|url|app|platform):/m.test(text)) {
        specs.push({ text, label });
      } else if (CONFIG_KEYS.test(text)) {
        checkConfig(join(dir, `config-${checked}`), text, data, label);
        checked++;
      }
      // Anything else is a fragment: one step or one key, not a whole file.
    }
    specs.forEach(({ text, label }, i) => {
      writeFileSync(join(dir, `spec-${i}.yaml`), text);
      checkSecrets(run(engineOf(text), ['validate', `spec-${i}.yaml`], dir, label), () => text, () => label);
    });
    checked += specs.length;
  }
  if (!checked) problems.push('no full spec or config example found in the user docs');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length) {
  console.error(problems.join('\n\n'));
  console.error(`\n${problems.length} example problem(s).`);
  process.exit(1);
}
console.log('All examples validate.');
