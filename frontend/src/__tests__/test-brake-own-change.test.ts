/**
 * The test-file count and the per-page ceilings are judged on the pull request's OWN change against its base
 * (Ran's decision R10), not on absolute totals. These tests build the real thing in a temporary git repo, with the
 * merge-base the brake takes, and drive the real disk-and-git side (judgeGrowth). New file because: this is the only
 * test that needs git; test-brake-lib.test.ts is pure functions.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { changedFiles, judgeGrowth } from '../../scripts/test-brake-io.mjs';
import { COUNT_IN_OLD_PLACE_REASON } from '../../scripts/test-brake-lib.mjs';

const PAGE = 'src/pages/v2/jobs/JobDetailPage.tsx';
const ROOT = mkdtempSync(join(tmpdir(), 'brake-own-change-'));
const FRONTEND = join(ROOT, 'frontend');
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(FRONTEND, path)), { recursive: true });
  writeFileSync(join(FRONTEND, path), text);
};
const mountingTest = `import { JobDetailPage } from '../pages/v2/jobs/JobDetailPage';\nexport const x = JobDetailPage;\n`;
const plainTest = `export const x = 1;\n`;
const setJson = (name: string, value: unknown) => put(name, `${JSON.stringify(value, null, 2)}\n`);
/** The count lives in its own file (#3401); the budget file beside it carries the real budgets and no count. */
const setBudget = (maxTestFiles: number) => {
  setJson('test-budget.json', { maxCpuSeconds: 4500, maxMinutes: 10, workers: 6 });
  setJson('test-file-count.json', { maxTestFiles });
};
const setCeiling = (n: number) => setJson('test-page-ceilings.json', { [PAGE]: n });
const commit = (msg: string) => { git('add', '-A'); git('commit', '-q', '-m', msg); };
const judge = (opts: { base?: string; env?: Record<string, string | undefined> } = {}) =>
  judgeGrowth(FRONTEND, { base: opts.base, env: opts.env ?? {} });
/** pretend `origin/staging` is this commit (the repo has no remote) */
const setStaging = (sha = 'HEAD') => git('update-ref', 'refs/remotes/origin/staging', git('rev-parse', sha));

