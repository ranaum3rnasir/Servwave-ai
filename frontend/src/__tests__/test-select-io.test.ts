/**
 * Test selection (#3257), the git side: real throw-away repositories shaped like a pull request's merge ref
 * (a two-parent merge of the base tip and the head), and the real `selectForRun` over them. The test tool's
 * `list --changed` call is replaced by a function that answers like it, except where the child process itself is
 * under test. Nothing here touches the real repository's history or the network.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listChanged, parseListOutput, parseNameStatus, selectForRun } from '../../scripts/test-select-io.mjs';

const FRONTEND = resolve(__dirname, '../..');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const BUTTON = 'frontend/src/components/Button.tsx';
const BUTTON_TEST = 'frontend/src/components/__tests__/Button.test.tsx';
const GUARD = 'frontend/src/__tests__/disk-reader.guard.test.ts';

interface Repo { root: string; frontend: string; head: string; baseTip: string; mergeBase: string }

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/**
 * A repository shaped like a pull request into staging: `staging` gets one more commit AFTER the pull request branched
 * (so the base tip is not the merge base), the pull request branch applies `change`, and HEAD is their merge commit.
 */
function pullRequestRepo(change: (root: string) => void): Repo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-select-io-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'staging');
  write(root, 'package.json', '{}');
  write(root, 'package-lock.json', '{}');
  write(root, 'frontend/package.json', '{}');
  write(root, BUTTON, 'export const Button = 1;\n');
  write(root, BUTTON_TEST, 'it("x", () => {});\n');
  write(root, GUARD, 'it("g", () => {});\n');
  write(root, 'docs/ci.md', '# ci\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const mergeBase = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'feature');
  change(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'the pull request');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'staging');
  write(root, 'docs/other.md', 'staging moved on\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'staging moved on');
  const baseTip = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '--detach', 'staging');
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge ref', 'feature');
  return { root, frontend: join(root, 'frontend'), head, baseTip, mergeBase };
}

const prEnv = (r: Repo): Record<string, string> => ({ TEST_SELECTION: 'on', GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'staging', PR_HEAD_SHA: r.head });
const answering = (r: Repo, files: string[], seen: string[] = []) => async ({ base }: { frontend: string; base: string }) => {
  seen.push(base);
  return JSON.stringify(files.map((f) => ({ file: join(r.root, f) })));
};

describe('selectForRun over a real merge ref', () => {
  it('selects what the tool lists plus the always-run list, from the merge base and not the base tip', async () => {
    const r = pullRequestRepo((root) => write(root, BUTTON, 'export const Button = 2;\n'));
    const asked: string[] = [];
    const d = await selectForRun({ env: prEnv(r), frontend: r.frontend, runList: answering(r, [BUTTON_TEST], asked) });
    expect(d).toMatchObject({ mode: 'selected', reason: 'changed-files', total: 2 });
    expect(d.files).toEqual(['src/__tests__/disk-reader.guard.test.ts', 'src/components/__tests__/Button.test.tsx']);
    expect(asked).toEqual([r.mergeBase]);
    expect(asked[0]).not.toBe(r.baseTip);
  });

  it('does not count what the base branch changed after the pull request branched', async () => {
    // docs/other.md only changed on staging; the pull request touches nothing but docs/ci.md.
    const r = pullRequestRepo((root) => write(root, 'docs/ci.md', '# ci changed\n'));
    const d = await selectForRun({ env: prEnv(r), frontend: r.frontend, runList: answering(r, []) });
    expect(d).toMatchObject({ mode: 'selected', reason: 'always-run-only' });
  });

  it('a lockfile change is a full run, reason=lockfile', async () => {
    const r = pullRequestRepo((root) => write(root, 'package-lock.json', '{"changed":true}'));
    expect(await selectForRun({ env: prEnv(r), frontend: r.frontend, runList: answering(r, []) })).toMatchObject({ mode: 'full', reason: 'lockfile' });
  });

  it('a deleted source file is a full run, reason=deleted-source', async () => {
    const r = pullRequestRepo((root) => rmSync(join(root, BUTTON)));
    expect(await selectForRun({ env: prEnv(r), frontend: r.frontend, runList: answering(r, []) })).toMatchObject({ mode: 'full', reason: 'deleted-source' });
  });

  it('a renamed source file is a full run, reason=renamed-source', async () => {
    const r = pullRequestRepo((root) => {
      write(root, 'frontend/src/components/ButtonNext.tsx', 'export const Button = 1;\n');
      rmSync(join(root, BUTTON));
    });
    expect(await selectForRun({ env: prEnv(r), frontend: r.frontend, runList: answering(r, []) })).toMatchObject({ mode: 'full', reason: 'renamed-source' });
  });

  it('a clone that is shallow is a full run', async () => {
    const r = pullRequestRepo((root) => write(root, BUTTON, 'export const Button = 3;\n'));
    const clone = realpathSync(mkdtempSync(join(tmpdir(), 'test-select-io-shallow-')));
    roots.push(clone);
    git(clone, 'clone', '-q', '--no-local', '--depth', '1', `file://${r.root}`, 'c');
    const d = await selectForRun({ env: prEnv(r), frontend: join(clone, 'c', 'frontend'), runList: answering(r, []) });
    expect(d).toMatchObject({ mode: 'full', reason: 'shallow-clone' });
  });

  it('a checkout that is not the merge of the event head is a full run', async () => {
    const r = pullRequestRepo((root) => write(root, BUTTON, 'export const Button = 4;\n'));
    git(r.root, 'checkout', '-q', '--detach', r.head); // the pull request head itself: one parent
    expect(await selectForRun({ env: prEnv(r), frontend: r.frontend, runList: answering(r, []) })).toMatchObject({ mode: 'full', reason: 'not-two-parent-merge' });
  });

  it('a merge whose second parent is not the head the event names is a full run', async () => {
    const r = pullRequestRepo((root) => write(root, BUTTON, 'export const Button = 5;\n'));
    const env = { ...prEnv(r), PR_HEAD_SHA: r.baseTip };
    expect(await selectForRun({ env, frontend: r.frontend, runList: answering(r, []) })).toMatchObject({ mode: 'full', reason: 'head-mismatch' });
  });

  it('a tracked file edited on disk before the list is taken is a full run (the diff and the list must be one tree)', async () => {
    const r = pullRequestRepo((root) => write(root, BUTTON, 'export const Button = 6;\n'));
    write(r.root, BUTTON, 'export const Button = "edited after checkout";\n');
    expect(await selectForRun({ env: prEnv(r), frontend: r.frontend, runList: answering(r, [BUTTON_TEST]) })).toMatchObject({ mode: 'full', reason: 'tree-mismatch' });
  });

  it('a tracked file edited while the tool lists is a full run too', async () => {
    const r = pullRequestRepo((root) => write(root, BUTTON, 'export const Button = 7;\n'));
    const runList = async () => { write(r.root, BUTTON, 'export const Button = "edited during the list";\n'); return JSON.stringify([{ file: join(r.root, BUTTON_TEST) }]); };
    expect(await selectForRun({ env: prEnv(r), frontend: r.frontend, runList })).toMatchObject({ mode: 'full', reason: 'tree-mismatch' });
  });

  it('a case mismatch between what the tool lists and the tracked path is a full run (resolved against the tracked list, not the disk)', async () => {
    const r = pullRequestRepo((root) => write(root, BUTTON, 'export const Button = 8;\n'));
    const d = await selectForRun({ env: prEnv(r), frontend: r.frontend, runList: answering(r, ['frontend/src/components/__tests__/button.test.tsx']) });
    expect(d).toMatchObject({ mode: 'full', reason: 'case-mismatch' });
  });

  it('the tool listing something unreadable is a full run', async () => {
    const r = pullRequestRepo((root) => write(root, BUTTON, 'export const Button = 9;\n'));
    expect(await selectForRun({ env: prEnv(r), frontend: r.frontend, runList: async () => 'not json' })).toMatchObject({ mode: 'full', reason: 'selector-bad-output' });
  });
});

