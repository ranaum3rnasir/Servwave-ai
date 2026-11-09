// Run with: node --test scripts/ci-budget/frontend.test.mjs
// Seam: frontendReport() is PURE over run records (+ their log lines), the latest full run's log lines and the budget file ->
// the Frontend section and the list of ticket actions. Expected figures are worked by hand, never recomputed the way the code does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  frontendReport, relevantLines, parseRunLines, classify, slowestFilesFromLines, measuredFromLines, budgetRows, actionFor,
  ERROR_FALLBACK_REASONS, FALLBACK_MARKER, retriedMarker, FRONTEND_JOB_NAME,
} from './frontend.mjs';

const NOW = '2026-11-08T12:00:00Z';
const MIN = 60_000;
const at = (iso, plusMs) => new Date(Date.parse(iso) + plusMs).toISOString();
const BUDGET = { maxCpuSeconds: 4500, workers: 6, maxMinutes: 10, maxTestFiles: 1527 };

const verdict = (extra = '', retried = 0) => `TEST-CI-VERDICT result=passed code=0 reasons=none mode=full ${extra}files=10/10 passed=100 failed=0 retried=${retried}`.replace('mode=full selection=', 'mode=full selection=');

/** One finished execution of the Frontend job. `lines` default to a plain full run with selection off; by default it is a push to staging (a trusted run). */
let nextId = 1000;
function run({ runMin = 15, queueMin = 1, doneAt = '2026-11-05T12:00:00Z', runId = nextId++, lines = [verdict()], ...over } = {}) {
  const startedAt = at(doneAt, -runMin * MIN);
  return {
    runId, runAttempt: 1, conclusion: 'success', labels: ['self-hosted', 'macOS'], runnerGroup: 'Default',
    createdAt: at(startedAt, -queueMin * MIN), startedAt, completedAt: doneAt, lines, event: 'push', headBranch: 'staging', ...over,
  };
}
const report = (runs, extra = {}) => frontendReport({ now: NOW, runs, nightly: { unavailable: 'test' }, budget: BUDGET, openTickets: [], ...extra });
const shadowLines = (reason, would = 'full') => [verdict('selection=shadow '), `TEST-SELECT-SHADOW would=${would} reason=${reason} failing=0 misses=0`];

test('an empty week prints a section that says there was nothing to tally, and asks for no ticket', () => {
  const { section, actions } = report([]);
  assert.deepEqual(actions, []);
  assert.equal(section.id, 'frontend');
  assert.equal(section.breach, false);
  assert.match(section.markdown, /No Frontend check finished in the last 7 days/);
  assert.match(section.markdown, /No successful first execution on a self-hosted machine/);
  assert.match(section.markdown, /Not available: test/);
});

test('all full runs (selection off): one row, every run counted, no fallbacks, no tickets', () => {
  const runs = Array.from({ length: 10 }, () => run());
  const { section, actions } = report(runs);
  assert.deepEqual(actions, []);
  assert.match(section.markdown, /\| off \| full \| selection off \| - \| 10 \|/);
  assert.match(section.markdown, /Test selection is off: every run was full\./);
  assert.match(section.markdown, /Error-type fallbacks .*: \*\*0 of 10 \(0%\)\*\*.*within it/);
});

test('6% error fallbacks (3 of 50 runs) open ONE ticket; the line is strictly above 5%', () => {
  const runs = [
    ...Array.from({ length: 47 }, () => run({ lines: shadowLines('changed-files', 'selected-4-of-1597') })),
    run({ lines: shadowLines('selector-threw') }),
    run({ lines: shadowLines('selector-timeout') }),
    run({ lines: shadowLines('unclassified-path') }),
  ];
  const { section, actions } = report(runs);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'open');
  assert.equal(actions[0].cause, 'error-fallbacks');
  assert.deepEqual(actions[0].labels, ['priority:medium', 'module:general', 'ci-budget']);
  assert.match(actions[0].body, /\*\*3 runs of 50 \(6%\)\*\*/);
  assert.match(actions[0].body, /\| selector-threw \| 1 \|/);
  assert.ok(actions[0].body.includes(FALLBACK_MARKER));
  assert.match(section.markdown, /\*\*3 of 50 \(6%\)\*\*.*over it/);
  assert.match(section.markdown, /\| shadow \| full \| changed-files \| selected \| 47 \|/);
});

