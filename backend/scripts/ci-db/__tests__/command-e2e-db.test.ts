/**
 * The Database command, end to end, on a tiny fixture suite (spec #3234, "Testing Decisions"): the real command, a real private
 * Postgres server, a real test run in lanes. Four scenarios run side by side, each with its own server (so this also runs two
 * private servers at once): a clean set of files (one of them runs a bare client command), a planted failure, a planted skip, a planted hang.
 * Two more scenarios cover the path-skip rule (#3238) on a scratch repository: a pull request that changes only a screen skips the lanes (a
 * planted failing lane file never runs, the core checks do), and a push of the same change runs everything. Each ends with the verdict and
 * the exit code the spec names, and leaves no server, directory or process behind.
 *
 * The fixture files are written next to the real suites for the length of the test (the command finds files by name) and removed
 * after; a crash leaves them behind, and the next run removes those whose owner process is gone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { npmBin } from '../files';

const BACKEND = path.resolve(__dirname, '../../..');
const TESTS = path.join(BACKEND, 'src/__tests__');
const OWN = `zz-e2e-${process.pid}`;

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** A fixture test file: it proves it was given its own lane database, then does what the scenario says. */
const fixture = (body: string) => `
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
it('has its own lane database', () => {
  expect(process.env.TEST_DATABASE_URL).toMatch(/\\/lane_\\d+$/);
});
${body}
`;

// A backend/.env as a developer has one: it names databases, at an unused port (never the shared server's). The e2e writes it for the
// length of the test when the developer has none, and removes it after; a developer's own file is never touched.
const ENV_FILE = path.join(BACKEND, '.env');
const ENV_FILE_MARK = 'ci-db-e2e-env-file-canary';
const ENV_FILE_BODY = (pid: number) => `# ${ENV_FILE_MARK} ${pid}
DATABASE_URL=postgresql://${ENV_FILE_MARK}@127.0.0.1:1/envfile
DIRECT_URL=postgresql://${ENV_FILE_MARK}@127.0.0.1:1/envfile
MIGRATION_SHAPE_DB_URL=postgresql://${ENV_FILE_MARK}@127.0.0.1:1/envfile
`;
let wroteEnvFile = false;

const FILES: Record<string, string> = {
  'clean-a': fixture(''),
  'clean-b': fixture("it('also passes', () => { expect(1 + 1).toBe(2); });"),
  // A bare client command inside the run reaches the private server and nothing else, whatever the caller's environment pointed at.
  'bare': fixture(`
import { execFileSync } from 'node:child_process';
it('a bare psql reaches the private server, not the shared one', () => {
  const out = execFileSync('psql', ['-X', '-A', '-t', '-c', "SELECT inet_server_port() || ' ' || current_setting('data_directory')"], { encoding: 'utf8' }).trim();
  const [port, dir] = out.split(' ');
  expect(port).toBe(process.env.PGPORT);
  expect(port).not.toBe('5432');
  expect(dir).toContain('servwave-db');
  expect(process.env.DATABASE_URL).toBeUndefined();
  expect(process.env.DIRECT_URL).toBeUndefined();
});
// The developer's env file (backend/.env) names a database too. Every way the app's code reads one is tried here: the app's own
// config (dotenv from the working directory), the Prisma client built the way the app builds it, and a plain read of the file.
it('no env file reaches the worker: the only database settings are the lane database and the private server', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(process.cwd() + '/');
  req('dotenv').config();
  const { PrismaClient } = req('@prisma/client');
  new PrismaClient();
  for (const name of ['DATABASE_URL', 'DIRECT_URL', 'MIGRATION_SHAPE_DB_URL']) expect(process.env[name], name).toBeUndefined();
  expect(() => readFileSync(process.cwd() + '/.env', 'utf8')).toThrow(/ENOENT/);
  expect(process.env.TEST_DATABASE_URL).toMatch(/\\/lane_\\d+$/);
  expect(Object.entries(process.env).filter(([k, v]) => /^(DATABASE|DIRECT)_URL$|_DB_URL$/.test(k) && v && !/lane_\\d+$/.test(v))).toEqual([]);
  expect(Object.values(process.env).filter((v) => v?.includes('${ENV_FILE_MARK}'))).toEqual([]);
});`),
  'fails': fixture("it('fails on purpose', () => { expect(1).toBe(2); });"),
  'skips': fixture("it.skip('is skipped on purpose', () => {});"),
  // Blocks the whole worker, so no test timeout can end it: only the stall rule does.
  'hangs': fixture("it('hangs on purpose', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000); });"),
};

// ---- the path-skip rule, end to end (#3238) -------------------------------------------------------------------------------------------

/** A scratch repository whose HEAD is a merge commit that changes only a screen: what a screens-only pull request checks out. */
function screensOnlyMerge(): { dir: string; head: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ci-db-e2e-repo-'));
  const git = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, 'frontend/src'), { recursive: true });
  mkdirSync(path.join(dir, 'backend/src'), { recursive: true });
  writeFileSync(path.join(dir, 'frontend/src/Screen.tsx'), 'v1');
  writeFileSync(path.join(dir, 'backend/src/a.ts'), 'v1');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(path.join(dir, 'frontend/src/Screen.tsx'), 'v2');
  git('add', '-A'); git('commit', '-q', '-m', 'screen');
  git('checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'backend/src/a.ts'), 'v2');
  git('add', '-A'); git('commit', '-q', '-m', 'target moved on');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'feature');
  return { dir, head: git('rev-parse', 'HEAD') };
}

