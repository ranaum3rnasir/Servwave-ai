// Run with: node --test scripts/ci-nightly/lib.test.mjs
// Seam: pure functions over a captured test log, a list of failure lines and the list of open issues -> report, decision, text.
// Expected values are written out by hand from the issue text (#3256), never recomputed the way the code computes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseVerdictLine, failedFilesFromLines, budgetSection, buildReport, classify, decide, renderSummary,
  MARKER, ISSUE_LABELS, FAILED_FILES_SHOWN, normalizeRef, isValidRef, stateOf,
} from './lib.mjs';

const GREEN = 'TEST-CI-VERDICT result=passed code=0 reasons=none mode=full files=1597/1597 passed=16950 failed=0 retried=1';
const RED = 'TEST-CI-VERDICT result=failed code=10 reasons=test-failed mode=full files=1597/1597 passed=16948 failed=2 retried=0';
const BRAKE = 'TEST-BRAKE-VERDICT result=passed code=0 reasons=none time=not-judged (no base)';
const SUMMARY = ['## Frontend tests', '', 'x', '## Test growth brake', '', '### Budget', '', '| Figure | Measured | Budget |', '|---|---|---|', '| CPU-seconds | 3000 | 4500 |', '', '### 20 slowest files', '', 'a'].join('\n');
const LINES = [
  'FAILED src/__tests__/a.test.tsx > shows the total: expected 3',
  'FAILED src/__tests__/a.test.tsx > shows the tax: expected 4',
  'FAILED src/pages/b.test.tsx (file): cannot import',
  'UNHANDLED boom',
];

const input = (over = {}) => ({
  ref: 'staging', sha: 'abc1234', exitCode: 0, log: `${GREEN}\n${BRAKE}\n`, failedLines: [], summaryMd: SUMMARY, runSeconds: 754, ...over,
});

test('the verdict line is read into its fields', () => {
  assert.deepEqual(parseVerdictLine(`noise\n${RED}\nmore`), {
    line: RED, result: 'failed', code: 10, reasons: ['test-failed'], mode: 'full', files: '1597/1597', passed: 16948, failed: 2, retried: 0,
  });
});

test('a log with no verdict line gives null; several lines give the last one', () => {
  assert.equal(parseVerdictLine('nothing here'), null);
  assert.equal(parseVerdictLine(`${RED}\n${GREEN}`).result, 'passed');
});

test('failed files: each file once, in first-seen order, from FAILED and file/suite lines; UNHANDLED lines name no file', () => {
  assert.deepEqual(failedFilesFromLines(LINES), ['src/__tests__/a.test.tsx', 'src/pages/b.test.tsx']);
});

test('the budget section is cut out of the run summary, up to the next heading', () => {
  assert.equal(budgetSection(SUMMARY), '| Figure | Measured | Budget |\n|---|---|---|\n| CPU-seconds | 3000 | 4500 |');
  assert.equal(budgetSection('## nothing'), null);
});

test('the report carries both verdict lines, the failed files, the budget figures and the run time', () => {
  const r = buildReport(input({ exitCode: 10, log: `${RED}\n${BRAKE}\n`, failedLines: LINES }));
  assert.equal(r.verdictLine, RED);
  assert.equal(r.brakeLine, BRAKE);
  assert.deepEqual(r.failedFiles, ['src/__tests__/a.test.tsx', 'src/pages/b.test.tsx']);
  assert.equal(r.budget, '| Figure | Measured | Budget |\n|---|---|---|\n| CPU-seconds | 3000 | 4500 |');
  assert.equal(r.runSeconds, 754);
  assert.equal(r.exitCode, 10);
});

test('the failed files shown are capped, and the report says how many more', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `FAILED src/f${i}.test.ts > t: x`);
  const r = buildReport(input({ exitCode: 10, log: RED, failedLines: lines }));
  assert.equal(FAILED_FILES_SHOWN, 40);
  assert.equal(r.failedFiles.length, 40);
  assert.equal(r.failedMore, 20);
});

test('classify: exit 0 with a passed verdict is green', () => {
  assert.deepEqual(classify(buildReport(input()), 'success'), { color: 'green' });
});

