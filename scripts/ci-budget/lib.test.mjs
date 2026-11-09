// Run with: node --test scripts/ci-budget/lib.test.mjs
// Seam: pure functions over a list of run records (one per execution of the Database job) -> figures, decision, text.
// Expected figures are worked by hand from the issue text, never recomputed the way the code computes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureWeeks, trend, overBudget, databaseSection, decide, renderReport, slowestFilesFromLog, formatDuration, MARKER, SLOWEST_FILES_HEADING, SLOWEST_FILES_HEADER_ROW } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NOW = '2026-11-08T12:00:00Z';
const MIN = 60_000;
const at = (iso, plusMs) => new Date(Date.parse(iso) + plusMs).toISOString();

/** One execution of the Database job that finished `doneAt`, queued `queueMin` minutes and ran `runMin` minutes. */
function rec(runMin, { queueMin = 1, doneAt = '2026-11-05T12:00:00Z', ...over } = {}) {
  const startedAt = at(doneAt, -runMin * MIN);
  return {
    runAttempt: 1,
    conclusion: 'success',
    labels: ['self-hosted', 'macOS'],
    runnerGroup: 'Default',
    createdAt: at(startedAt, -queueMin * MIN),
    startedAt,
    completedAt: doneAt,
    ...over,
  };
}

test('an empty week has no figures, and says why', () => {
  const w = measureWeeks([], NOW);
  assert.equal(w.current.runs, 0);
  assert.equal(w.current.run, null);
  assert.equal(w.current.queue, null);
  assert.equal(w.previous.runs, 0);
});

test('one run is its own typical run and its own slowest tenth', () => {
  const w = measureWeeks([rec(9, { queueMin: 4 })], NOW);
  assert.equal(w.current.runs, 1);
  assert.deepEqual(w.current.run, { typicalSec: 540, slowestTenthSec: 540, longestSec: 540 });
  assert.deepEqual(w.current.queue, { typicalSec: 240, slowestTenthSec: 240, longestSec: 240 });
});

test('ten runs of 1..10 minutes: typical 5.5 min, the slowest tenth is the time nine in ten runs stay within (9 min), longest 10 min', () => {
  const records = Array.from({ length: 10 }, (_, i) => rec(i + 1));
  assert.deepEqual(measureWeeks(records, NOW).current.run, { typicalSec: 330, slowestTenthSec: 540, longestSec: 600 });
});

test('twenty runs: the slowest tenth is the 18th fastest', () => {
  const records = Array.from({ length: 20 }, (_, i) => rec(i + 1));
  assert.equal(measureWeeks(records, NOW).current.run.slowestTenthSec, 18 * 60);
});

test('fifteen runs: the slowest tenth rounds up to the 14th fastest, so a tail of two runs is never hidden', () => {
  const records = Array.from({ length: 15 }, (_, i) => rec(i + 1));
  assert.equal(measureWeeks(records, NOW).current.run.slowestTenthSec, 14 * 60);
});

test('only the first execution counts: a re-run (attempt 2, 3) is left out and counted as such', () => {
  const w = measureWeeks([rec(5), rec(30, { runAttempt: 2 }), rec(30, { runAttempt: 3 })], NOW);
  assert.equal(w.current.runs, 1);
  assert.equal(w.current.run.longestSec, 300);
  assert.equal(w.current.left.rerun, 2);
});

test('cancelled, failed and skipped executions are left out and counted by kind', () => {
  const w = measureWeeks(
    [rec(5), rec(1, { conclusion: 'cancelled' }), rec(40, { conclusion: 'failure' }), rec(0, { conclusion: 'skipped' }), rec(20, { conclusion: null })],
    NOW,
  );
  assert.equal(w.current.runs, 1);
  assert.deepEqual(w.current.left, { rerun: 0, cancelled: 1, notPassed: 3, hosted: 0 });
});

test('hosted-machine executions are left out; the reserved runner and the general Mac runners count', () => {
  const w = measureWeeks(
    [
      rec(6, { labels: ['database'] }),
      rec(7, { labels: ['self-hosted', 'macOS'] }),
      rec(50, { labels: ['ubuntu-latest'], runnerGroup: 'GitHub Actions' }),
      rec(50, { labels: ['ubuntu-24.04'], runnerGroup: 'Default' }),
      rec(50, { labels: [], runnerGroup: 'GitHub Actions' }),
    ],
    NOW,
  );
  assert.equal(w.current.runs, 2);
  assert.equal(w.current.run.longestSec, 420);
  assert.equal(w.current.left.hosted, 3);
});

