/**
 * Roles & Permissions - the person's own switches have ONE reader in the browser.
 *
 * Two slices once each added a hook named `useMySwitches` for `GET /api/permission-switches/me`, in two files with
 * different shapes and different cache policies; the menu and the job page's customer block would have sent the
 * request twice and followed a role edit at different times. Every screen reads the answer through
 * `lib/api/mySwitches.ts`. This fails when a second file calls the route or exports a second reader.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['__tests__', '__mocks__', 'node_modules']);

function productionFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...productionFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function filesMatching(pattern: RegExp): string[] {
  return productionFiles()
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SRC, file).split(sep).join('/'));
}

describe('the reader of the person\'s own switches', () => {
  it('is called from exactly one production file', () => {
    expect(filesMatching(/['"`]\/api\/permission-switches\/me['"`]/)).toEqual(['lib/api/mySwitches.ts']);
  });

  it('is exported under one hook name from one file', () => {
    expect(filesMatching(/export (?:function|const) useMySwitches\b/)).toEqual(['lib/api/mySwitches.ts']);
  });
});