/** The core check these two scenarios run next to their lane files: quick, and needs the migrated template. */
const CORE_FILE = 'src/__tests__/rls-coverage.test.ts';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** A leftover canary env file of a crashed run (its owner is gone) is removed; any other file is a developer's and stays. */
function removeStaleEnvFile(): void {
  try {
    const m = new RegExp(`^# ${ENV_FILE_MARK} (\\d+)`).exec(readFileSync(ENV_FILE, 'utf8'));
    if (m && !alive(Number(m[1]))) unlinkSync(ENV_FILE);
  } catch { /* none */ }
}

function removeStale(): void {
  removeStaleEnvFile();
  for (const f of readdirSync(TESTS)) {
    const m = /^zz-e2e-(\d+)-/.exec(f);
    if (m && !alive(Number(m[1]))) rmSync(path.join(TESTS, f), { force: true });
  }
}

interface Outcome { code: number | null; out: string; root: string; stepOutput: string }

function runCommand(scenario: string, extraEnv: NodeJS.ProcessEnv = {}, extraPatterns: string[] = []): Promise<Outcome> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-db-e2e-'));
  // The runner's own folder: the command's orphan sweep covers only what is under it, so these runs never touch the outer run's server.
  if (process.getuid?.() === 0 && process.env.DB_CHECK_SERVER_USER) spawnSync('chown', [process.env.DB_CHECK_SERVER_USER, root]);
  const env = { ...process.env, RUNNER_TEMP: root, DB_LANES: '2', DB_CHECK_STALL_SECONDS: '8', CI: '', GITHUB_ENV: '', GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '', GITHUB_ACTIONS: '',
    // The host's own event must not decide these runs (inside CI it is a pull request): only the scenarios that mean to set one do.
    GITHUB_EVENT_NAME: '', GITHUB_SHA: '', DB_CHECK_DIFF_DIR: '', ...extraEnv };
  // The file the runner gives each step for its outputs: the later steps of the job read from it whether the lanes ran (#3240).
  if (!('GITHUB_OUTPUT' in extraEnv)) { env.GITHUB_OUTPUT = path.join(root, 'step-output'); writeFileSync(env.GITHUB_OUTPUT, ''); }
  return new Promise((resolve) => {
    const child = spawn(npmBin(BACKEND, 'tsx'), ['scripts/ci-db/cli.ts', 'run', `${OWN}-${scenario}`, ...extraPatterns], { cwd: BACKEND, env });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (code) => resolve({ code, out, root, stepOutput: env.GITHUB_OUTPUT ? readFileSync(env.GITHUB_OUTPUT, 'utf8') : '' }));
  });
}

const verdict = (o: Outcome) => /^DB-CI-VERDICT .*$/m.exec(o.out)?.[0] ?? `(no verdict line) ${o.out.slice(-500)}`;

