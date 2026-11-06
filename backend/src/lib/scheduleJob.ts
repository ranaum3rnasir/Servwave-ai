import cron from 'node-cron';
import { runOnJobsClient } from './prismaJobs';
import { skipRunIfPaused, type JobName } from './jobsPaused';

/**
 * Schedule a background job. Every job in index.ts goes through here instead of `cron.schedule`, so that each run happens
 * inside `runOnJobsClient` and reaches the database on the jobs' own two lines (lib/prismaJobs.ts), never the users'.
 *
 * `name` is the job's name for JOBS_PAUSED (lib/jobsPaused.ts): when it is paused the run is skipped here, before the job
 * (and so the database) is reached, and one line is logged for the run.
 */
export function scheduleJob(name: JobName, expression: string, task: () => unknown, options?: Parameters<typeof cron.schedule>[2]) {
  return cron.schedule(
    expression,
    () => {
      if (skipRunIfPaused(name)) return;
      return runOnJobsClient(task) as void | Promise<void>;
    },
    options,
  );
}

/**
 * Run a job once, now, on the jobs' lines: the run at boot. Resolves to what the job returns, or to undefined when the job is
 * paused (JOBS_PAUSED), in which case it was not started and one line was logged.
 */
export function runJobAtBoot<T>(name: JobName, task: () => Promise<T>): Promise<T | undefined> {
  if (skipRunIfPaused(name)) return Promise.resolve(undefined);
  return runOnJobsClient(task);
}
