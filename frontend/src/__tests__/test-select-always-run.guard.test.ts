/**
 * Guard for test selection (#3257): every test that reads the disk, runs a child process, has a computed import or
 * imports a module from outside the frontend folder (#3402) must be on the always-run list (frontend/scripts/test-select-lists.json), because the test tool's import graph cannot
 * see what such a test depends on: a backend file read from disk, a file spawned, a module named at run time.
 * A test that does any of these and is not listed fails here, naming the file and what to do.
 *
 * Also guards what the narrowed full-run rules of #3402 rest on: no other file under src/ imports from outside the frontend
 * folder, and no workflow on the `workflows` trigger's exception list runs a frontend test.
 *
 * And the shorter list of #3403: a pull request that changes nothing under frontend/ runs only the tests that can be affected
 * from outside it (`outsideReaders`), so that list is held complete the same way, and held free of tests that read only inside.
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
import { FRONTEND_PREFIX, WORKFLOW_TEST_SIGNAL, firesTrigger, matchesAny, needlessOutsideReaders, outsideImports, pathsLeavingFrontend, unlistedOutsideReaders, unlistedTests, type Lists } from '../../scripts/test-select-lib.mjs';

const FRONTEND = resolve(__dirname, '../..');
const REPO = resolve(FRONTEND, '..');
const LISTS: Lists = JSON.parse(readFileSync(join(FRONTEND, 'scripts/test-select-lists.json'), 'utf8'));

/** Every tracked file under src/ whose name matches, with its source, frontend-relative. */
function filesIn(root: string, wanted: RegExp): { path: string; source: string }[] {
  // tracked plus new-but-not-yet-added files, so a file written a minute ago is already judged
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  return tracked.filter((p) => wanted.test(p) && existsSync(join(root, p))).map((path) => ({ path, source: readFileSync(join(root, path), 'utf8') }));
}

/** Every tracked test file under src/ with its source, frontend-relative. The real tree is read once for the whole file. */
const cached = new Map<string, { path: string; source: string }[]>();
const testFilesIn = (root: string) => {
  if (root !== FRONTEND) return filesIn(root, /\.test\.tsx?$/);
  if (!cached.has(root)) cached.set(root, filesIn(root, /\.test\.tsx?$/));
  return cached.get(root)!;
};

/** Reads a local module a test imports: relative or `@/` (= src/), with or without extension or /index. null when it is not a local source file. */
function readLocalIn(root: string) {
  const found = new Map<string, { path: string; source: string } | null>(); // many tests import the same helper: look each one up once
  return (fromPath: string, specifier: string): { path: string; source: string } | null => {
    const base = specifier.startsWith('@/') ? join('src', specifier.slice(2)) : join(dirname(fromPath), specifier);
    if (!found.has(base)) {
      const candidates = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'].map((e) => base + e);
      const hit = candidates.find((c) => existsSync(join(root, c)) && statSync(join(root, c)).isFile());
      found.set(base, hit ? { path: hit, source: readFileSync(join(root, hit), 'utf8') } : null);
    }
    return found.get(base)!;
  };
}
/** The real tree's module reader, shared by every real-tree check in this file. */
const REAL_MODULES = readLocalIn(FRONTEND);

const fix = (offenders: { path: string; signals: string[]; via?: string[] }[]) =>
  offenders.map((o) => `${o.path} (${o.signals.join(', ')}${o.via ? `, through ${o.via.join(' ')}` : ''}): add it to "alwaysRun" in frontend/scripts/test-select-lists.json, by file-name pattern where the name allows`);

describe('the always-run list is complete', () => {
  it('lists every real test that reads the disk, runs a child process or has a computed import', () => {
    expect(fix(unlistedTests({ files: testFilesIn(FRONTEND), alwaysRun: LISTS.alwaysRun, readLocal: REAL_MODULES }))).toEqual([]);
  });

  it('no file under src/ other than a test imports from outside the frontend folder (#3402)', () => {
    // A file deleted or renamed outside frontend/ is not a full run. That is safe only while everything in the frontend that imports
    // from out there is an always-run test. The test above holds tests and their support modules to it; this one holds the rest.
    const others = filesIn(FRONTEND, /\.(?:tsx?|jsx?|mjs|cjs)$/).filter((f) => !/\.test\.tsx?$/.test(f.path));
    const offenders = outsideImports(others).map((o) => `${o.path} imports ${o.specifier}: a file deleted out there would not select the tests that reach this module. Keep the import inside frontend/, or import it from an always-run test only`);
    expect(offenders).toEqual([]);
  });

  it('has no dead entry: every pattern matches at least one tracked test file', () => {
    const paths = testFilesIn(FRONTEND).map((f) => FRONTEND_PREFIX + f.path);
    expect(LISTS.alwaysRun.filter((g) => !paths.some((p) => matchesAny(p, [g])))).toEqual([]);
  });
});