describeDb('the Database command, end to end, on a fixture suite', () => {
  const results: Record<string, Outcome> = {};
  let repo: { dir: string; head: string } | undefined;

  beforeAll(async () => {
    removeStale();
    mkdirSync(TESTS, { recursive: true });
    // A directory listing, not existsSync: inside the command's own run the file is hidden from existsSync, and a developer's must not be overwritten.
    if (!readdirSync(BACKEND).includes('.env')) { writeFileSync(ENV_FILE, ENV_FILE_BODY(process.pid)); wroteEnvFile = true; }
    const scenarios: Record<string, string[]> = {
      clean: ['clean-a', 'clean-b', 'bare'], fail: ['clean-a', 'fails'], skip: ['clean-a', 'skips'], hang: ['clean-a', 'hangs'],
      // A failing lane file next to a clean one: if the lanes ran, the first would turn the run red.
      prskip: ['clean-a', 'fails'], pushrun: ['clean-a', 'clean-b'],
    };
    for (const [scenario, kinds] of Object.entries(scenarios)) {
      for (const kind of kinds) writeFileSync(path.join(TESTS, `${OWN}-${scenario}-${kind}-db.test.ts`), FILES[kind]!);
    }
    // The clean run is started from an environment that points at the shared server on 5432 in every way a caller can: the command must
    // not follow any of it.
    const pointedAtTheSharedServer = {
      PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'no_such_database', DATABASE_URL: 'postgresql://x@127.0.0.1:5432/x',
      DIRECT_URL: 'postgresql://x@127.0.0.1:5432/x', TEST_DATABASE_URL: 'postgresql://x@127.0.0.1:5432/postgres', DB_LANE_URL_BASE: 'postgresql://x@127.0.0.1:5432',
    };
    repo = screensOnlyMerge();
    const event = (name: string) => ({ GITHUB_EVENT_NAME: name, GITHUB_SHA: repo!.head, DB_CHECK_DIFF_DIR: repo!.dir });
    const entries = await Promise.all(Object.keys(scenarios).map(async (s) => {
      if (s === 'prskip') return [s, await runCommand(s, event('pull_request'), [CORE_FILE])] as const;
      if (s === 'pushrun') return [s, await runCommand(s, event('push'), [CORE_FILE])] as const;
      return [s, await runCommand(s, s === 'clean' ? pointedAtTheSharedServer : {})] as const;
    }));
    for (const [s, o] of entries) results[s] = o;
  }, 240_000);

  afterAll(() => {
    // unlinkSync: rmSync looks the file up first, and inside the command's own run an env file does not exist for it.
    if (wroteEnvFile) unlinkSync(ENV_FILE);
    for (const f of readdirSync(TESTS)) if (f.startsWith(`${OWN}-`)) rmSync(path.join(TESTS, f), { force: true });
    for (const o of Object.values(results)) rmSync(o.root, { recursive: true, force: true });
    if (repo) rmSync(repo.dir, { recursive: true, force: true });
  });

  it('a clean set of files passes (started from an environment aimed at the shared server): exit 0, every file ran once on its own lane database, a bare psql reached the private server', () => {
    expect(results.clean!.code, verdict(results.clean!)).toBe(0);
    expect(verdict(results.clean!)).toMatch(/result=passed code=0 .*files=3\/3 passed=6 failed=0/);
  });

  it('a planted failure turns the run red as failed tests (10) and names the file', () => {
    expect(results.fail!.code, verdict(results.fail!)).toBe(10);
    expect(verdict(results.fail!)).toMatch(/result=failed code=10 .*test-failed:[^ ,]*-fails-db\.test\.ts/);
    expect(results.fail!.out).toContain('fails on purpose');
  });

  it('a planted skip turns the run red as incomplete (11), not green with a skip', () => {
    expect(results.skip!.code, verdict(results.skip!)).toBe(11);
    expect(verdict(results.skip!)).toMatch(/result=incomplete code=11 .*undeclared-skip:[^ ,]*-skips-db\.test\.ts/);
  });

  it('a planted hang trips the stall rule (12), which names the file in flight and its lane', () => {
    expect(results.hang!.code, verdict(results.hang!)).toBe(12);
    expect(results.hang!.out).toMatch(/No test file finished for [\d.]+ s\. In flight:\s+- lane \d: `[^`]*-hangs-db\.test\.ts`/);
  });

  it('a pull request that changes only a screen: the core checks run, the lanes are skipped (a failing lane file never runs), and the summary says so', () => {
    const o = results.prskip!;
    expect(o.code, verdict(o)).toBe(0);
    expect(verdict(o)).toMatch(/result=passed code=0 reasons=none files=1\/1 passed=\d+ failed=0 retried=0 lanes=0 suites-skipped=2$/);
    expect(o.out).toContain('suites skipped: no relevant path changed');
    expect(o.out).toMatch(/\| lanes \| skipped: no relevant path changed \|/);
    expect(o.out).toMatch(/\| outside roles \| passed \|/);
    expect(o.out).toMatch(/\| migrations apply \| passed \|/);
    expect(o.out).toMatch(/\| rls-coverage \| passed \|/);
    expect(o.out).toContain('path rule: skip the lanes and what follows (all-paths-irrelevant)');
    expect(o.out).not.toContain('fails on purpose');
    expect(o.out).not.toMatch(/### Lanes/);
    // The next steps of the job learn it too: a skipped-lanes run must not be recorded as having tested the tree (#3240, decision D9).
    expect(o.stepOutput).toBe('suites_skipped=true\n');
  });

  it('a push of the same change runs everything: the lanes run, nothing says skipped', () => {
    const o = results.pushrun!;
    expect(o.code, verdict(o)).toBe(0);
    expect(verdict(o)).toMatch(/result=passed code=0 reasons=none files=3\/3 passed=\d+ failed=0 retried=0 lanes=2$/);
    expect(o.out).not.toContain('suites skipped');
    expect(o.out).toContain('path rule: run everything (not-a-pull-request: push)');
    expect(o.out).toMatch(/### Lanes/);
    expect(o.stepOutput).toBe('suites_skipped=false\n');
  });

  it('every run stopped its server and left nothing: no directory, no server process, no listener', () => {
    for (const [name, o] of Object.entries(results)) {
      expect(o.out, name).toMatch(/Server stopped \((graceful|forced)\)/);
      const left = existsSync(path.join(o.root, 'servwave-db')) ? readdirSync(path.join(o.root, 'servwave-db')) : [];
      expect(left, `${name}: run directory left behind`).toEqual([]);
      const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout;
      expect(ps.includes(o.root), `${name}: a process still runs from ${o.root}`).toBe(false);
    }
  });

  it('two private servers ran at once on different ports', () => {
    const ports = Object.values(results).map((o) => /port (\d+), boot-check port/.exec(o.out)?.[1]);
    expect(ports.every(Boolean)).toBe(true);
    expect(new Set(ports).size).toBe(ports.length);
    for (const p of ports) expect(Number(p)).toBeGreaterThanOrEqual(24500);
  });
});
