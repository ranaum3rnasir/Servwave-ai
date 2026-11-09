// Run with: node --test scripts/ci-main-skip/run.test.mjs
// The real run.mjs, as the workflow runs it, against a stand-in for GitHub's API on a local port. Checks what it writes for the
// workflow (step outputs) and that every kind of failure ends in "run everything".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_MJS = fileURLToPath(new URL('./run.mjs', import.meta.url));
const SHA = 'a'.repeat(40);
const TREE = '1'.repeat(40);
const HEAD = 'b'.repeat(40);
const NAMES = ['Frontend (lint + type-check + tests + build)', 'Backend (build + tests)', 'Database (migrations + RLS)'];
const greenJobs = (tree = TREE) => NAMES.map((name) => ({ name, conclusion: 'success', steps: [{ name: `Tested tree ${tree} full`, conclusion: 'success' }] }));

/** A stand-in for the API: `routes` maps a path prefix to a status and a body; anything unlisted is a 404. Records what was asked. */
async function withApi(routes, fn) {
  const asked = [];
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    asked.push({ url: req.url, auth: req.headers.authorization });
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(`/repos/o/r/${prefix}`));
    res.writeHead(hit ? hit[1].status : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hit ? hit[1].body : {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, asked); } finally { server.close(); }
}

async function runIt(apiUrl, over = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'main-skip-'));
  const out = path.join(dir, 'output');
  writeFileSync(out, '');
  const env = {
    PATH: process.env.PATH, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: SHA, GITHUB_REPOSITORY: 'o/r',
    GITHUB_API_URL: apiUrl, GITHUB_TOKEN: 'stand-in', GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    CI_MAIN_SKIP_WAIT_MS: '1', ...over,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const child = spawn(process.execPath, [RUN_MJS], { env });
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  child.stderr.on('data', (d) => { text += d; });
  const code = await new Promise((r) => child.on('close', r));
  const result = { code, text, output: readFileSync(out, 'utf8') };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

const happy = () => ({
  [`git/commits/${SHA}`]: { status: 200, body: { tree: { sha: TREE } } },
  [`commits/${SHA}/pulls`]: { status: 200, body: [{ number: 4321, base: { ref: 'main' }, merged_at: '2026-11-08T10:00:00Z', merge_commit_sha: SHA, head: { sha: HEAD } }] },
  'actions/workflows/ci.yml/runs': { status: 200, body: { workflow_runs: [{ id: 900, event: 'pull_request', head_sha: HEAD, status: 'completed', conclusion: 'success', pull_requests: [] }] } },
  'actions/runs/900/jobs': { status: 200, body: { jobs: greenJobs() } },
});

test('the same tree, all green and recorded: skip=true and the pull request number, read with the workflow token only', async () => {
  await withApi(happy(), async (url, asked) => {
    const r = await runIt(url);
    assert.equal(r.code, 0);
    assert.equal(r.output, 'skip=true\npr=4321\n');
    assert.match(r.text, /identical tree already tested on pull request 4321/);
    assert.ok(asked.length >= 4 && asked.every((a) => a.auth === 'Bearer stand-in'));
  });
});

test('a different tree on the record: skip=false', async () => {
  const routes = happy();
  routes['actions/runs/900/jobs'].body.jobs = greenJobs('2'.repeat(40));
  await withApi(routes, async (url) => {
    const r = await runIt(url);
    assert.equal(r.code, 0);
    assert.equal(r.output, 'skip=false\n');
    assert.match(r.text, /running everything \(no-run-qualifies/);
  });
});

test('an API error at any step: skip=false and the step still succeeds', async () => {
  for (const broken of [`git/commits/${SHA}`, `commits/${SHA}/pulls`, 'actions/workflows/ci.yml/runs', 'actions/runs/900/jobs']) {
    const routes = happy();
    routes[broken] = { status: 502, body: { message: 'bad gateway' } };
    await withApi(routes, async (url) => {
      const r = await runIt(url);
      assert.equal(r.code, 0, broken);
      assert.equal(r.output, 'skip=false\n', broken);
      assert.match(r.text, /could-not-read:HTTP 502/, broken);
    });
  }
});

test('a garbage answer from the API: skip=false', async () => {
  const routes = happy();
  routes['actions/runs/900/jobs'] = { status: 200, body: 'not an object' };
  await withApi(routes, async (url) => {
    assert.equal((await runIt(url)).output, 'skip=false\n');
  });
});

test('nothing listening, or no workflow token: skip=false', async () => {
  assert.equal((await runIt('http://127.0.0.1:1')).output, 'skip=false\n');
  await withApi(happy(), async (url, asked) => {
    const r = await runIt(url, { GITHUB_TOKEN: undefined });
    assert.equal(r.output, 'skip=false\n');
    assert.equal(asked.length, 0);
  });
});

test('a direct push (no pull request produced the commit): skip=false, after looking again', async () => {
  const routes = happy();
  routes[`commits/${SHA}/pulls`] = { status: 200, body: [] };
  await withApi(routes, async (url, asked) => {
    const r = await runIt(url);
    assert.equal(r.output, 'skip=false\n');
    assert.match(r.text, /no-pull-request/);
    assert.equal(asked.filter((a) => a.url.includes('/pulls')).length, 3);
  });
});

test('a push to staging, a pull request run or any other event: skip=false without a single API call', async () => {
  await withApi(happy(), async (url, asked) => {
    for (const over of [{ GITHUB_REF: 'refs/heads/staging' }, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/4321/merge' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }]) {
      const r = await runIt(url, over);
      assert.equal(r.output, 'skip=false\n', JSON.stringify(over));
    }
    assert.equal(asked.length, 0);
  });
});
