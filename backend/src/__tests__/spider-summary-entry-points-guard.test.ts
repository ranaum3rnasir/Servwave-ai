/* =============================================================================
   #3108, source guard: the entry points to a starting summary. A new reader or writer of a summary or its claims fails here
   until someone decides, on purpose, that it belongs (and reads READY summaries only, or goes through the run).

   Only WHO touches these is pinned, never how: the behaviour (a half-written summary invisible, one delivery, claims in
   pieces that resume) is proven at the agreed seams over a real database in spider-summary-resume-db.test.ts,
   spider-summary-stop-points-db.test.ts, spider-summary-give-up-db.test.ts and spider-summary-supersede-db.test.ts.

   - the summary row (spider_summaries) is written only by summaryRuns.ts (status, delivery mark and record) and by the email
     provider's delivery events (emailEvents.ts, which only corrects a recorded email outcome); it is never deleted;
   - the run row (spider_summary_runs) is written only by summaryRuns.ts;
   - a person reads a summary only through readSpiderSummary (the Spider page's card and a person's page);
   - alert-log rows are read for a person's screen only by the History endpoints, and removed only by releaseClaims
     (per-lead claims never acted on) and releaseSummaryClaims (the claims of a summary that was given up on);
   - the summary and its run use no interactive transaction.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const BACKEND = join(__dirname, '..', '..');
const SRC = join(BACKEND, 'src');
const SPIDER = join(SRC, 'services', 'spider');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The source with comments blanked out, so prose that names a function is never counted as a call. */
const code = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const rel = (path: string) => relative(BACKEND, path).split('\\').join('/');
const ALL = sourceFiles(SRC);

/** The files whose code matches `re`, sorted. */
const filesMatching = (re: RegExp): string[] => ALL.filter((f) => re.test(code(f))).map(rel).sort();

describe('a starting summary: who reads it and who writes it and its claims (source guard)', () => {
  it('the summary row is written only by summaryRuns.ts and emailEvents.ts, and never deleted', () => {
    expect(filesMatching(/\.spiderSummary\.(create|createMany|update|updateMany|upsert)\(|UPDATE\s+spider_summaries/i)).toEqual([
      'src/services/spider/emailEvents.ts',
      'src/services/spider/summaryRuns.ts',
    ]);
    expect(filesMatching(/\.spiderSummary\.(delete|deleteMany)\(|(DELETE\s+FROM|TRUNCATE)\s+"?(public"\."?)?spider_summaries/i)).toEqual([]);
  });

  it('the run row is written only by summaryRuns.ts', () => {
    expect(filesMatching(/\.spiderSummaryRun\./)).toEqual(['src/services/spider/summaryRuns.ts']);
  });

  it('a person reads a summary only through readSpiderSummary', () => {
    expect(filesMatching(/\.spiderSummary\.(findFirst|findUnique|findMany|count|aggregate|groupBy)\(/).filter((f) => f.includes('/controllers/'))).toEqual([]);
    expect(filesMatching(/\breadSpiderSummary\(/)).toEqual(['src/controllers/spider.controller.ts', 'src/services/spider/summary.ts']);
  });

  it("alert-log rows are read for a person's screen only by History, and removed only by the two releases", () => {
    expect(filesMatching(/\.spiderAlert\.(findMany|count|aggregate|groupBy)\(/)).toEqual([
      'src/controllers/spider.controller.ts',
      'src/lib/comm-usage.ts',
      'src/services/spider/emailEvents.ts',
      'src/services/spider/summary.ts',
      'src/services/spider/sweep.ts',
    ]);
    expect(filesMatching(/\.spiderAlert\.(delete|deleteMany)\(/)).toEqual(['src/services/spider/alertLog.ts']);
    expect(filesMatching(/DELETE\s+FROM\s+spider_alerts/i)).toEqual(['src/services/spider/summaryRuns.ts']);
  });

  it("claims are written only by the summary's writer and by claimVisits", () => {
    expect(filesMatching(/\.spiderAlert\.(create|createMany|createManyAndReturn|upsert)\(/)).toEqual([
      'src/services/spider/alertLog.ts',
      'src/services/spider/summary.ts',
    ]);
    expect(filesMatching(/INSERT\s+INTO\s+"?(public"\."?)?spider_alerts/i)).toEqual([]);
  });

  it('the summary and its run use no interactive transaction', () => {
    for (const f of ['summary.ts', 'summaryRuns.ts']) expect(code(join(SPIDER, f)), f).not.toMatch(/\$transaction\s*\(/);
  });
});
