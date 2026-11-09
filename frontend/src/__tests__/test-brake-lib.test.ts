/**
 * The brake on frontend test growth (#3254), as pure functions over PLANTED event files, page counts and
 * budget files. Expected values come from the issue text: a test over 2 s or a file over 10 s of body time
 * fails and names it; a file over the line is re-run alone once and judged on that run; the over-the-line list
 * may only shrink; a page's file count may not rise, lowering is free, a new page starts at 3; the full run
 * fails over 4,500 CPU-seconds or 10.0 minutes (at 6 workers); the 20 slowest files are listed.
 */
import { describe, expect, it } from 'vitest';
import {
  brakeLine,
  budgetTable,
  buildBaseline,
  checkBudget,
  checkFileCount,
  countTestFiles,
  cpuSecondsOf,
  cpuWarningLine,
  importSpecifiers,
  timeCeilingSkipReason,
  isPageModule,
  judgeReruns,
  listMayOnlyShrink,
  offenderLine,
  overTheLine,
  pageCeilings,
  pagesGrownBy,
  PAGE_HARNESSES,
  renderBrakeSummary,
  scanPageImports,
  slowestFiles,
  timeCeiling,
} from '../../scripts/test-brake-lib.mjs';

type Ev = Record<string, unknown>;
const test = (file: string, name: string, duration: number, extra: Ev = {}): Ev => ({ ev: 'test', file, name, status: 'passed', duration, retries: 0, errors: [], ...extra });
const NONE = { tests: [], files: [] };