test('exactly 5% (the line itself) is within it: 5 of 100 opens nothing', () => {
  const runs = [...Array.from({ length: 95 }, () => run()), ...Array.from({ length: 5 }, () => run({ lines: shadowLines('selector-threw') }))];
  assert.deepEqual(report(runs).actions, []);
});

test('deliberate full runs (lockfile, promotion, workflows) are not error fallbacks, however many', () => {
  const runs = Array.from({ length: 10 }, () => run({ lines: shadowLines('lockfile') }));
  const { section, actions } = report(runs);
  assert.deepEqual(actions, []);
  assert.match(section.markdown, /\*\*0 of 10 \(0%\)\*\*/);
});

test('selection ON: the reason is on the verdict line, a selected run is told apart from a full one', () => {
  const runs = [
    run({ lines: ['TEST-CI-VERDICT result=passed code=0 reasons=none mode=selected-12-of-1597 selection=changed-files files=12/12 passed=9 failed=0 retried=0'] }),
    run({ lines: ['TEST-CI-VERDICT result=passed code=0 reasons=none mode=full selection=selector-threw files=10/10 passed=9 failed=0 retried=0'] }),
  ];
  const { section, actions } = report(runs);
  assert.match(section.markdown, /\| on \| selected \| changed-files \| - \| 1 \|/);
  assert.match(section.markdown, /\| on \| full \| selector-threw \| - \| 1 \|/);
  assert.equal(actions[0].cause, 'error-fallbacks'); // 1 of 2
});

test('an execution with no verdict line, or an unreadable log, is reported apart and is not in the denominator', () => {
  const runs = [run(), run({ lines: [] }), run({ lines: null }), run({ lines: shadowLines('selector-threw') })];
  const { section } = report(runs);
  assert.match(section.markdown, /4 executions .* 2 executions printed a verdict/);
  assert.match(section.markdown, /1 with no verdict line/);
  assert.match(section.markdown, /1 whose log could not be read/);
  assert.match(section.markdown, /\*\*1 of 2 \(50%\)\*\*/);
});

test('hosted shard verdicts are tallied as shards and never as fallbacks', () => {
  const { section } = report([run({ lines: ['TEST-CI-VERDICT result=passed code=0 reasons=none mode=shard-2-of-6 files=3/3 passed=9 failed=0 retried=0'] })]);
  assert.match(section.markdown, /\| shard \| shard \| hosted shard \| - \| 1 \|/);
});

test('a test retried in two runs gets a ticket; retried in one run, nothing', () => {
  const retried = (file, test) => [verdict('', 1), `TEST-CI-RETRIED attempts=2 file=${file} test=${test}`];
  const runs = [
    run({ runId: 1, lines: retried('src/a.test.ts', 'saves the form') }),
    run({ runId: 2, lines: retried('src/a.test.ts', 'saves the form') }),
    run({ runId: 3, lines: retried('src/b.test.ts', 'only once') }),
    run({ runId: 4 }),
  ];
  const { section, actions } = report(runs);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'open');
  assert.deepEqual(actions[0].labels, ['priority:low', 'module:general', 'ci-budget']);
  assert.match(actions[0].title, /src\/a\.test\.ts > saves the form/);
  assert.match(actions[0].body, /Workflow runs: 1, 2/);
  assert.ok(actions[0].body.includes(retriedMarker('src/a.test.ts', 'saves the form')));
  assert.match(section.markdown, /\| `src\/a\.test\.ts` \| `saves the form` \| 2 \|/);
  assert.doesNotMatch(section.markdown, /only once/);
});

test('two attempts of ONE workflow run are one run, not two', () => {
  const lines = [verdict('', 1), 'TEST-CI-RETRIED attempts=2 file=src/a.test.ts test=x'];
  const { actions } = report([run({ runId: 7, lines }), run({ runId: 7, runAttempt: 2, lines })]);
  assert.deepEqual(actions, []);
});

test('runs that logged only the retry COUNT are reported as names not logged, never guessed', () => {
  const { section, actions } = report([run({ lines: [verdict('', 3)] }), run({ lines: [verdict('', 1)] })]);
  assert.deepEqual(actions, []);
  assert.match(section.markdown, /2 executions retried tests whose names were not logged/);
});

