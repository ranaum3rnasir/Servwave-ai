/**
 * Test selection (#3257) through the real command: `npm run test:ci` run over a throw-away repository that is
 * shaped like a pull request's merge ref (base moved on after the branch point, HEAD a two-parent merge), with three
 * tiny test files and the real test tool. Checks the three values of the variable end to end: off is today's run,
 * shadow runs everything and logs what it would have selected beside what failed, on runs the selection.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cleanUp, changeA, pullRequest, prEnv, ran, run, write } from './support/testSelectRun';

afterAll(cleanUp);

describe('npm run test:ci with test selection, over a real merge ref', () => {
  it('on: a one-file change runs the tests that reach it plus the always-run list, and the verdict line says so', async () => {
    const pr = pullRequest({ change: changeA });
    const o = await run(pr, prEnv(pr, 'on'));
    expect(o.code).toBe(0);
    expect(o.out).toContain('test-select: on: selected 2 of 3, reason=changed-files');
    expect(o.verdict).toBe('TEST-CI-VERDICT result=passed code=0 reasons=none mode=selected-2-of-3 selection=changed-files files=2/2 passed=2 failed=0 retried=0');
    expect(ran(o)).toEqual(['src/__tests__/disk.guard.test.ts', 'src/a.test.ts']);
    expect(o.summary).toContain('Selection (on): selected 2 of 3, reason=changed-files');
  }, 120_000);

  it('on: a backend-only pull request runs only the tests that read outside the frontend folder, with a reason of its own (#3403)', async () => {
    const pr = pullRequest({ change: (root) => write(root, 'backend/src/x.ts', 'export const x = 1;\n'), outsideReader: true });
    const o = await run(pr, prEnv(pr, 'on'));
    expect(o.code).toBe(0);
    expect(o.out).toContain('test-select: on: selected 1 of 4, reason=no-frontend-change');
    expect(o.verdict).toBe('TEST-CI-VERDICT result=passed code=0 reasons=none mode=selected-1-of-4 selection=no-frontend-change files=1/1 passed=1 failed=0 retried=0');
    expect(ran(o)).toEqual(['src/__tests__/test-select-outside.test.ts']);
    expect(o.summary).toContain('Selection (on): selected 1 of 4, reason=no-frontend-change');
  }, 120_000);

  it('on: a lockfile change is a full run, reason=lockfile', async () => {
    const pr = pullRequest({ change: (root) => write(root, 'package-lock.json', '{"changed":true}') });
    const o = await run(pr, prEnv(pr, 'on'));
    expect(o.code).toBe(0);
    expect(o.out).toContain('test-select: on: full, reason=lockfile');
    expect(o.verdict).toContain('mode=full selection=lockfile files=3/3');
    expect(ran(o)).toHaveLength(3);
  }, 120_000);

  it('on: a promotion pull request into main is a full run', async () => {
    const pr = pullRequest({ change: changeA });
    const o = await run(pr, { ...prEnv(pr, 'on'), GITHUB_BASE_REF: 'main' });
    expect(o.verdict).toContain('mode=full selection=promotion-into-main files=3/3');
  }, 120_000);

  it('on: the hosted fallback (a shard) refuses selection and runs its whole slice', async () => {
    const pr = pullRequest({ change: changeA });
    const o = await run(pr, prEnv(pr, 'on'), ['--shard=1/2']);
    expect(o.out).toContain('test-select: on: full, reason=hosted-shard');
    expect(o.verdict).toContain('mode=shard-1-of-2 selection=hosted-shard');
    expect(ran(o)).toHaveLength(2); // 3 files, slice 1 of 2
  }, 120_000);

  it('on: a selector that cannot decide (the event head is not what the checkout merged) is a full, green run', async () => {
    const pr = pullRequest({ change: changeA });
    const o = await run(pr, { ...prEnv(pr, 'on'), PR_HEAD_SHA: '0000000000000000000000000000000000000000' });
    expect(o.code).toBe(0);
    expect(o.verdict).toContain('mode=full selection=head-mismatch files=3/3');
  }, 120_000);

});