test('queue time is reported apart from run time and never added to it', () => {
  const w = measureWeeks([rec(5, { queueMin: 20 }), rec(5, { queueMin: 2 })], NOW);
  assert.equal(w.current.run.longestSec, 300);
  assert.equal(w.current.queue.longestSec, 1200);
  assert.equal(w.current.queue.typicalSec, 660);
});

test('a week is the seven days before now; the seven days before that are the previous week; older and future runs are in neither', () => {
  const w = measureWeeks(
    [
      rec(5, { doneAt: '2026-11-07T12:00:00Z' }),
      rec(6, { doneAt: '2026-11-01T12:00:01Z' }),
      rec(7, { doneAt: '2026-11-01T12:00:00Z' }), // exactly seven days ago belongs to the previous week
      rec(8, { doneAt: '2026-10-26T12:00:00Z' }),
      rec(9, { doneAt: '2026-10-25T12:00:00Z' }), // exactly fourteen days ago is older than both weeks
      rec(99, { doneAt: '2026-11-08T12:00:01Z' }),
    ],
    NOW,
  );
  assert.equal(w.current.runs, 2);
  assert.equal(w.previous.runs, 2);
  assert.equal(w.previous.run.longestSec, 480);
});

test('a record without a start or an end (still running) is left out, not counted as zero', () => {
  const w = measureWeeks([rec(5), { ...rec(5), completedAt: null }, { ...rec(5), startedAt: null }], NOW);
  assert.equal(w.current.runs, 1);
});

// ---- the budget: the slowest tenth above 8 minutes -----------------------------------------------------------------------------

test('over budget only when the slowest tenth is strictly above 8 minutes; no runs is never over', () => {
  const week = (min) => measureWeeks([rec(min)], NOW).current;
  assert.equal(overBudget(week(8)), false);
  assert.equal(overBudget(week(8.05)), true); // 483 s
  assert.equal(overBudget(week(7)), false);
  assert.equal(overBudget(measureWeeks([], NOW).current), false);
});

test('the budget looks at the slowest tenth, not the typical run: a fast week with a long tail is over', () => {
  const records = [...Array.from({ length: 8 }, () => rec(3)), rec(9), rec(12)];
  const { current } = measureWeeks(records, NOW);
  assert.equal(current.run.typicalSec, 180);
  assert.equal(current.run.slowestTenthSec, 540);
  assert.equal(overBudget(current), true);
});

test('queue time alone never puts a week over budget', () => {
  assert.equal(overBudget(measureWeeks([rec(3, { queueMin: 90 })], NOW).current), false);
});

test('the trend is this week against the previous one, and absent when the previous week had no runs', () => {
  const w = measureWeeks([rec(9, { doneAt: '2026-11-05T12:00:00Z' }), rec(6, { doneAt: '2026-10-30T12:00:00Z' })], NOW);
  assert.deepEqual(trend(w), { runsDelta: 0, typicalDeltaSec: 180, slowestTenthDeltaSec: 180 });
  assert.equal(trend(measureWeeks([rec(9)], NOW)), null);
  assert.equal(trend(measureWeeks([rec(9, { doneAt: '2026-10-30T12:00:00Z' })], NOW)), null);
});

test('durations read as minutes and seconds', () => {
  assert.equal(formatDuration(540), '9 min 00 s');
  assert.equal(formatDuration(8 * 60 + 5), '8 min 05 s');
  assert.equal(formatDuration(45), '0 min 45 s');
});

// ---- the report ----------------------------------------------------------------------------------------------------------------

const slow = { source: 'run 42346529929', files: [{ file: 'src/__tests__/a-db.test.ts', lane: '3', time: '95.2 s' }, { file: 'src/__tests__/b-db.test.ts', lane: '1', time: '80.0 s' }] };

test('the Database section carries run time, queue time, what was left out, the trend and the slowest files', () => {
  const weeks = measureWeeks(
    [rec(9, { queueMin: 20 }), rec(10, { queueMin: 2, runAttempt: 2 }), rec(2, { conclusion: 'cancelled' }), rec(6, { doneAt: '2026-10-30T12:00:00Z' })],
    NOW,
  );
  const s = databaseSection({ weeks, slowest: slow });
  assert.equal(s.id, 'database');
  assert.equal(s.breach, true);
  assert.match(s.markdown, /Slowest tenth: \*\*9 min 00 s\*\*/);
  assert.match(s.markdown, /Budget: 8 min 00 s/);
  assert.match(s.markdown, /Run time[\s\S]*Typical run: 9 min 00 s/);
  assert.match(s.markdown, /Queue time[^\n]*\n[\s\S]*Typical wait: 20 min 00 s/);
  assert.match(s.markdown, /1 re-run/);
  assert.match(s.markdown, /1 cancelled/);
  assert.match(s.markdown, /Previous week[^\n]*: 1 run[\s\S]*slowest tenth 6 min 00 s/);
  assert.match(s.markdown, /up 3 min 00 s/);
  assert.match(s.markdown, /\| `src\/__tests__\/a-db\.test\.ts` \| `3` \| `95\.2 s` \|/);
  assert.match(s.markdown, /run 42346529929/);
});