test('classify: any non-zero exit is red, with the reason from the verdict line', () => {
  assert.deepEqual(classify(buildReport(input({ exitCode: 10, log: RED })), 'success'), { color: 'red', reason: 'exit code 10, verdict failed (test-failed)' });
  assert.deepEqual(classify(buildReport(input({ exitCode: 15, log: `${GREEN}\n${BRAKE}` })), 'success'), { color: 'red', reason: 'exit code 15, verdict passed (none)' });
});

test('classify: a clean exit with no verdict line is red, because nothing proves what ran', () => {
  assert.deepEqual(classify(buildReport(input({ log: 'quiet' })), 'success'), { color: 'red', reason: 'exit code 0, no verdict line' });
});

test('classify: no report is red: the job failed before the tests, or was cancelled or timed out', () => {
  assert.deepEqual(classify(null, 'failure'), { color: 'red', reason: 'the run failed before it produced a report' });
  assert.deepEqual(classify(null, 'cancelled'), { color: 'red', reason: 'the run was cancelled or timed out before it produced a report' });
});

test('classify: a cancelled verdict (exit 14) is red, like every other non-zero exit', () => {
  const cancelled = 'TEST-CI-VERDICT result=cancelled code=14 reasons=cancelled mode=full files=3/1597 passed=1 failed=0 retried=0';
  assert.deepEqual(classify(buildReport(input({ exitCode: 14, log: cancelled })), 'success'), { color: 'red', reason: 'exit code 14, verdict cancelled (cancelled)' });
});

test('classify: green needs a FULL run; a clean exit on a selected or shard run is red', () => {
  const selected = 'TEST-CI-VERDICT result=passed code=0 reasons=none mode=selected-3-of-9 files=3/3 passed=40 failed=0 retried=0';
  assert.deepEqual(classify(buildReport(input({ log: selected })), 'success'), { color: 'red', reason: 'exit code 0 but not a full run (mode=selected-3-of-9)' });
});

const issue = (number, body = `x\n${MARKER}`, extra = {}) => ({ number, body, ...extra });
const redReport = () => buildReport(input({ exitCode: 10, log: `${RED}\n${BRAKE}`, failedLines: LINES }));
const ctx = (over = {}) => ({ report: buildReport(input()), jobResult: 'success', ref: 'staging', openIssues: [], runUrl: 'https://example.test/run/9', ...over });

test('red with no open issue opens exactly one, with the labels, the verdict line and the failed files', () => {
  const d = decide(ctx({ report: redReport(), openIssues: [] }));
  assert.equal(d.kind, 'open');
  assert.equal(d.title, 'CI nightly: the full run of staging is red');
  assert.deepEqual(d.labels, ['priority:medium', 'module:general', 'ci-nightly']);
  assert.deepEqual(ISSUE_LABELS, ['priority:medium', 'module:general', 'ci-nightly']);
  assert.ok(d.body.includes(MARKER));
  assert.ok(d.body.includes(RED));
  assert.ok(d.body.includes('- src/__tests__/a.test.tsx'));
  assert.ok(d.body.includes('- src/pages/b.test.tsx'));
  assert.ok(d.body.includes('https://example.test/run/9'));
  assert.ok(d.body.includes('12 min 34 s'));
  assert.ok(d.body.includes('| CPU-seconds | 3000 | 4500 |'));
});

test('a second red updates the one open issue instead of opening another', () => {
  const d = decide(ctx({ report: redReport(), openIssues: [issue(77)] }));
  assert.equal(d.kind, 'comment');
  assert.equal(d.number, 77);
  assert.ok(d.body.includes(RED));
});

test('with two marked issues open, the oldest gets the comment and the other is named', () => {
  const d = decide(ctx({ report: redReport(), openIssues: [issue(90), issue(80)] }));
  assert.equal(d.number, 80);
  assert.ok(d.body.includes('#90'));
});

test('an open issue without the marker, and a pull request, are never taken for the nightly issue', () => {
  const d = decide(ctx({ report: redReport(), openIssues: [issue(5, 'something else'), issue(6, MARKER, { pull_request: {} })] }));
  assert.equal(d.kind, 'open');
});

