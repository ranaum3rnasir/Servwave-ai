/**
 * #3259: each API client file is importable alone.
 *
 * Six client files once imported each other, so a change to any one of them made the test tool select about 555 tests
 * (every test that reaches any of the six). What two clients share now lives in `src/lib/api/shared/`, which imports no
 * client. This fails when a file under `src/lib/api/` (a client, a shared file, a sub-folder file) imports a client file
 * (`src/lib/api/<name>.ts`) by any door: import, type import, re-export, `export *`, dynamic `import()` or `require()`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(SRC, 'lib', 'api');

const clientNames = new Set(
  readdirSync(API_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name))
    .map((e) => e.name.replace(/\.(ts|tsx)$/, '')),
);

const isTest = (name: string) => /\.test\.(ts|tsx)$/.test(name);

function apiFiles(dir: string = API_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== '__mocks__') out.push(...apiFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !isTest(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function specifiersByTree(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const first = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        if (first && ts.isStringLiteralLike(first)) found.push(first.text);
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const target = node.moduleReference.expression;
      if (target && ts.isStringLiteral(target)) found.push(target.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Every quoted module specifier the text names after `from`, `import` or `require` (a comment or whitespace may sit between the keyword
 * and the quote). This is a plain text scan: it reads comments and strings too, so it names more than the real imports, never fewer.
 */
const QUOTED_SPECIFIER = /(?:\bfrom|\bimport|\brequire)(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\(?(?:\s|\/\*[\s\S]*?\*\/)*(['"`])([^'"`\n]+)\1/g;

/**
 * Every module specifier a source text pulls in, by any door: import, type import, re-export, `export *`, `export * as ns`, dynamic
 * `import()`, `require()` and `import x = require()`.
 *
 * The compiler's import scanner (`ts.preProcessFile`) builds no syntax tree, which keeps the walk over every source file under the test
 * time limit, but it does not lex regex literals or JSX text: a `/*`, `//`, quote or backtick inside one can make it lose the imports
 * after it. So its answer is trusted only when it agrees with a plain text scan of the same file (`QUOTED_SPECIFIER`): when the two
 * name different specifiers, the file goes through the full syntax tree. A file the scanner misread therefore always shows a specifier
 * in the text that the scanner did not return, and gets the tree.
 */
function specifiersOf(fileName: string, text: string): string[] {
  const scanned = ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
  const named = new Set<string>();
  for (const m of text.matchAll(QUOTED_SPECIFIER)) named.add(m[2]!);
  const seen = new Set(scanned);
  if (named.size === seen.size && [...named].every((n) => seen.has(n))) return scanned;
  return specifiersByTree(fileName, text);
}

/** The client file (`<name>`) a specifier reaches from a file under `lib/api/`, or null when it reaches none. */
function clientReached(fromFile: string, specifier: string): string | null {
  let abs: string;
  if (specifier.startsWith('@/')) abs = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) abs = resolve(dirname(fromFile), specifier);
  else return null;
  const rel = relative(API_DIR, abs).split(sep).join('/');
  if (rel.startsWith('..')) return null;
  // `lib/api` itself or `lib/api/index` is a door to every client.
  if (rel === '' || rel === 'index') return 'index';
  const name = rel.replace(/\.(ts|tsx)$/, '');
  // A client is a file directly in lib/api; a folder (shared, communication-shared, _mock) is not one.
  if (name.includes('/') || !clientNames.has(name)) return null;
  return name;
}

/** `{ file, imports }` for every import of a client file from a file under lib/api (the file's own name excepted). */
function clientImports(files: { path: string; text: string }[]): { file: string; imports: string }[] {
  const bad: { file: string; imports: string }[] = [];
  for (const f of files) {
    const own = relative(API_DIR, f.path).split(sep).join('/').replace(/\.(ts|tsx)$/, '');
    for (const spec of specifiersOf(f.path, f.text)) {
      const hit = clientReached(f.path, spec);
      if (hit && hit !== own) bad.push({ file: relative(SRC, f.path).split(sep).join('/'), imports: hit });
    }
  }
  return bad;
}


// ---------------------------------------------------------------- transitive reach

/** Every non-test source file under src/, by absolute path. */
function allSourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== '__mocks__' && entry.name !== 'node_modules') out.push(...allSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !isTest(entry.name)) out.push(full);
  }
  return out;
}

/** The source file a specifier of `fromFile` resolves to, among `known`, or null (a package, an asset, a stub). */
function resolveModule(fromFile: string, specifier: string, known: Set<string>): string | null {
  let abs: string;
  if (specifier.startsWith('@/')) abs = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) abs = resolve(dirname(fromFile), specifier);
  else return null;
  for (const c of [abs, `${abs}.ts`, `${abs}.tsx`, join(abs, 'index.ts'), join(abs, 'index.tsx')]) if (known.has(c)) return c;
  return null;
}

