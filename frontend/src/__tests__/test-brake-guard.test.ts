/**
 * Guard for the committed brake files (#3254) and the rule for agents. The counts (test files, files per page) are
 * judged on each pull request's own change by `npm run test:ci`, not here: see test-brake-own-change.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEW_PAGE_START } from '../../scripts/test-brake-lib.mjs';
import { PAGE_CEILINGS_FILE, loadBrakeFiles, scanPages } from '../../scripts/test-brake-io.mjs';

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

  it('the budget file has the figures of the issue and a whole-number test-file count (it moves with the files, in the same diff)', () => {
    expect(files.budget).toMatchObject({ maxCpuSeconds: 4500, maxMinutes: 10, workers: 6 });
    expect(Number.isInteger(files.budget.maxTestFiles) && files.budget.maxTestFiles > 0).toBe(true);
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