describe('judged on the pull request\'s own change', () => {
  // staging at the start: 2 test files, both mount the page, ceiling 3 (so one more fits), maxTestFiles 2
  it('builds the base', () => {
    git('init', '-q', '-b', 'main');
    put(PAGE, 'export const JobDetailPage = () => null;\n');
    put('src/__tests__/one.test.tsx', mountingTest);
    put('src/__tests__/two.test.tsx', mountingTest);
    setBudget(2);
    setCeiling(3);
    commit('base');
    setStaging();
    expect(judge().fileCount?.status).toBe('passed');
  });

  it('two pull requests that each add a mounting test file and raise the numbers merge cleanly; a third, unrelated one stays green', () => {
    git('checkout', '-q', '-b', 'pr-a', 'main');
    put('src/__tests__/a.test.tsx', mountingTest);
    setBudget(3);
    setCeiling(3);
    commit('pr a');
    expect(judge()).toMatchObject({ pages: { status: 'passed' }, fileCount: { status: 'passed', judged: 'own-change' } });

    git('checkout', '-q', '-b', 'pr-b', 'main');
    put('src/__tests__/b.test.tsx', mountingTest);
    setBudget(3);
    setCeiling(3);
    commit('pr b');
    expect(judge().fileCount?.status).toBe('passed');

    // staging takes both: the identical edits to the two JSON files merge without a conflict
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge a', 'pr-a');
    git('merge', '-q', '--no-ff', '-m', 'merge b', 'pr-b');
    setStaging();
    // 4 test files against maxTestFiles 3, 4 files mounting the page against a ceiling of 3: the absolute numbers are red,
    // and a run with no base does not judge them at all
    const merged = judgeGrowth(FRONTEND, { base: 'origin/does-not-exist', env: {} });
    expect(merged.resolved).toBeNull();
    expect(merged.fileCount).toMatchObject({ status: 'not-judged', judged: 'none' });
    expect(merged.pages).toMatchObject({ status: 'not-judged', judged: 'none' });

    // the third pull request changes neither number: green, whatever the base holds
    git('checkout', '-q', '-b', 'pr-c', 'main');
    put('src/lib/unrelated.ts', 'export const y = 2;\n');
    commit('pr c');
    const third = judge();
    expect(third.resolved?.ref).toBe('origin/staging');
    expect(third.fileCount).toMatchObject({ status: 'passed', judged: 'own-change' });
    expect(third.pages).toMatchObject({ status: 'passed', judged: 'own-change' });
  });

  it('a third pull request branched BEFORE the merges, judged on its merge with staging, is green too', () => {
    git('checkout', '-q', '-b', 'pr-d', 'pr-a~1');
    put('src/lib/other.ts', 'export const z = 3;\n');
    commit('pr d');
    git('merge', '-q', '--no-ff', '-m', 'merge staging into d', 'origin/staging');
    const verdict = judge();
    expect(verdict.fileCount).toMatchObject({ status: 'passed', judged: 'own-change' });
    expect(verdict.pages.status).toBe('passed');
  });

  it('the base is the merge-base, not the tip: a number staging moved after the branch point is not this change\'s', () => {
    git('checkout', '-q', '-b', 'pr-e', 'pr-a~1');
    put('src/lib/e.ts', 'export const e = 5;\n');
    commit('pr e');
    // staging moved on (to the merged tree above); pr-e still holds the old budget of 2 and its 2 old files
    const verdict = judge();
    expect(verdict.fileCount).toMatchObject({ status: 'passed', judged: 'own-change' });
  });

  it('a pull request that adds a test file without raising maxTestFiles fails and names the numbers; raising by the same k passes', () => {
    git('checkout', '-q', '-b', 'pr-f', 'main');
    put('src/__tests__/f1.test.tsx', plainTest);
    put('src/__tests__/f2.test.tsx', plainTest);
    commit('two files, no budget');
    const bad = judge();
    expect(bad.fileCount).toMatchObject({ status: 'failed', problems: ['file-count-not-in-budget'] });
    expect(bad.fileCount?.line).toBe('this change moves the test files by +2 (4 -> 6) but maxTestFiles by +0 (3 -> 3). Move maxTestFiles in test-file-count.json by +2 in the same diff.');
    setBudget(5);
    commit('budget +2');
    expect(judge().fileCount?.status).toBe('passed');
  });

  it('the file count is judged on every run, selected and shard runs included (judgeGrowth takes no run mode): it is a git count, not a result of which tests ran', () => {
    git('checkout', '-q', '-b', 'pr-f2', 'main');
    put('src/__tests__/f3.test.tsx', plainTest);
    commit('one file, no budget');
    const verdict = judge();
    expect(verdict.fileCount).toMatchObject({ status: 'failed', problems: ['file-count-not-in-budget'] });
    expect(verdict.filesNow).toBe(5);
    setBudget(4);
    commit('budget +1');
    expect(judge().fileCount?.status).toBe('passed');
  });

  it('deleting a test file needs the number lowered in the same diff', () => {
    git('checkout', '-q', '-b', 'pr-g', 'main');
    git('rm', '-q', 'frontend/src/__tests__/one.test.tsx');
    commit('delete one');
    expect(judge().fileCount?.line).toContain('by -1 (4 -> 3) but maxTestFiles by +0');
    setBudget(2);
    commit('lower');
    expect(judge().fileCount?.status).toBe('passed');
  });

  it('a pull request fails a page ceiling only when it adds a test file mounting that page and the page is then over', () => {
    // main now has 4 test files mounting the page against a ceiling of 3 (the two merges above)
    git('checkout', '-q', '-b', 'pr-h', 'main');
    put('src/__tests__/h.test.tsx', plainTest);
    setBudget(4);
    commit('adds a file that does not mount the page');
    expect(judge().pages.status).toBe('passed');

    git('checkout', '-q', '-b', 'pr-i', 'main');
    put('src/__tests__/i.test.tsx', mountingTest);
    setBudget(4);
    commit('adds a file mounting the page');
    expect(judge().pages.problems).toEqual([{ kind: 'over-ceiling', page: PAGE, actual: 5, ceiling: 3 }]);
  });

  it('a modified test file that starts mounting the page counts as growing it; a rename of a mounting file does not', () => {
    git('checkout', '-q', '-b', 'pr-j', 'main');
    put('src/__tests__/h.test.tsx', plainTest);
    commit('plain file');
    setStaging('pr-j');
    put('src/__tests__/h.test.tsx', mountingTest);
    commit('now mounts it');
    expect(judge().pages.problems.map((p: { kind: string }) => p.kind)).toEqual(['over-ceiling']);

    git('checkout', '-q', '-b', 'pr-k', 'main');
    git('mv', 'frontend/src/__tests__/one.test.tsx', 'frontend/src/__tests__/one-renamed.test.tsx');
    commit('rename');
    setStaging('main');
    expect(judge().pages.status).toBe('passed');
  });

  it('with no resolvable base both checks are not judged and say so', () => {
    git('checkout', '-q', 'main');
    git('update-ref', '-d', 'refs/remotes/origin/staging');
    const verdict = judge();
    expect(verdict.resolved).toBeNull();
    expect(verdict.fileCount).toMatchObject({ status: 'not-judged', judged: 'none' });
    expect(verdict.fileCount?.notes.join()).toContain('not judged');
    expect(verdict.pages).toMatchObject({ status: 'not-judged', judged: 'none' });
  });

  it('the base branch is origin/$GITHUB_BASE_REF when it is set', () => {
    setStaging('main');
    git('update-ref', 'refs/remotes/origin/release', git('rev-parse', 'main'));
    expect(judge({ env: { GITHUB_BASE_REF: 'release' } }).resolved?.ref).toBe('origin/release');
  });
});

