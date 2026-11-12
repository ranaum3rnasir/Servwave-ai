/**
 * `npm run test:ci` (#3253), end to end: the real command runs the real test tool on a tiny fixture
 * suite (scripts/__fixtures__/test-ci/, its own config, not the real suite) with a planted failure, a
 * planted file that fails to load, a planted expected file that never reports and a planted hang.
 * Each ends red with its own reason code and exit code. The watchdog is shortened by option here;
 * its default stays 240 s.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FRONTEND = resolve(__dirname, '../..');
const CONFIG = join(FRONTEND, 'scripts/__fixtures__/test-ci/vitest.config.mjs');

/**
 * The environment a child run sees: the caller's, minus everything the test tool or the brake reads from the CI
 * runner (VITEST*, TEST_CI*, the worker count, CI, the compile-cache variables, and every GITHUB_* variable such as
 * GITHUB_BASE_REF and GITHUB_EVENT_NAME). These runs must give the same answer on a laptop, on a push and on a pull request into any branch.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('VITEST') || k.startsWith('TEST_CI') || k === 'TEST_SELECTION' || k === 'PR_HEAD_SHA' || k.startsWith('GITHUB_') || k === 'FRONTEND_TEST_WORKERS' || k === 'CI' || k === 'NODE_COMPILE_CACHE' || k === 'NODE_DISABLE_COMPILE_CACHE') delete env[k];
  }
  return env;
}

/** Waits poll a real condition in steps of this size, up to a deadline, never a fixed sleep. */
const POLL_STEP_MS = 50;
const WAIT_DEADLINE_MS = 30_000;

async function waitFor(condition: () => boolean, deadlineMs = WAIT_DEADLINE_MS): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (!condition()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, POLL_STEP_MS));
  }
  return true;
}

const readText = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

interface Outcome { code: number | null; out: string; verdict: string; summary: string; events: string }

