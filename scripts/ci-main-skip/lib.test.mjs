// Run with: node --test scripts/ci-main-skip/lib.test.mjs
// Seam: pure decision over GitHub's own data (pushed commit, the pull request, its runs and their jobs) -> skip or run, with a reason.
// Expected values come from the issue text (#3240), never recomputed the way the code computes them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, isPushToMain, noticeText, pullsOfCommit, HEAVY_JOBS } from './lib.mjs';

const SHA = 'a'.repeat(40);          // the pushed commit
const TREE = '1'.repeat(40);         // its tree
const OTHER_TREE = '2'.repeat(40);
const HEAD = 'b'.repeat(40);         // the pull request's head commit

const FRONTEND = 'Frontend (lint + type-check + tests + build)';
const BACKEND = 'Backend (build + tests)';
const DATABASE = 'Database (migrations + RLS)';

/** A heavy job that finished green and recorded `tree` (what the workflow's last steps leave in GitHub's data). */
const job = (name, { tree = TREE, conclusion = 'success', recordConclusion = 'success', withRecord = true } = {}) => ({
  name,
  conclusion,
  steps: [
    { name: 'Install deps', conclusion: 'success' },
    { name: 'Tests', conclusion: 'success' },
    ...(withRecord ? [{ name: `Tested tree ${tree} full`, conclusion: recordConclusion }] : []),
  ],
});
const run = (over = {}) => ({
  id: 900, event: 'pull_request', head_sha: HEAD, status: 'completed', conclusion: 'success',
  jobs: [job(FRONTEND), job(BACKEND), job(DATABASE)],
  ...over,
});
const withJob = (name, over) => run({ jobs: [FRONTEND, BACKEND, DATABASE].map((n) => (n === name ? job(n, over) : job(n))) });
const pull = (over = {}) => ({ number: 4321, base: { ref: 'main' }, merged_at: '2026-11-08T10:00:00Z', merge_commit_sha: SHA, head: { sha: HEAD }, ...over });
const push = (over = {}) => ({ event: 'push', ref: 'refs/heads/main', sha: SHA, tree: TREE, pulls: [pull()], runs: [run()], ...over });

test('the three heavy checks are the three required names, unchanged', () => {
  assert.deepEqual(HEAVY_JOBS, [FRONTEND, BACKEND, DATABASE]);
});

test('the same tree, all three checks green and full on the pull request run: skip, naming the pull request and the run', () => {
  assert.deepEqual(decide(push()), { skip: true, reason: 'identical-tree-already-tested', pr: 4321, runId: 900 });
  assert.equal(noticeText(4321), 'identical tree already tested on pull request 4321');
});

test('a different tree: run everything', () => {
  const d = decide(push({ tree: OTHER_TREE }));
  assert.equal(d.skip, false);
  assert.match(d.reason, /tree-differs:/);
});

test('one job recorded a different tree than the other two: run everything', () => {
  const d = decide(push({ runs: [withJob(BACKEND, { tree: OTHER_TREE })] }));
  assert.equal(d.skip, false);
  assert.match(d.reason, /tree-differs:Backend/);
});

test('no record on the run (for example a run from before the record existed): run everything', () => {
  const d = decide(push({ runs: [run({ jobs: [job(FRONTEND, { withRecord: false }), job(BACKEND), job(DATABASE)] })] }));
  assert.equal(d.skip, false);
  assert.match(d.reason, /no-record:Frontend/);
});

test('no runs of the pull request head at all: run everything', () => {
  assert.equal(decide(push({ runs: [] })).skip, false);
  assert.equal(decide(push({ runs: undefined })).skip, false);
});

test('the pull request cannot be found for the pushed commit (a direct push): run everything', () => {
  assert.deepEqual(decide(push({ pulls: [] })), { skip: false, reason: 'no-pull-request' });
  assert.equal(decide(push({ pulls: undefined })).skip, false);
});

test('a pull request that is associated with the commit but did not produce it, or is not merged into main: not the one', () => {
  assert.equal(decide(push({ pulls: [pull({ merge_commit_sha: 'c'.repeat(40) })] })).skip, false);
  assert.equal(decide(push({ pulls: [pull({ merged_at: null })] })).skip, false);
  assert.equal(decide(push({ pulls: [pull({ base: { ref: 'staging' } })] })).skip, false);
  assert.deepEqual(pullsOfCommit([pull({ number: 7 }), pull({ number: 8, merge_commit_sha: 'd'.repeat(40) })], SHA).map((p) => p.number), [7]);
});

test('two pull requests claim the commit: run everything', () => {
  assert.deepEqual(decide(push({ pulls: [pull(), pull({ number: 4322 })] })), { skip: false, reason: 'pull-request-ambiguous' });
});

test('an error while reading anything: run everything, with the error in the reason', () => {
  assert.deepEqual(decide({ event: 'push', ref: 'refs/heads/main', error: 'HTTP 502 from the runs list' }), { skip: false, reason: 'could-not-read:HTTP 502 from the runs list' });
  // even when everything else on the input would have said skip
  assert.equal(decide(push({ error: 'HTTP 500' })).skip, false);
});

test('the pushed commit has no readable tree: run everything', () => {
  assert.equal(decide(push({ tree: '' })).skip, false);
  assert.equal(decide(push({ tree: undefined })).skip, false);
  assert.equal(decide(push({ tree: 'not-a-hash' })).skip, false);
});