test('green closes the open nightly issue, with a comment that says why', () => {
  const d = decide(ctx({ openIssues: [issue(77)] }));
  assert.equal(d.kind, 'close');
  assert.deepEqual(d.numbers, [77]);
  assert.ok(d.body.includes(GREEN));
});

test('green closes every marked issue left open, and does nothing when none is open', () => {
  assert.deepEqual(decide(ctx({ openIssues: [issue(1), issue(2)] })).numbers, [1, 2]);
  assert.equal(decide(ctx({ openIssues: [] })).kind, 'none');
});

test('a cancelled or timed-out run with no report is red and updates the open issue', () => {
  const d = decide(ctx({ report: null, jobResult: 'cancelled', openIssues: [issue(77)] }));
  assert.equal(d.kind, 'comment');
  assert.ok(d.body.includes('cancelled or timed out'));
});

const drillRed = () => buildReport(input({ ref: 'drill/x', exitCode: 10, log: RED, failedLines: LINES }));
const drillGreen = () => buildReport(input({ ref: 'drill/x' }));
const stateIn = (body) => JSON.parse(/<!-- ci-nightly-state (\{.*\}) -->/.exec(body)[1]);
// An issue as the job leaves it: a drill red opens it, then maybe other refs go red.
const opened = (by, extraRefs = [], stagingRed = false) => issue(50, `text\nRefs that were red: x\n<!-- ci-nightly-state ${JSON.stringify({ openedBy: by, refs: [by, ...extraRefs], stagingRed })} -->\n${MARKER}\n`);

test('a red manual run of another ref opens the one issue and records which ref opened it', () => {
  const d = decide(ctx({ ref: 'drill/x', report: drillRed(), openIssues: [] }));
  assert.equal(d.kind, 'open');
  assert.deepEqual(stateIn(d.body), { openedBy: 'drill/x', refs: ['drill/x'], stagingRed: false });
  assert.ok(d.body.includes('Refs that were red: `drill/x`.'));
});

test('a red staging run opens an issue with staging as opener and staging red', () => {
  assert.deepEqual(stateIn(decide(ctx({ report: redReport(), openIssues: [] })).body), { openedBy: 'staging', refs: ['staging'], stagingRed: true });
});

test('a second red of another ref updates the one issue and adds the ref to its body, never a second issue', () => {
  const d = decide(ctx({ ref: 'drill/y', report: buildReport(input({ ref: 'drill/y', exitCode: 10, log: RED })), openIssues: [opened('drill/x')] }));
  assert.equal(d.kind, 'comment');
  assert.equal(d.number, 50);
  assert.deepEqual(stateIn(d.issueBody), { openedBy: 'drill/x', refs: ['drill/x', 'drill/y'], stagingRed: false });
  assert.ok(d.issueBody.includes('Refs that were red: `drill/x`, `drill/y`.'));
  assert.equal(d.issueBody.split(MARKER).length, 2);
});

test('a red staging run on a drill-opened issue records that staging has been red', () => {
  const d = decide(ctx({ report: redReport(), openIssues: [opened('drill/x')] }));
  assert.equal(stateIn(d.issueBody).stagingRed, true);
});

test('a green full run of staging closes the issue, whoever opened it', () => {
  assert.deepEqual(decide(ctx({ openIssues: [opened('drill/x', ['staging'], true)] })).numbers, [50]);
});

test('a green run of the ref that opened the issue closes it when staging has not been red since', () => {
  assert.deepEqual(decide(ctx({ ref: 'drill/x', report: drillGreen(), openIssues: [opened('drill/x')] })).numbers, [50]);
});

test('a green run of the opening ref does NOT close it once staging has been red since', () => {
  assert.equal(decide(ctx({ ref: 'drill/x', report: drillGreen(), openIssues: [opened('drill/x', ['staging'], true)] })).kind, 'none');
});

test('a green run of a ref that did not open the issue never closes it', () => {
  assert.equal(decide(ctx({ ref: 'drill/z', report: buildReport(input({ ref: 'drill/z' })), openIssues: [opened('drill/x')] })).kind, 'none');
});