test('exactly one open ticket per cause: an open ticket with the marker gets a comment, never a second ticket', () => {
  const failing = Array.from({ length: 10 }, () => run({ lines: shadowLines('selector-threw') }));
  const open = [{ number: 41, body: `old\n${FALLBACK_MARKER}\n` }];
  const { actions } = report(failing, { openTickets: open });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'comment');
  assert.equal(actions[0].number, 41);
});

test('each cause has its own ticket: a retried test and the fallbacks open two, and a second flaky test a third, each exactly once', () => {
  const lines = (test) => [...shadowLines('selector-threw'), `TEST-CI-RETRIED attempts=2 file=src/a.test.ts test=${test}`];
  const runs = [run({ runId: 1, lines: lines('one') }), run({ runId: 2, lines: lines('one') }), run({ runId: 3, lines: lines('two') }), run({ runId: 4, lines: lines('two') })];
  const { actions } = report(runs);
  assert.deepEqual(actions.map((a) => a.kind), ['open', 'open', 'open']);
  assert.equal(new Set(actions.map((a) => a.cause)).size, 3);
  assert.equal(new Set(actions.map((a) => a.body.match(/<!-- [^>]+ -->/)[0])).size, 3);
});

test('running it again with the tickets it would have opened now open gives comments only: one open ticket per cause at any time', () => {
  const runs = [run({ runId: 1, lines: [verdict('', 1), 'TEST-CI-RETRIED attempts=2 file=src/a.test.ts test=x'] }), run({ runId: 2, lines: [verdict('', 1), 'TEST-CI-RETRIED attempts=2 file=src/a.test.ts test=x'] })];
  const first = report(runs).actions;
  assert.deepEqual(first.map((a) => a.kind), ['open']);
  const openNow = first.map((a, i) => ({ number: 100 + i, body: a.body }));
  const second = report(runs, { openTickets: openNow }).actions;
  assert.deepEqual(second.map((a) => [a.kind, a.number]), [['comment', 100]]);
});

