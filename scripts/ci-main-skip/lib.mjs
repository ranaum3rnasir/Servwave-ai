/* =============================================================================
   Push to main: skip the heavy suites when the pushed tree is the tree the promotion pull request already tested (#3240).

   Pure rules only. run.mjs reads GitHub's own data (the pushed commit, the pull request that produced it, that pull request's runs
   and their jobs) and hands it here; this module answers "skip the heavy suites, or run everything", with a reason code.

   The record: the last steps of each heavy job on a PULL REQUEST run read the tree of the commit that job checked out and are named
   "Tested tree <40 or 64 hex> full". They only run when every step before them in the job succeeded, and the Database job's record
   step does not run when its lanes were skipped (#3238), so a skipped-lanes run leaves no record (decision D9). GitHub's jobs data
   then holds, per job, the step name and the step's conclusion: no file the pull request controls, and no secret beyond the
   workflow token's read access to Actions.

   Skip only when ALL of these hold; anything else, and any doubt, runs everything exactly as before:
     - the event is a push to main;
     - exactly one merged pull request into main has the pushed commit as its merge commit;
     - a completed pull-request run of ci.yml exists for that pull request's head commit, whose three heavy jobs each
       concluded success and each recorded a tree equal to the pushed commit's tree.
   ========================================================================== */

/** The three required checks that carry the heavy suites: the job names are the check names, unchanged. */
export const HEAVY_JOBS = [
  'Frontend (lint + type-check + tests + build)',
  'Backend (build + tests)',
  'Database (migrations + RLS)',
];

/** The step the workflow names after the tree it tested; the same shape is in ci.yml (pinned by lib.test.mjs). */
export const RECORD_STEP = /^Tested tree ([0-9a-f]{40}|[0-9a-f]{64}) full$/;

const OBJECT_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/** True for a push to the main branch: the only event this rule may narrow. Pull requests, staging and everything else run everything. */
export function isPushToMain(event, ref) {
  return event === 'push' && ref === 'refs/heads/main';
}

/** The text of the notice a skipped heavy check prints. */
export function noticeText(prNumber) {
  return `identical tree already tested on pull request ${prNumber}`;
}

/** The merged pull requests into main whose merge commit is the pushed commit (a squash or merge-commit merge produces exactly this). */
export function pullsOfCommit(pulls, sha) {
  if (!Array.isArray(pulls) || typeof sha !== 'string' || sha === '') return [];
  return pulls.filter((p) => p && p.base?.ref === 'main' && !!p.merged_at && p.merge_commit_sha === sha && Number.isInteger(p.number) && typeof p.head?.sha === 'string');
}

/** The tree recorded by one job, or why there is none. Exactly one successful record step is required. */
function recordedTree(job) {
  const records = (job.steps ?? []).filter((s) => s.conclusion === 'success').map((s) => RECORD_STEP.exec(s.name ?? '')).filter(Boolean);
  if (records.length === 0) return { reason: `no-record:${job.name}` };
  const trees = new Set(records.map((m) => m[1]));
  if (trees.size !== 1) return { reason: `record-ambiguous:${job.name}` };
  return { tree: [...trees][0] };
}

/** Does this one run prove the pushed tree? { ok: true } or { ok: false, reason }. */
function judgeRun(run, pushedTree) {
  for (const name of HEAVY_JOBS) {
    const job = (run.jobs ?? []).find((j) => j.name === name);
    if (!job) return { ok: false, reason: `missing-job:${name}` };
    if (job.conclusion !== 'success') return { ok: false, reason: `not-green:${name}:${job.conclusion ?? 'unfinished'}` };
    const rec = recordedTree(job);
    if (rec.reason) return { ok: false, reason: rec.reason };
    if (rec.tree !== pushedTree) return { ok: false, reason: `tree-differs:${name}` };
  }
  return { ok: true };
}

/**
 * The decision.
 *   input: {
 *     event, ref,                // the workflow's event name and ref
 *     sha, tree,                 // the pushed commit and its tree
 *     pulls,                     // pull requests GitHub associates with the pushed commit
 *     runs,                      // ci.yml runs for the pull request's head commit, each with its jobs (latest attempt) and their steps
 *     error                      // set when any read failed: the text of the failure
 *   }
 *   output: { skip: boolean, reason: string, pr?: number, runId?: number }
 * Skip is true only when every condition in the header holds. `reason` is a short code for the log; it never carries content.
 */
export function decide(input) {
  const run = (reason) => ({ skip: false, reason });
  const { event, ref, sha, tree, pulls, runs, error } = input ?? {};
  if (!isPushToMain(event, ref)) return run(`not-a-push-to-main:${event ?? 'none'}`);
  if (error) return run(`could-not-read:${error}`);
  if (typeof tree !== 'string' || !OBJECT_ID.test(tree)) return run('no-pushed-tree');
  const candidates = pullsOfCommit(pulls, sha);
  if (candidates.length === 0) return run('no-pull-request');
  if (candidates.length > 1) return run('pull-request-ambiguous');
  const pr = candidates[0];
  const forHead = (Array.isArray(runs) ? runs : []).filter((r) => r
    && r.event === 'pull_request' && r.head_sha === pr.head.sha && r.status === 'completed'
    && (!Array.isArray(r.pull_requests) || r.pull_requests.length === 0 || r.pull_requests.some((p) => p?.number === pr.number)));
  if (forHead.length === 0) return run('no-run-for-pull-request-head');
  const verdicts = [];
  for (const r of forHead) {
    const v = judgeRun(r, tree);
    if (v.ok) return { skip: true, reason: 'identical-tree-already-tested', pr: pr.number, runId: r.id };
    verdicts.push(`run ${r.id}: ${v.reason}`);
  }
  return run(`no-run-qualifies (${verdicts.join('; ')})`);
}