describe('time ceiling: a test over 2 s or a file over 10 s, in a file the pull request changed', () => {
  const CHANGED = ['src/new.test.ts'];

  it('a 3-second test in a changed file is red and names the file and the test (after the lone re-run is also 3 s)', () => {
    const events = [test('src/new.test.ts', 'does a thing', 3000)];
    const first = timeCeiling({ events, changed: CHANGED, listed: NONE });
    expect(first.status).toBe('rerun-needed');
    expect(first.suspects).toEqual(['src/new.test.ts']);
    const final = judgeReruns({ suspects: first.suspects, rerunEvents: { 'src/new.test.ts': events }, listed: NONE });
    expect(final.status).toBe('failed');
    expect(final.offenders).toEqual([{ kind: 'test-over-2s', file: 'src/new.test.ts', name: 'does a thing', ms: 3000 }]);
    expect(offenderLine(final.offenders[0])).toContain('src/new.test.ts > does a thing');
  });

  it('with a skip reason (a pull request into main) a slow changed file is not judged and nothing is re-run', () => {
    const r = timeCeiling({ events: [test('src/new.test.ts', 'does a thing', 9000)], changed: CHANGED, listed: NONE, skipReason: 'PR into main' });
    expect(r).toMatchObject({ status: 'not-judged', reason: 'PR into main', skipped: true, suspects: [] });
    expect(renderBrakeSummary({ time: r, lists: { status: 'passed', grown: [] }, pages: { status: 'passed', problems: [], comparedToBase: true }, budget: { status: 'passed', problems: [], warnings: [], notes: [] }, budgetFigures: '', slowest: null, line: 'L' })).toContain('Not judged: PR into main');
  });

  it('the same file passing when re-run alone is green', () => {
    const slowHere = [test('src/new.test.ts', 'does a thing', 3000)];
    const fastAlone = [test('src/new.test.ts', 'does a thing', 400)];
    const first = timeCeiling({ events: slowHere, changed: CHANGED, listed: NONE });
    const final = judgeReruns({ suspects: first.suspects, rerunEvents: { 'src/new.test.ts': fastAlone }, listed: NONE });
    expect(final).toEqual({ status: 'passed', offenders: [], cleared: ['src/new.test.ts'] });
  });

  it('exactly 2 s is fine, 2.001 s is over; exactly 10 s of file time is fine, over is red', () => {
    const at = (ms: number) => overTheLine({ events: [test('f.test.ts', 'a', ms)], only: ['f.test.ts'] });
    expect(at(2000).tests).toEqual([]);
    expect(at(2001).tests).toHaveLength(1);
    const five = (ms: number) => overTheLine({ events: Array.from({ length: 5 }, (_, i) => test('f.test.ts', `t${i}`, ms)), only: ['f.test.ts'] });
    expect(five(2000).files).toEqual([]);
    expect(five(2000).tests).toEqual([]);
    const eleven = overTheLine({ events: Array.from({ length: 11 }, (_, i) => test('f.test.ts', `t${i}`, 1000)), only: ['f.test.ts'] });
    expect(eleven.tests).toEqual([]);
    expect(eleven.files).toEqual([{ file: 'f.test.ts', ms: 11_000 }]);
  });

  it('a file over 10 s of body time re-run alone and still over is red naming the file', () => {
    const many = Array.from({ length: 11 }, (_, i) => test('src/new.test.ts', `t${i}`, 1000));
    const first = timeCeiling({ events: many, changed: CHANGED, listed: NONE });
    expect(first.suspects).toEqual(['src/new.test.ts']);
    const final = judgeReruns({ suspects: first.suspects, rerunEvents: { 'src/new.test.ts': many }, listed: NONE });
    expect(final.offenders).toEqual([{ kind: 'file-over-10s', file: 'src/new.test.ts', name: null, ms: 11_000 }]);
  });

  it('a slow file the pull request did not add or change is not judged', () => {
    const events = [test('src/old.test.ts', 'slow already', 9000)];
    expect(timeCeiling({ events, changed: CHANGED, listed: NONE })).toMatchObject({ status: 'passed', suspects: [] });
  });

  it('entries on the over-the-line list are exempt, exactly by file > test name', () => {
    const events = [test('src/new.test.ts', 'slow already', 3000), test('src/new.test.ts', 'slow new', 3000)];
    const listed = { tests: ['src/new.test.ts > slow already'], files: [] };
    const found = overTheLine({ events, only: CHANGED, listed });
    expect(found.tests.map((t) => t.name)).toEqual(['slow new']);
  });

  it('a retried test is judged on its last attempt, not on the sum of all attempts', () => {
    const retried = test('src/new.test.ts', 'flaky', 5000, { retries: 1, attempts: [{ attempt: 1, ms: 4000, status: 'failed' }, { attempt: 2, ms: 900, status: 'passed' }] });
    expect(overTheLine({ events: [retried], only: CHANGED }).tests).toEqual([]);
  });

  it('without a changed-file list nothing is judged and it says so (fail-open on WHICH files, not on a judged one)', () => {
    const r = timeCeiling({ events: [test('src/new.test.ts', 'slow', 9000)], changed: null, listed: NONE });
    expect(r).toMatchObject({ status: 'not-judged', reason: 'no-changed-file-list', suspects: [] });
  });

  it('a judged file whose lone re-run reported nothing, or failed, is red, never green', () => {
    expect(judgeReruns({ suspects: ['a.test.ts'], rerunEvents: { 'a.test.ts': null }, listed: NONE }).offenders[0].kind).toBe('rerun-missing');
    expect(judgeReruns({ suspects: ['a.test.ts'], rerunEvents: { 'a.test.ts': [test('a.test.ts', 'x', 10, { status: 'failed' })] }, listed: NONE }).offenders[0].kind).toBe('rerun-failed');
  });
});

describe('the over-the-line list may only shrink', () => {
  const base = { tests: ['a.test.ts > x', 'a.test.ts > y'], files: ['b.test.ts'] };
  it('removing entries passes; adding one fails and names it; same list passes', () => {
    expect(listMayOnlyShrink({ current: { tests: ['a.test.ts > x'], files: [] }, base }).status).toBe('passed');
    expect(listMayOnlyShrink({ current: base, base }).status).toBe('passed');
    expect(listMayOnlyShrink({ current: { tests: [...base.tests, 'c.test.ts > z'], files: base.files }, base })).toEqual({ status: 'failed', grown: ['c.test.ts > z'] });
  });
  it('with no base copy it is not judged', () => {
    expect(listMayOnlyShrink({ current: base, base: null }).status).toBe('not-judged');
  });
  it('the baseline generator lists every test over 2 s and every file over 10 s of a whole-suite event file, sorted', () => {
    const events = [test('b.test.ts', 'slow', 2500), test('a.test.ts', 'ok', 100), ...Array.from({ length: 11 }, (_, i) => test('c.test.ts', `t${i}`, 1000))];
    expect(buildBaseline(events)).toEqual({ tests: ['b.test.ts > slow'], files: ['c.test.ts'] });
  });
});

