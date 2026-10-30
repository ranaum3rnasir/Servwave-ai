/* =============================================================================
   Roles & Permissions alignment, P20: the authorization tests are a release gate.

   The suite is a list (authorization-suite.ts) and a config that runs it. This test keeps the list true and keeps CI running it:
   every file it names exists, every ticket names at least one, the real-database ones are dealt to a Database job shard, and
   ci.yml runs the suite as a named step on pull requests and on every push to main.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { AUTHORIZATION_SUITE, AUTHORIZATION_SUITE_FILES } from './authorization-suite';

const BACKEND = path.resolve(__dirname, '../..');
const CI = readFileSync(path.resolve(BACKEND, '../.github/workflows/ci.yml'), 'utf8');

describe('the authorization suite', () => {
  it('names at least one proving test for every ticket', () => {
    expect(Object.keys(AUTHORIZATION_SUITE).length).toBeGreaterThanOrEqual(18);
    for (const [ticket, files] of Object.entries(AUTHORIZATION_SUITE)) expect(files.length, ticket).toBeGreaterThan(0);
  });

  it('names only files that exist', () => {
    for (const file of AUTHORIZATION_SUITE_FILES) expect(existsSync(path.join(__dirname, file)), file).toBe(true);
  });

  it('is run by an npm script whose config includes every named file and every permission-* test', () => {
    const pkg = JSON.parse(readFileSync(path.join(BACKEND, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:authorization']).toContain('vitest.authorization.config.ts');
    const config = readFileSync(path.join(BACKEND, 'vitest.authorization.config.ts'), 'utf8');
    expect(config).toContain('AUTHORIZATION_SUITE_FILES');
    expect(config).toContain("'src/__tests__/permission-*.test.ts'");
    expect(readdirSync(__dirname).filter((f) => /^permission-.*\.test\.ts$/.test(f)).length).toBeGreaterThan(50);
  });

  it('has its real-database suites in the Database job: none of them has a step of its own that leaves it out of the shards', () => {
    const skipped = (/DB_SUITES_SKIP: '([^']+)'/.exec(CI)?.[1] ?? '').split('|');
    for (const file of AUTHORIZATION_SUITE_FILES.filter((f) => f.endsWith('-db.test.ts'))) {
      expect(skipped.some((name) => file === `${name}-db.test.ts`), `${file} is skipped by the shards`).toBe(false);
    }
  });

  it('runs in ci.yml as a named step of the Backend job, on pull requests and on every push to main', () => {
    expect(CI).toMatch(/- name: Authorization suite \(release gate\)\n\s+working-directory: backend\n\s+run: npm run test:authorization/);
    expect(CI).toMatch(/on:\n\s+pull_request:\n\s+branches: \[staging, main, servwave\]\n[\s\S]*?\n\s+push:\n\s+branches: \[main\]/);
    // The step sits in the Backend job, which branch protection requires.
    const backend = /^ {2}backend:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n)/m.exec(CI)![1]!;
    expect(backend).toContain('Authorization suite (release gate)');
  });
});
