/* =============================================================================
   Source guard (#3105, Spider phase 1): every background job in index.ts runs on the jobs' own database lines.

   A job reaches the jobs client only when it is started through `scheduleJob` or `runJobAtBoot` (lib/scheduleJob.ts, which
   run it inside `runOnJobsClient`, lib/prismaJobs.ts). A job added later with a bare `cron.schedule`, or run bare at boot,
   would quietly share the users' lines again; this test reads the source and fails for it. The table is every job the server
   starts today: a job that is not listed here fails the test too, so a new job has to be added here on purpose.

   The same door is where JOBS_PAUSED is checked (#3109), so the table also holds each job's name for it: every job is started
   under its own name, and the names are exactly the list in lib/jobsPaused.ts.

   The behaviour (a scheduled job really lands on the jobs' lines) is proven in jobs-database-lines-db.test.ts.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JOB_NAMES } from '../lib/jobsPaused';

const SRC = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf8');

/** The source without comments, so a word in a comment can neither satisfy nor trip the checks. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

/** Top-level statements of index.ts: a new one starts on every line that does not begin with whitespace, `}` or `)`. */
const statements = code('index.ts').split(/\n(?=[^\s})])/);

const JOBS: { job: string; name: string; entry: string; expression?: string }[] = [
  { job: 'invoice due checks', name: 'invoice-due', entry: 'runInvoiceDueChecks', expression: '0 6 * * *' },
  { job: 'Automation Center poller', name: 'automations', entry: 'runAutomationTick', expression: '* * * * *' },
  { job: 'Spider sweep', name: 'spider', entry: 'runSpiderSweep', expression: '*/2 * * * *' },
  { job: 'received-attachments sweep', name: 'attachments', entry: 'sweepReceivedAttachments', expression: '*/10 * * * *' },
  { job: 'Stripe fee sweep', name: 'stripe-fees', entry: 'sweepUncapturedFees', expression: '0 7 * * *' },
  { job: 'Stripe fee sweep at boot', name: 'stripe-fees', entry: 'sweepUncapturedFees' },
  { job: 'nightly payment reconcile', name: 'payment-reconcile', entry: 'runNightlyReconcile', expression: '7 8 * * *' },
  { job: 'account status refresh', name: 'account-status', entry: 'refreshAllAccountStatuses', expression: '30 7 * * *' },
];

describe('every background job runs on the jobs client', () => {
  it.each(JOBS)('$job ($entry) is started under the name "$name", through scheduleJob or runJobAtBoot', ({ name, entry, expression }) => {
    const started = statements.filter((s) => new RegExp(`\\b${entry}\\(`).test(s));
    const own = expression
      ? started.filter((s) => s.startsWith(`scheduleJob('${name}', '${expression}'`))
      : started.filter((s) => s.startsWith(`void runJobAtBoot('${name}'`));
    expect(own).toHaveLength(1);
  });

  it('index.ts starts no job that is not in the table', () => {
    const scheduled = [...code('index.ts').matchAll(/\bscheduleJob\('[^']+', '([^']+)'/g)].map((m) => m[1]).sort();
    const listed = JOBS.flatMap((j) => (j.expression ? [j.expression] : [])).sort();
    expect(scheduled).toEqual(listed);
    // The only bare run at boot is the listed one.
    const bareRuns = statements.filter((s) => /^void\b/.test(s));
    expect(bareRuns).toHaveLength(1);
  });

  it('index.ts never starts a job on the scheduler directly', () => {
    const index = code('index.ts');
    expect(index).not.toMatch(/node-cron/);
    expect(index).not.toMatch(/\bcron\.schedule\(/);
  });

  it('no module but lib/scheduleJob.ts reaches the scheduler, however it imports it', () => {
    // `import cron from`, `import { schedule } from`, `import * as`, `require(...)` and `import(...)` all name the package.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(rel);
        } else if (/\.ts$/.test(entry.name) && rel !== path.join('lib', 'scheduleJob.ts') && /['"]node-cron['"]/.test(code(rel))) {
          offenders.push(rel);
        }
      }
    };
    walk('.');
    expect(offenders).toEqual([]);
  });

  it('the names the jobs are started under are exactly the names JOBS_PAUSED accepts; only the fee sweep is started twice (cron and boot), under one name', () => {
    const used = [...code('index.ts').matchAll(/\b(?:scheduleJob|runJobAtBoot)\('([^']+)'/g)].map((m) => m[1]!).sort();
    expect([...new Set(used)]).toEqual([...JOB_NAMES].sort());
    expect(used.filter((name) => used.indexOf(name) !== used.lastIndexOf(name))).toEqual(['stripe-fees', 'stripe-fees']);
  });

  it('index.ts warns about unknown names in JOBS_PAUSED once, at the top level, before it starts the first job', () => {
    const warns = statements.filter((s) => /^warnUnknownPausedJobs\(\);/.test(s));
    expect(warns).toHaveLength(1);
    expect(statements.indexOf(warns[0]!)).toBeLessThan(statements.findIndex((s) => /^scheduleJob\(/.test(s)));
  });

  it('importing lib/prisma reaches neither the app configuration nor the pause list, so a script that imports it needs only DATABASE_URL', () => {
    // Follow every relative import of lib/prisma.ts, however deep.
    const reached = new Set<string>();
    const visit = (file: string) => {
      if (reached.has(file)) return;
      reached.add(file);
      for (const m of code(file).matchAll(/\bfrom\s+'(\.{1,2}\/[^']+)'/g)) {
        const target = path.join(path.dirname(file), m[1]!).replace(/\.js$/, '');
        for (const candidate of [`${target}.ts`, path.join(target, 'index.ts')]) {
          if (fs.existsSync(path.join(SRC, candidate))) visit(candidate);
        }
      }
    };
    visit(path.join('lib', 'prisma.ts'));
    expect([...reached].filter((f) => /config[\\/]env\.ts$|jobsPaused\.ts$|scheduleJob\.ts$/.test(f))).toEqual([]);
    // The walk really followed imports (the jobs client is among what lib/prisma reaches).
    expect(reached.has(path.join('lib', 'prismaJobs.ts'))).toBe(true);
  });
});
