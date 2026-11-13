/* =============================================================================
   #3471, source guard: every way a starting summary is started, and every way its trigger is written or cleared. A new
   caller fails here until someone decides, on purpose, that it belongs.

   The ways in, from a sweep of the source:
   - A summary is started (runStartingSummary) from exactly two places: the check's summary step (summaryStart.ts, behind a
     lease per company, never inside the check itself) and the sweep's trigger branch, which runs ONLY while the check is off
     (`!tickOn`): with the check on the sweep never acts on a trigger.
   - The check starts summaries only through startReadySummaries, called once from tick.ts check(), and only for a trigger
     that is ready (summaryTriggerReady); the ready rule's two limits (30 s of quiet, 2 minutes at most) live in
     summaryStart.ts alone, and the sweep's own (2 and 10 minutes, the check off) in sweep.ts alone.
   - The trigger columns are written by: Activate and the settings Save (spider.controller.ts), the picker's Save (the
     exclusions controller), the check's clearSpentTrigger (summaryStart.ts) and the sweep's own clear (the check off).
     The settings Save's write is conditional on the trigger it read (#3444 item 1).
   - The sweep's interval is decided in one place (spiderSweepIntervalMs, by the check's own switch) and index.ts schedules
     by it; its lease follows it.
   - The flood guard: the sweep counts the check's alerts (floodGuardRoom) before it takes its share.
   - A summary's stays are read from the watch list (readSummaryStays), not by reading every open lead again.
   The behaviour itself is proven against a real database in spider-summary-at-once-db.test.ts.
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
const callRe = (fn: string) => new RegExp(`(?<!function\\s)\\b${fn}\\s*\\(`, 'g');
const callersOf = (fn: string) => ALL.filter((f) => (code(f).match(callRe(fn)) ?? []).length > 0).map(rel).sort();
const filesMatching = (re: RegExp) => ALL.filter((f) => re.test(code(f))).map(rel).sort();

const SWEEP = join(SPIDER, 'sweep.ts');
const TICK = join(SPIDER, 'tick.ts');
const START = join(SPIDER, 'summaryStart.ts');

/** The body of a top-level function. */
function bodyOf(fn: string, file: string): string {
  const src = code(file);
  const start = src.search(new RegExp(`(async\\s+)?function\\s+${fn}\\b`));
  expect(start, `${fn} in ${rel(file)}`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${fn}`);
}

describe('a starting summary: who starts it, when, and who writes its trigger (source guard)', () => {
  it('runStartingSummary is called from the check\'s summary step and from the sweep\'s trigger branch, nowhere else', () => {
    expect(callersOf('runStartingSummary')).toEqual(['src/services/spider/summaryStart.ts', 'src/services/spider/sweep.ts']);
    expect(code(SWEEP).match(callRe('runStartingSummary'))).toHaveLength(1);
    expect(code(START).match(callRe('runStartingSummary'))).toHaveLength(1);
  });

  it('the sweep acts on a trigger only while the check is off: with the check on there is no summary and no waiting', () => {
    const company = bodyOf('sweepCompany', SWEEP);
    const call = company.indexOf('runStartingSummary(');
    expect(call).toBeGreaterThan(0);
    // The branch that calls it, and the lease check before it, are both `!tickOn &&` branches; so is the quiet wait.
    expect(company.lastIndexOf('if (!tickOn && trigger) {', call)).toBeGreaterThan(0);
    expect(company).toMatch(/if \(!tickOn && trigger && !stillHeld\(\)\)/);
    expect(company).toMatch(/if \(!tickOn && trigger && now\.getTime\(\) - trigger\.getTime\(\) < SWEEP_SUMMARY_QUIET_MS/);
    // With the check on, only the stays after the trigger's moment are alerted on its own, and the flood guard is shared.
    expect(company).toMatch(/const tickTrigger = tickOn \? trigger : null/);
    expect(company).toMatch(/entered_at\.getTime\(\) \+ limitMs\(o\.limit\.value, o\.limit\.unit\) > tickTrigger\.getTime\(\)/);
    expect(company).toMatch(/floodGuardRoom\(orgId, now\)/);
    expect(bodyOf('floodGuardRoom', SWEEP)).toMatch(/kind: 'ALERTED'/);
    // The sweep safety line: tickOn is read once for the run from the check's own switch.
    expect(bodyOf('sweepAllCompanies', SWEEP)).toMatch(/const tickOn = spiderTickEnabled\(\)/);
    expect(bodyOf('sweepAllCompanies', SWEEP)).toMatch(/safetyCaught/);
  });

  it('the check starts summaries through startReadySummaries, once, and only for a ready trigger, one task per company, under a lease', () => {
    expect(callersOf('startReadySummaries')).toEqual(['src/services/spider/tick.ts']);
    expect(code(TICK).match(callRe('startReadySummaries'))).toHaveLength(1);
    expect(code(TICK)).toMatch(/startReadySummaries\(companies, now\)/);
    // (Its return type has braces of its own, so the whole file's code is read: each is named once, in this function.)
    const start = code(START);
    expect(start).toMatch(/building\.has\(c\.orgId\) \|\| !summaryTriggerReady\(/);
    expect(start).toMatch(/\(holdUntil\.get\(c\.orgId\) \?\? 0\) > now\.getTime\(\)/);
    expect(start.match(callRe('summariseCompany'))).toHaveLength(1);
    const build = bodyOf('buildSummary', START);
    expect(build.indexOf('claimSweepLease(undefined, summaryLeaseName(orgId))')).toBeGreaterThanOrEqual(0);
    expect(build.indexOf('claimSweepLease(')).toBeLessThan(build.indexOf('runStartingSummary('));
    expect(build.indexOf('readSummaryStays(')).toBeLessThan(build.indexOf('runStartingSummary('));
    // A run that is waiting for its next try is not asked again before then, and the trigger stays.
    expect(build).toMatch(/r\.state === 'waiting' \|\| r\.state === 'retry'/);
    expect(build).toMatch(/holdUntil\.set\(orgId, \(r\.retryAt \?\?/);
  });

  it('the ready rule\'s limits are declared once each: the check\'s (30 s, 2 min) in summaryStart.ts, the sweep\'s (2, 10 min) in sweep.ts', () => {
    const declared = (name: string) => filesMatching(new RegExp(`\\b(const|let|var)\\s+${name}\\b`));
    expect(declared('SUMMARY_QUIET_MS')).toEqual(['src/services/spider/summaryStart.ts']);
    expect(declared('SUMMARY_MAX_WAIT_MS')).toEqual(['src/services/spider/summaryStart.ts']);
    expect(declared('SWEEP_SUMMARY_QUIET_MS')).toEqual(['src/services/spider/sweep.ts']);
    expect(declared('SWEEP_SUMMARY_MAX_WAIT_MS')).toEqual(['src/services/spider/sweep.ts']);
    expect(code(START)).toMatch(/SUMMARY_QUIET_MS = 30_000/);
    expect(code(START)).toMatch(/SUMMARY_MAX_WAIT_MS = 2 \* 60_000/);
    // The sweep never uses the check's, nor the check the sweep's.
    expect(code(SWEEP)).not.toMatch(/\bSUMMARY_(QUIET|MAX_WAIT)_MS\b/);
    expect(code(START)).not.toMatch(/SWEEP_SUMMARY/);
  });

  it('a summary reads its stays from the watch list, never every open lead again', () => {
    const read = bodyOf('readSummaryStays', START);
    expect(read).toMatch(/FROM lim l\s+JOIN spider_lead_watch w/);
    expect(read).toMatch(/AT TIME ZONE 'UTC'/);
    expect(code(START)).not.toMatch(/\.lead\.(findMany|findFirst|count)\(|watchedVisits|allOpenLeads|currentStageVisits/);
    // The check's summary step does not reach the sweep's open-lead reads.
    expect(code(START)).not.toMatch(/from '\.\/sweep'/);
  });

  it('the trigger columns are written only by the switch and the Save (spider.controller), the picker, the check\'s and the sweep\'s clears', () => {
    // (The picker names the column in the type of the row it locks; it writes it through triggerData, below.)
    expect(filesMatching(/summary_trigger_at\s*:(?!\s*true\b)/)).toEqual([
      'src/controllers/spider-picker.controller.ts',
      'src/controllers/spider.controller.ts',
      'src/services/spider/summaryStart.ts',
      'src/services/spider/sweep.ts',
    ]);
    // The picker writes it through the shared merge (triggerData), inside its locked transaction.
    expect(code(join(SRC, 'controllers', 'spider-picker.controller.ts'))).toMatch(/\.\.\.\(trigger \? triggerData\(row!, trigger, new Date\(\)\) : \{\}\)/);
  });

  it('the settings Save writes its trigger only if the trigger it read is still there, and merges again from the newer one', () => {
    const save = code(join(SRC, 'controllers', 'spider.controller.ts'));
    const update = save.slice(save.indexOf('export async function updateSpiderSettings'));
    expect(update).toMatch(/summary_trigger_at: existing\.summary_trigger_at,\s*summary_trigger_kind: existing\.summary_trigger_kind,\s*summary_trigger_since: existing\.summary_trigger_since,/);
    expect(update).toMatch(/for \(let tries = 0; tries < SAVE_TRIGGER_TRIES; tries \+= 1\)/);
    // One merge: the same function the picker uses.
    expect(update).toMatch(/triggerData\(existing, trigger, new Date\(\)\)/);
  });

  it('the sweep\'s interval comes from one function, the cron and the lease follow it, and the include path still re-arms (#3469)', () => {
    const index = code(join(SRC, 'index.ts'));
    expect(index).toMatch(/scheduleJob\('spider', spiderSweepCron\(\)/);
    expect(bodyOf('withSweepLease', SWEEP)).toMatch(/claimSweepLease\(spiderSweepIntervalMs\(\)\)/);
    expect(callersOf('spiderSweepIntervalMs')).toEqual(['src/services/spider/sweep.ts']);
    expect(code(join(SRC, 'controllers', 'spider-picker.controller.ts'))).toMatch(/rearmIncludedLeads\(orgId, leadIds\)/);
  });

  it('closes what nothing resumes: the sweep reaps orphaned runs before its companies (both modes)', () => {
    const all = bodyOf('sweepAllCompanies', SWEEP);
    expect(all.indexOf('reapOrphanedRuns(now)')).toBeGreaterThan(0);
    expect(all.indexOf('reapOrphanedRuns(now)')).toBeLessThan(all.indexOf('sweepCompany('));
    expect(callersOf('reapOrphanedRuns')).toEqual(['src/services/spider/sweep.ts']);
  });
});
