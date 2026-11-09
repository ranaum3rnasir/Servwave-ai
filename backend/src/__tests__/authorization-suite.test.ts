/* =============================================================================
   Roles & Permissions alignment, P20: the authorization tests are a release gate.

   The suite is a list (authorization-suite.ts) and a config that runs it. This test keeps the list true and keeps CI running it:
   every file it names exists, every ticket names at least one, the real-database ones are in the list the Database command runs, and
   ci.yml runs the suite as a named step on pull requests and on every push to main, except the ONE push whose tree the merged pull
   request's own run already tested in full (#3240): the condition is pinned below, step by step.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { AUTHORIZATION_SUITE, AUTHORIZATION_SUITE_FILES } from './authorization-suite';
import { dbCommandList } from './support/db-command-list';

const BACKEND = path.resolve(__dirname, '../..');
const CI = readFileSync(path.resolve(BACKEND, '../.github/workflows/ci.yml'), 'utf8');
// js-yaml ships no types of its own; only `load` is used.
const { load } = require('js-yaml') as { load(text: string): unknown };
type Step = { name?: string; if?: string | boolean; uses?: string; run?: string; id?: string; env?: Record<string, string> };
type Job = { name?: string; if?: string; permissions?: Record<string, string>; outputs?: Record<string, string>; steps?: Step[] };
const workflow = load(CI) as { jobs: Record<string, Job> };

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

  it('has its real-database suites in the Database command: every one is in the list it runs, and the list has a floor', () => {
    const expected = dbCommandList();
    expect(expected.all.length).toBeGreaterThanOrEqual(380);
    const authorizationDb = AUTHORIZATION_SUITE_FILES.filter((f) => f.endsWith('-db.test.ts')).map((f) => `src/__tests__/${f}`);
    expect(authorizationDb.length).toBeGreaterThan(30);
    for (const file of authorizationDb) expect(expected.all, `${file} is not run by the Database command`).toContain(file);
    const permissionDb = readdirSync(__dirname).filter((f) => /^permission-.*-db\.test\.ts$/.test(f)).map((f) => `src/__tests__/${f}`);
    expect(permissionDb.length).toBeGreaterThan(50);
    for (const file of permissionDb) expect(expected.all, `${file} is not run by the Database command`).toContain(file);
  });

  it('skips the Database lanes on pull requests only: a push to main always runs the real-database authorization suites, whatever it changed', () => {
    // The real entry point of the command, asked what it would do. A push never skips, even when every path it changed is on the
    // skip list (the rule's own table is in scripts/ci-db/__tests__/skip.test.ts); neither does a run with no event at all.
    expect(dbCommandList({ GITHUB_EVENT_NAME: 'push' }).skip).toEqual({ skip: false, reason: 'not-a-pull-request: push' });
    expect(dbCommandList({ GITHUB_EVENT_NAME: '' }).skip).toEqual({ skip: false, reason: 'not-a-pull-request: (none)' });
    // And a pull request whose changed paths cannot be read runs too (fail-open).
    const unreadable = dbCommandList({ GITHUB_EVENT_NAME: 'pull_request', DB_CHECK_DIFF_DIR: '/nonexistent-folder-for-the-skip-guard' }).skip;
    expect(unreadable.skip).toBe(false);
    expect(unreadable.reason).toMatch(/^changed-paths-unreadable/);
    // Nothing in the workflow can make a push look like a pull request or hide the gate: the event name is GitHub's own, the push
    // trigger carries no path filter, and the command that decides runs unconditionally.
    expect(CI).not.toMatch(/GITHUB_EVENT_NAME\s*[:=]/);
    expect(CI).not.toMatch(/paths(-ignore)?:/);
    const push = /^ {2}push:\n([\s\S]*?)(?=^\S)/m.exec(CI)![1]!;
    expect(push.replace(/^\s*#.*$/gm, '').trim()).toBe('branches: [main]');
  });

  it('runs in ci.yml as a named step of the Backend job, on pull requests and on every push to main', () => {
    expect(CI).toMatch(/- name: Authorization suite \(release gate\)\n\s+if: \$\{\{ needs\.pick-runners\.outputs\.tree_skip != 'true' \}\}\n\s+working-directory: backend\n\s+run: npm run test:authorization/);
    expect(CI).toMatch(/on:\n\s+pull_request:\n\s+branches: \[staging, main, servwave\]\n[\s\S]*?\n\s+push:\n\s+branches: \[main\]/);
    // The step sits in the Backend job, which branch protection requires.
    const backend = /^ {2}backend:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n)/m.exec(CI)![1]!;
    expect(backend).toContain('Authorization suite (release gate)');
  });

  // #3240. Ran narrowed the rule on 2026-11-05: a push to main runs the authorization gate EXCEPT when the pushed tree is the tree the
  // merged pull request's run already tested, with all three heavy checks green and full. These pins make that the only way out.
  describe('the one condition under which a push to main skips the gate (#3240)', () => {
    const NOT_TESTED = "needs.pick-runners.outputs.tree_skip != 'true'";
    const pick = workflow.jobs['pick-runners']!;
    const treeStep = pick.steps!.find((st) => st.id === 'tree')!;

    it('puts exactly that condition on the Authorization suite step, and on the Backend steps around it', () => {
      const backend = workflow.jobs.backend!.steps!;
      const gate = backend.find((st) => st.name === 'Authorization suite (release gate)')!;
      expect(gate.if).toBe(`\${{ ${NOT_TESTED} }}`);
      expect(gate.run).toContain('npm run test:authorization');
      // Nothing else in the step can make it skip: no continue-on-error, no second condition.
      expect(Object.keys(gate)).not.toContain('continue-on-error');
      for (const st of backend.filter((x) => !(x.name ?? '').startsWith('Tested tree ') && x.name !== 'Read the tested tree' && x.name !== 'Identical tree already tested')) {
        expect(st.if, st.name ?? st.uses).toBe(`\${{ ${NOT_TESTED} }}`);
      }
    });

    it('lets the output be "true" only from the main-push step, which runs on a push to main and nothing else', () => {
      expect(pick.outputs!.tree_skip).toBe('${{ steps.tree.outputs.skip }}');
      expect(treeStep.if).toBe("${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}");
      expect(treeStep.run).toBe('node scripts/ci-main-skip/run.mjs');
      // Every line of the workflow that names the output is its declaration or a step/job condition on it: nothing else reads or sets it.
      const lines = CI.split('\n').filter((l) => l.includes('tree_skip') && !/^\s*#/.test(l));
      expect(lines.length).toBeGreaterThan(15);
      for (const l of lines) {
        expect(l, l).toMatch(/^\s+(tree_skip: \$\{\{ steps\.tree\.outputs\.skip \}\}|if: \$\{\{ [^}]*needs\.pick-runners\.outputs\.tree_skip (!=|==) 'true'[^}]* \}\})$/);
      }
      expect(CI).not.toMatch(/echo "?skip=/);
    });

    it('reads GitHub with the workflow token and nothing else: read-only Actions, pull requests and contents, no secret', () => {
      expect(pick.permissions).toEqual({ contents: 'read', actions: 'read', 'pull-requests': 'read' });
      expect(treeStep.env).toEqual({ GITHUB_TOKEN: '${{ github.token }}' });
      expect(treeStep['continue-on-error' as keyof Step]).toBe(true);
    });

    it('leaves the pull-request run, the staging branch and the promotion pull request itself on the full gate', () => {
      // The trigger is unchanged (a push to main only), the main-push step has no way to answer "true" for a pull request event, and
      // the decision refuses every event but a push to main (table: scripts/ci-main-skip/lib.test.mjs).
      const push = /^ {2}push:\n([\s\S]*?)(?=^\S)/m.exec(CI)![1]!;
      expect(push.replace(/^\s*#.*$/gm, '').trim()).toBe('branches: [main]');
      expect(String(treeStep.if)).toContain("github.ref == 'refs/heads/main'");
    });
  });
});
