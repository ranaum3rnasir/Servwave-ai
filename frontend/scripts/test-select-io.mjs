/**
 * The git and process side of test selection (#3257). It gathers facts and hands them to the pure policy
 * (test-select-lib.mjs); it decides nothing itself, never throws, and answers "full" on any error or on a timeout.
 *
 * Local git only and the test tool's own `list --changed <base>` in a child process with a 60 s limit. No network
 * call, ever: nothing here imports a network module, and a test reads this file's source to keep it so.
 */
import { execFile, spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRONTEND_PREFIX, LIST_LIMIT_MS, decideEarly, decideSelection, normalizeMode } from './test-select-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LISTS_FILE = join(HERE, 'test-select-lists.json');

function git(cwd, args) {
  return new Promise((res, rej) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: LIST_LIMIT_MS }, (err, stdout) => (err ? rej(err) : res(stdout)));
  });
}

/** `git diff --name-status -z -M` output to [{ status, path, oldPath? }]. Statuses keep their first letter only. */
export function parseNameStatus(text) {
  const tokens = String(text).split('\0');
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i];
    if (code === '') continue;
    const status = code[0];
    if (status === 'R' || status === 'C') {
      out.push({ status, oldPath: tokens[i + 1], path: tokens[i + 2] });
      i += 2;
    } else {
      out.push({ status, path: tokens[i + 1] });
      i += 1;
    }
  }
  return out;
}

/** The test tool's `list --filesOnly --json` output to repository-relative paths; null when it is not that shape. */
export function parseListOutput(text, repoRoot) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(data) || data.some((e) => !e || typeof e.file !== 'string')) return null;
  return data.map((e) => {
    const rel = relative(repoRoot, e.file);
    return rel.startsWith('..') || rel.startsWith(sep) ? e.file : rel.split(sep).join('/');
  });
}

/** Run the test tool's change-detection: `vitest list --changed <base> --filesOnly --json`. Killed (whole group) at the limit. */
export function listChanged({ frontend, base, limitMs = LIST_LIMIT_MS }) {
  return new Promise((resolveP, rejectP) => {
    const vitestBin = join(dirname(createRequire(join(frontend, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
    const child = spawn(process.execPath, [vitestBin, 'list', '--changed', base, '--filesOnly', '--json'], {
      cwd: frontend, detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CI: '1' },
    });
    let stdout = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, limitMs);
    child.on('error', (e) => { clearTimeout(timer); rejectP(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      kill();
      if (timedOut) rejectP(Object.assign(new Error('the change-detection child hit its time limit'), { code: 'TIMEOUT' }));
      else if (code !== 0) rejectP(new Error(`the change-detection child exited ${code}`));
      else resolveP(stdout);
    });
  });
}

/** Facts about the repository for the policy. `runList` is injectable for tests. */
export async function gatherFacts({ repoRoot, frontend, env, runList = listChanged, listLimitMs = LIST_LIMIT_MS }) {
  const shallowText = (await git(repoRoot, ['rev-parse', '--is-shallow-repository'])).trim();
  const shallow = shallowText === 'true' ? true : shallowText === 'false' ? false : null;
  const parents = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(/\s+/).slice(1);
  let mergeBase = null;
  if (parents.length === 2) {
    try { mergeBase = (await git(repoRoot, ['merge-base', parents[0], parents[1]])).trim() || null; } catch { mergeBase = null; }
  }
  const diffTree = (await git(repoRoot, ['rev-parse', 'HEAD^{tree}'])).trim();
  const tracked = (await git(repoRoot, ['ls-files', '-z'])).split('\0').filter(Boolean);
  let changed = null;
  let listed = null;
  let listTree = null;
  if (mergeBase) {
    changed = parseNameStatus(await git(repoRoot, ['diff', '--name-status', '-z', '-M', '--no-ext-diff', mergeBase, 'HEAD']));
    const text = await runList({ frontend, base: mergeBase, limitMs: listLimitMs });
    listed = parseListOutput(text, repoRoot);
    const dirty = (await git(repoRoot, ['status', '--porcelain', '--untracked-files=no'])).trim() !== '';
    listTree = dirty ? 'dirty' : (await git(repoRoot, ['rev-parse', 'HEAD^{tree}'])).trim();
  }
  return {
    shallow, parents, mergeBase, baseUsed: mergeBase, diffTree, listTree, changed, tracked, listed,
    eventHeadSha: env.PR_HEAD_SHA ?? '',
  };
}

/**
 * Decide for this run. Never throws and never makes a run red: any exception is `selector-threw`, a hang is
 * `selector-timeout`. With the variable unset or `off` it returns at once without touching git.
 */
export async function selectForRun({ env = process.env, frontend, shard = false, runList = listChanged, listLimitMs = LIST_LIMIT_MS, backstopMarginMs = 5000 }) {
  const base = { mode: env.TEST_SELECTION, shard, event: env.GITHUB_EVENT_NAME ?? '', baseRef: env.GITHUB_BASE_REF ?? '' };
  try {
    const early = decideEarly(base);
    if (early) return early;
    const work = (async () => {
      const repoRoot = realpathSync(resolve((await git(frontend, ['rev-parse', '--show-toplevel'])).trim()));
      if (relative(repoRoot, realpathSync(frontend)).split(sep).join('/') !== FRONTEND_PREFIX.slice(0, -1)) throw new Error('the frontend folder is not <repo>/frontend');
      const lists = JSON.parse(readFileSync(LISTS_FILE, 'utf8'));
      const facts = await gatherFacts({ repoRoot, frontend: realpathSync(frontend), env, runList, listLimitMs });
      return decideSelection({ ...base, ...facts, lists });
    })();
    let timer;
    const backstop = new Promise((res) => { timer = setTimeout(() => res({ mode: 'full', reason: 'selector-timeout', files: [], total: null, detail: null }), listLimitMs + backstopMarginMs); });
    try {
      return await Promise.race([work, backstop]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const reason = err?.code === 'TIMEOUT' || err?.killed ? 'selector-timeout' : 'selector-threw';
    return { mode: 'full', reason, files: [], total: null, detail: String(err?.message ?? err) };
  }
}

export { normalizeMode };
