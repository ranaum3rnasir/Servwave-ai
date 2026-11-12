/**
 * Shared by the two files that run `npm run test:ci` over a throw-away repository shaped like a pull request's merge ref
 * (test-select-e2e.test.ts and test-select-e2e-shadow-and-off.test.ts): the repository builder, the spawned command and its outcome.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const FRONTEND = resolve(__dirname, '../../..');
const roots: string[] = [];
/** Removes every throw-away repository and output folder this file made: call it from `afterAll`. */
export const cleanUp = () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); };

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

export const A_TEST = "import { expect, it } from 'vitest';\nimport { a } from './a';\nit('a', () => { expect(a()).toBe(1); });\n";
export const B_TEST = "import { expect, it } from 'vitest';\nimport { b } from './b';\nit('b', () => { expect(b()).toBe(2); });\n";
export const B_BROKEN = "import { expect, it } from 'vitest';\nimport { b } from './b';\nit('b', () => { expect(b()).toBe(999); });\n";
export const GUARD = "import { expect, it } from 'vitest';\nit('guard', () => { expect(1).toBe(1); });\n";

export interface Pr { frontend: string; head: string }

/** A repository whose HEAD is the merge of a pull request that changes `change`, into a staging that moved on. */
export function pullRequest(opts: { change: (root: string) => void; bTest?: string; outsideReader?: boolean }): Pr {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-select-e2e-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'staging');
  write(root, 'package.json', '{}');
  write(root, 'package-lock.json', '{}');
  write(root, 'frontend/package.json', '{"type":"module"}');
  write(root, 'frontend/vitest.config.mjs', "export default { test: { include: ['src/**/*.test.ts'], environment: 'node', globals: false } };\n");
  write(root, 'frontend/src/a.ts', 'export const a = () => 1;\n');
  write(root, 'frontend/src/b.ts', 'export const b = () => 2;\n');
  write(root, 'frontend/src/a.test.ts', A_TEST);
  write(root, 'frontend/src/b.test.ts', opts.bTest ?? B_TEST);
  write(root, 'frontend/src/__tests__/disk.guard.test.ts', GUARD);
  // on the real outside-readers list by its name (#3403); only the tests that ask for it get a fourth file
  if (opts.outsideReader) write(root, 'frontend/src/__tests__/test-select-outside.test.ts', GUARD);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'feature');
  opts.change(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'the pull request');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', 'staging');
  write(root, 'docs/moved-on.md', 'staging moved on\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'staging moved on');
  git(root, 'checkout', '-q', '--detach', 'staging');
  git(root, 'merge', '-q', '--no-ff', '-m', 'merge ref', 'feature');
  // the test tool resolves from the repository's own dependencies; untracked, like a real checkout's node_modules
  symlinkSync(join(FRONTEND, '..', 'node_modules'), join(root, 'frontend', 'node_modules'));
  // the brake judges the repository it runs in: a generous budget, untracked like a developer's local copy
  write(root, 'frontend/test-budget.json', JSON.stringify({ maxCpuSeconds: 100000, maxMinutes: 1000, workers: 6 }));
  write(root, 'frontend/test-file-count.json', JSON.stringify({ maxTestFiles: 100000 }));
  write(root, 'frontend/test-page-ceilings.json', '{}');
  return { frontend: join(root, 'frontend'), head };
}

export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('VITEST') || k.startsWith('TEST_') || k.startsWith('GITHUB_') || k === 'PR_HEAD_SHA' || k === 'FRONTEND_TEST_WORKERS' || k === 'CI') delete env[k];
  }
  return env;
}

export interface Outcome { code: number | null; out: string; verdict: string; events: string; summary: string }

export function run(pr: Pr, env: Record<string, string>, extra: string[] = []): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), 'test-select-e2e-out-'));
  roots.push(dir);
  const events = join(dir, 'events.jsonl');
  const summary = join(dir, 'summary.md');
  const child = spawn(process.execPath, [
    'scripts/test-ci.mjs', `--root=${pr.frontend}`, `--config=${join(pr.frontend, 'vitest.config.mjs')}`, '--floor=1',
    `--events=${events}`, `--summary=${summary}`, ...extra,
  ], { cwd: FRONTEND, env: { ...childEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
  return new Promise((res) => child.on('close', (code) => res({ code, out, verdict: out.split('\n').find((l) => l.startsWith('TEST-CI-VERDICT')) ?? '', events: read(events), summary: read(summary) })));
}

export const prEnv = (pr: Pr, value: string): Record<string, string> => ({ TEST_SELECTION: value, GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'staging', PR_HEAD_SHA: pr.head });
export const ran = (o: Outcome) => [...o.events.matchAll(/"ev":"file-end","file":"([^"]+)"/g)].map((m) => m[1]).sort();
export const changeA = (root: string) => write(root, 'frontend/src/a.ts', 'export const a = () => 1; // changed\n');
