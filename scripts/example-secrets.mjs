// The literal-secret warnings of `validate` output that scripts/check-examples.mjs turns into problems. `validate`
// only warns, but a spec there is one a user copies, so it fails. A `fill` step of an `expect-fail` spec types a
// wrong password on purpose; its `auth` and `env` still hold no literal.
import { parse as parseYaml } from 'yaml';

/** The `! <file>: ... literal secret` lines that count, as {file, line}. `textOf(file)` gives the spec YAML. */
export function literalSecrets(output, textOf) {
  return [...output.matchAll(/^! (.+?): .*literal secret.*$/gm)].flatMap(([line, file]) => {
    const tags = [].concat(parseYaml(textOf(file))?.tags ?? []);
    const wrongOnPurpose = tags.includes('expect-fail') && / fills ".*" with a literal secret/.test(line);
    return wrongOnPurpose ? [] : [{ file, line }];
  });
}
