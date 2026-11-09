/**
 * The render helper builds its default ability set from the frontend's own copy of the backend permission-switch
 * catalog (support/switchCatalog.generated.json), not from the backend source file. This is the one test that reads the
 * backend file: it proves the copy still matches, once, instead of every suite proving it at every render. It also
 * proves the old coupling is not creeping back through the render helper.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_COPY_PATH,
  CATALOG_SOURCE_PATH,
  REGENERATE_COMMAND,
  renderCopy,
} from '../../scripts/switch-catalog.mjs';

const SRC = resolve(__dirname, '..');
const FRONTEND = resolve(SRC, '..');

describe('the frontend copy of the switch catalog', () => {
  it('matches the backend catalog', () => {
    const expected = renderCopy(readFileSync(CATALOG_SOURCE_PATH, 'utf8'));
    const actual = readFileSync(CATALOG_COPY_PATH, 'utf8');
    if (actual !== expected) {
      throw new Error(
        'The frontend copy of the permission-switch catalog differs from the backend catalog. ' +
          `Regenerate it with: ${REGENERATE_COMMAND}`,
      );
    }
    expect(actual).toBe(expected);
  });
});

/** Every frontend source file the render helper loads: its imports followed down, relative and `@/` alike. */
function closureOf(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  const resolveSpec = (from: string, spec: string): string | null => {
    const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
    if (!base) return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
      if (/\.(ts|tsx)$/.test(c) && existsSync(c)) return c;
    }
    return null;
  };
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
      const next = resolveSpec(file, m[1]!);
      if (next) queue.push(next);
    }
  }
  return [...seen];
}

describe('the render helper', () => {
  const files = closureOf(join(SRC, '__tests__/helpers.tsx'));

  it('loads only files inside the frontend folder', () => {
    expect(files.length).toBeGreaterThan(1);
    const outside = files.filter((f) => !f.startsWith(FRONTEND + '/'));
    expect(outside).toEqual([]);
  });

  it('reads no file from disk and names no backend path while loading', () => {
    const offenders = files.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const found: string[] = [];
      if (/from\s+['"](?:node:)?fs(?:\/promises)?['"]|\breadFileSync\b|\breadFile\b/.test(code)) found.push('reads from disk');
      if (/['"`][^'"`\n]*\bbackend\/[^'"`\n]*['"`]/.test(code)) found.push('names a backend path');
      if (/['"`]\.\.\/\.\.\/\.\.\/\.\./.test(code)) found.push('climbs out of the frontend folder');
      return found.map((why) => `${f.slice(FRONTEND.length + 1)}: ${why}`);
    });
    expect(offenders).toEqual([]);
  });
});
