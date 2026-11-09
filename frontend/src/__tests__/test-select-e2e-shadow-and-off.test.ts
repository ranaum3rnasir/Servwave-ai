/**
 * Test selection (#3257) through the real command, second half (see test-select-e2e.test.ts): the shadow value logs what it
 * would have selected beside what failed, off is today's run, and an unrecognised value is a full run.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cleanUp, changeA, pullRequest, B_BROKEN, prEnv, ran, run } from './support/testSelectRun';

afterAll(cleanUp);

describe('npm run test:ci with test selection, over a real merge ref', () => {
  it('shadow: runs every file, and logs what it would have run beside what failed (a miss is a failing file outside it)', async () => {
    const pr = pullRequest({ change: changeA, bTest: B_BROKEN });
    const o = await run(pr, prEnv(pr, 'shadow'));
    expect(o.code).toBe(10); // red because b.test.ts fails by itself, not because of the selector
    expect(o.verdict).toContain('mode=full selection=shadow files=3/3');
    expect(o.out).toContain('TEST-SELECT-SHADOW would=selected-2-of-3 reason=changed-files failing=1 misses=1');
    expect(o.out).toContain('TEST-SELECT-SHADOW-MISS src/b.test.ts');
    expect(ran(o)).toHaveLength(3);
    expect(o.summary).toContain('Selection (shadow): this run ran every test file.');
    expect(o.summary).toContain('- src/b.test.ts');
  }, 120_000);

  it('shadow: a green run logs zero misses', async () => {
    const pr = pullRequest({ change: changeA });
    const o = await run(pr, prEnv(pr, 'shadow'));
    expect(o.code).toBe(0);
    expect(o.out).toContain('TEST-SELECT-SHADOW would=selected-2-of-3 reason=changed-files failing=0 misses=0');
  }, 120_000);

  it.each([[undefined], ['off'], ['']])('off (variable %j): exactly the full run, no selection output and no selection token', async (value) => {
    const pr = pullRequest({ change: changeA });
    const env = value === undefined ? { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'staging', PR_HEAD_SHA: pr.head } : prEnv(pr, value);
    const o = await run(pr, env);
    expect(o.code).toBe(0);
    expect(o.out).not.toContain('test-select:');
    expect(o.out).not.toContain('TEST-SELECT');
    expect(o.verdict).toBe('TEST-CI-VERDICT result=passed code=0 reasons=none mode=full files=3/3 passed=3 failed=0 retried=0');
    expect(o.summary).not.toContain('Selection');
  }, 120_000);

  it('an unrecognised value is a full run, not a guess', async () => {
    const pr = pullRequest({ change: changeA });
    const o = await run(pr, prEnv(pr, 'yes'));
    expect(o.code).toBe(0);
    expect(o.verdict).toContain('mode=full selection=invalid-mode files=3/3');
  }, 120_000);
});