function runCommand(files: string[], extra: string[] = [], opts: { killWhen?: (events: string) => boolean; brakeRoot?: string; env?: Record<string, string> } = {}): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), 'test-ci-e2e-'));
  const list = join(dir, 'files.txt');
  const summary = join(dir, 'summary.md');
  const events = join(dir, 'events.jsonl');
  writeFileSync(list, files.join('\n'));
  // The brake judges its own tiny root, not the real source tree or the real git history: an empty tree, no repo, so
  // these runs can never be turned red (or slowed by a scan of 1,600 files) by the state of the real repository.
  const brakeRoot = opts.brakeRoot ?? join(dir, 'brake-root');
  if (!opts.brakeRoot) {
    mkdirSync(join(brakeRoot, 'src'), { recursive: true });
    writeFileSync(join(brakeRoot, 'test-budget.json'), JSON.stringify({ maxCpuSeconds: 1, maxMinutes: 1, workers: 6 }));
    writeFileSync(join(brakeRoot, 'test-file-count.json'), JSON.stringify({ maxTestFiles: 0 }));
    writeFileSync(join(brakeRoot, 'test-page-ceilings.json'), '{}');
  }
  const env = { ...childEnv(), ...opts.env };
  const child = spawn(process.execPath, [
    'scripts/test-ci.mjs', `--config=${CONFIG}`, `--files-from=${list}`, `--summary=${summary}`, `--events=${events}`, `--brake-root=${brakeRoot}`, ...extra,
  ], { cwd: FRONTEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  if (opts.killWhen) {
    const killWhen = opts.killWhen;
    void waitFor(() => killWhen(readText(events))).then((seen) => { if (seen) child.kill('SIGTERM'); });
  }
  return new Promise((res) => child.on('close', (code) => {
    const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
    res({ code, out, verdict: out.split('\n').find((l) => l.startsWith('TEST-CI-VERDICT')) ?? '', summary: read(summary), events: read(events) });
  }));
}

describe('npm run test:ci on the fixture suite', () => {
  it('a clean run prints one verdict line, exits 0 and writes a preflight block', async () => {
    const r = await runCommand(['ok.test.ts']);
    expect(r.verdict).toBe('TEST-CI-VERDICT result=passed code=0 reasons=none mode=selected-1-of-1 files=1/1 passed=2 failed=0 retried=0');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/preflight[\s\S]*workers: 4 \(default 4/);
    expect(r.summary).toContain('### Preflight');
    expect(r.events).toContain('"ev":"file-end"');
    // The compile cache: the command names its directory and, after a run, Node has written compiled code there.
    expect(r.out).toContain('compile cache: node_modules/.cache/test-ci/compile-cache');
    expect(readdirSync(join(FRONTEND, 'node_modules/.cache/test-ci/compile-cache')).length).toBeGreaterThan(0);
  }, 60_000);

  it('a planted failure ends red as "failed" (exit 10)', async () => {
    const r = await runCommand(['ok.test.ts', 'fail.test.ts']);
    expect(r.code).toBe(10);
    expect(r.verdict).toContain('result=failed code=10 reasons=tests-failed');
    expect(r.summary).toContain('planted failure');
  }, 60_000);

  it('a planted file that fails to load ends red as "failed" (exit 10), not silently skipped', async () => {
    const r = await runCommand(['ok.test.ts', 'broken-load.test.ts']);
    expect(r.code).toBe(10);
    expect(r.verdict).toContain('reasons=file-failed-to-load');
    expect(r.summary).toContain('planted load failure');
  }, 60_000);

  it('a planted expected file that never reports ends red as "incomplete" (exit 11)', async () => {
    const r = await runCommand(['ok.test.ts', 'ghost.test.ts']);
    expect(r.code).toBe(11);
    expect(r.verdict).toContain('result=incomplete code=11 reasons=file-missing');
    expect(r.summary).toContain('Expected file never ran: ghost.test.ts');
  }, 60_000);

  it('a planted hang ends red as "stalled" (exit 12) inside the shortened watchdog window, naming the files', async () => {
    const started = Date.now();
    const r = await runCommand(['ok.test.ts', 'hang.test.ts'], ['--idle-ms=3000']);
    const elapsed = Date.now() - started;
    expect(r.code).toBe(12);
    expect(r.verdict).toContain('result=stalled code=12 reasons=no-event');
    expect(r.out).toContain('Files in flight: hang.test.ts');
    expect(r.summary).toContain('Stalled (no-event)');
    expect(elapsed).toBeLessThan(45_000);
  }, 60_000);

  it('on the runner cancel signal it prints "failed so far" from the event file and exits 14', async () => {
    const r = await runCommand(['fail.test.ts', 'hang.test.ts'], ['--idle-ms=600000', '--file-margin-ms=600000'], { killWhen: (events) => events.includes('"ev":"file-start","file":"hang.test.ts"') && events.includes('planted failure') });
    expect(r.out).toMatch(/Failed so far \(1;/);
    expect(r.out).toContain('FAILED fail.test.ts > planted failure');
    expect(r.code).toBe(14);
  }, 60_000);

  it('a real it.only under --allowOnly=false ends red as "incomplete" with only-present (exit 11)', async () => {
    const r = await runCommand(['ok.test.ts', 'only-present.test.ts']);
    expect(r.code).toBe(11);
    expect(r.verdict).toContain('result=incomplete code=11');
    expect(r.verdict).toContain('only-present');
    expect(r.verdict).toContain('failed=0');
  }, 60_000);

  it('a throwing describe-level beforeAll ends red as "failed" with suite-failed and its error (exit 10)', async () => {
    const r = await runCommand(['ok.test.ts', 'beforeall-throw.test.ts']);
    expect(r.code).toBe(10);
    expect(r.verdict).toContain('reasons=suite-failed');
    expect(r.summary).toContain('planted beforeAll failure');
  }, 60_000);

  it('an unknown option or a non-numeric floor exits non-zero with usage, never a silent run', async () => {
    for (const bad of ['--bogus=1', '--floor=abc']) {
      const r = await runCommand(['ok.test.ts'], [bad]);
      expect(r.code, bad).toBe(11);
      expect(r.out, bad).toContain('usage: npm run test:ci');
      expect(r.out, bad).not.toContain('preflight');
    }
  }, 60_000);

  it('a policy file without a floor is red on a full-mode check (invalid-floor)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-ci-policy-'));
    const policy = join(dir, 'policy.json');
    writeFileSync(policy, JSON.stringify({ skipAllowList: {}, maxRetried: 10 }));
    const r = await runCommand(['ok.test.ts'], [`--policy=${policy}`]);
    expect(r.code).toBe(11);
    expect(r.verdict).toContain('invalid-floor');
  }, 60_000);

  it('when the command itself is killed with SIGKILL, the test tool and its workers die with it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-ci-kill-'));
    const list = join(dir, 'files.txt');
    writeFileSync(list, 'hang.test.ts');
    const eventsPath = join(dir, 'events.jsonl');
    const env = childEnv();
    const child = spawn(process.execPath, ['scripts/test-ci.mjs', `--config=${CONFIG}`, `--files-from=${list}`, `--summary=${join(dir, 's.md')}`, `--events=${eventsPath}`, '--idle-ms=600000', '--file-margin-ms=600000'], { cwd: FRONTEND, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    await waitFor(() => /test tool pid (\d+)/.test(out));
    const toolPid = Number(/test tool pid (\d+)/.exec(out)?.[1]);
    expect(toolPid).toBeGreaterThan(0);
    // the tool has started its worker once the hanging file has started
    expect(await waitFor(() => readText(eventsPath).includes('"ev":"file-start","file":"hang.test.ts"'))).toBe(true);
    child.kill('SIGKILL');
    const alive = () => { try { process.kill(-toolPid, 0); return true; } catch { return false; } };
    await waitFor(() => !alive(), 15_000);
    expect(alive()).toBe(false);
  }, 60_000);

  it('lists each attempt of a retried test with its own real duration (800 ms, then about 0 ms)', async () => {
    const r = await runCommand(['ok.test.ts', 'retry-timing.test.ts']);
    expect(r.code).toBe(0);
    const m = /attempt 1 failed (\d+) ms; attempt 2 passed (\d+) ms/.exec(r.summary);
    expect(m, r.summary).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(700);
    expect(Number(m![1])).toBeLessThan(1500);
    expect(Number(m![2])).toBeLessThan(200);
    expect(r.summary).toContain('planted first-attempt failure');
  }, 60_000);

  it('a beforeAll that times out is reported as a hook timeout, not a plain suite failure', async () => {
    const r = await runCommand(['ok.test.ts', 'beforeall-timeout.test.ts']);
    expect(r.code).toBe(10);
    expect(r.verdict).toContain('hook-timeout');
    expect(r.verdict).not.toContain('suite-failed');
  }, 60_000);

  it('a bad --shard prints usage and exits 11 without a stack trace', async () => {
    for (const bad of ['7/6', '0/6', 'abc']) {
      const env = childEnv();
      const r = await new Promise<{ code: number | null; out: string }>((res) => {
        const c = spawn(process.execPath, ['scripts/test-ci.mjs', `--shard=${bad}`], { cwd: FRONTEND, env });
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { out += d; });
        c.on('close', (code) => res({ code, out }));
      });
      expect(r.code, bad).toBe(11);
      expect(r.out, bad).toContain('usage: npm run test:ci');
      expect(r.out, bad).not.toMatch(/\n\s+at /);
    }
  }, 60_000);

  it('duplicate lines in the file list are one expected file', async () => {
    const r = await runCommand(['ok.test.ts', 'ok.test.ts']);
    expect(r.verdict).toContain('mode=selected-1-of-1 files=1/1');
    expect(r.code).toBe(0);
  }, 60_000);

  it('an explicit file list is run as given even when test selection is on (no selector, no selection token)', async () => {
    const r = await runCommand(['ok.test.ts'], [], { env: { TEST_SELECTION: 'on', GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'staging' } });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('test-select:');
    expect(r.verdict).toBe('TEST-CI-VERDICT result=passed code=0 reasons=none mode=selected-1-of-1 files=1/1 passed=2 failed=0 retried=0');
  }, 60_000);

  it('refuses --shard together with a selection', async () => {
    const r = await runCommand(['ok.test.ts'], ['--shard=1/2']);
    expect(r.code).toBe(11);
    expect(r.out).toContain('refusing --shard together with --files-from');
  }, 60_000);

  it('a hosted shard with an empty slice fails without running anything', async () => {
    const env = childEnv();
    const r = await new Promise<{ code: number | null; out: string }>((res) => {
      const c = spawn(process.execPath, ['scripts/test-ci.mjs', '--shard=999999/1000000'], { cwd: FRONTEND, env });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { out += d; });
      c.on('close', (code) => res({ code, out }));
    });
    expect(r.code).toBe(11);
    expect(r.out).toContain('reasons=empty-slice');
    expect(r.out).not.toContain('preflight');
  }, 60_000);
});

