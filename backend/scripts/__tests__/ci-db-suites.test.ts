/**
 * CI runs every `*-db.test.ts` that has no step of its own as several steps of the Database job, each one
 * `scripts/ci-db-suites.sh <shard> <shards>`. This is the check that no suite falls between the steps:
 *
 *  - the shards together hold every suite once (none dropped, none run twice), whatever the shard count;
 *  - the suites that have their own step stay out of every shard;
 *  - the steps in ci.yml name every shard of ONE shard count, so changing the count in two of three steps
 *    (or adding a step and forgetting a "3") cannot quietly stop a third of the suites from running;
 *  - a red shard does not hide the shards after it: each later shard (and the checks that follow them) still
 *    runs, unless the job was cancelled or its lock / database / earlier steps never got that far.
 *
 * A new suite needs nothing: it is picked up by name.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BACKEND = path.resolve(__dirname, '../..');
const SCRIPT = path.join(BACKEND, 'scripts/ci-db-suites.sh');
const CI_FILE = path.resolve(BACKEND, '../.github/workflows/ci.yml');

/** The names ci.yml gives the shards as the suites to leave out, read from the workflow so the two cannot differ. */
function skippedByCi(): string[] {
  const found = [...readFileSync(CI_FILE, 'utf8').matchAll(/DB_SUITES_SKIP: '([^']+)'/g)].map((m) => m[1]!);
  expect(found.length).toBeGreaterThan(0);
  // Every step carries the same list.
  expect(new Set(found).size).toBe(1);
  return found[0]!.split('|');
}

const skip = skippedByCi();