test('an empty week reports that there was nothing to measure and is not a breach', () => {
  const s = databaseSection({ weeks: measureWeeks([], NOW), slowest: null });
  assert.equal(s.breach, false);
  assert.match(s.markdown, /No successful first execution/);
});

test('when no recent run printed its slowest files, the section says so instead of inventing a list', () => {
  const s = databaseSection({ weeks: measureWeeks([rec(9)], NOW), slowest: null });
  assert.match(s.markdown, /slowest files[\s\S]*not available/i);
});

test('the report is a list of sections, so another check can add its own; every section appears under its title', () => {
  const frontend = { id: 'frontend', title: 'Frontend', breach: false, markdown: 'FE-BODY' };
  const database = databaseSection({ weeks: measureWeeks([rec(9)], NOW), slowest: slow });
  const text = renderReport([database, frontend], NOW);
  assert.match(text, /^## Weekly CI time budget/);
  assert.ok(text.indexOf('Database check') < text.indexOf('FE-BODY'));
  assert.match(text, /### Frontend\n\nFE-BODY/);
  assert.ok(text.includes(MARKER));
});

// ---- the one open ticket -------------------------------------------------------------------------------------------------------

const over = databaseSection({ weeks: measureWeeks([rec(9)], NOW), slowest: slow });
const under = databaseSection({ weeks: measureWeeks([rec(5)], NOW), slowest: slow });
const ticket = (number, body = `old\n${MARKER}`, extra = {}) => ({ number, body, ...extra });

test('under budget does nothing, even when a ticket is open', () => {
  assert.deepEqual(decide({ sections: [under], openTickets: [] }), { kind: 'none' });
  assert.deepEqual(decide({ sections: [under], openTickets: [ticket(10)] }), { kind: 'none' });
});

test('over budget with no open ticket opens one, labelled with one priority and one module label', () => {
  const d = decide({ sections: [over], openTickets: [] }, NOW);
  assert.equal(d.kind, 'open');
  assert.deepEqual(d.labels.filter((l) => l.startsWith('priority:')), ['priority:medium']);
  assert.deepEqual(d.labels.filter((l) => l.startsWith('module:')), ['module:general']);
  assert.ok(d.labels.includes('ci-budget'));
  assert.ok(d.body.includes(MARKER));
  assert.match(d.body, /Slowest tenth: \*\*9 min 00 s\*\*/);
  assert.match(d.title, /^CI weekly time budget/);
});

test('over budget with a ticket already open comments on it and never opens a second', () => {
  const d = decide({ sections: [over], openTickets: [ticket(77)] }, NOW);
  assert.equal(d.kind, 'comment');
  assert.equal(d.number, 77);
  assert.match(d.body, /Slowest tenth: \*\*9 min 00 s\*\*/);
});

test('an open issue without the marker, or a pull request, is not the budget ticket', () => {
  const d = decide({ sections: [over], openTickets: [ticket(5, 'someone elses ticket'), ticket(6, `x ${MARKER}`, { pull_request: {} })] }, NOW);
  assert.equal(d.kind, 'open');
});

test('with two marked tickets open the oldest gets the comment, and the comment names the other', () => {
  const d = decide({ sections: [over], openTickets: [ticket(90), ticket(80)] }, NOW);
  assert.equal(d.kind, 'comment');
  assert.equal(d.number, 80);
  assert.match(d.body, /#90/);
});

test('a breach in any section counts: the ticket opens when a later section is over and the database is not', () => {
  const frontend = { id: 'frontend', title: 'Frontend', breach: true, markdown: 'too slow' };
  assert.equal(decide({ sections: [under, frontend], openTickets: [] }, NOW).kind, 'open');
});

// ---- the ten slowest files, read from the latest run's log ---------------------------------------------------------------------

const stamp = (l) => `2026-11-07T06:50:00.1234567Z ${l}`;
const logOf = (lines) => lines.map(stamp).join('\n');

test('the ten slowest files are read from the table the Database command prints, log timestamps and all', () => {
  const log = logOf([
    'unrelated line',
    '### Retried tests (0, more than 10 fails the run)',
    '',
    'None.',
    '',
    SLOWEST_FILES_HEADING,
    '',
    SLOWEST_FILES_HEADER_ROW,
    '|---|---|---|',
    '| src/__tests__/a-db.test.ts | 3 | 95.2 s |',
    '| src/__tests__/odd\\|name-db.test.ts | 1 | 80.0 s |',
    '',
    'Total test seconds: 900 of a budget of 1200 (75%).',
    '| not part of the table | x | y |',
  ]);
  assert.deepEqual(slowestFilesFromLog(log), [
    { file: 'src/__tests__/a-db.test.ts', lane: '3', time: '95.2 s' },
    { file: 'src/__tests__/odd|name-db.test.ts', lane: '1', time: '80.0 s' },
  ]);
});

test('a log without that table (an older run, or a run that skipped its lanes) gives no list, not an empty one', () => {
  assert.equal(slowestFilesFromLog(logOf(['### Core checks', '| a | b | c |'])), null);
  assert.equal(slowestFilesFromLog(''), null);
});

test('a table under that heading with other columns is not read as files', () => {
  assert.equal(slowestFilesFromLog(logOf([SLOWEST_FILES_HEADING, '', '| Phase | Result | Time |', '|---|---|---|', '| roles | passed | 1.0 s |'])), null);
});

test('the heading and column row this reader looks for are the ones the Database command prints', () => {
  const summary = readFileSync(fileURLToPath(new URL('../../backend/scripts/ci-db/summary.ts', import.meta.url)), 'utf8');
  assert.ok(summary.includes(`'${SLOWEST_FILES_HEADING}'`), 'summary.ts no longer prints the heading this reader looks for');
  assert.ok(summary.includes(`'${SLOWEST_FILES_HEADER_ROW}'`), 'summary.ts no longer prints the column row this reader looks for');
});

// The workflow pins (#3242). Plain-text reads of ci-budget.yml (no YAML dependency: this file runs in a job with none needed).
const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci-budget.yml', import.meta.url)), 'utf8');
/** The text of one top-level job (from `  <id>:` to the next job or the end). */
const jobBlock = (id) => workflow.split(/^  (?=[a-z-]+:\n)/m).find((b) => b.startsWith(`${id}:\n`)) ?? assert.fail(`job ${id} not found`);
const uncommented = (t) => t.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('every run that can write the ticket shares ONE constant concurrency group and is queued, never cancelled', () => {
  const writer = uncommented(jobBlock('budget'));
  assert.match(writer, /^ {4}concurrency:\n {6}group: ci-budget-writer\n {6}cancel-in-progress: false$/m);
  assert.doesNotMatch(writer.match(/group: .*/)[0], /\$\{\{/, 'the writer group must not depend on the event or the ref');
  // A workflow-level group would put the ticket-writing runs in per-event/per-ref groups again.
  assert.doesNotMatch(uncommented(workflow.split(/^jobs:/m)[0]), /^concurrency:/m);
});

test('only the job that writes the ticket may write issues; the workflow default is read-only', () => {
  const top = uncommented(workflow.split(/^jobs:/m)[0]);
  assert.match(top, /^permissions:\n {2}actions: read\n {2}contents: read$/m);
  assert.doesNotMatch(top, /write/);
  assert.match(uncommented(jobBlock('budget')), /^ {6}issues: write$/m);
  assert.equal((uncommented(workflow).match(/issues: write/g) ?? []).length, 1);
});

test('M1c: the Database marker only counts as the last line of the body, not in the middle of it', () => {
  const over = { id: 'database', title: 'Database check', breach: true, markdown: 'x' };
  const forged = [ticket(1, `see ${MARKER} here`), ticket(2, `${MARKER}\ntext after`), ticket(3, `${MARKER} trailing`)];
  assert.equal(decide({ sections: [over], openTickets: forged }, NOW).kind, 'open');
  assert.equal(decide({ sections: [over], openTickets: [...forged, ticket(4, `report\n${MARKER}\n`)] }, NOW).number, 4);
});

test('M1b: the Database section\'s slowest-files table is code-spanned', () => {
  const s = databaseSection({ weeks: measureWeeks([], NOW), slowest: { source: 'run 1', files: [{ file: 'src/@evil`.test.ts', lane: '#9', time: '1.0' }] } });
  assert.match(s.markdown, /\| `src\/@evil'\.test\.ts` \| `#9` \| `1\.0` \|/);
});