/** A source repo whose page is mounted by 2 test files against a ceiling of 1, cloned at depth 1 like the hosted shards. Returns its frontend folder. */
function shallowClone(): string {
  const origin = mkdtempSync(join(tmpdir(), 'brake-shallow-src-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const put = (root: string, path: string, text: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  const mount = "import { ShallowPage } from '../pages/ShallowPage';\nexport const x = ShallowPage;\n";
  git(origin, 'init', '-q', '-b', 'main');
  put(origin, 'frontend/src/pages/ShallowPage.tsx', 'export const ShallowPage = () => null;\n');
  put(origin, 'frontend/src/__tests__/a.test.tsx', mount);
  put(origin, 'frontend/src/__tests__/b.test.tsx', mount);
  put(origin, 'frontend/test-budget.json', JSON.stringify({ maxCpuSeconds: 1, maxMinutes: 1, workers: 6 }));
  put(origin, 'frontend/test-file-count.json', JSON.stringify({ maxTestFiles: 2 }));
  put(origin, 'frontend/test-page-ceilings.json', JSON.stringify({ 'src/pages/ShallowPage.tsx': 1 }));
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'base');
  const clone = join(mkdtempSync(join(tmpdir(), 'brake-shallow-')), 'clone');
  git(tmpdir(), 'clone', '-q', '--depth', '1', `file://${origin}`, clone);
  return join(clone, 'frontend');
}

describe('npm run test:ci: the brake on test growth (#3254), on the fixture suite', () => {
  function changedList(files: string[]): string {
    const p = join(mkdtempSync(join(tmpdir(), 'test-brake-changed-')), 'changed.txt');
    writeFileSync(p, files.join('\n'));
    return `--changed-from=${p}`;
  }

  it('a planted 3-second test in a file the pull request added ends red (exit 15) with the file and the test named', async () => {
    const r = await runCommand(['ok.test.ts', 'slow-3s.test.ts'], [changedList(['slow-3s.test.ts'])]);
    expect(r.verdict).toContain('result=passed code=0');
    expect(r.out).toContain('TEST-BRAKE-VERDICT result=failed code=15 reasons=test-time-ceiling');
    expect(r.out).toContain('slow-3s.test.ts > takes three seconds');
    expect(r.out).toContain('re-running it alone');
    expect(r.code).toBe(15);
    expect(r.summary).toContain('## Test growth brake');
  }, 90_000);

  it('the same 3 seconds in a file that was slow only in the full run is green once it passes when re-run alone', async () => {
    const r = await runCommand(['ok.test.ts', 'slow-under-load.test.ts'], [changedList(['slow-under-load.test.ts'])]);
    expect(r.out).toContain('slow-under-load.test.ts is over the line; re-running it alone');
    expect(r.out).toContain('TEST-BRAKE-VERDICT result=passed code=0 reasons=none');
    expect(r.code).toBe(0);
  }, 90_000);

  it('the same slow file that the pull request did not touch is not judged', async () => {
    const r = await runCommand(['ok.test.ts', 'slow-3s.test.ts'], [changedList(['ok.test.ts'])]);
    expect(r.out).not.toContain('re-running it alone');
    expect(r.code).toBe(0);
  }, 90_000);

  it('a red main run never prints a brake verdict of "passed": the brake says it did not judge, and the exit stays the run\'s own', async () => {
    const r = await runCommand(['ok.test.ts', 'fail.test.ts']);
    expect(r.code).toBe(10);
    expect(r.out).toContain('TEST-BRAKE-VERDICT result=not-judged code=0 reasons=main-run-red');
    expect(r.out).not.toContain('TEST-BRAKE-VERDICT result=passed');
  }, 90_000);

  it('with no changed-file list (a push or a local run) the time ceiling judges nothing and says so', async () => {
    const r = await runCommand(['ok.test.ts', 'slow-3s.test.ts']);
    expect(r.out).toContain('time ceiling not judged (no-changed-file-list)');
    expect(r.summary).toContain('Nothing was checked');
    expect(r.code).toBe(0);
  }, 90_000);

  it('on a depth-1 checkout (no base) a page over its ceiling is not judged: exit 0, said plainly, no pass claimed for the ceilings', async () => {
    const r = await runCommand(['ok.test.ts'], [], { brakeRoot: shallowClone() });
    expect(r.code).toBe(0);
    expect(r.out).toContain('TEST-BRAKE-VERDICT result=passed code=0 reasons=none pages=not-judged (no base: shallow checkout or no remote)');
    expect(r.out).not.toContain('page-ceiling');
    expect(r.summary).toContain('Not judged (no base: shallow checkout or no remote). The ceilings were not checked.');
    expect(r.summary).not.toContain('Within the ceilings');
  }, 90_000);

  it('on a depth-1 staging -> main pull request the base is origin/main, the own change is empty, and the brake passes: exit 0, time said to be not judged', async () => {
    const r = await runCommand(['ok.test.ts'], [], { brakeRoot: shallowClone(), env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main', GITHUB_HEAD_REF: 'staging' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('base: merge-base with origin/main');
    expect(r.out).toContain('TEST-BRAKE-VERDICT result=passed code=0 reasons=none time=not-judged (PR from staging into main)');
    expect(r.out).not.toContain('page-ceiling');
  }, 90_000);

  it('a planted 3-second test on the staging -> main pull request is not time-judged, and NO lone re-run happens: exit 0, said plainly', async () => {
    const r = await runCommand(['ok.test.ts', 'slow-3s.test.ts'], [changedList(['slow-3s.test.ts'])], { env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main', GITHUB_HEAD_REF: 'staging' } });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('re-running it alone');
    expect(r.out).not.toContain('test-time-ceiling');
    expect(r.out).toContain('time=not-judged (PR from staging into main)');
    expect(r.summary).toContain('Not judged: PR from staging into main');
  }, 90_000);

  // One wiring case for "judged into main": the head ref reaches the decision. The other heads (feature, hotfix, none,
  // staging into staging) are pinned by the table in test-brake-lib.test.ts (timeCeilingSkipReason).
  it('the same planted test on a promote branch into main is judged and ends red (exit 15)', async () => {
    const r = await runCommand(['ok.test.ts', 'slow-3s.test.ts'], [changedList(['slow-3s.test.ts'])], { env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main', GITHUB_HEAD_REF: 'promote/x' } });
    expect(r.out).toContain('re-running it alone');
    expect(r.out).toContain('TEST-BRAKE-VERDICT result=failed code=15 reasons=test-time-ceiling');
    expect(r.code).toBe(15);
  }, 90_000);

  it('the same planted test on a pull request into staging is judged and ends red (exit 15)', async () => {
    const r = await runCommand(['ok.test.ts', 'slow-3s.test.ts'], [changedList(['slow-3s.test.ts'])], { env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'staging' } });
    expect(r.out).toContain('re-running it alone');
    expect(r.out).toContain('TEST-BRAKE-VERDICT result=failed code=15 reasons=test-time-ceiling');
    expect(r.code).toBe(15);
  }, 90_000);
});