/**
 * Client pairs where one reaches the other through any chain of modules (a client importing a hook file that imports another
 * client). `files` = [{ path, text }]; a client is a file directly in `lib/api`. Returns `{ from, to, via }` with the chain.
 */
function transitiveClientReaches(files: { path: string; text: string }[]): { from: string; to: string; via: string[] }[] {
  const known = new Set(files.map((f) => f.path));
  const edges = new Map<string, string[]>();
  for (const f of files) {
    const targets = specifiersOf(f.path, f.text).map((sp) => resolveModule(f.path, sp, known)).filter((t): t is string => t !== null);
    edges.set(f.path, targets);
  }
  const isClient = (p: string) => dirname(p) === API_DIR;
  const found: { from: string; to: string; via: string[] }[] = [];
  for (const start of files.map((f) => f.path).filter(isClient)) {
    const seen = new Map<string, string[]>([[start, []]]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of edges.get(cur) ?? []) {
        if (seen.has(next)) continue;
        const chain = [...seen.get(cur)!, relative(SRC, next).split(sep).join('/')];
        seen.set(next, chain);
        if (isClient(next) && next !== start) found.push({ from: relative(SRC, start).split(sep).join('/'), to: relative(SRC, next).split(sep).join('/'), via: chain });
        else queue.push(next);
      }
    }
  }
  return found;
}