describe('per-page file-count ceiling', () => {
  const PAGE = 'src/pages/v2/jobs/JobDetailPage.tsx';
  const NEW = 'src/pages/v2/brand/NewThingPage.tsx';

  it('a 55th test file for a page with 54 fails; at 54 passes', () => {
    expect(pageCeilings({ actual: { [PAGE]: 55 }, ceilings: { [PAGE]: 54 }, baseCeilings: { [PAGE]: 54 }, grown: [PAGE] }).problems).toEqual([{ kind: 'over-ceiling', page: PAGE, actual: 55, ceiling: 54 }]);
    expect(pageCeilings({ actual: { [PAGE]: 54 }, ceilings: { [PAGE]: 54 }, baseCeilings: { [PAGE]: 54 }, grown: [PAGE] }).status).toBe('passed');
  });
  it('raising the number in the file fails even when the count fits; lowering passes', () => {
    expect(pageCeilings({ actual: { [PAGE]: 54 }, ceilings: { [PAGE]: 60 }, baseCeilings: { [PAGE]: 54 }, grown: [PAGE] }).problems).toEqual([{ kind: 'ceiling-raised', page: PAGE, ceiling: 60, was: 54 }]);
    expect(pageCeilings({ actual: { [PAGE]: 40 }, ceilings: { [PAGE]: 45 }, baseCeilings: { [PAGE]: 54 }, grown: [PAGE] }).status).toBe('passed');
  });
  it('a new page starts at 3: 3 passes, 4 fails, whether or not the file lists it', () => {
    expect(pageCeilings({ actual: { [NEW]: 3 }, ceilings: {}, baseCeilings: {}, grown: [NEW] }).status).toBe('passed');
    expect(pageCeilings({ actual: { [NEW]: 4 }, ceilings: {}, baseCeilings: {}, grown: [NEW] }).problems[0]).toMatchObject({ kind: 'over-ceiling', actual: 4, ceiling: 3 });
    expect(pageCeilings({ actual: { [NEW]: 3 }, ceilings: { [NEW]: 3 }, baseCeilings: {}, grown: [NEW] }).status).toBe('passed');
    expect(pageCeilings({ actual: { [NEW]: 3 }, ceilings: { [NEW]: 4 }, baseCeilings: {}, grown: [NEW] }).problems[0]).toMatchObject({ kind: 'new-page-over-start' });
  });
  it('a page the change did not grow can never fail it, even over its ceiling; a page it grew fails when over', () => {
    const over = { actual: { [PAGE]: 56 }, ceilings: { [PAGE]: 54 }, baseCeilings: { [PAGE]: 54 } };
    expect(pageCeilings({ ...over, grown: [] })).toMatchObject({ status: 'passed', judged: 'own-change' });
    expect(pageCeilings({ ...over, grown: [NEW] }).status).toBe('passed');
    expect(pageCeilings({ ...over, grown: [PAGE] }).problems).toEqual([{ kind: 'over-ceiling', page: PAGE, actual: 56, ceiling: 54 }]);
  });
  it('a grown new page starts at 3; a lowered ceiling and a ceiling raised in this change are still judged on their own', () => {
    expect(pageCeilings({ actual: { [NEW]: 4 }, ceilings: {}, baseCeilings: {}, grown: [NEW] }).problems[0]).toMatchObject({ kind: 'over-ceiling', ceiling: 3 });
    expect(pageCeilings({ actual: { [PAGE]: 56 }, ceilings: { [PAGE]: 56 }, baseCeilings: { [PAGE]: 54 }, grown: [] }).problems).toEqual([{ kind: 'ceiling-raised', page: PAGE, ceiling: 56, was: 54 }]);
  });
  it('with no base the ceilings are not judged, over or under: never a pass and never a failure', () => {
    expect(pageCeilings({ actual: { [PAGE]: 55 }, ceilings: { [PAGE]: 54 }, baseCeilings: null, grown: null })).toMatchObject({ status: 'not-judged', problems: [], judged: 'none', reason: 'no base: shallow checkout or no remote' });
    expect(pageCeilings({ actual: { [PAGE]: 54 }, ceilings: { [PAGE]: 99 }, baseCeilings: null }).status).toBe('not-judged');
  });

  it('the scan counts a test file once per page across alias, relative and dynamic imports, and ignores mocks and comments', () => {
    // Built from parts so this file does not itself look like a test that imports a page (the guard scans sources).
    const [JOB, LEAD, ALIAS] = ['JobDetail' + 'Page', 'LeadDetail' + 'Page', '@/pages/v2/jobs'];
    const pages = [PAGE, 'src/pages/v2/leads/LeadDetailPage.tsx'];
    const tests = [
      { path: 'src/pages/v2/jobs/__tests__/a.test.tsx', source: `import JobDetailPage from '../${JOB}';\nimport X from '../${JOB}';` },
      { path: 'src/__tests__/b.test.tsx', source: `import JobDetailPage from '${ALIAS}/${JOB}';\nconst L = await import('@/pages/v2/leads/${LEAD}');` },
      { path: 'src/__tests__/c.test.tsx', source: `vi.mock('${ALIAS}/${JOB}', stub);\n// import x from '${ALIAS}/${JOB}'\n` },
      { path: 'src/__tests__/d.test.tsx', source: `import {\n  a,\n  b,\n} from '${ALIAS}/${JOB}';` },
    ];
    expect(scanPageImports({ tests, pages })).toEqual({ [PAGE]: 3, 'src/pages/v2/leads/LeadDetailPage.tsx': 1 });
    expect(importSpecifiers("import type { T } from './t';\nexport { z } from './z';")).toEqual(['./t', './z']);
  });
  it('a block-comment opener inside a line comment or a string does not swallow the imports that follow (verifier finding 1)', () => {
    const lineComment = "// No /api/inventory/* request is made here\nimport A from './a';\n/* closes here */\nimport B from './b';";
    expect(importSpecifiers(lineComment)).toEqual(['./a', './b']);
    const slashStar = "/* // */\nimport C from './c';\n// end */ not a closer\nimport D from './d';";
    expect(importSpecifiers(slashStar)).toEqual(['./c', './d']);
    const inString = "const route = '/api/*';\nimport E from './e';\nconst z = 1; /* later */";
    expect(importSpecifiers(inString)).toEqual(['./e']);
    const commented = "// import F from './f';\n/* import G from './g'; */\nimport H from './h';";
    expect(importSpecifiers(commented)).toEqual(['./h']);
  });
  it('a mock of a page is not an import of it, a dynamic import and an export-from are', () => {
    expect(importSpecifiers("vi.mock('./m', () => ({}));\nconst x = await import('./d');\nexport { y } from './e';")).toEqual(['./d', './e']);
  });
  it('page-level modules are the Page.tsx files under src/pages, not their tests', () => {
    expect(isPageModule(PAGE)).toBe(true);
    expect(isPageModule('src/pages/v2/jobs/__tests__/JobDetailPage.test.tsx')).toBe(false);
    expect(isPageModule('src/pages/v2/jobs/JobCard.tsx')).toBe(false);
    expect(isPageModule('src/components/FooPage.tsx')).toBe(false);
  });
});