function shardFiles(shard: number, shards: number): string[] {
  const out = execFileSync('bash', [SCRIPT, String(shard), String(shards), '--list'], {
    cwd: BACKEND,
    env: { ...process.env, DB_SUITES_SKIP: skip.join('|') },
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

/** Every tracked real-database suite that has no step of its own, found without the script. */
function expectedSuites(): string[] {
  const tracked = execFileSync('git', ['ls-files', '--', '*-db.test.ts'], { cwd: BACKEND, encoding: 'utf8' }).split('\n').filter(Boolean);
  return tracked.filter((f) => !skip.some((name) => f.endsWith(`/${name}-db.test.ts`) || f === `${name}-db.test.ts`));
}

describe('ci-db-suites.sh deals the real-database suites out to the Database job steps', () => {
  for (const shards of [1, 2, 3, 4, 7]) {
    it(`${shards} shard(s) between them run every suite once, and differ by at most one suite`, () => {
      const dealt = Array.from({ length: shards }, (_, i) => shardFiles(i + 1, shards));
      const all = dealt.flat();
      expect(new Set(all).size, 'a suite is in two shards').toBe(all.length);
      expect([...all].sort()).toEqual([...expectedSuites()].sort());
      const sizes = dealt.map((files) => files.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    });
  }

  it('leaves out the suites that have a step of their own, and this one is not among the skipped', () => {
    expect(skip.length).toBeGreaterThan(0);
    const all = [1, 2, 3].flatMap((shard) => shardFiles(shard, 3));
    for (const name of skip) expect(all.filter((f) => f.endsWith(`/${name}-db.test.ts`)), name).toEqual([]);
    expect(all.length).toBeGreaterThan(50);
  });

  it('refuses a shard outside 1..shards, and a count that is not a number, rather than running nothing', () => {
    for (const args of [['0', '3'], ['4', '3'], ['x', '3'], ['1', ''], ['', '']]) {
      expect(() => execFileSync('bash', [SCRIPT, ...args, '--list'], { cwd: BACKEND, stdio: 'pipe' })).toThrow();
    }
  });
});

describe('ci.yml runs every shard, of one shard count', () => {
  it('has one step for each of shards 1..N of the same N', () => {
    const calls = [...readFileSync(CI_FILE, 'utf8').matchAll(/scripts\/ci-db-suites\.sh (\d+) (\d+)\s*$/gm)].map((m) => ({
      shard: Number(m[1]),
      shards: Number(m[2]),
    }));
    expect(calls.length).toBeGreaterThan(0);
    const counts = new Set(calls.map((c) => c.shards));
    expect([...counts], 'the steps disagree on the number of shards').toHaveLength(1);
    const n = [...counts][0]!;
    expect(calls.map((c) => c.shard).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });

  it('gives every shard step a time limit, so a hung database is still caught early', () => {
    const steps = readFileSync(CI_FILE, 'utf8').split(/\n {6}- name: /).filter((s) => /run: bash scripts\/ci-db-suites\.sh/.test(s));
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(step).toMatch(/timeout-minutes: \d+/);
  });
});

/** The job's steps in order, each as the text between its `- name:` line and the next one. */
function ciSteps(): string[] {
  return readFileSync(CI_FILE, 'utf8').split(/\n {6}- name: /).slice(1);
}
const isShard = (step: string) => /run: bash scripts\/ci-db-suites\.sh/.test(step);
const ifLine = (step: string) => /^ {8}if: (.*)$/m.exec(step)?.[1];
const idOf = (step: string) => /^ {8}id: (\S+)$/m.exec(step)?.[1];
/** Setup is done (lock and database), shard 1 got to run, and nobody cancelled the job. */
const KEEP_GOING = (firstShardId: string) =>
  `\${{ !cancelled() && steps.lock.outcome == 'success' && steps.pg.outcome == 'success' && steps.${firstShardId}.outcome != 'skipped' }}`;

describe('ci.yml keeps running after a red shard', () => {
  const steps = ciSteps();
  const shardSteps = steps.filter(isShard);
  const shardNumber = (step: string) => Number(/ci-db-suites\.sh (\d+) \d+/.exec(step)![1]);
  const ordered = [...shardSteps].sort((a, b) => shardNumber(a) - shardNumber(b));

  it('leaves shard 1 on the default condition: it runs only when every step before it passed', () => {
    expect(ifLine(ordered[0]!)).toBeUndefined();
    expect(idOf(ordered[0]!), 'shard 1 needs an id for the later shards to point at').toBeTruthy();
  });

  it('runs every later shard unless the job was cancelled or setup never got that far', () => {
    expect(ordered.length).toBeGreaterThan(1);
    const first = idOf(ordered[0]!)!;
    for (const step of ordered.slice(1)) {
      expect(ifLine(step), `shard ${shardNumber(step)}`).toBe(KEEP_GOING(first));
    }
  });

  it('gives every shard an id of its own, so each one can be told apart', () => {
    const ids = ordered.map(idOf);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the checks that follow the shards going too, so a red shard does not hide them', () => {
    const last = steps.indexOf(ordered[ordered.length - 1]!);
    const release = steps.findIndex((s) => s.startsWith('Drop throwaway database and release the lock'));
    expect(release).toBeGreaterThan(last);
    const first = idOf(ordered[0]!)!;
    const between = steps.slice(last + 1, release);
    expect(between.length).toBeGreaterThan(0);
    for (const step of between) expect(ifLine(step), step.split('\n')[0]).toBe(KEEP_GOING(first));
  });

  it('still releases the lock and drops the database whatever happened, but only a lock this job holds', () => {
    const release = steps.find((s) => s.startsWith('Drop throwaway database and release the lock'))!;
    expect(ifLine(release)).toBe("always() && steps.lock.outcome == 'success'");
  });
});

/**
 * The Database job's three time limits have to agree, or a queue of two jobs fails the second for no
 * reason (batch 97: "Gave up waiting for the lock after 25 minutes" twice, with no test run, because the
 * wait was shorter than the time the job ahead could legitimately hold the lock):
 *
 *   wait for the lock  >  the longest a holder keeps it
 *   job limit          >=  setup before the lock + the full wait + the full hold
 *   stale-lock age     >  job limit (so a waiting job never reaps a holder that is still within its limit)
 *
 * Every number is read from ci.yml. Only the two budgets the workflow comment names, the minutes before the
 * lock and the minutes the steps other than the shards hold it, are fixed here.
 */
describe('ci.yml: the lock wait fits the longest legitimate hold', () => {
  /** Checkout, `npm ci` and the build, before the lock (ci.yml: "10 before the lock"). */
  const SETUP_MINUTES = 10;
  /** Every step inside the lock except the shards (ci.yml: "5 for every step except the real-database suites"). */
  const OTHER_HELD_STEPS_MINUTES = 5;

  const text = readFileSync(CI_FILE, 'utf8');
  /** The `database:` job: from its key to the next job key. */
  const job = /^ {2}database:\n([\s\S]*?)(?=^ {2}[a-z][a-z-]*:\n|(?![\s\S]))/m.exec(text)![1]!;
  const num = (re: RegExp, what: string): number => {
    const m = re.exec(job);
    expect(m, `${what} not found in the database job`).not.toBeNull();
    return Number(m![1]);
  };

  const jobLimit = num(/^ {4}timeout-minutes: (\d+)$/m, 'the job timeout-minutes');
  const waitSeconds = num(/"\$WAITED" -gt (\d+)/, 'the lock wait');
  const staleSeconds = num(/"\$AGE" -gt (\d+)/, 'the stale-lock age');
  const shardLimits = job
    .split(/\n {6}- name: /)
    .filter((s) => /run: bash scripts\/ci-db-suites\.sh/.test(s))
    .map((s) => Number(/timeout-minutes: (\d+)/.exec(s)?.[1]));
  const holdMinutes = OTHER_HELD_STEPS_MINUTES + shardLimits.reduce((a, b) => a + b, 0);
  const waitMinutes = waitSeconds / 60;

  it('has a numeric limit on every shard, so the longest hold can be added up', () => {
    expect(shardLimits.length).toBeGreaterThan(0);
    for (const limit of shardLimits) expect(Number.isFinite(limit)).toBe(true);
  });

  it('waits for the lock longer than the longest a holder keeps it', () => {
    expect(waitMinutes).toBeGreaterThan(holdMinutes);
  });

  it('lets the job run for the setup, the full wait and the full hold', () => {
    expect(jobLimit).toBeGreaterThanOrEqual(SETUP_MINUTES + waitMinutes + holdMinutes);
  });

  it('reaps a lock only when it is older than the job limit, so a live holder is never reaped', () => {
    expect(staleSeconds / 60).toBeGreaterThan(jobLimit);
  });

  it('tells the reader the number of minutes it really waited', () => {
    expect(job).toContain(`Gave up waiting for the lock after ${waitMinutes} minutes`);
  });
});
