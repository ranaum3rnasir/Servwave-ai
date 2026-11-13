/* =============================================================================
   JOBS_PAUSED (#3109, Spider phase 1): an operator pauses background jobs with a setting instead of a code change.

   Seam (agreed with Ran): the sweep and job entry points with JOBS_PAUSED set and unset. A job's entry point is the door the
   server starts it through: `scheduleJob` for every cron job, `runJobAtBoot` for the run at boot (lib/scheduleJob.ts). The
   Spider sweep's own entry on a real database is jobs-paused-db.test.ts; this file is the table over every job name.

   No database: the jobs here are probes, so a paused job that still ran would show as a call.
   ========================================================================== */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { scheduleJob, runJobAtBoot } from '../lib/scheduleJob';
import { JOB_NAMES, warnUnknownPausedJobs, type JobName } from '../lib/jobsPaused';

/** Every background job the server starts, by the name an operator writes in JOBS_PAUSED. Written out here on purpose: the list in
 *  the code is checked against this one, so adding a job means adding its name here too. */
const EXPECTED_NAMES = [
  'invoice-due',
  'automations',
  'spider',
  'attachments',
  'stripe-fees',
  'payment-reconcile',
  'account-status',
  'spider-watch-backfill',
  'spider-watch-check',
  'spider-tick',
] as const;

// The setting is read through the app's configuration (config/env.ts, here the shared test env of setup.ts), so a case sets it there.
const originalPaused = env.JOBS_PAUSED;
const setPaused = (value: string | undefined) => {
  if (value === undefined) delete env.JOBS_PAUSED;
  else env.JOBS_PAUSED = value;
};

/** Starts a probe job through the cron door and runs it once, the way the scheduler would when its time comes. */
async function runByCron(name: JobName): Promise<number> {
  const probe = vi.fn();
  const job = scheduleJob(name, '0 0 1 1 *', probe);
  try {
    await job.execute();
  } finally {
    await job.destroy();
  }
  return probe.mock.calls.length;
}

/** Runs a probe job through the boot door. */
async function runAtBoot(name: JobName): Promise<number> {
  const probe = vi.fn(async () => 'done');
  await runJobAtBoot(name, probe);
  return probe.mock.calls.length;
}

const infoLines = () => vi.mocked(logger.info).mock.calls.map((c) => String(c[0]));
const pausedLines = () => infoLines().filter((line) => /paused/i.test(line));
const otherThan = (name: string) => EXPECTED_NAMES.find((n) => n !== name)!;

describe('JOBS_PAUSED: every background job can be paused, by its own name or by all', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => setPaused(originalPaused));

  it('the list of job names an operator may write is exactly these', () => {
    expect([...JOB_NAMES]).toEqual([...EXPECTED_NAMES]);
  });

  describe.each([
    ['cron job', runByCron],
    ['run at boot', runAtBoot],
  ] as const)('started as a %s', (_door, run) => {
    it.each(EXPECTED_NAMES)('%s is paused by its own name: it skips the run and says so once', async (name) => {
      setPaused(name);
      expect(await run(name)).toBe(0);
      expect(pausedLines()).toHaveLength(1);
      expect(pausedLines()[0]).toContain(name);
    });

    it.each(EXPECTED_NAMES)('%s is paused by "all"', async (name) => {
      setPaused('all');
      expect(await run(name)).toBe(0);
      expect(pausedLines()).toHaveLength(1);
      expect(pausedLines()[0]).toContain(name);
    });

    it.each(EXPECTED_NAMES)('%s runs, and says nothing about pausing, when JOBS_PAUSED is unset', async (name) => {
      setPaused(undefined);
      expect(await run(name)).toBe(1);
      expect(pausedLines()).toEqual([]);
    });

    it.each(EXPECTED_NAMES)('%s runs when only another job is listed', async (name) => {
      setPaused(otherThan(name));
      expect(await run(name)).toBe(1);
      expect(pausedLines()).toEqual([]);
    });
  });

  it('pausing stripe-fees pauses the whole fee sweep: the nightly run and the run at boot (a pause only applies on a restart)', async () => {
    setPaused('stripe-fees');
    expect(await runByCron('stripe-fees')).toBe(0);
    expect(await runAtBoot('stripe-fees')).toBe(0);
    expect(pausedLines()).toHaveLength(2);
    // Another job's boot run is not touched by it.
    expect(await runAtBoot('spider')).toBe(1);
  });

  it('a paused job is told apart from the others in the same list: the listed ones skip, the rest run', async () => {
    setPaused('spider,attachments');
    const ran = {
      spider: await runByCron('spider'),
      attachments: await runByCron('attachments'),
      automations: await runByCron('automations'),
      'invoice-due': await runByCron('invoice-due'),
    };
    expect(ran).toEqual({ spider: 0, attachments: 0, automations: 1, 'invoice-due': 1 });
  });

  it('every run of a paused job logs one line: three runs, three lines', async () => {
    setPaused('spider');
    for (let i = 0; i < 3; i += 1) await runByCron('spider');
    expect(pausedLines()).toHaveLength(3);
  });

  it('spaces and capital letters in the setting do not matter', async () => {
    setPaused('  Spider ,  AUTOMATIONS  ');
    expect(await runByCron('spider')).toBe(0);
    expect(await runByCron('automations')).toBe(0);
    expect(await runByCron('attachments')).toBe(1);
  });

  it('"ALL" in capitals pauses everything too', async () => {
    setPaused('ALL');
    expect(await runByCron('spider')).toBe(0);
  });

  it('an empty setting, or one of only commas and spaces, pauses nothing', async () => {
    for (const value of ['', ' ', ',', ' , ,']) {
      setPaused(value);
      expect(await runByCron('spider')).toBe(1);
    }
    expect(pausedLines()).toEqual([]);
  });
});

describe('JOBS_PAUSED: a name that is not a job is warned about once, at boot', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => setPaused(originalPaused));

  /** The names the warning calls unknown: what sits between "no such job: " and the sentence's full stop. */
  const namedUnknown = (line: string) => /no such job: ([^.]*)\./.exec(line)![1];

  it('warns once, naming exactly the unknown name, as the operator wrote it (the valid names it lists after are the help)', () => {
    setPaused('spider,Spidr');
    warnUnknownPausedJobs();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const line = String(vi.mocked(logger.warn).mock.calls[0]![0]);
    expect(line).toContain('JOBS_PAUSED');
    expect(namedUnknown(line)).toBe('Spidr');
  });

  it('lists every unknown name in that one warning, each once', () => {
    setPaused('spidr, automatons,SPIDR,spider');
    warnUnknownPausedJobs();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    expect(namedUnknown(String(vi.mocked(logger.warn).mock.calls[0]![0]))).toBe('spidr, automatons');
  });

  it('says nothing when every name is a job, "all" included, or when it is unset', () => {
    for (const value of [undefined, '', 'spider', 'spider,automations', 'all', ' ALL ']) {
      setPaused(value);
      warnUnknownPausedJobs();
    }
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('is not repeated by the runs: ten runs of jobs with a typo in the setting warn nothing more', async () => {
    setPaused('spidr');
    warnUnknownPausedJobs();
    for (let i = 0; i < 10; i += 1) await runByCron('spider');
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });

  it('a typo pauses nothing: the job the operator meant still runs', async () => {
    setPaused('spidr');
    expect(await runByCron('spider')).toBe(1);
  });
});