describe('which pages a change grew', () => {
  const PAGE = 'src/pages/v2/jobs/JobDetailPage.tsx';
  const OTHER = 'src/pages/v2/jobs/JobsPage.tsx';
  const pages = [PAGE, OTHER];
  const mounts = "import { JobDetailPage } from '../pages/v2/jobs/JobDetailPage';\n";
  const plain = "import { x } from './helpers';\n";

  it('an added test file that imports a page grew it; one that imports none grew nothing', () => {
    expect(pagesGrownBy({ changed: [{ path: 'src/__tests__/a.test.tsx', source: mounts, baseSource: null }], pages })).toEqual([PAGE]);
    expect(pagesGrownBy({ changed: [{ path: 'src/__tests__/a.test.tsx', source: plain, baseSource: null }], pages })).toEqual([]);
  });
  it('a changed file grew a page only when it did not import it at the base', () => {
    expect(pagesGrownBy({ changed: [{ path: 'src/__tests__/a.test.tsx', source: mounts, baseSource: plain }], pages })).toEqual([PAGE]);
    expect(pagesGrownBy({ changed: [{ path: 'src/__tests__/a.test.tsx', source: `${mounts}// edited`, baseSource: mounts }], pages })).toEqual([]);
  });
});

describe('test-file count on the change itself', () => {
  it('countTestFiles counts the files the tool runs and nothing else', () => {
    expect(countTestFiles(['src/a.test.ts', 'src/b.test.tsx', 'src/c.ts', 'e2e/d.test.ts', 'src/a.test.ts'])).toBe(2);
  });
  it('adding k files with maxTestFiles raised by k passes; deleting with a lowered number passes; no change passes', () => {
    expect(checkFileCount({ files: 12, maxTestFiles: 12, base: { files: 10, maxTestFiles: 10 } }).status).toBe('passed');
    expect(checkFileCount({ files: 8, maxTestFiles: 8, base: { files: 10, maxTestFiles: 10 } }).status).toBe('passed');
    expect(checkFileCount({ files: 10, maxTestFiles: 10, base: { files: 10, maxTestFiles: 10 } }).status).toBe('passed');
  });
  it('a number the change did not touch cannot fail it: the base itself may be out of step', () => {
    expect(checkFileCount({ files: 12, maxTestFiles: 11, base: { files: 12, maxTestFiles: 11 } }).status).toBe('passed');
    expect(checkFileCount({ files: 13, maxTestFiles: 12, base: { files: 12, maxTestFiles: 11 } }).status).toBe('passed');
  });
  it('a file added without raising the number, or the number raised without a file, fails and names the numbers', () => {
    const more = checkFileCount({ files: 11, maxTestFiles: 10, base: { files: 10, maxTestFiles: 10 } });
    expect(more.problems).toEqual(['file-count-not-in-budget']);
    expect(more.line).toBe('this change moves the test files by +1 (10 -> 11) but maxTestFiles by +0 (10 -> 10). Move maxTestFiles by +1 in the same diff.');
    const fewer = checkFileCount({ files: 9, maxTestFiles: 10, base: { files: 10, maxTestFiles: 10 } });
    expect(fewer.line).toContain('by -1 (10 -> 9) but maxTestFiles by +0');
    expect(checkFileCount({ files: 10, maxTestFiles: 12, base: { files: 10, maxTestFiles: 10 } }).status).toBe('failed');
  });
  it('with no base the count is not judged and says so, whatever the numbers are', () => {
    for (const files of [9, 10, 11]) {
      const r = checkFileCount({ files, maxTestFiles: 10, base: null });
      expect(r).toMatchObject({ status: 'not-judged', judged: 'none', problems: [], line: null });
      expect(r.notes.join()).toContain('not judged (no base: shallow checkout or no remote)');
    }
  });
});

