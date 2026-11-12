/**
 * Guard for the committed brake files (#3254) and the rule for agents. The counts (test files, files per page) are
 * judged on each pull request's own change by `npm run test:ci`, not here: see test-brake-own-change.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEW_PAGE_START } from '../../scripts/test-brake-lib.mjs';
import { BUDGET_FILE, FILE_COUNT_FILE, PAGE_CEILINGS_FILE, loadBrakeFiles, scanPages } from '../../scripts/test-brake-io.mjs';
import { SELECTOR_PATHS } from '../../scripts/test-select-lib.mjs';

const FRONTEND = resolve(__dirname, '../..');

describe('the committed brake files', () => {
  const { counts } = scanPages(FRONTEND);
  const files = loadBrakeFiles(FRONTEND);

  // The numbers themselves are judged on each pull request's OWN change (npm run test:ci, judgeGrowth): an absolute
  // check here would turn an unrelated pull request red when two others merged cleanly. This guard keeps the files
  // well-formed and the scan alive.
  it(`${PAGE_CEILINGS_FILE} lists page modules with whole-number ceilings, and new pages start at ${NEW_PAGE_START}`, () => {
    for (const [page, ceiling] of Object.entries(files.ceilings)) {
      expect(page, 'a ceiling is for a page module').toMatch(/^src\/pages\/.*Page\.tsx$/);
      expect(Number.isInteger(ceiling) && ceiling >= 1, `${page}: ${ceiling}`).toBe(true);
    }
    expect(NEW_PAGE_START).toBe(3);
  });

  it('the scan sees the job detail page and the file lists a ceiling for it, so a source-scan that finds nothing cannot pass', () => {
    expect(counts['src/pages/v2/jobs/JobDetailPage.tsx']).toBeGreaterThan(0);
    expect(files.ceilings['src/pages/v2/jobs/JobDetailPage.tsx']).toBeGreaterThan(0);
  });

  it('the budget file has the reviewed figures and a whole-number test-file count (it moves with the files, in the same diff)', () => {
    // CPU-seconds: 4500 in the issue, lowered to 3600 on 2026-11-10 after the tool fixes (3,233 and 3,309 measured on pull
    // request runs on the CI machine). Lower it again after every gain (docs/ci.md); a raise is Ran's to review.
    expect(files.budget).toMatchObject({ maxCpuSeconds: 3600, maxMinutes: 10, workers: 6 });
    expect(Number.isInteger(files.budget.maxTestFiles) && files.budget.maxTestFiles > 0).toBe(true);
  });

  it('the test-file count is in its own file, not in the budget file, and the selector does not guard it (#3401)', () => {
    const budgetFile = JSON.parse(readFileSync(resolve(FRONTEND, BUDGET_FILE), 'utf8'));
    const countFile = JSON.parse(readFileSync(resolve(FRONTEND, FILE_COUNT_FILE), 'utf8'));
    expect(budgetFile).not.toHaveProperty('maxTestFiles');
    expect(Number.isInteger(countFile.maxTestFiles) && countFile.maxTestFiles > 0).toBe(true);
    // the real budget figures stay guarded: a pull request that changes one still gets a full Frontend run
    expect(SELECTOR_PATHS).toContain(`frontend/${BUDGET_FILE}`);
    expect(SELECTOR_PATHS.some((p) => p.includes(FILE_COUNT_FILE))).toBe(false);
  });
});

describe('the rule for agents is in the project rules file', () => {
  const rules = readFileSync(resolve(FRONTEND, '../CLAUDE.md'), 'utf8');
  const section = rules.slice(rules.indexOf('## Frontend tests: where a test belongs'));

  it('has the section with every rule of the issue and the builder-report line', () => {
    expect(rules).toContain('## Frontend tests: where a test belongs');
    for (const phrase of [
      'Find before you write', 'One harness per page', 'One mount per state', 'Lowest level that can fail',
      'No real timer over 100 ms', 'rejected `findBy`', 'smallest number that crosses the threshold', 'The budget',
      'tests added to: <file>', 'new file because: <reason>',
    ]) expect(section, phrase).toContain(phrase);
  });
});