for (const [name, conclusion] of [[FRONTEND, 'failure'], [BACKEND, 'skipped'], [DATABASE, 'cancelled'], [BACKEND, 'failure'], [FRONTEND, 'skipped'], [DATABASE, 'failure'], [FRONTEND, null]]) {
  test(`${name} concluded ${conclusion} on the pull request run, even with a record of the right tree: run everything`, () => {
    const d = decide(push({ runs: [withJob(name, { conclusion })] }));
    assert.equal(d.skip, false);
    assert.match(d.reason, new RegExp(`not-green:${name.split(' ')[0]}`));
  });
}

test('a heavy job missing from the run: run everything', () => {
  const d = decide(push({ runs: [run({ jobs: [job(FRONTEND), job(BACKEND)] })] }));
  assert.equal(d.skip, false);
  assert.match(d.reason, /missing-job:Database/);
});

// Decision D9: a pull-request run whose Database check skipped its lanes (#3238) did not test the tree, so its record step did not run.
test('D9: a Database check that skipped its lanes left no record, so the push to main runs everything', () => {
  const skippedLanes = withJob(DATABASE, { recordConclusion: 'skipped' });
  const d = decide(push({ runs: [skippedLanes] }));
  assert.equal(d.skip, false);
  assert.match(d.reason, /no-record:Database/);
});

test('a record step that did not succeed is no record', () => {
  for (const recordConclusion of ['failure', 'skipped', 'cancelled', null]) assert.equal(decide(push({ runs: [withJob(FRONTEND, { recordConclusion })] })).skip, false, String(recordConclusion));
});

test('a step that merely looks like a record is no record: wrong length, not hex, not "full"', () => {
  for (const name of ['Tested tree 123 full', `Tested tree ${'z'.repeat(40)} full`, `Tested tree ${TREE}`, `Tested tree ${TREE} full (partial)`, `tested tree ${TREE} full`]) {
    const forged = run({ jobs: [job(FRONTEND), job(BACKEND), { name: DATABASE, conclusion: 'success', steps: [{ name, conclusion: 'success' }] }] });
    assert.equal(decide(push({ runs: [forged] })).skip, false, name);
  }
});

test('two different records in one job: run everything', () => {
  const twice = run({ jobs: [job(FRONTEND), job(BACKEND), { name: DATABASE, conclusion: 'success', steps: [{ name: `Tested tree ${TREE} full`, conclusion: 'success' }, { name: `Tested tree ${OTHER_TREE} full`, conclusion: 'success' }] }] });
  assert.match(decide(push({ runs: [twice] })).reason, /record-ambiguous:Database/);
});

test('a sha-256 repository works the same way', () => {
  const t = '3'.repeat(64);
  const r = run({ jobs: [FRONTEND, BACKEND, DATABASE].map((n) => job(n, { tree: t })) });
  assert.equal(decide(push({ tree: t, runs: [r] })).skip, true);
});

test('the pull request changed after the run: only a run of the pull request\'s final head commit counts', () => {
  const d = decide(push({ runs: [run({ head_sha: 'e'.repeat(40) })] }));
  assert.deepEqual(d, { skip: false, reason: 'no-run-for-pull-request-head' });
});

test('only a completed pull-request run counts: a push run, a run still going, or a run of another pull request is ignored', () => {
  assert.equal(decide(push({ runs: [run({ event: 'push' })] })).skip, false);
  assert.equal(decide(push({ runs: [run({ status: 'in_progress' })] })).skip, false);
  assert.equal(decide(push({ runs: [run({ pull_requests: [{ number: 1 }] })] })).skip, false);
  // a run that lists this pull request, or lists none (a fork), is fine
  assert.equal(decide(push({ runs: [run({ pull_requests: [{ number: 4321 }] })] })).skip, true);
  assert.equal(decide(push({ runs: [run({ pull_requests: [] })] })).skip, true);
});

test('a red first run followed by a green re-run: the green run counts, and it is the one named', () => {
  const red = withJob(DATABASE, { conclusion: 'failure' });
  red.id = 800;
  assert.deepEqual(decide(push({ runs: [red, run({ id: 901 })] })), { skip: true, reason: 'identical-tree-already-tested', pr: 4321, runId: 901 });
});

test('several runs, none qualifying: run everything, listing why each failed', () => {
  const a = withJob(DATABASE, { conclusion: 'failure' }); a.id = 1;
  const b = withJob(BACKEND, { tree: OTHER_TREE }); b.id = 2;
  const d = decide(push({ runs: [a, b] }));
  assert.equal(d.skip, false);
  assert.match(d.reason, /run 1: not-green:Database.*run 2: tree-differs:Backend/);
});

test('anything that is not a push to main runs everything: staging, a pull request, another branch, no event', () => {
  assert.equal(isPushToMain('push', 'refs/heads/main'), true);
  for (const [event, ref] of [['push', 'refs/heads/staging'], ['push', 'refs/heads/servwave'], ['push', 'refs/tags/main'], ['pull_request', 'refs/pull/4321/merge'], ['pull_request', 'refs/heads/main'], ['workflow_dispatch', 'refs/heads/main'], [undefined, undefined], ['', '']]) {
    assert.equal(isPushToMain(event, ref), false, `${event} ${ref}`);
    assert.equal(decide(push({ event, ref })).skip, false, `${event} ${ref}`);
  }
});

test('the promotion pull request itself always runs everything: its own event is a pull request, never a push', () => {
  assert.equal(decide(push({ event: 'pull_request', ref: 'refs/pull/4321/merge' })).skip, false);
});

test('garbage input runs everything instead of throwing', () => {
  for (const input of [undefined, null, {}, { event: 'push', ref: 'refs/heads/main' }, push({ pulls: [null], runs: [null] }), push({ runs: [{ event: 'pull_request' }] })]) {
    assert.equal(decide(input).skip, false);
  }
});