describe('budget of a full run', () => {
  const BUDGET = { maxCpuSeconds: 4500, maxMinutes: 10.0, workers: 6, maxTestFiles: 1571, cpuEnforcement: 'fail' };
  const ok = { cpuSeconds: 4177, minutes: 9.2, files: 1571, workers: 6 };

  it('today (4,177 CPU-seconds, 9.2 minutes) passes; exactly the budget passes', () => {
    expect(checkBudget({ budget: BUDGET, measured: ok, mode: 'full' }).status).toBe('passed');
    expect(checkBudget({ budget: BUDGET, measured: { ...ok, cpuSeconds: 4500, minutes: 10.0 }, mode: 'full' }).status).toBe('passed');
  });
  it('over 4,500 CPU-seconds fails; over 10.0 minutes at 6 workers fails on the nightly run', () => {
    expect(checkBudget({ budget: BUDGET, measured: { ...ok, cpuSeconds: 4501 }, mode: 'full' }).problems).toEqual(['cpu-over-budget']);
    expect(checkBudget({ budget: BUDGET, measured: { ...ok, minutes: 10.1 }, mode: 'full', nightly: true }).problems).toEqual(['minutes-over-budget']);
  });
  it('minutes are judged only on the nightly run (#3249: the idle machine): a 6-worker pull request or push run over 10.0 passes, with the figure reported', () => {
    const r = checkBudget({ budget: BUDGET, measured: { ...ok, minutes: 12.4 }, mode: 'full' });
    expect(r.status).toBe('passed');
    expect(r.problems).toEqual([]);
    expect(r.notes).toEqual(['minutes not judged: only the nightly run on the idle machine is compared (this run: 12.4 minutes at 6 workers, budget 10.0)']);
    expect(checkBudget({ budget: BUDGET, measured: { ...ok, minutes: 12.4 }, mode: 'full', nightly: false }).status).toBe('passed');
  });
  it('the nightly run within 10.0 minutes passes; at exactly 10.0 passes', () => {
    expect(checkBudget({ budget: BUDGET, measured: ok, mode: 'full', nightly: true }).status).toBe('passed');
    expect(checkBudget({ budget: BUDGET, measured: { ...ok, minutes: 10.0 }, mode: 'full', nightly: true }).status).toBe('passed');
  });
  it('the test-file count is not judged here: it is judged on the change itself (checkFileCount)', () => {
    expect(checkBudget({ budget: BUDGET, measured: { ...ok, files: 99999 }, mode: 'full' }).status).toBe('passed');
  });
  it('minutes at another worker count are reported, not judged; a CPU figure that could not be measured is red', () => {
    const r = checkBudget({ budget: BUDGET, measured: { ...ok, workers: 4, minutes: 11.2 }, mode: 'full', nightly: true });
    expect(r.status).toBe('passed');
    expect(r.notes[0]).toBe('minutes not judged: run at 4 workers, budget at 6');
    expect(checkBudget({ budget: BUDGET, measured: { ...ok, cpuSeconds: null }, mode: 'full' }).problems).toEqual(['cpu-not-measured']);
  });
  it('a selected or shard run is never judged against the full budget', () => {
    for (const mode of ['selected', 'shard']) {
      expect(checkBudget({ budget: BUDGET, measured: { cpuSeconds: 99999, minutes: 99, files: 99999, workers: 6 }, mode }).status).toBe('not-judged');
    }
  });
  it('CPU-seconds come from the last cpu event of the run', () => {
    expect(cpuSecondsOf([{ ev: 'cpu', seconds: 12.5 }])).toBe(12.5);
    expect(cpuSecondsOf([{ ev: 'run-end' }])).toBeNull();
  });

  describe('cpuEnforcement: warn only until a 6-worker Mac baseline exists', () => {
    const over = { ...ok, cpuSeconds: 5798, workers: 4 };
    const warnBudget = { ...BUDGET, cpuEnforcement: 'warn' };

    it('warn + CPU over budget: no problem (exit 0), a warning naming the reason', () => {
      const r = checkBudget({ budget: warnBudget, measured: over, mode: 'full' });
      expect(r.status).toBe('passed');
      expect(r.problems).toEqual([]);
      expect(r.warnings).toEqual(['cpu-over-budget']);
    });
    it('warn + CPU over budget: the job summary shows the warning with the measured figure and the budget', () => {
      const budget = checkBudget({ budget: warnBudget, measured: over, mode: 'full' });
      const md = renderBrakeSummary({
        time: { status: 'passed', judged: [], suspects: [] }, lists: { status: 'passed', grown: [] }, pages: { status: 'passed', problems: [], comparedToBase: true },
        budget, budgetFigures: budgetTable({ budget: warnBudget, measured: over }), slowest: null, line: brakeLine({ result: 'passed', reasons: [] }),
        cpuWarning: cpuWarningLine({ budget: warnBudget, measured: over }),
      });
      expect(md).toContain('WARNING: CPU-seconds 5798 over the budget of 4500 (warn only, not enforced)');
      expect(md).not.toContain('Within budget.');
    });
    it('fail + CPU over budget: red with cpu-over-budget, no warning', () => {
      const r = checkBudget({ budget: BUDGET, measured: over, mode: 'full' });
      expect(r.status).toBe('failed');
      expect(r.problems).toEqual(['cpu-over-budget']);
      expect(r.warnings).toEqual([]);
    });
    it('under budget: no warning and no problem in either mode', () => {
      for (const b of [warnBudget, BUDGET]) {
        const r = checkBudget({ budget: b, measured: ok, mode: 'full' });
        expect(r.status).toBe('passed');
        expect(r.warnings).toEqual([]);
      }
    });
    it('a missing or unknown value is invalid and reads as "fail": over budget is red, and the note says why', () => {
      const { cpuEnforcement: _gone, ...missing } = BUDGET;
      for (const b of [missing, { ...BUDGET, cpuEnforcement: 'wran' }, { ...BUDGET, cpuEnforcement: 'WARN' }, { ...BUDGET, cpuEnforcement: null }]) {
        const r = checkBudget({ budget: b, measured: over, mode: 'full' });
        expect(r.problems).toEqual(['cpu-over-budget']);
        expect(r.warnings).toEqual([]);
        expect(r.notes.join('\n')).toContain('cpuEnforcement is missing or invalid');
        expect(r.notes.join('\n')).toContain('treated as "fail"');
      }
    });
    it('warn mode does not soften any other reason: minutes at 6 workers and an unmeasured CPU stay red', () => {
      const at6 = { ...over, workers: 6 };
      expect(checkBudget({ budget: warnBudget, measured: { ...at6, minutes: 10.1 }, mode: 'full', nightly: true }).problems).toEqual(['minutes-over-budget']);
      expect(checkBudget({ budget: warnBudget, measured: { ...ok, cpuSeconds: null }, mode: 'full' }).problems).toEqual(['cpu-not-measured']);
    });
    it('the committed test-budget.json carries a valid cpuEnforcement and a note', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const committed = JSON.parse(readFileSync(resolve(__dirname, '../../test-budget.json'), 'utf8'));
      expect(['warn', 'fail']).toContain(committed.cpuEnforcement);
      expect(typeof committed.cpuEnforcementNote).toBe('string');
    });
  });
});

