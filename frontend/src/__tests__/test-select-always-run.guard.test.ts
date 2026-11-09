/**
 * Guard for test selection (#3257): every test that reads the disk, runs a child process or has a computed import
 * must be on the always-run list (frontend/scripts/test-select-lists.json), because the test tool's import graph cannot
 * see what such a test depends on: a backend file read from disk, a file spawned, a module named at run time.
 * A test that does any of these and is not listed fails here, naming the file and what to do.
 *
 * Also guards that no list entry is dead. (That no test path is a substring of another, which a selection handed to the
 * tool by name depends on, is guarded by test-file-paths.guard.test.ts.)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FRONTEND_PREFIX, matchesAny, unlistedTests, type Lists } from '../../scripts/test-select-lib.mjs';

const FRONTEND = resolve(__dirname, '../..');
const LISTS: Lists = JSON.parse(readFileSync(join(FRONTEND, 'scripts/test-select-lists.json'), 'utf8'));

/** Every tracked test file under src/ with its source, frontend-relative. */
function testFilesIn(root: string): { path: string; source: string }[] {
  // tracked plus new-but-not-yet-added files, so a test written a minute ago is already judged
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  return tracked.filter((p) => /\.test\.tsx?$/.test(p)).map((path) => ({ path, source: readFileSync(join(root, path), 'utf8') }));
}

/** Reads a local module a test imports: relative or `@/` (= src/), with or without extension or /index. null when it is not a local source file. */
function readLocalIn(root: string) {
  return (fromPath: string, specifier: string): { path: string; source: string } | null => {
    const base = specifier.startsWith('@/') ? join('src', specifier.slice(2)) : join(dirname(fromPath), specifier);
    const candidates = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'].map((e) => base + e);
    const hit = candidates.find((c) => existsSync(join(root, c)) && statSync(join(root, c)).isFile());
    return hit ? { path: hit, source: readFileSync(join(root, hit), 'utf8') } : null;
  };
}

const fix = (offenders: { path: string; signals: string[]; via?: string[] }[]) =>
  offenders.map((o) => `${o.path} (${o.signals.join(', ')}${o.via ? `, through ${o.via.join(' ')}` : ''}): add it to "alwaysRun" in frontend/scripts/test-select-lists.json, by file-name pattern where the name allows`);

describe('the always-run list is complete', () => {
  it('lists every real test that reads the disk, runs a child process or has a computed import', () => {
    expect(fix(unlistedTests({ files: testFilesIn(FRONTEND), alwaysRun: LISTS.alwaysRun, readLocal: readLocalIn(FRONTEND) }))).toEqual([]);
  });

  it('has no dead entry: every pattern matches at least one tracked test file', () => {
    const paths = testFilesIn(FRONTEND).map((f) => FRONTEND_PREFIX + f.path);
    expect(LISTS.alwaysRun.filter((g) => !paths.some((p) => matchesAny(p, [g])))).toEqual([]);
  });
});

describe('the guard itself catches a planted test that is not listed', () => {
  const plant = (source: string) => unlistedTests({ files: [{ path: 'src/__tests__/planted.test.ts', source }], alwaysRun: LISTS.alwaysRun });

  it('a test that reads the disk', () => {
    expect(plant("import { readFileSync } from 'node:fs';\nit('x', () => { readFileSync('../backend/a.ts'); });")[0]).toMatchObject({ path: 'src/__tests__/planted.test.ts', signals: ['reads-disk'] });
  });

  it('a test that runs a child process', () => {
    expect(plant("import { execFileSync } from 'node:child_process';\nit('x', () => { execFileSync('ls'); });")[0].signals).toContain('runs-child-process');
  });

  it('a test with a computed import', () => {
    expect(plant("it('x', async () => { const m = await import(/* @vite-ignore */ file); });")[0].signals).toEqual(['computed-import']);
  });

  it('a test that is listed by a pattern is not flagged', () => {
    const files = [{ path: 'src/__tests__/planted-guard.test.ts', source: "import fs from 'node:fs';" }];
    expect(unlistedTests({ files, alwaysRun: LISTS.alwaysRun })).toEqual([]);
  });

  it('a plain test is not flagged', () => {
    expect(plant("import { render } from '@testing-library/react';\nit('x', () => {});")).toEqual([]);
  });

  it('a planted file in a real tracked tree is found by the same scan the guard runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'always-run-guard-'));
    try {
      const file = join(root, 'src/__tests__/planted-reader.test.ts');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "import { readFileSync } from 'node:fs';\nit('x', () => { readFileSync('/etc/hosts'); });\n");
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['add', '-A'], { cwd: root });
      expect(unlistedTests({ files: testFilesIn(root), alwaysRun: LISTS.alwaysRun, readLocal: readLocalIn(root) }).map((o) => o.path)).toEqual(['src/__tests__/planted-reader.test.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe('a test that reads the disk only through a local helper module', () => {
    const tree: Record<string, string> = {
      'src/__tests__/helpers/disk.ts': "import { readFileSync } from 'node:fs';\nexport const load = () => readFileSync('/etc/hosts', 'utf8');",
      'src/__tests__/helpers/outer.ts': "export { load } from './disk';",
      'src/__tests__/helpers/types-only.ts': "import { readFileSync } from 'node:fs';\nexport type T = ReturnType<typeof readFileSync>;",
    };
    const readLocal = (from: string, spec: string) => {
      const base = spec.startsWith('@/') ? 'src/' + spec.slice(2) : join(dirname(from), spec);
      const hit = Object.keys(tree).find((k) => k === base + '.ts' || k === base);
      return hit ? { path: hit, source: tree[hit] } : null;
    };
    const run = (source: string) => unlistedTests({ files: [{ path: 'src/__tests__/planted.test.ts', source }], alwaysRun: LISTS.alwaysRun, readLocal });

    it('a relative import of the helper is flagged, naming the helper', () => {
      const [o] = run("import { load } from './helpers/disk';\nit('x', () => { load(); });");
      expect(o).toMatchObject({ path: 'src/__tests__/planted.test.ts', signals: ['reads-disk'], via: ['src/__tests__/helpers/disk.ts'] });
    });

    it('an @/ alias import of the helper is flagged', () => {
      expect(run("import { load } from '@/__tests__/helpers/disk';\nit('x', () => { load(); });")).toHaveLength(1);
    });

    it('a helper reached through another helper is flagged', () => {
      expect(run("import { load } from './helpers/outer';\nit('x', () => { load(); });")).toHaveLength(1);
    });

    it('a type-only import of a disk-reading module is not flagged', () => {
      expect(run("import type { T } from './helpers/types-only';\nit('x', () => {});")).toEqual([]);
    });

    it('without a way to read local modules, only the test itself is judged (the old behaviour)', () => {
      expect(unlistedTests({ files: [{ path: 'src/__tests__/planted.test.ts', source: "import { load } from './helpers/disk';" }], alwaysRun: LISTS.alwaysRun })).toEqual([]);
    });
  });
});
