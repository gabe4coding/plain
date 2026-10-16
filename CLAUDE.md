plain runs natural-language YAML specs on three engines: browser (`src/browser/`), desktop (`src/computer/`) and
mobile (`src/mobile/`); desktop and mobile share `src/native/`. Playwright or the native adapter acts; Jev
(TypeSafe's model) is the only decision maker.

## Validation (mandatory)

Before any pull request, and before you report a change as done, follow the `validating-changes` skill
(`.claude/skills/validating-changes/SKILL.md`).

```
npm run build               # src/ → dist/; after a clone and after each src/ change
npm test                    # build + node --test 'dist/**/*.test.js' 'scripts/*.test.mjs'; needs no Jev key
npm run verify              # the key-free gate CI runs: tests, docs, source rules, examples, plugins
node scripts/validate.mjs   # the whole validation loop + the pre-PR stamp
```

## Rules for every task

- The repo is site-agnostic: site-specific skills, environment facts and regression specs go in downstream plugins.
- No literal credentials in any spec, doc YAML included: `$VAR` in the `env` block, `${env.*}` in steps.
- When you drive a site: test environments only, stop before the last irreversible step (payment, booking,
  sending), never bypass bot protection.

## Where to read more

| Before you … | Read |
|---|---|
| change code (`src/`, `scripts/`, `bin/`, `plugins/`, `mods/`, `e2e/`, `examples/`, `package.json`) | `CODING_STANDARDS.md` |
| change the native, desktop or mobile engine | the `CLAUDE.md` (also `AGENTS.md`) in `src/native/`, `src/computer/` or `src/mobile/` |
| write or change a user doc (`README.md`, `docs/*.mdx`, `examples/mobile/README.md`) | the `writing-docs` skill (`.claude/skills/writing-docs/SKILL.md`) |
| change an agent note (`CLAUDE.md`, `CODING_STANDARDS.md`, `src/*/CLAUDE.md`, `.claude/skills/`) or write down a learning | the `writing-agent-notes` skill (`.claude/skills/writing-agent-notes/SKILL.md`) |
| run a spec, `validate`, `--list` or the MCP server | `docs/running.mdx` |
| build, test, run, release or benchmark beyond the commands above | `docs/development.mdx` |
| use the plain MCP tools | the `using-plain` skill (`plugins/plain/skills/using-plain/SKILL.md`) |
