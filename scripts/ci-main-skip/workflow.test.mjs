// Run with: node --test scripts/ci-main-skip/workflow.test.mjs
// The record and the skip as ci.yml wires them (#3240): the names the rule reads are the names the workflow writes, every heavy step
// carries the one skip condition, the Database record honours decision D9, the required names and time limits are unchanged.
// These read the workflow as data (parsed, not matched as text); the behaviour itself is in lib.test.mjs and run.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { HEAVY_JOBS, RECORD_STEP, noticeText } from './lib.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const wf = yaml.load(read('../../.github/workflows/ci.yml'));
const NOT_TESTED = "needs.pick-runners.outputs.tree_skip != 'true'";
const jobs = Object.entries(wf.jobs).filter(([, j]) => HEAVY_JOBS.includes(j.name));
const TREE = 'f'.repeat(40);
const bare = (cond) => String(cond).replace(/^\$\{\{\s*|\s*\}\}$/g, '').split(' && ');

test('the three heavy checks are the jobs named exactly as the required checks, with their time limits unchanged', () => {
  assert.deepEqual(jobs.map(([, j]) => j.name).sort(), [...HEAVY_JOBS].sort());
  const limit = Object.fromEntries(jobs.map(([id, j]) => [id, j['timeout-minutes']]));
  assert.deepEqual(limit, {
    backend: "${{ needs.pick-runners.outputs.linux == '\"ubuntu-latest\"' && 60 || 30 }}",
    frontend: "${{ needs.pick-runners.outputs.frontend == '\"ubuntu-latest\"' && 30 || 45 }}",
    database: "${{ needs.pick-runners.outputs.database == '\"ubuntu-latest\"' && 60 || 25 }}",
  });
});

test('each heavy job writes a record the rule can read: the name of its tree step, with the tree filled in, on pull requests only', () => {
  for (const [id, j] of jobs) {
    const record = j.steps.filter((s) => (s.name ?? '').startsWith('Tested tree '));
    assert.equal(record.length, 1, id);
    assert.equal(record[0].name.replace('${{ steps.tree.outputs.tree }}', TREE).match(RECORD_STEP)?.[1], TREE, id);
    assert.ok(bare(record[0].if).includes("github.event_name == 'pull_request'"), id);
    assert.ok(bare(record[0].if).includes("steps.tree.outputs.tree != ''"), id);
    const read = j.steps.find((s) => s.id === 'tree');
    assert.ok(bare(read.if).includes("github.event_name == 'pull_request'"), id);
    assert.ok(read.run.includes("git rev-parse 'HEAD^{tree}'"), id);
    // The record is written after the real work, so it exists only when every step before it succeeded (no `if` on them can lie).
    const at = j.steps.indexOf(record[0]);
    const work = j.steps.filter((s) => s.run || s.uses).filter((s) => !['Read the tested tree', 'Identical tree already tested'].includes(s.name) && s !== record[0] && s.if !== undefined && !bare(s.if).includes('always()'));
    for (const s of work) assert.ok(j.steps.indexOf(s) < at, `${id}: ${s.name ?? s.uses} runs after the record`);
  }
});

test('D9: the Database record is written only when the lanes ran; the command says so in its own step output', () => {
  const db = wf.jobs.database;
  const command = db.steps.find((s) => s.run === 'npm run test:db');
  assert.equal(command.id, 'db');
  assert.ok(bare(db.steps.find((s) => s.id === 'tree').if).includes("steps.db.outputs.suites_skipped == 'false'"));
  assert.match(read('../../backend/scripts/ci-db/run.ts'), /GITHUB_OUTPUT, `suites_skipped=\$\{skipped\}\\n`/);
  // The other two jobs have no lanes to skip.
  for (const id of ['backend', 'frontend']) assert.ok(!bare(wf.jobs[id].steps.find((s) => s.id === 'tree').if).some((c) => c.includes('suites_skipped')), id);
});

test('every step of the three heavy jobs is skipped by the one condition and by nothing else, except the notice that says why', () => {
  for (const [id, j] of jobs) {
    for (const s of j.steps) {
      const terms = bare(s.if ?? '');
      if (s.name === 'Identical tree already tested') {
        assert.deepEqual(terms, ["needs.pick-runners.outputs.tree_skip == 'true'"], id);
        assert.equal(s.run, 'echo "::notice title=Identical tree::' + noticeText('${PULL_REQUEST}') + '"', id);
        assert.deepEqual(s.env, { PULL_REQUEST: '${{ needs.pick-runners.outputs.tree_pr }}' }, id);
      } else {
        assert.ok(terms.includes(NOT_TESTED), `${id} › ${s.name ?? s.uses} has no skip condition`);
      }
    }
  }
  // The hosted-only frontend shards are skipped the same way, and the job-level rule still lets the required job run to say its notice.
  assert.ok(bare(wf.jobs['frontend-tests'].if).includes(NOT_TESTED));
  for (const [id, j] of jobs) assert.equal(j.if, '${{ !cancelled() }}', id);
});

test('the main-push step is in the Pick runners job, fails open, and the first step there is still the runner choice', () => {
  const pick = wf.jobs['pick-runners'];
  assert.equal(pick.steps[0].id, 'pick');
  const step = pick.steps.find((s) => s.id === 'tree');
  assert.equal(step['continue-on-error'], true);
  assert.equal(pick.steps.find((s) => (s.uses ?? '').startsWith('actions/checkout')).with['persist-credentials'], false);
  assert.equal(pick['timeout-minutes'], 5);
});
