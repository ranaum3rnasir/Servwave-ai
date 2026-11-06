import { env } from '../config/env';
import { logger } from './logger';

/**
 * JOBS_PAUSED (#3109): an operator pauses background jobs with a setting instead of a code change.
 *
 * The value is a comma-separated list of the names below, or `all`. Spaces around a name and capital letters do not matter.
 * A paused job skips its run before it touches the database (no lease, no query) and logs one line per run saying so; the
 * other jobs run as usual. A name that is not in the list pauses nothing and is warned about once at boot
 * (`warnUnknownPausedJobs`, called from index.ts), so a typo is visible.
 *
 * This is the one place the job names are listed. Every job index.ts starts is started under one of them
 * (`scheduleJob` / `runJobAtBoot`, lib/scheduleJob.ts), which is where the setting is checked. A run at boot is a run of
 * the same job and uses the job's name: a pause only takes effect on a restart, and that restart must not run what was paused.
 *
 * The setting is read through config/env.ts (optional, no default). Only the job doors import this module (lib/scheduleJob.ts,
 * index.ts); lib/prisma, lib/prismaJobs and lib/tenant-guard never do, so a script that imports lib/prisma still loads with only
 * DATABASE_URL (jobs-use-jobs-client-guard.test.ts pins that).
 */
export const JOB_NAMES = [
  'invoice-due', // daily invoice overdue / due-soon check
  'automations', // Automation Center poller, every minute
  'spider', // Spider lead watcher sweep, every 2 minutes
  'attachments', // received-mail attachments retry sweep
  'stripe-fees', // Stripe fee reconciliation sweep: the nightly cron run AND the run at boot (one job, one name)
  'payment-reconcile', // nightly payment reconcile against the processor
  'account-status', // nightly Stripe account-status refresh
] as const;

export type JobName = (typeof JOB_NAMES)[number];

const ALL = 'all';

/** The entries of JOBS_PAUSED: trimmed, empty ones dropped, as written. */
function writtenNames(): string[] {
  return (env.JOBS_PAUSED ?? '').split(',').map((n) => n.trim()).filter((n) => n !== '');
}

/** The names in JOBS_PAUSED, lower-cased, each once. */
function requestedNames(): string[] {
  return [...new Set(writtenNames().map((n) => n.toLowerCase()))];
}

export function isJobPaused(name: JobName): boolean {
  const requested = requestedNames();
  return requested.includes(ALL) || requested.includes(name);
}

/**
 * Called at the start of every run of a job: when the job is paused, logs the one line for this run and returns true, and the
 * caller must then return without touching anything.
 */
export function skipRunIfPaused(name: JobName): boolean {
  if (!isJobPaused(name)) return false;
  logger.info(`[jobs] ${name} is paused (JOBS_PAUSED): this run was skipped`);
  return true;
}

/** Boot: one warning naming the entries in JOBS_PAUSED that are no job, as written (each once). Nothing when there are none. */
export function warnUnknownPausedJobs(): void {
  const known: readonly string[] = [...JOB_NAMES, ALL];
  const seen = new Set<string>();
  const unknown = writtenNames().filter((n) => {
    const key = n.toLowerCase();
    if (known.includes(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unknown.length === 0) return;
  logger.warn(
    `[jobs] JOBS_PAUSED names no such job: ${unknown.join(', ')}. Nothing was paused for them. Jobs: ${JOB_NAMES.join(', ')}; or all.`,
  );
}