describe('the outside-readers list is complete, and nothing on it reads only inside the frontend folder (#3403)', () => {
  const OUTSIDE = LISTS.outsideReaders ?? [];
  const fixOutside = (offenders: { path: string; signals: string[]; via?: string[] }[]) =>
    offenders.map((o) => `${o.path} (${o.signals.join(', ')}${o.via ? `, through ${o.via.join(' ')}` : ''}): add it to "outsideReaders" in frontend/scripts/test-select-lists.json. A pull request that changes nothing under frontend/ runs only that list`);

  it('lists every real test that imports from outside frontend/, runs a child process or builds a path that leaves frontend/', () => {
    expect(fixOutside(unlistedOutsideReaders({ files: testFilesIn(FRONTEND), outsideReaders: OUTSIDE, readLocal: REAL_MODULES }))).toEqual([]);
  });

  it('lists no test that reads only inside frontend/: such a test cannot be affected by a change outside it', () => {
    expect(needlessOutsideReaders({ files: testFilesIn(FRONTEND), outsideReaders: OUTSIDE, readLocal: REAL_MODULES }).map((p) => `${p}: take it off "outsideReaders"`)).toEqual([]);
  });

  it('has no dead entry, and every outside reader is on the always-run list too', () => {
    const paths = testFilesIn(FRONTEND).map((f) => FRONTEND_PREFIX + f.path);
    expect(OUTSIDE.length).toBeGreaterThan(0);
    expect(OUTSIDE.filter((g) => !paths.some((p) => matchesAny(p, [g])))).toEqual([]);
    expect(paths.filter((p) => matchesAny(p, OUTSIDE) && !matchesAny(p, LISTS.alwaysRun))).toEqual([]);
  });

  it('is much shorter than the always-run list (the point of the rule)', () => {
    const paths = testFilesIn(FRONTEND).map((f) => FRONTEND_PREFIX + f.path);
    const outside = paths.filter((p) => matchesAny(p, OUTSIDE)).length;
    const always = paths.filter((p) => matchesAny(p, LISTS.alwaysRun)).length;
    expect(outside).toBeLessThan(always / 2);
  });

  const TEST = 'src/__tests__/planted.test.ts';
  const plantOutside = (source: string, readLocal?: Parameters<typeof unlistedOutsideReaders>[0]['readLocal']) => unlistedOutsideReaders({ files: [{ path: TEST, source }], outsideReaders: OUTSIDE, readLocal });

  it('a planted test that reads a backend file and is not on the list is named', () => {
    const [o] = plantOutside("import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nit('x', () => { readFileSync(join(__dirname, '..', '..', '..', 'backend', 'prisma', 'schema.prisma'), 'utf8'); });");
    expect(o).toEqual({ path: TEST, signals: ['path-leaves-frontend'] });
  });

  it('a planted test that reads the disk only inside frontend/ is not named', () => {
    expect(plantOutside("import { readFileSync } from 'node:fs';\nimport { join, resolve } from 'node:path';\nconst FRONTEND = resolve(__dirname, '../..');\nit('x', () => { readFileSync(join(FRONTEND, 'vercel.json'), 'utf8'); readFileSync(join(__dirname, '../design-system/tokens.css'), 'utf8'); });")).toEqual([]);
  });

  it('a planted test that runs a child process is named: what the child reads cannot be seen', () => {
    expect(plantOutside("import { execFileSync } from 'node:child_process';\nit('x', () => { execFileSync('git', ['ls-files']); });")[0].signals).toEqual(['runs-child-process']);
  });

  it('a planted test that imports a module from outside frontend/ is named', () => {
    expect(plantOutside("import { SORT_FIELDS } from '../../../backend/src/lib/sortFields';\nit('x', () => {});")[0].signals).toEqual(['imports-outside-frontend']);
  });

  it('a planted test that reaches outside only through a frontend script it imports is named, with the script', () => {
    const script = { path: 'scripts/reads-backend.mjs', source: "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const load = () => readFileSync(join(import.meta.dirname, '../../backend/src/catalog.ts'), 'utf8');" };
    const readLocal = (_from: string, spec: string) => (spec === '../../scripts/reads-backend.mjs' ? script : null);
    const [o] = plantOutside("import { load } from '../../scripts/reads-backend.mjs';\nit('x', () => { load(); });", readLocal);
    expect(o).toEqual({ path: TEST, signals: ['path-leaves-frontend'], via: ['scripts/reads-backend.mjs'] });
  });

  it('application code is not followed: the import graph covers it, and it cannot read the disk', () => {
    const app = { path: 'src/lib/thing.ts', source: "const p = join(__dirname, '../../../backend');" };
    expect(plantOutside("import { thing } from '../lib/thing';\nit('x', () => {});", () => app)).toEqual([]);
  });

  it('a planted test that is on the list is not named', () => {
    const files = [{ path: 'src/__tests__/test-select-planted.test.ts', source: "import { execFileSync } from 'node:child_process';" }];
    expect(unlistedOutsideReaders({ files, outsideReaders: OUTSIDE })).toEqual([]);
  });

  describe('which paths leave the frontend folder', () => {
    const leaves = (source: string, path = TEST) => pathsLeavingFrontend({ path, source });
    it.each<[string, string, string[]]>([
      ['three steps up from src/__tests__', "join(__dirname, '..', '..', '..', 'backend')", ['path-leaves-frontend']],
      ['three steps up in one string', "resolve(__dirname, '../../../backend/src')", ['path-leaves-frontend']],
      ['two steps up: the frontend folder itself', "resolve(__dirname, '../..')", []],
      ['a file in the frontend folder', "join(__dirname, '../../vercel.json')", []],
      ['a path built in two steps', "const FRONTEND = resolve(__dirname, '../..');\nconst REPO = resolve(FRONTEND, '..');", ['path-leaves-frontend']],
      ['a path built in two steps that stays inside', "const FRONTEND = resolve(__dirname, '../..');\nconst SRC = join(FRONTEND, 'src');", []],
      ['from this file by its URL', "const here = dirname(fileURLToPath(import.meta.url));\njoin(here, '../../../render.yaml')", ['path-leaves-frontend']],
      ['from this file by its URL, staying inside', "const here = dirname(fileURLToPath(import.meta.url));\njoin(here, '../../index.html')", []],
      ['a URL relative to this file', "new URL('../../../backend/x.ts', import.meta.url)", ['path-leaves-frontend']],
      ['from the working folder (the frontend folder), one step up', "join(process.cwd(), '..', 'backend')", ['path-leaves-frontend']],
      ['from the working folder, staying inside', "join(process.cwd(), 'src')", []],
      ['a bare relative path handed to the file system', "readFileSync('../backend/a.ts')", ['path-leaves-frontend']],
      ['a step up from something that cannot be followed', "join(someFolder(), '..', 'x')", ['climbs-from-unknown-base']],
      ['a step up inside a template string', 'const p = `${ROOT}/../backend`;', ['climbs-from-unknown-base']],
      ['a variable segment after a path that stays inside', "join(__dirname, '..', name)", []],
      ['a relative specifier in a list (not a path from the working folder)', "it.each(['../../instrument'])('x', async (e) => { await import(e); });", []],
      ['a path named only in a comment', "// see ../../../backend/x\nconst a = 1; /* join(__dirname, '../../../x') */", []],
    ])('%s', (_name, source, expected) => {
      expect(leaves(source)).toEqual(expected);
    });

    it('counts the steps from the file that builds the path, so a deeper file can climb further and stay inside', () => {
      const five = "const ROOT = join(__dirname, '..', '..', '..', '..', '..');";
      expect(leaves(five, 'src/pages/v2/auth-public/__tests__/x.test.ts')).toEqual([]);
      expect(leaves(five, 'src/features/estimate-workspace/components/x.test.ts')).toEqual(['path-leaves-frontend']);
    });
  });
});