test('an open pull request, or an issue without the marker, is not the ticket; two marked tickets: the oldest gets the comment and the body names the other', () => {
  const failing = Array.from({ length: 4 }, () => run({ lines: shadowLines('selector-threw') }));
  const notThem = [{ number: 5, body: FALLBACK_MARKER, pull_request: {} }, { number: 6, body: 'a ticket without it' }];
  assert.equal(report(failing, { openTickets: notThem }).actions[0].kind, 'open');
  const two = [{ number: 9, body: FALLBACK_MARKER }, { number: 8, body: FALLBACK_MARKER }];
  const a = report(failing, { openTickets: two }).actions[0];
  assert.equal(a.number, 8);
  assert.match(a.body, /Also open with the same marker: #9\./);
});

test('the Database ticket marker is not one of ours, so the two reports never take each other\'s ticket', () => {
  const failing = Array.from({ length: 4 }, () => run({ lines: shadowLines('selector-threw') }));
  const dbOnly = [{ number: 3, body: '<!-- ci-weekly-budget -->' }];
  assert.equal(report(failing, { openTickets: dbOnly }).actions[0].kind, 'open');
});

test('only executions finished in the last seven days are tallied', () => {
  const old = run({ doneAt: '2026-10-20T12:00:00Z', lines: shadowLines('selector-threw') });
  const future = run({ doneAt: '2026-11-09T12:00:00Z', lines: shadowLines('selector-threw') });
  const { section, actions } = report([old, future, run()]);
  assert.deepEqual(actions, []);
  assert.match(section.markdown, /1 execution of the Frontend check finished/);
});

test('durations: typical and slowest tenth of the Frontend check; queue time apart and never added', () => {
  const runs = Array.from({ length: 10 }, (_, i) => run({ runMin: i + 1, queueMin: 20 }));
  const { section } = report(runs);
  assert.match(section.markdown, /Typical run: 5 min 30 s/);
  assert.match(section.markdown, /Slowest tenth: 9 min 00 s/);
  assert.match(section.markdown, /Longest run: 10 min 00 s/);
  assert.match(section.markdown, /Typical wait: 20 min 00 s/);
  assert.match(section.markdown, /never added to the run time/);
});

test('the Frontend section never marks a breach (its tickets are its own), so it cannot open the Database ticket', () => {
  const failing = Array.from({ length: 4 }, () => run({ lines: shadowLines('selector-threw') }));
  assert.equal(report(failing).section.breach, false);
});

// ---- the latest full run -------------------------------------------------------------------------------------------------------

const FULL_RUN = [
  'test-brake budget:',
  '| Figure | Measured | Budget |',
  '|---|---|---|',
  '| CPU-seconds | 4462 | 4500 |',
  '| Minutes of test step (4 workers) | 16.5 | 10.0 (at 6 workers) |',
  '| Test files (moves with maxTestFiles) | 1597 | 1597 |',
  'test-brake: minutes not judged: run at 4 workers, budget at 6',
  'test-brake: 20 slowest files',
  '| # | File | Seconds | Tests |',
  '|---|---|---|---|',
  ...Array.from({ length: 22 }, (_, i) => `| ${i + 1} | src/f${i + 1}.test.ts | ${(100 - i).toFixed(1)} | ${i + 3} |`),
  '',
  'TEST-BRAKE-VERDICT result=passed code=0 reasons=none',
];

test('the slowest files are read from the table a full run prints, at most 20', () => {
  const files = slowestFilesFromLines(FULL_RUN);
  assert.equal(files.length, 22);
  assert.deepEqual(files[0], { rank: 1, file: 'src/f1.test.ts', seconds: 100, tests: 3 });
  const { section } = report([], { nightly: { kind: 'nightly', source: 'run 5', lines: FULL_RUN } });
  assert.match(section.markdown, /\| 20 \| `src\/f20\.test\.ts` \| 81 \| 22 \|/);
  assert.doesNotMatch(section.markdown, /f21\.test/);
  assert.match(section.markdown, /Source: the latest nightly full run, run 5\./);
});

test('the budget figures are the run\'s against the budget file; minutes only compare at the budget\'s worker count', () => {
  const measured = measuredFromLines(FULL_RUN);
  assert.deepEqual(measured, { cpuSeconds: 4462, minutes: 16.5, workers: 4, files: 1597 });
  const rows = budgetRows(measured, BUDGET);
  assert.equal(rows[0].status, 'within');
  assert.equal(rows[1].status, 'not comparable (run at 4 workers)');
  assert.equal(rows[2].status, 'OVER'); // 1597 files against 1527
  assert.equal(budgetRows({ ...measured, workers: 6 }, BUDGET)[1].status, 'OVER'); // 16.5 min against 10
  assert.equal(budgetRows({ ...measured, workers: 6, minutes: 9 }, BUDGET)[1].status, 'within');
});

test('no nightly run, or one that printed no tables: the section says so and invents nothing', () => {
  const none = report([], { nightly: { unavailable: 'no nightly full run exists yet' } }).section.markdown;
  assert.match(none, /Not available: no nightly full run exists yet\./);
  const bare = report([], { nightly: { kind: 'nightly', source: 'run 5', lines: ['TEST-CI-VERDICT result=failed'] } }).section.markdown;
  assert.match(bare, /printed no budget table/);
  assert.match(bare, /printed no table of slowest files/);
});

test('a full pull request run used because no nightly exists is labelled as such', () => {
  const md = report([], { nightly: { kind: 'pull-request', source: 'run 9', lines: FULL_RUN } }).section.markdown;
  assert.match(md, /the newest full pull request run \(no nightly full run has been read yet\)/);
});

// ---- reading the log ------------------------------------------------------------------------------------------------------------

test('relevantLines drops timestamps and colour codes and keeps only the lines this report reads', () => {
  const log = [
    '2026-11-08T20:55:26.4730510Z TEST-CI-VERDICT result=passed code=0 reasons=none mode=full files=1/1 passed=1 failed=0 retried=0',
    '2026-11-08T20:55:26.4730511Z \u001b[32m✓\u001b[39m src/x.test.ts',
    '2026-11-08T20:55:26.4730512Z test-select: shadow: full, reason=lockfile',
    '2026-11-08T20:55:26.4730513Z TEST-SELECT-SHADOW would=full reason=lockfile failing=0 misses=0\r',
    '2026-11-08T20:55:26.4730514Z TEST-CI-RETRIED attempts=2 file=src/a.test.ts test=has spaces in it',
  ].join('\n');
  const lines = relevantLines(log);
  assert.equal(lines.length, 4);
  const p = parseRunLines(lines);
  assert.equal(p.verdict.retried, '0');
  assert.equal(p.shadow.reason, 'lockfile');
  assert.deepEqual(p.retried, [{ file: 'src/a.test.ts', test: 'has spaces in it' }]);
});

test('classify: off, shadow (with what it would have done), on, shard, none', () => {
  const c = (...l) => classify(parseRunLines(l));
  assert.deepEqual(c(verdict()), { selection: 'off', ran: 'full', reason: 'selection off', would: '-' });
  assert.deepEqual(c(...shadowLines('lockfile')), { selection: 'shadow', ran: 'full', reason: 'lockfile', would: 'full' });
  assert.equal(c(...shadowLines('changed-files', 'selected-3-of-9')).would, 'selected');
  assert.equal(c(verdict('selection=shadow ')).reason, 'unknown (no shadow line)');
  assert.equal(c().selection, 'none');
});

// ---- the codes this report calls errors are real codes -----------------------------------------------------------------------------

test('every reason this report treats as an error-type fallback is a code the selector really prints', () => {
  const source = readFileSync(fileURLToPath(new URL('../../frontend/scripts/test-select-lib.mjs', import.meta.url)), 'utf8');
  for (const code of ERROR_FALLBACK_REASONS) assert.match(source, new RegExp(`'${code}'`), `${code} is not a reason the selector prints`);
});

test('the command prints the TEST-CI-RETRIED line this report reads, in the same shape', () => {
  const source = readFileSync(fileURLToPath(new URL('../../frontend/scripts/test-ci-lib.mjs', import.meta.url)), 'utf8');
  assert.ok(source.includes('`TEST-CI-RETRIED attempts=${r.attempts} file=${r.file} test='));
});

test('the Frontend job name is the one ci.yml declares', () => {
  const ci = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
  assert.ok(ci.includes(`name: ${FRONTEND_JOB_NAME}`));
});

test('actionFor on its own: no marker anywhere means open', () => {
  const cause = { key: 'k', marker: '<!-- m -->', title: 't', labels: ['a'], body: 'b' };
  assert.equal(actionFor(cause, []).kind, 'open');
  assert.equal(actionFor(cause, [{ number: 1, body: '<!-- m -->' }]).kind, 'comment');
});

test('the 5% is of the runs that printed a verdict: runs with no verdict (a cancelled run) do not dilute it', () => {
  const runs = [run({ lines: shadowLines('selector-threw') }), run({ lines: shadowLines('lockfile') }), ...Array.from({ length: 30 }, () => run({ lines: [] }))];
  const { actions } = report(runs);
  assert.equal(actions.length, 1); // 1 of 2, not 1 of 32
});

// ---- M1: code in an unmerged pull request must not steer the bot's tickets -------------------------------------------------------

const flaky = (test, file = 'src/a.test.ts') => [verdict('', 1), `TEST-CI-RETRIED attempts=2 file=${file} test=${test}`];
const nightlyRun = (runId, lines) => ({ runId, completedAt: '2026-11-04T04:00:00Z', lines });

test('M1a: TEST-CI-RETRIED lines from pull request runs open nothing and are not in the report', () => {
  const crafted = flaky('x @some-team <!-- ci-weekly-budget -->');
  const runs = Array.from({ length: 50 }, (_, i) => run({ runId: 1 + i, event: 'pull_request', headBranch: 'feature/x', lines: crafted }));
  const { section, actions } = report(runs);
  assert.deepEqual(actions, []);
  assert.doesNotMatch(section.markdown, /some-team/);
  assert.match(section.markdown, /Tests retried in two or more runs this week\n\nNone\./);
});

test('M1a: a push to a branch that is not staging or main (a throwaway ref) is not trusted either', () => {
  const runs = [1, 2].map((id) => run({ runId: id, event: 'push', headBranch: 'attacker', lines: flaky('x') }));
  assert.deepEqual(report(runs).actions, []);
});

test('M1a: retries count from pushes to staging and from the nightly runs, together', () => {
  const { actions } = report([run({ runId: 1, lines: flaky('x') })], { nightlyRuns: [nightlyRun(2, flaky('x'))] });
  assert.equal(actions.length, 1);
  assert.match(actions[0].body, /Workflow runs: 1, 2/);
});

test('M1a: a pull request run and a staging run of the same test are ONE trusted run, so no ticket', () => {
  const runs = [run({ runId: 1, lines: flaky('x') }), run({ runId: 2, event: 'pull_request', headBranch: 'f', lines: flaky('x') })];
  assert.deepEqual(report(runs).actions, []);
});

test('M1b: file and test text goes into the title, body and table as a code span: no backtick, mention or issue reference survives as live text', () => {
  const nasty = 'ends` here @some-team see #123 <!-- ci-weekly-budget --> | pipe';
  const runs = [1, 2].map((id) => run({ runId: id, lines: flaky(nasty, 'src/`a`@b.ts') }));
  const { section, actions } = report(runs);
  const a = actions[0];
  assert.equal(a.title, "Flaky test: `src/'a'@b.ts > ends' here @some-team see #123 <! -- ci-weekly-budget -- > | pipe`");
  const testLine = a.body.split('\n').find((l) => l.startsWith('- Test: '));
  assert.equal(testLine, "- Test: `ends' here @some-team see #123 <! -- ci-weekly-budget -- > | pipe`");
  assert.ok(a.body.split('\n').find((l) => l.startsWith('- File: ')).startsWith("- File: `src/'a'@b.ts`"));
  assert.ok(!a.body.includes('<!-- ci-weekly-budget -->'));
  assert.ok(!section.markdown.includes('<!-- ci-weekly-budget -->'));
  const row = section.markdown.split('\n').find((l) => l.includes('some-team'));
  assert.equal(row, "| `src/'a'@b.ts` | `ends' here @some-team see #123 <! -- ci-weekly-budget -- > \\| pipe` | 2 |");
});

test('M1b: the selection reason of a verdict line (log text) is a code span in the table too', () => {
  const evil = 'TEST-CI-VERDICT result=passed code=0 reasons=none mode=full selection=@team#9 files=1/1 passed=1 failed=0 retried=0';
  const { section } = report([run({ lines: [evil] })]);
  assert.match(section.markdown, /\| on \| full \| `@team#9` \| - \| 1 \|/);
  assert.doesNotMatch(section.markdown, /\| @team#9 \|/);
});

test('M1b: the slowest-files table of the latest full run is code-spanned', () => {
  const lines = ['| # | File | Seconds | Tests |', '|---|---|---|---|', '| 1 | src/@evil`x.test.ts | 3.2 | 4 |'];
  const { section } = frontendReport({ now: NOW, runs: [], nightly: { kind: 'nightly', source: 'run 1', lines }, budget: BUDGET });
  assert.match(section.markdown, /\| 1 \| `src\/@evil'x\.test\.ts` \| 3\.2 \| 4 \|/);
});

test('M1c: a marker in the middle of an open issue\'s body (or in its title text) does not make it our ticket', () => {
  const failing = Array.from({ length: 4 }, () => run({ lines: shadowLines('selector-threw') }));
  const forged = [{ number: 7, body: `hello ${FALLBACK_MARKER} and more text` }, { number: 8, body: `${FALLBACK_MARKER}\nmore text after` }];
  assert.equal(report(failing, { openTickets: forged }).actions[0].kind, 'open');
  const real = [{ number: 9, body: `report\n${FALLBACK_MARKER}\n` }];
  assert.equal(report(failing, { openTickets: real }).actions[0].number, 9);
  const key = [1, 2].map((id) => run({ runId: id, lines: flaky('x') }));
  const m = retriedMarker('src/a.test.ts', 'x');
  assert.equal(report(key, { openTickets: [{ number: 3, body: `a ${m} b` }] }).actions[0].kind, 'open');
});

test('M1d: at most 5 flaky-test tickets per run (the most-retried first), the overflow is counted in the section', () => {
  const runs = [];
  for (let t = 0; t < 8; t += 1) for (const id of [1, 2]) runs.push(run({ runId: t * 10 + id, lines: flaky(`test ${t}`) }));
  const { section, actions } = report(runs);
  assert.equal(actions.length, 5);
  assert.match(section.markdown, /3 more tests are over the line and got no ticket this run \(at most 5 tickets per run, the most-retried first\)/);
});