describe('the 20 slowest files and the summary', () => {
  it('lists the 20 slowest files by summed body time, slowest first', () => {
    const events = Array.from({ length: 25 }, (_, i) => test(`f${i}.test.ts`, 't', (i + 1) * 100));
    const rows = slowestFiles(events);
    expect(rows).toHaveLength(20);
    expect(rows[0]).toEqual({ file: 'f24.test.ts', ms: 2500, tests: 1 });
    expect(rows[19].file).toBe('f5.test.ts');
  });
  it('the summary carries the figures, the offenders and the slowest files; the verdict line names reasons', () => {
    const budget = { status: 'passed', reason: null, problems: [], notes: [] };
    const md = renderBrakeSummary({
      time: { status: 'rerun-needed', judged: ['a.test.ts'], suspects: ['a.test.ts'], final: { status: 'failed', offenders: [{ kind: 'test-over-2s', file: 'a.test.ts', name: 'slow', ms: 3000 }], cleared: [] } },
      lists: { status: 'passed', grown: [] }, pages: { status: 'passed', problems: [], comparedToBase: true }, budget, budgetFigures: 'FIGURES', slowest: slowestFiles([test('a.test.ts', 'slow', 3000)]), line: brakeLine({ result: 'failed', reasons: ['test-time-ceiling'] }),
    });
    expect(md).toContain('a.test.ts > slow: 3000 ms');
    expect(md).toContain('FIGURES');
    expect(md).toContain('| 1 | a.test.ts | 3.0 | 1 |');
    expect(brakeLine({ result: 'failed', reasons: ['test-time-ceiling'] })).toBe('TEST-BRAKE-VERDICT result=failed code=15 reasons=test-time-ceiling');
    expect(brakeLine({ result: 'not-judged', reasons: ['main-run-red'] })).toBe('TEST-BRAKE-VERDICT result=not-judged code=0 reasons=main-run-red');
    expect(brakeLine({ result: 'passed', reasons: [] })).toBe('TEST-BRAKE-VERDICT result=passed code=0 reasons=none');
    expect(brakeLine({ result: 'passed', reasons: [], notJudged: ['pages=not-judged (no base: shallow checkout or no remote)'] })).toBe('TEST-BRAKE-VERDICT result=passed code=0 reasons=none pages=not-judged (no base: shallow checkout or no remote)');
  });
});