describe('the selector never makes a run red', () => {
  it('a tool call that throws is a full run, reason=selector-threw', async () => {
    const r = pullRequestRepo((root) => write(root, BUTTON, 'export const Button = 10;\n'));
    const runList = async () => { throw new Error('boom'); };
    expect(await selectForRun({ env: prEnv(r), frontend: r.frontend, runList })).toMatchObject({ mode: 'full', reason: 'selector-threw', files: [] });
  });

  it('a folder that is not a repository is a full run, never an exception', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'test-select-io-none-')));
    roots.push(dir);
    const d = await selectForRun({ env: { TEST_SELECTION: 'shadow', GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'staging' }, frontend: dir });
    expect(d).toMatchObject({ mode: 'full', reason: 'selector-threw' });
  });

  it('a tool call that never answers is a full run, reason=selector-timeout, at the limit', async () => {
    const r = pullRequestRepo((root) => write(root, BUTTON, 'export const Button = 11;\n'));
    const runList = () => new Promise<string>(() => {});
    const started = Date.now();
    const d = await selectForRun({ env: prEnv(r), frontend: r.frontend, runList, listLimitMs: 50, backstopMarginMs: 50 });
    expect(d).toMatchObject({ mode: 'full', reason: 'selector-timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('the child process that asks the tool is killed at its limit and reports a timeout', async () => {
    await expect(listChanged({ frontend: FRONTEND, base: 'HEAD', limitMs: 1 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('with the variable unset it answers at once without touching git', async () => {
    const d = await selectForRun({ env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'staging' }, frontend: '/nonexistent/frontend' });
    expect(d).toMatchObject({ mode: 'full', reason: 'off' });
  });

  it('makes no network call: the selector imports no network module and names no network client', () => {
    for (const file of ['test-select-io.mjs', 'test-select-lib.mjs', 'test-select.mjs']) {
      const source = readFileSync(join(FRONTEND, 'scripts', file), 'utf8');
      expect(source, file).not.toMatch(/node:(?:https?|net|tls|dns|dgram|http2)\b|\bfetch\s*\(|\bXMLHttpRequest\b|\bgh\s+api\b|api\.github\.com/);
    }
  });
});

describe('parsers', () => {
  it('reads git name-status -z, including renames and a name with a newline', () => {
    const text = ['M', 'a.ts', 'D', 'b.ts', 'R100', 'old.ts', 'new.ts', 'A', 'with\nnewline.ts', ''].join('\0');
    expect(parseNameStatus(text)).toEqual([
      { status: 'M', path: 'a.ts' }, { status: 'D', path: 'b.ts' }, { status: 'R', oldPath: 'old.ts', path: 'new.ts' }, { status: 'A', path: 'with\nnewline.ts' },
    ]);
  });

  it('reads the tool output as repository-relative paths, and keeps a path outside the repository as it is', () => {
    const out = JSON.stringify([{ file: '/repo/frontend/src/a.test.ts' }, { file: '/elsewhere/b.test.ts' }]);
    expect(parseListOutput(out, '/repo')).toEqual(['frontend/src/a.test.ts', '/elsewhere/b.test.ts']);
  });

  it.each(['', 'nope', '{}', '[1]', '[{"nofile":1}]'])('refuses output that is not a list of files: %j', (text) => {
    expect(parseListOutput(text, '/repo')).toBeNull();
  });
});
