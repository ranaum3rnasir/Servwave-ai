/* Every piece of text in a source file that can reach the browser, read with the TypeScript compiler, and the
   shipped files of a source tree. Comments and identifiers are never looked at. Shared by the guards that read source
   for words that must not reach a user. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface TextLiteral {
  text: string;
  line: number;
}

/** String literals (toasts, labels, class names, URLs, console arguments), template pieces and JSX text. */
export function textLiterals(file: string): TextLiteral[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: TextLiteral[] = [];
  const add = (node: ts.Node, text: string) => {
    found.push({ text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };
  const visit = (node: ts.Node) => {
    // Module specifiers and type-level literal unions are never rendered.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node)) return;
    if (ts.isLiteralTypeNode(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text);
    else if (ts.isJsxText(node)) add(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The `console.*` calls of a source file, with their line and the text of their arguments. */
export function consoleCalls(file: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && /^console\./.test(node.expression.getText(source))) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText(source).slice(0, 120) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Shipped source files under `dir`: tests, stories and fixtures never reach a user. */
export function shippedFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === '__mocks__') continue;
      shippedFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|stories)\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}
