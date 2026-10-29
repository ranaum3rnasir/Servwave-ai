import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * A small static-import walker over `src/`, for tests that pin what an entry point pulls in.
 *
 * It follows `import x from '...'`, `import '...'` and `export ... from '...'`; it does NOT
 * follow `import('...')` (a lazy chunk is not part of the initial graph) or `import type`
 * (erased at build). `@/` resolves to `src/`. Package imports are returned as bare names so a
 * test can assert a package never enters the graph.
 *
 * Lives beside the tests but is not a `.test.ts`, so vitest does not try to run it.
 */

const SRC = resolve(__dirname, '..');
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx', ''];

const FROM_CLAUSE = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function resolveSpecifier(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && /\.(tsx?|ts)$/.test(candidate)) return candidate;
  }
  return null;
}

export interface ImportGraph {
  /** Absolute paths of every source file statically reachable from the entry, entry included. */
  files: Set<string>;
  /** Bare package specifiers imported anywhere in that set (`react`, `@sentry/react`, ...). */
  packages: Set<string>;
  /** For each file, the file that first imported it: follow these back to find WHY it is in. */
  parents: Map<string, string>;
}

/** The import chain from the entry to `file`, as `src/`-relative paths. */
export function importChain(graph: ImportGraph, file: string): string[] {
  const chain = [file];
  let at = file;
  while (graph.parents.has(at)) {
    at = graph.parents.get(at)!;
    chain.unshift(at);
  }
  return chain.map(relativeToSrc);
}

export function staticImportGraph(entry: string): ImportGraph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const parents = new Map<string, string>();
  const queue: string[] = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    const code = stripComments(readFileSync(file, 'utf8'));

    const specs: string[] = [];
    for (const m of code.matchAll(FROM_CLAUSE)) {
      if (m[1]) continue; // import type / export type
      specs.push(m[3]!);
    }
    for (const m of code.matchAll(BARE_IMPORT)) specs.push(m[1]!);

    for (const spec of specs) {
      const next = resolveSpecifier(file, spec);
      if (next) {
        if (!files.has(next) && !parents.has(next)) parents.set(next, file);
        queue.push(next);
      } else if (!spec.startsWith('.') && !spec.startsWith('@/')) {
        packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
      }
    }
  }
  return { files, packages, parents };
}

/** `src/`-relative, forward-slash form of a path, for readable assertion messages. */
export function relativeToSrc(file: string): string {
  return file.slice(SRC.length + 1).split('\\').join('/');
}