test('a green run of another ref never closes an issue opened by staging', () => {
  assert.equal(decide(ctx({ ref: 'drill/x', report: drillGreen(), openIssues: [opened('staging', [], true)] })).kind, 'none');
});

test('a green run that is not a full run closes nothing, on any ref', () => {
  const selected = 'TEST-CI-VERDICT result=passed code=0 reasons=none mode=selected-3-of-9 files=3/3 passed=40 failed=0 retried=0';
  assert.equal(decide(ctx({ report: buildReport(input({ log: selected })), openIssues: [opened('staging', [], true)] })).kind, 'comment');
  assert.equal(decide(ctx({ ref: 'drill/x', report: buildReport(input({ ref: 'drill/x', log: selected })), openIssues: [opened('drill/x')] })).kind, 'comment');
});

test('an issue from before the state existed is read as opened by staging and red on staging, so a drill cannot close it', () => {
  assert.equal(decide(ctx({ ref: 'drill/x', report: drillGreen(), openIssues: [issue(77)] })).kind, 'none');
});

test('every spelling of the staging branch counts as staging', () => {
  for (const spelling of ['staging', 'refs/heads/staging', 'REFS/HEADS/staging', 'Refs/Heads/staging', ' staging ']) {
    assert.equal(normalizeRef(spelling), 'staging', spelling);
    const d = decide(ctx({ ref: spelling, report: buildReport(input({ ref: spelling })), openIssues: [opened('drill/x', ['staging'], true)] }));
    assert.equal(d.kind, 'close', spelling);
    const open = decide(ctx({ ref: spelling, report: buildReport(input({ ref: spelling, exitCode: 10, log: RED })), openIssues: [] }));
    assert.deepEqual(stateIn(open.body), { openedBy: 'staging', refs: ['staging'], stagingRed: true }, spelling);
  }
});

test('a tag or branch that merely contains the word staging is not staging', () => {
  for (const other of ['refs/tags/staging', 'staging-2', 'feature/staging', 'x/origin/staging', 'origin/staging', 'heads/staging', 'refs/remotes/origin/staging', 'remotes/origin/staging', 'Staging', 'STAGING']) {
    assert.notEqual(normalizeRef(other), 'staging', other);
    assert.equal(decide(ctx({ ref: other, report: buildReport(input({ ref: other })), openIssues: [opened('staging', [], true)] })).kind, 'none', other);
  }
});

test('isValidRef agrees with `git check-ref-format --branch` on a table of names, markup characters included', async () => {
  const { spawnSync } = await import('node:child_process');
  const names = [
    'staging', 'drill/x', 'build/3256-r4', 'fix/a&b', 'a<b', "it's", 'a"b', 'a|b', 'a`b', 'a-->b', 'x{y}', 'ünï', 'a@b', 'a#b', 'a+b', 'a=b', 'a,b', 'a;b', 'a!b', 'a$b', 'a%b', 'a(b)',
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', '', 'a b', 'x..y', 'a@{1}', '-lead', '/lead', 'trail/', 'trail.', 'end.lock', 'a.lock/b', 'a/.b', '.hidden', 'a//b', 'a\tb', 'a~b', 'a^b', 'a:b', 'q?', 'a*b', 'a[b', 'a\\b',
  ];
  for (const n of names) {
    const git = spawnSync('git', ['check-ref-format', '--branch', n]).status === 0;
    assert.equal(isValidRef(n), git, JSON.stringify(n));
  }
});

