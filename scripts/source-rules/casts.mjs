// Each way past the type check in the code of src/ (not the tests): `as any`, `as unknown as`, `as never`, an `any`
// type, a non-null `!` (also `let x!: T`) and the `@ts-` directives. A wrong type then compiles and fails at run
// time. The count must not go up. The TypeScript parser finds them, so text in strings and comments is not a hit,
// and each escape on a line counts: a new one next to an old one fails too.
import ts from 'typescript';

const FIX = 'give the value its real type, narrow it with a check or parse it with a schema';
// A line of a comment that starts with the directive, after `//`, `///`, `/*`, `/**` or the `*` of a block comment.
const DIRECTIVE = /^\s*(?:\/\/\/?|\/\*+|\*+)?\s*@ts-(?:ignore|expect-error|nocheck)\b/;
const { SyntaxKind } = ts;

/** The escape that `node` is, or null. */
function escapeOf(node) {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    if (node.type.kind === SyntaxKind.AnyKeyword) return '`as any`';
    if (node.type.kind === SyntaxKind.NeverKeyword) return '`as never`';
    let inner = node.expression;
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
    if ((ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner))
      && inner.type.kind === SyntaxKind.UnknownKeyword) return '`as unknown as`';
    return null;
  }
  if (node.kind === SyntaxKind.AnyKeyword) {
    const cast = ts.isAsExpression(node.parent) || ts.isTypeAssertionExpression(node.parent);
    return cast ? null : 'an `any` type';
  }
  if (ts.isNonNullExpression(node)) return 'a non-null `!`';
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.exclamationToken) {
    return 'a definite `!`';
  }
  return null;
}

/** The hits of the escapes in the TypeScript file at `path`. */
function escapes(text, path) {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const lineAt = (position) => file.getLineAndCharacterOfPosition(position).line + 1;
  const hits = [];
  const visit = (node) => {
    const escape = escapeOf(node);
    if (escape) {
      // The line of the `!` or the cast type, which can end an expression that starts lines above.
      const at = ts.isNonNullExpression(node) ? node.end - 1 : (node.type ?? node).getStart(file);
      hits.push({ line: lineAt(at), message: `${escape} skips the type check: ${FIX}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const at of directives(file, text)) {
    hits.push({ line: lineAt(at), message: `a \`@ts-\` directive skips the type check: ${FIX}` });
  }
  return hits.sort((a, b) => a.line - b.line);
}

/** The positions of the `@ts-` directives: only in the real comments, so a string that holds one is no hit. */
function directives(file, text) {
  const comments = new Map();
  const visit = (node) => {
    // The JSDoc nodes are the comments again, parsed.
    if (node.kind >= SyntaxKind.FirstJSDocNode && node.kind <= SyntaxKind.LastJSDocNode) return;
    // Each comment is in front of a token, the end of the file at the latest.
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) comments.set(range.pos, range.end);
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  return [...comments].flatMap(([pos, end]) => {
    let at = pos;
    return text.slice(pos, end).split('\n').flatMap((line) => {
      const start = at;
      at += line.length + 1;
      return DIRECTIVE.test(line) ? [start] : [];
    });
  });
}

export default {
  name: 'casts',
  files: /^src\/.*\.tsx?$/,
  check: escapes,
  message: `a type escape: ${FIX}`,
  ratchet: true,
  examples: {
    hit: [
      { path: 'src/a.ts', text: 'const s = { state: state as any };' },
      { path: 'src/a.ts', text: 'const c = config as unknown as Options;' },
      { path: 'src/a.ts', text: 'setup({ spec: message.spec as never });' },
      { path: 'src/a.ts', text: 'function parse(value: any) {}' },
      { path: 'src/a.ts', text: 'type Seen = Record<string, any>;' },
      { path: 'src/a.ts', text: 'const run: () => any = go;' },
      { path: 'src/a.ts', text: 'const d = routes.get(key)!;' },
      { path: 'src/a.ts', text: 'const url = `${target!.app}`;' },
      { path: 'src/a.ts', text: 'callback!();' },
      { path: 'src/a.ts', text: 'let ready!: boolean;' },
      { path: 'src/a.ts', text: '  // @ts-expect-error\nconst n: number = "x";' },
    ],
    miss: [
      { path: 'src/a.ts', text: '// a value read as any is a type escape, value!\nconst a = 1;' },
      { path: 'src/a.ts', text: 'if (a !== b && !c) d = e as unknown;' },
      { path: 'src/a.ts', text: "throw new Error('Saved! Try as any time: any');" },
      { path: 'src/a.ts', text: 'const many: Company = anyone; // done!' },
      { path: 'src/a.ts', text: "const header = '// @ts-nocheck'; // see // @ts-ignore" },
    ],
  },
};
