/**
 * #3259: the routed job detail page has one harness (`harness/jobDetailPage.tsx`) and no second fake server.
 *
 * A test file that reaches the page through the harness never imports the page itself, so the harness is the only importer
 * and a file that mounts the page by hand (its own import, its own fake server) fails here. The brake counts a test file
 * that imports the page OR the harness as mounting the page (`PAGE_HARNESSES` in `scripts/test-brake-lib.mjs`, decision D14),
 * so this guard no longer tracks a count: the ceiling in `test-page-ceilings.json` does, and falls only when files are merged.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGE_HARNESSES, scanPageImports } from '../../../scripts/test-brake-lib.mjs';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE_FILE = 'src/pages/v2/jobs/JobDetailPage.tsx';
const HARNESS = /from\s+['"](?:(?:\.\.?\/)+|@\/__tests__\/)harness\/jobDetailPage['"]/;

function testFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(full));
    else if (/\.test\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('the job detail page harness (#3259)', () => {
  const files = testFiles().map((f) => ({ path: `src/${relative(SRC, f).split(sep).join('/')}`, text: readFileSync(f, 'utf8') }));
  /** The test files that import the page, by any specifier the brake itself resolves (alias, relative, dynamic). */
  const importsPage = (f: { path: string; text: string }) =>
    Boolean((scanPageImports({ tests: [{ path: f.path, source: f.text }], pages: [PAGE_FILE], harnesses: {} }) as Record<string, number>)[PAGE_FILE]);
  const direct = files.filter(importsPage).map((f) => f.path);

  it('is imported by tests, and a test that imports it does not also mount the page by hand', () => {
    const viaHarness = files.filter((f) => HARNESS.test(f.text));
    expect(viaHarness.length).toBeGreaterThan(5);
    expect(viaHarness.filter(importsPage).map((f) => f.path)).toEqual([]);
  });

  it('is imported by no test file: the harness is the one importer of the page', () => {
    expect(direct).toEqual([]);
  });

  it('is named, as the page\'s harness, in the brake\'s one mapping', () => {
    expect((PAGE_HARNESSES as Record<string, string[]>)[PAGE_FILE]).toEqual(['src/__tests__/harness/jobDetailPage.tsx']);
  });
});