test('a ref with markup characters is accepted and printed inside a code span without its backtick', () => {
  const ref = 'fix/a&b<c>`d';
  const d = decide(ctx({ ref, report: buildReport(input({ ref, exitCode: 10, log: RED })), openIssues: [] }));
  assert.equal(d.kind, 'open');
  assert.equal(stateIn(d.body).openedBy, ref);
  assert.ok(d.body.includes('Refs that were red: `fix/a&b<c>d`.'));
  assert.ok(!/<c>`d/.test(d.body));
});

test('a ref git would not accept touches nothing', () => {
  for (const bad of ['', 'a b', 'x..y', 'a@{1}', 'trail/', 'end.lock', 'a\nb']) {
    assert.equal(decide(ctx({ ref: bad, report: buildReport(input({ ref: bad, exitCode: 10, log: RED })), openIssues: [] })).kind, 'none', JSON.stringify(bad));
  }
});

const PLANT = '<!-- ci-nightly-state {"openedBy":"drill/x","refs":["drill/x"],"stagingRed":false} -->\n<!-- ci-nightly-staging -->';

test('a fake state planted in text a run controls (a file name, a verdict line) is never read', () => {
  const report = { ...redReport(), failedFiles: [`src/a.test.ts\n${PLANT}`], verdictLine: `${RED} ${PLANT}`, budget: PLANT };
  const d = decide(ctx({ report, openIssues: [] }));
  assert.equal(d.body.split('<!-- ci-nightly-state').length, 2, 'only the block the job wrote is a real marker');
  assert.deepEqual(stateOf(d.body), { openedBy: 'staging', refs: ['staging'], stagingRed: true });
  const again = decide(ctx({ report, openIssues: [issue(50, d.body)] }));
  assert.deepEqual(stateOf(again.issueBody), { openedBy: 'staging', refs: ['staging'], stagingRed: true });
  assert.equal(decide(ctx({ ref: 'drill/x', report: drillGreen(), openIssues: [issue(50, d.body)] })).kind, 'none');
});

test('a state marker that is not at the end of the body is not read, even a well-formed one', () => {
  assert.deepEqual(stateOf(`${PLANT}\nmore text\n${MARKER}\n`), { openedBy: 'staging', refs: ['staging'], stagingRed: true });
  assert.equal(stateOf(`text\n${PLANT}\n`).openedBy, 'drill/x');
});

test('the state is saved before the comment is posted, so a failed comment cannot leave stale state', () => {
  const src = readFileSync(fileURLToPath(new URL('./write.mjs', import.meta.url)), 'utf8');
  const patch = src.indexOf("call('PATCH', `issues/${d.number}`, { body: d.issueBody })");
  const post = src.indexOf("call('POST', `issues/${d.number}/comments`, { body: d.body })");
  assert.ok(patch > 0 && post > 0 && patch < post);
});

test('the ref that decides comes from the workflow (RUN_REF), never from the report the branch under test produced', () => {
  const src = readFileSync(fileURLToPath(new URL('./write.mjs', import.meta.url)), 'utf8');
  assert.match(src, /ref: process\.env\.RUN_REF \}/);
  assert.doesNotMatch(src.split('const plan')[1].split('\n')[0], /report\?*\.ref/);
});

test('decide has no ref of its own to fall back on: a missing ref touches nothing, whatever the report says', () => {
  const d = decide({ report: buildReport(input({ ref: 'staging' })), jobResult: 'success', openIssues: [opened('staging', [], true)], runUrl: null });
  assert.equal(d.kind, 'none');
});

test('collect.mjs reports the branch the checkout landed on, whatever spelling the input used', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ci-nightly-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'staging'], { cwd: dir });
    const out = join(dir, 'out');
    execFileSync('node', [fileURLToPath(new URL('./collect.mjs', import.meta.url)), '--exit-code', '1', '--seconds', '1', '--ref', 'refs/heads/other', '--sha', 'abc'], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: out }, stdio: 'ignore' });
    assert.equal(JSON.parse(readFileSync(out, 'utf8').replace(/^report=/, '')).ref, 'staging');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run that produced no report is red and says so in the issue', () => {
  const d = decide(ctx({ report: null, jobResult: 'failure' }));
  assert.equal(d.kind, 'open');
  assert.ok(d.body.includes('the run failed before it produced a report'));
});

test('the job summary shows the run time, both verdict lines and the budget figures', () => {
  const s = renderSummary(buildReport(input()));
  assert.ok(s.includes('Run time: 12 min 34 s'));
  assert.ok(s.includes(GREEN));
  assert.ok(s.includes(BRAKE));
  assert.ok(s.includes('| CPU-seconds | 3000 | 4500 |'));
});

// ---- the workflow's pins (plain-text reads: no YAML dependency) ----------------------------------------------------------------
const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci-nightly.yml', import.meta.url)), 'utf8');
const uncommented = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const code = uncommented(workflow);
const jobBlock = (id) => code.split(/^ {2}(?=[a-z-]+:\n)/m).find((b) => b.startsWith(`${id}:\n`)) ?? assert.fail(`job ${id} not found`);

test('the schedule is one nightly time clear of the existing early-morning jobs (05:23, 05:43, 06:17 UTC)', () => {
  const crons = [...code.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(crons, ['11 3 * * *']);
});

test('the run job checks out staging explicitly (a schedule runs the default branch\'s file) and calls the one command', () => {
  const run = jobBlock('full-run');
  assert.match(run, /ref: \$\{\{ inputs\.ref \|\| 'staging' \}\}/);
  assert.match(run, /npm run test:ci --/);
  assert.doesNotMatch(run, /--shard|--files-from/);
  assert.doesNotMatch(run, /issues: write/);
});

test('the run job is on the reserved frontend runner, the one the pull request Frontend job uses, so the two suites queue behind each other', () => {
  assert.match(jobBlock('full-run'), /^ {4}runs-on: \[frontend\]$/m);
  assert.doesNotMatch(jobBlock('full-run'), /macOS/);
  assert.match(jobBlock('unit'), /^ {4}runs-on: \[self-hosted, macOS\]$/m); // the unit-test job is cheap and stays on the general pool
});

test('the run job tells the test command it is the nightly run, the only run whose minutes are judged against the budget', () => {
  assert.match(jobBlock('full-run'), /^ {10}TEST_CI_NIGHTLY: '1'$/m);
});

test('two full suites never run on the Mac at once: the run job has one constant group, queued and never cancelled', () => {
  assert.match(jobBlock('full-run'), /^ {4}concurrency:\n {6}group: ci-nightly-run\n {6}cancel-in-progress: false$/m);
});

test('the report job does not leave its write token in the shared workspace', () => {
  assert.match(jobBlock('report'), /uses: actions\/checkout@v7\n {8}with:\n {10}persist-credentials: false/);
});

test('every run that can write the issue shares ONE constant group, queued and never cancelled', () => {
  const w = jobBlock('report');
  assert.match(w, /^ {4}concurrency:\n {6}group: ci-nightly-writer\n {6}cancel-in-progress: false$/m);
  assert.doesNotMatch(code.split(/^jobs:/m)[0], /^concurrency:/m);
});

test('only the report job may write issues, and it does not check out the code under test', () => {
  assert.equal((code.match(/issues: write/g) ?? []).length, 1);
  assert.match(jobBlock('report'), /issues: write/);
  assert.doesNotMatch(jobBlock('report'), /ref: /);
  assert.doesNotMatch(jobBlock('report'), /npm ci/);
});

test('a manual run only writes the issue when "apply" is ticked', () => {
  assert.match(code, /DRY_RUN: \$\{\{ github\.event_name == 'workflow_dispatch' && !inputs\.apply && 'yes' \|\| '' \}\}/);
});

test('no node_modules cache, and no repository variable is set by the workflow', () => {
  assert.doesNotMatch(code, /cache: 'npm'/);
  assert.doesNotMatch(code, /gh variable|CI_RUNNERS/);
});

test('the promotion checklist in the CI documentation says to read the nightly issue before promoting', () => {
  const docs = readFileSync(fileURLToPath(new URL('../../docs/ci.md', import.meta.url)), 'utf8');
  const checklist = docs.split('**Promotion checklist**')[1] ?? assert.fail('no promotion checklist in docs/ci.md');
  assert.match(checklist.split('\n\n')[0], /before opening the promotion pull request/);
  assert.match(docs.split('### The nightly full run')[1], /cut from the lane head or later|contain `scripts\/ci-nightly\/collect.mjs`/);
  assert.match(checklist, /Read the open `ci-nightly` issue/);
});

test('the drill paragraph in the CI documentation states the closing rule', () => {
  const docs = readFileSync(fileURLToPath(new URL('../../docs/ci.md', import.meta.url)), 'utf8');
  assert.match(docs, /closes the issue only if it is a full run \(`mode=full`\) and\s+its ref is `staging`, or its ref is the ref that opened the issue and no `staging` run has been red since/);
});