describe('API client files are importable alone (#3259)', () => {
  it('no file under lib/api imports a client file of lib/api', () => {
    const files = apiFiles().map((path) => ({ path, text: readFileSync(path, 'utf8') }));
    expect(files.length).toBeGreaterThan(50);
    expect(clientImports(files)).toEqual([]);
  });

  it('no client reaches another client through any chain of modules, nor does a shared file reach one', () => {
    const files = allSourceFiles().map((path) => ({ path, text: readFileSync(path, 'utf8') }));
    expect(files.length).toBeGreaterThan(500);
    expect(transitiveClientReaches(files)).toEqual([]);
    expect(statSync(API_DIR).isDirectory() && existsSync(join(API_DIR, 'shared'))).toBe(true);
  });

  it('sees a client that reaches another through an app module, however long the chain', () => {
    const f = (name: string) => join(SRC, name);
    const files = [
      { path: f('lib/api/a.ts'), text: "import { h } from '@/hooks/useThing';" },
      { path: f('hooks/useThing.ts'), text: "export * from '../lib/useOther';" },
      { path: f('lib/useOther.ts'), text: "import { y } from '@/lib/api/b';" },
      { path: f('lib/api/b.ts'), text: 'export const y = 1;' },
    ];
    expect(transitiveClientReaches(files)).toEqual([
      { from: 'lib/api/a.ts', to: 'lib/api/b.ts', via: ['hooks/useThing.ts', 'lib/useOther.ts', 'lib/api/b.ts'] },
    ]);
    expect(transitiveClientReaches(files.slice(0, 3).concat([{ path: f('lib/api/b.ts'), text: '' }]).map((x) => (x.path.endsWith('useOther.ts') ? { ...x, text: "import { y } from '@/lib/axios';" } : x)))).toEqual([]);
  });

  it('sees a shared file that imports a client, and a client reached through a shared file', () => {
    clientNames.add('b');
    expect(clientImports([{ path: join(API_DIR, 'shared/x.ts'), text: "import { y } from '@/lib/api/b';" }])).toEqual([
      { file: 'lib/api/shared/x.ts', imports: 'b' },
    ]);
    const f = (name: string) => join(SRC, name);
    expect(
      transitiveClientReaches([
        { path: f('lib/api/a.ts'), text: "import { z } from './shared/x';" },
        { path: f('lib/api/shared/x.ts'), text: "import { y } from '../b';" },
        { path: f('lib/api/b.ts'), text: '' },
      ]).map((r) => r.via),
    ).toEqual([['lib/api/shared/x.ts', 'lib/api/b.ts']]);
  });

  it('sees every door a client import can come through', () => {
    clientNames.add('b');
    const at = (name: string) => join(API_DIR, name);
    const cases: [string, string, string][] = [
      ['static import', at('a.ts'), "import { x } from '@/lib/api/b';"],
      ['type import', at('a.ts'), "import type { X } from './b';"],
      ['re-export', at('a.ts'), "export { x } from './b';"],
      ['export star', at('a.ts'), "export * from '@/lib/api/b';"],
      ['export star as namespace', at('a.ts'), "export * as ns from '@/lib/api/b';"],
      ['import after a regex literal holding a quote', at('a.ts'), "const q = /'/; import { x } from './b';"],
      ['require after a regex literal holding a double quote', at('a.ts'), "const q = /[\"]/; const m = require('./b');"],
      ['dynamic import after a regex literal holding a quote', at('a.ts'), "const q = /'/; export const m = () => import('./b');"],
      ['import after a regex literal holding a backtick', at('a.ts'), "const q = /`/;\nimport { x } from './b';"],
      ['type re-export', at('a.ts'), "export type { X } from '../api/b';"],
      ['dynamic import', at('a.ts'), "const m = await import('@/lib/api/b');"],
      ['require', at('a.ts'), "const m = require('./b');"],
      ['import-equals', at('a.ts'), "import b = require('./b');"],
      ['from the shared folder', at('shared/a.ts'), "import { x } from '../b';"],
      ['from a sub-folder file', at('communication-shared/a.ts'), "import { x } from '@/lib/api/b.ts';"],
      ['the folder itself', at('a.ts'), "import { x } from '@/lib/api';"],
    ];
    for (const [door, path, text] of cases) {
      expect(clientImports([{ path, text }]), door).toEqual([
        { file: relative(SRC, path).split(sep).join('/'), imports: door === 'the folder itself' ? 'index' : 'b' },
      ]);
    }
  });

  it('sees an import the compiler import scanner loses after a regex literal, a comment-like or a quote-like text', () => {
    clientNames.add('b');
    const at = (name: string) => join(API_DIR, name);
    const cases: [string, string, string][] = [
      ['regex holding /* (strip trailing slashes) then import()', at('a.ts'), "const strip = (u: string) => u.replace(/\\/*$/, '');\nexport const m = () => import('./b');"],
      ['regex holding /* then require', at('a.ts'), "const strip = (u: string) => u.replace(/\\/*$/, '');\nconst m = require('./b');"],
      ['regex holding /* then export from at the bottom', at('a.ts'), "const strip = (u: string) => u.replace(/\\/*$/, '');\nexport { x } from './b';"],
      ['regex holding /* then a comment between from and the quote', at('a.ts'), "const strip = (u: string) => u.replace(/\\/*$/, '');\nexport { x } from /* why */ './b';\n/* end */"],
      ['regex holding // (URL) then import() on the same line', at('a.ts'), "const m = /^https?:\\/\\//.test(u) ? import('./b') : null;"],
      ['regex after a closing brace', at('a.ts'), 'function f(s: string) {\n  if (s) { g(); } /`/.test(s);\n}\nexport const m = () => import(\'./b\');'],
      ['regex after a closing parenthesis', at('a.ts'), "if (s) /`/.test(s);\nexport const m = () => import('./b');"],
      ['regex after else', at('a.ts'), "if (s) g(); else /`/.test(s);\nexport const m = () => import('./b');"],
      ['regex after throw', at('a.ts'), "const f = () => { throw /`/; };\nexport const m = () => import('./b');"],
      ['regex after await', at('a.ts'), "const f = async () => { await /'/; };\nexport const m = () => import('./b');"],
      ['regex after a greater-than', at('a.ts'), "const lt = a > /'/;\nexport const m = () => import('./b');"],
      ['regex with an escaped backtick', at('a.ts'), 'const q = /\\`/;\nexport const m = () => import(\'./b\');'],
      ['regex with an escaped quote', at('a.ts'), "const q = /\\'/;\nexport const m = () => import('./b');"],
      ['JSX text with an apostrophe, then import() on the same line', at('a.tsx'), "export const e = <p>don't</p>; export const m = () => import('./b');"],
      ['JSX text with a lone backtick, then import() on the same line', at('a.tsx'), "export const e = <p>a ` b</p>; export const m = () => import('./b');"],
    ];
    for (const [form, path, text] of cases) {
      expect.soft(clientImports([{ path, text }]), form).toEqual([{ file: relative(SRC, path).split(sep).join('/'), imports: 'b' }]);
    }
  });

  it('lets a client import the shared folder, a sub-folder and the rest of the app', () => {
    clientNames.add('b');
    const path = join(API_DIR, 'a.ts');
    const text = [
      "import { k } from '@/lib/api/shared/queryKeys';",
      "import { f } from './shared/leadViews';",
      "import { p } from '@/lib/api/communication-shared';",
      "import api from '@/lib/axios';",
      "import { useQuery } from '@tanstack/react-query';",
    ].join('\n');
    expect(clientImports([{ path, text }])).toEqual([]);
  });
});
