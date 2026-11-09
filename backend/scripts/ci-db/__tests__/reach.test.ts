/**
 * The premise of the path-skip rule (#3238): no real-database suite, and no helper one imports, reads a path above the backend folder
 * (so a change to the frontend, the docs or the agent tooling cannot change what the suites see). This is the analysis the guard in
 * scripts/__tests__/ci-db-suites.test.ts runs over every suite; here it is tried on planted source, so a guard that finds nothing is
 * known to be able to find something.
 */
import { describe, it, expect } from 'vitest';
import { pathsAboveBackend, importsOf } from '../reach';

/** Source of a file in `dir` (relative to the backend folder) -> what it reads above the backend folder. */
const above = (dir: string, source: string) => pathsAboveBackend(source, dir);

describe('reads above the backend folder, found in source', () => {
  it.each([
    ['a path built from the file\'s folder, climbing out of the backend', 'src/__tests__', "const f = join(__dirname, '..', '..', '..', 'docs', 'ci.md');"],
    ['the same with one string', 'src/__tests__', "const f = path.join(__dirname, '../../../frontend/src/x.ts');"],
    ['with resolve', 'src/__tests__', "readFileSync(path.resolve(__dirname, '../../../.github/workflows/ci.yml'), 'utf8');"],
    ['from a deeper file', 'scripts/ci-db/__tests__', "join(__dirname, '../../../../frontend')"],
    ['from the working folder (the backend folder under the test tool)', 'src/lib', "join(process.cwd(), '..', 'frontend', 'package.json')"],
    ['through a constant', 'src/__tests__', "const ROOT = path.resolve(__dirname, '../../..');\nconst DOCS = path.join(ROOT, 'docs');"],
    ['through a constant of a constant', 'src/__tests__', "const BACKEND = path.resolve(__dirname, '../..');\nconst ROOT = path.join(BACKEND, '..');\nreadFileSync(join(ROOT, 'README.md'))"],
    ['a relative name given to a file function (relative to the working folder)', 'src/__tests__', "readFileSync('../frontend/package.json', 'utf8')"],
    ['a working-folder path joined by plain concatenation', 'src/__tests__', "readFileSync(process.cwd() + '/../docs/ci.md')"],
    ['a working-folder path inside a template', 'src/__tests__', 'readFileSync(`${process.cwd()}/../docs/ci.md`)'],
    ['the repository root asked from git', 'src/__tests__', "execSync('git rev-parse --show-toplevel')"],
    ['a path it cannot work out that climbs', 'src/__tests__', "join(SOMEWHERE_IMPORTED, '..', 'docs')"],
    ['a known part that climbs out, with a name after it that it cannot work out', 'src/__tests__', "join(__dirname, '../../..', SOME_NAME)"],
  ])('%s', (_what, dir, source) => {
    expect(above(dir, source).length, source).toBeGreaterThan(0);
  });
});

describe('reads inside the backend folder, and text that only looks like a read, are not found', () => {
  it.each([
    ['the schema', 'src/__tests__', "join(__dirname, '..', '..', 'prisma', 'schema.prisma')"],
    ['a migration', 'src/__tests__', "join(__dirname, '../../prisma/migrations/2026_x/migration.sql')"],
    ['a sibling folder of the sources', 'src/__tests__', "join(__dirname, '..', 'routes')"],
    ['the backend\'s own env file', 'src/__tests__', "readFileSync(join(__dirname, '../../.env'))"],
    ['the backend folder from a script test', 'scripts/ci-db/__tests__', "const BACKEND = path.resolve(__dirname, '../../..');"],
    ['the working folder', 'src/__tests__', "createRequire(process.cwd() + '/')"],
    ['joining plain names', 'src/__tests__', "const s = parts.join('..');"],
    ['an array join', 'src/__tests__', "['a', 'b'].join(' · ')"],
    ['a comment that names a path', 'src/__tests__', "// join(__dirname, '../../../docs')\n/* readFileSync('../frontend/x') */ const a = 1;"],
    ['a known part inside the backend folder, with a name after it that it cannot work out', 'src/__tests__', "join(__dirname, '..', '..', 'prisma', 'migrations', MIGRATION_NAME, 'migration.sql')"],
    ['the installed packages of the workspace root (only a manifest or lockfile change alters them)', 'scripts/ci-db', "join(backendDir, '..', 'node_modules/.bin')"],
    ['the installed packages of the workspace root, from a known folder', 'src/__tests__', "join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx')"],
    ['an import of a sibling', 'src/__tests__', "import { x } from '../../../src/lib/x';"],
  ])('%s', (_what, dir, source) => {
    expect(above(dir, source), source).toEqual([]);
  });

  it('names what it found, with the file function or the path', () => {
    const found = above('src/__tests__', "const f = join(__dirname, '..', '..', '..', 'docs', 'ci.md');");
    expect(found[0]).toContain('../docs/ci.md');
  });
});

describe('the files a file brings in', () => {
  it('lists relative imports, exports, requires, dynamic imports and mocks, and ignores packages', () => {
    const source = `
      import { a } from './a';
      import type { B } from '../b';
      export { c } from "./c";
      export * from './d';
      const e = require('./e');
      const f = await import('../f');
      vi.mock('./g', () => ({}));
      import express from 'express';
      import fs from 'node:fs';
      // import { z } from './commented';
    `;
    expect(importsOf(source).sort()).toEqual(['../b', '../f', './a', './c', './d', './e', './g']);
  });

  it('reads the source alias as the sources folder', () => {
    expect(importsOf("import { x } from '@/lib/x';")).toEqual(['@/lib/x']);
  });
});