describe('timeCeilingSkipReason (R17: only the staging -> main promotion is not time-judged)', () => {
  const PR = 'pull_request';
  it('skips a pull request from staging into main', () => {
    expect(timeCeilingSkipReason({ event: PR, baseRef: 'main', headRef: 'staging' })).toBe('PR from staging into main');
  });
  it.each([
    ['a promote branch into main', { event: PR, baseRef: 'main', headRef: 'promote/x' }],
    ['a hotfix branch into main', { event: PR, baseRef: 'main', headRef: 'hotfix/x' }],
    ['a feature branch into main', { event: PR, baseRef: 'main', headRef: 'feature/x' }],
    ['staging into staging', { event: PR, baseRef: 'staging', headRef: 'staging' }],
    ['a missing head into main', { event: PR, baseRef: 'main', headRef: undefined }],
    ['a push', { event: 'push', baseRef: 'main', headRef: 'staging' }],
    ['no environment', {}],
  ])('judges %s', (_name, input) => {
    expect(timeCeilingSkipReason(input)).toBeNull();
  });
});

describe('a harness counts as the page it mounts (#3259, decision D14)', () => {
  const PAGE = 'src/pages/v2/jobs/JobDetailPage.tsx';
  const OTHER = 'src/pages/v2/jobs/JobsPage.tsx';
  const HARNESS = 'src/__tests__/harness/jobDetailPage.tsx';
  const pages = [PAGE, OTHER];
  const viaHarness = "import { mountJobDetail } from '@/__tests__/harness/jobDetailPage';\n";
  const viaRelative = "import { mountJobDetail } from './harness/jobDetailPage';\n";
  const direct = "import JobDetailPage from '../pages/v2/jobs/JobDetailPage';\n";

  it('the one mapping names the job detail page harness', () => {
    expect(PAGE_HARNESSES[PAGE]).toEqual([HARNESS]);
  });
  it('a test file that imports the harness mounts the page, by alias or relative path, and counts once with a direct import too', () => {
    const tests = [
      { path: 'src/__tests__/a.test.tsx', source: viaHarness },
      { path: 'src/__tests__/b.test.tsx', source: viaRelative },
      { path: 'src/pages/v2/jobs/__tests__/c.test.tsx', source: `${viaHarness}${direct.replace('../pages/v2/jobs/', '../')}` },
      { path: 'src/__tests__/d.test.tsx', source: "import { x } from './helpers';\n" },
    ];
    expect(scanPageImports({ tests, pages })).toEqual({ [PAGE]: 3 });
  });
  it('the mapping is a parameter: with no harness named, only a direct import counts', () => {
    const tests = [{ path: 'src/__tests__/a.test.tsx', source: viaHarness }];
    expect(scanPageImports({ tests, pages, harnesses: {} })).toEqual({});
    expect(scanPageImports({ tests, pages, harnesses: { [PAGE]: [HARNESS] } })).toEqual({ [PAGE]: 1 });
    expect(scanPageImports({ tests, pages, harnesses: { [OTHER]: [HARNESS] } })).toEqual({ [OTHER]: 1 });
  });
  it('a new test file that mounts the page through its harness grows the page, so the ceiling judges it', () => {
    expect(pagesGrownBy({ changed: [{ path: 'src/__tests__/new.test.tsx', source: viaHarness, baseSource: null }], pages })).toEqual([PAGE]);
    expect(pageCeilings({ actual: { [PAGE]: 45 }, ceilings: { [PAGE]: 44 }, baseCeilings: { [PAGE]: 44 }, grown: [PAGE] }).problems).toEqual([
      { kind: 'over-ceiling', page: PAGE, actual: 45, ceiling: 44 },
    ]);
  });
  it('a harness that is not mapped to any page in the page list changes nothing', () => {
    expect(scanPageImports({ tests: [{ path: 'src/__tests__/a.test.tsx', source: viaHarness }], pages: [OTHER] })).toEqual({});
  });
});
