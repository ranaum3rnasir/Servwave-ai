/**
 * Guard (#3253): no test file path is a substring of another test file path.
 *
 * The test tool selects files by substring match on the path, and `npm run test:ci` passes a
 * selection as paths. If `src/a/foo.test.ts` were a substring of `src/b/a/foo.test.ts`, asking for
 * the first would also run the second, and the completeness check would report an "extra" file.
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (/\.test\.(ts|tsx)$/.test(entry.name)) out.push(`src/${full.slice(SRC.length + 1).split('\\').join('/')}`);
  }
  return out;
}

/** Pairs [shorter, longer] where the shorter path is a substring of the longer one. */
function substringPairs(paths: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  // The tool lowercases both sides when it filters, so compare that way.
  for (const a of paths) for (const b of paths) if (a !== b && b.toLowerCase().includes(a.toLowerCase())) pairs.push([a, b]);
  return pairs;
}

describe('test file paths', () => {
  it('finds the planted pair', () => {
    expect(substringPairs(['src/a/foo.test.ts', 'src/b/src/a/foo.test.ts', 'src/c.test.ts'])).toEqual([['src/a/foo.test.ts', 'src/b/src/a/foo.test.ts']]);
  });

  it('finds a pair that differs only by case', () => {
    expect(substringPairs(['src/a/Foo.test.ts', 'src/b/src/a/foo.test.ts'])).toEqual([['src/a/Foo.test.ts', 'src/b/src/a/foo.test.ts']]);
  });

  it('no test file path is a substring of another', () => {
    const files = testFiles(SRC);
    expect(files.length).toBeGreaterThan(1000);
    expect(substringPairs(files)).toEqual([]);
  });
});