describe('a pull request into main (a promotion cut off main)', () => {
  const PR_INTO_MAIN = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main', GITHUB_HEAD_REF: 'promote/x' };

  it('builds a main far behind staging, and a promote branch off main with one change on top', () => {
    git('checkout', '-q', 'main');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'pr-a~1')); // main: the old base only
    setStaging('main'); // staging: holds both merged pull requests (a.test.tsx, b.test.tsx)
    git('checkout', '-q', '-b', 'promote/x', 'pr-a~1');
    put('src/__tests__/picked.test.tsx', plainTest);
    setBudget(3);
    commit('one cherry-pick on top of main');
  });

  it('the own change is HEAD vs the merge-base with origin/main, not origin/staging: no 1,000-file diff', () => {
    const changed = changedFiles(FRONTEND, { env: PR_INTO_MAIN });
    expect(changed).toEqual(['src/__tests__/picked.test.tsx', 'test-file-count.json']);
    const verdict = judge({ env: PR_INTO_MAIN });
    expect(verdict.resolved?.ref).toBe('origin/main');
    expect(verdict.resolved?.commit).toBe(git('rev-parse', 'origin/main'));
    expect(verdict.fileCount).toMatchObject({ status: 'passed', judged: 'own-change' });
  });

  it('the page ceilings and the file count are still judged on a pull request into main', () => {
    put('src/__tests__/second.test.tsx', plainTest); // a second test file, maxTestFiles not raised
    commit('a test file without raising the budget');
    expect(judge({ env: PR_INTO_MAIN }).fileCount).toMatchObject({ status: 'failed' });
  });

});

// #3401: the count moved out of test-budget.json into test-file-count.json. These run last: they move origin/staging.
describe('the count lives in test-file-count.json, not in the budget file', () => {
  it('a tree that still carries maxTestFiles in test-budget.json is an error, not a silent pass', () => {
    git('checkout', '-q', '-b', 'old-place', 'main');
    git('rm', '-q', 'frontend/test-file-count.json');
    setJson('test-budget.json', { maxCpuSeconds: 4500, maxMinutes: 10, workers: 6, maxTestFiles: 4 });
    commit('a base from before the move: the count is in the budget file');
    expect(() => judge()).toThrow(/test-budget\.json carries maxTestFiles/);
  });

  it('a tree with no count file at all is an error too', () => {
    setJson('test-budget.json', { maxCpuSeconds: 4500, maxMinutes: 10, workers: 6 });
    expect(() => judge()).toThrow(/test-file-count\.json is missing/);
    git('checkout', '-q', '--', 'frontend/test-budget.json');
  });

  it('a pull request whose base still has the count in the old place is not judged for the count, and says why', () => {
    setStaging('old-place');
    git('checkout', '-q', '-b', 'pr-after-move', 'old-place');
    setBudget(5);
    put('src/__tests__/after-move.test.tsx', plainTest);
    commit('the count moved to its own file, and one test file was added');
    const verdict = judge();
    expect(verdict.fileCount).toMatchObject({ status: 'not-judged', judged: 'none', problems: [], reason: COUNT_IN_OLD_PLACE_REASON });
    expect(verdict.fileCount?.notes.join()).toContain('the base keeps the count in test-budget.json');
  });

  it('once the base has the count file, the same kind of change is judged on its own difference again', () => {
    setStaging('pr-after-move');
    git('checkout', '-q', '-b', 'pr-next', 'pr-after-move');
    put('src/__tests__/next.test.tsx', plainTest);
    commit('one more test file, the count not moved');
    expect(judge().fileCount).toMatchObject({ status: 'failed', problems: ['file-count-not-in-budget'] });
    setBudget(6);
    commit('the count +1');
    expect(judge().fileCount).toMatchObject({ status: 'passed', judged: 'own-change' });
  });
});
