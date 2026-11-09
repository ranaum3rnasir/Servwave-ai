#!/usr/bin/env node
/* =============================================================================
   Push to main: the thin I/O around lib.mjs (every rule lives there). #3240

   Reads GitHub's own data for the pushed commit, asks lib.mjs.decide() and writes two step outputs for the workflow:
     skip=true|false     "true" ONLY when the pushed tree is the tree the pull request's run already tested
     pr=<number>         the pull request the skip relies on (only with skip=true)
   Any failure at all (no token, a network error, a bad answer, a crash) writes skip=false: everything runs, as before.

   Environment (all supplied by the runner): GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, GITHUB_REPOSITORY, GITHUB_OUTPUT,
   GITHUB_STEP_SUMMARY, GITHUB_API_URL (default https://api.github.com), GITHUB_TOKEN (the workflow token; read access to
   Actions, pull requests and contents is all it needs). It writes nothing to GitHub.
   ========================================================================== */
import { appendFileSync } from 'node:fs';
import { decide, isPushToMain, noticeText, pullsOfCommit } from './lib.mjs';

const WORKFLOW_FILE = 'ci.yml';
/** The pull-request lookup can trail the push by a few seconds: look again before giving up. */
const LOOKUPS = Number(process.env.CI_MAIN_SKIP_LOOKUPS || 3);
const LOOKUP_WAIT_MS = Number(process.env.CI_MAIN_SKIP_WAIT_MS || 5000);

const env = process.env;
const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const repo = env.GITHUB_REPOSITORY || '';

async function get(path) {
  const res = await fetch(`${api}/repos/${repo}/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path.split('?')[0]}`);
  return res.json();
}

async function gather() {
  if (!env.GITHUB_TOKEN) throw new Error('no workflow token');
  if (!repo || !env.GITHUB_SHA) throw new Error('no repository or commit in the environment');
  const sha = env.GITHUB_SHA;
  const tree = (await get(`git/commits/${sha}`)).tree?.sha;
  let pulls = [];
  for (let i = 0; i < LOOKUPS; i += 1) {
    pulls = await get(`commits/${sha}/pulls?per_page=100`);
    if (pullsOfCommit(pulls, sha).length > 0) break;
    if (i + 1 < LOOKUPS) await new Promise((r) => setTimeout(r, LOOKUP_WAIT_MS));
  }
  const candidates = pullsOfCommit(pulls, sha);
  if (candidates.length !== 1) return { sha, tree, pulls, runs: [] };
  const headSha = candidates[0].head.sha;
  const listed = await get(`actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${headSha}&event=pull_request&status=completed&per_page=100`);
  const runs = [];
  for (const r of listed.workflow_runs ?? []) {
    const jobs = [];
    for (let page = 1; page <= 5; page += 1) {
      const body = await get(`actions/runs/${r.id}/jobs?filter=latest&per_page=100&page=${page}`);
      jobs.push(...(body.jobs ?? []));
      if ((body.jobs ?? []).length < 100) break;
    }
    runs.push({ id: r.id, event: r.event, head_sha: r.head_sha, status: r.status, conclusion: r.conclusion, pull_requests: r.pull_requests, jobs });
  }
  return { sha, tree, pulls, runs };
}

function write(file, text) {
  if (file) appendFileSync(file, text);
}

let decision;
try {
  const event = env.GITHUB_EVENT_NAME;
  const ref = env.GITHUB_REF;
  decision = isPushToMain(event, ref) ? decide({ event, ref, ...(await gather()) }) : decide({ event, ref });
} catch (e) {
  decision = { skip: false, reason: `could-not-read:${String(e?.message ?? e).slice(0, 200)}` };
}

write(env.GITHUB_OUTPUT, `skip=${decision.skip ? 'true' : 'false'}\n${decision.skip ? `pr=${decision.pr}\n` : ''}`);
const line = decision.skip
  ? `${noticeText(decision.pr)} (run ${decision.runId}): the heavy suites are skipped`
  : `running everything (${decision.reason})`;
console.log(line);
write(env.GITHUB_STEP_SUMMARY, `### Push to main\n- ${line}\n`);