describe('only real guards always run by their name (#3403, the #3374 item)', () => {
  it('a guard is named *.guard.test.*; a test that only has the word in its name is not on the list for it', () => {
    expect(LISTS.alwaysRun).toContain('frontend/src/**/*.guard.test.{ts,tsx}');
    expect(LISTS.alwaysRun.filter((g) => /\*guard\*/.test(g))).toEqual([]);
    for (const name of ['create-forms-leave-guard.test.tsx', 'create-task-dirty-guard.test.tsx', 'settings-unsaved-guard.test.tsx', 'dirty-guard-strict-mode.test.tsx']) {
      expect(matchesAny(`frontend/src/__tests__/${name}`, LISTS.alwaysRun)).toBe(false);
    }
    expect(matchesAny('frontend/src/__tests__/harness/page-harnesses.guard.test.ts', LISTS.alwaysRun)).toBe(true);
  });
});

describe("the full-run triggers' exceptions cannot reach the frontend tests (#3402)", () => {
  const excepted = LISTS.triggers.flatMap((t) => (t.except ?? []).map((path) => ({ trigger: t, path })));
  const workflows = excepted.filter((e) => e.trigger.code === 'workflows').map((e) => e.path);

  it('has no dead entry: every exception is a file in the repository, under its own trigger, and no longer fires it', () => {
    expect(excepted.length).toBeGreaterThan(0);
    expect(excepted.filter((e) => !existsSync(join(REPO, e.path)) || !matchesAny(e.path, e.trigger.patterns) || firesTrigger(e.trigger, e.path)).map((e) => e.path)).toEqual([]);
  });

  it('no workflow on the exception list runs a frontend test or pulls in a local workflow or action', () => {
    const offenders = workflows.filter((path) => WORKFLOW_TEST_SIGNAL.test(readFileSync(join(REPO, path), 'utf8')));
    expect(offenders.map((path) => `${path}: take it off "except" of the workflows trigger in frontend/scripts/test-select-lists.json, a change to it must be a full run`)).toEqual([]);
  });

  it('the CI workflow and the nightly workflow show the signal, so they could never be listed unnoticed', () => {
    for (const path of ['.github/workflows/ci.yml', '.github/workflows/ci-nightly.yml']) {
      expect(WORKFLOW_TEST_SIGNAL.test(readFileSync(join(REPO, path), 'utf8'))).toBe(true);
      expect(workflows).not.toContain(path);
    }
  });

  it.each([
    ['run: npm run test:ci -- --events=x', true],
    ['run: npx vitest run', true],
    ['run: npm test -- --retry=2', true],
    ['run: npx playwright test', true],
    ['uses: ./.github/actions/setup', true],
    ['uses: ./.github/workflows/ci.yml', true],
    ['run: node scripts/ci-budget/run.mjs', false],
    ['uses: actions/checkout@v7', false],
    ['run: npm audit --omit=dev', false],
  ])('the signal on a planted workflow line: %s -> %s', (line, expected) => {
    expect(WORKFLOW_TEST_SIGNAL.test(line)).toBe(expected);
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

  it('a test that imports a module from outside the frontend folder (#3402)', () => {
    expect(plant("import { SORT_FIELDS } from '../../../backend/src/lib/sortFields';\nit('x', () => {});")[0]).toMatchObject({ path: 'src/__tests__/planted.test.ts', signals: ['imports-outside-frontend'] });
  });

  it('a test whose imports stay inside the frontend folder is not flagged', () => {
    expect(plant("import { verdict } from '../../scripts/test-ci-lib.mjs';\nimport { x } from '@/lib/x';\nimport type { T } from '../../../backend/src/types';\nit('x', () => {});")).toEqual([]);
  });

  it('a test that is listed by a pattern is not flagged', () => {
    const files = [{ path: 'src/__tests__/planted.guard.test.ts', source: "import fs from 'node:fs';" }];
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
      'src/__tests__/helpers/backend.ts': "export { SORT_FIELDS } from '../../../../backend/src/lib/sortFields';",
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

    it('a helper that imports from outside the frontend folder is flagged, naming the helper (#3402)', () => {
      const [o] = run("import { SORT_FIELDS } from './helpers/backend';\nit('x', () => {});");
      expect(o).toMatchObject({ signals: ['imports-outside-frontend'], via: ['src/__tests__/helpers/backend.ts'] });
    });

    it('a type-only import of a disk-reading module is not flagged', () => {
      expect(run("import type { T } from './helpers/types-only';\nit('x', () => {});")).toEqual([]);
    });

    it('without a way to read local modules, only the test itself is judged (the old behaviour)', () => {
      expect(unlistedTests({ files: [{ path: 'src/__tests__/planted.test.ts', source: "import { load } from './helpers/disk';" }], alwaysRun: LISTS.alwaysRun })).toEqual([]);
    });
  });
});
