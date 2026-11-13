/* =============================================================================
   #2991, source guard: every way to a per-lead Spider alert goes through the run's cap.

   The ways in, from a sweep of the source (claims, sends and the end step of a per-lead alert):
   - claimVisits (alertLog.ts), the only writer of per-lead claims, is called once, in sweep.ts alertLeads, on the
     alerts planned from pickThisRun's share (at most SPIDER_ALERTS_PER_COMPANY_RUN);
   - planAlerts is called only there, with that share;
   - sendAlertMessages, the only caller of deliverSpiderEmails and deliverSpiderTexts (the per-lead email and text), is
     called from two places: the sweep's sendAlert, called once, in alertLeads' loop, after the lease/stop check and the
     company's time check; and the check's deliverAlert (tick.ts, #3469), from sendBatch after its stop-budget check,
     and from queueInterrupted only to record an alert interrupted;
   - claimWatchedStays (alertLog.ts), the check's claim, is called once, in tick.ts claimAndShow, on the stays the due
     statement handed over: at most SPIDER_ALERTS_PER_COMPANY_RUN per company in any FLOOD_WINDOW_MS (counted in the
     statement itself, sweep and check alerts alike), then pickThisRun's share of them;
   - the starting summary (summary.ts) writes its own claims and is never capped (Ran, 3 Nov): it never reads the caps.
   The limits are constants in one file (runCaps.ts), not company settings. The behaviour is proven against a real
   database in spider-alert-cap-db.test.ts.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const BACKEND = join(__dirname, '..', '..');
const SRC = join(BACKEND, 'src');
const SPIDER = join(SRC, 'services', 'spider');
const SWEEP = join(SPIDER, 'sweep.ts');
const TICK = join(SPIDER, 'tick.ts');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The source with comments blanked out, so prose that names a function is never counted as a call. */
const code = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const callRe = (fn: string) => new RegExp(`(?<!function\\s)\\b${fn}\\s*\\(`, 'g');

/** Files (relative to backend/) whose code calls `fn(`, leaving out its own declaration. */
function callersOf(fn: string): string[] {
  return sourceFiles(SRC).filter((f) => (code(f).match(callRe(fn)) ?? []).length > 0).map((f) => relative(BACKEND, f));
}

/** The body of a top-level function in sweep.ts (or another file). */
function bodyOf(fn: string, file: string = SWEEP): string {
  const src = code(file);
  const start = src.search(new RegExp(`(async\\s+)?function\\s+${fn}\\b`));
  expect(start, `${fn} in sweep.ts`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced ${fn}`);
}

describe('Spider per-lead alerts: every way in goes through the run cap (source guard)', () => {
  it('per-lead claims are written only by alertLeads, from the capped share', () => {
    expect(callersOf('claimVisits')).toEqual(['src/services/spider/sweep.ts']);
    expect(code(SWEEP).match(callRe('claimVisits'))).toHaveLength(1);
    expect(code(SWEEP).match(callRe('planAlerts'))).toHaveLength(1);
    expect(code(SWEEP).match(callRe('pickThisRun'))).toHaveLength(1);
    const alerts = bodyOf('alertLeads');
    // The share is the company's 100 less what the check raised in the flood window (#3471): the caller's `cap`, never more
    // than SPIDER_ALERTS_PER_COMPANY_RUN (sweepCompany computes it from that constant, or floodGuardRoom does).
    expect(alerts).toMatch(/const \{ chosen, capped \} = pickThisRun\(a\.visits, a\.cap\)/);
    expect(alerts).toMatch(/const planned = await planAlerts\(a\.orgId, a\.now, chosen, a\.channels\)/);
    // The claims are written once, from the capped share (the call above is the only caller of claimVisits).
    expect(alerts).toMatch(/\bclaimVisits\(/);
    // pickThisRun's own body (its return type is an object, so bodyOf's first brace would be the wrong one).
    const pick = code(SWEEP).match(/function pickThisRun\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(pick).toMatch(/limit: number = SPIDER_ALERTS_PER_COMPANY_RUN/);
    expect(pick).toMatch(/\.slice\(0, limit\)/);
    // Both callers' shares come from that constant: the sweep's cap is it, or it less the flood window's count; the check's is it.
    expect(bodyOf('floodGuardRoom')).toMatch(/Math\.max\(0, SPIDER_ALERTS_PER_COMPANY_RUN - recent\)/);
    expect(code(SWEEP)).toMatch(/const cap = tickOn && perLead\.length > 0 \? await floodGuardRoom\(orgId, now\) : SPIDER_ALERTS_PER_COMPANY_RUN/);
  });

  it('each per-lead send comes after the lease/stop check and the time check', () => {
    expect(callersOf('deliverSpiderEmails')).toEqual(['src/services/spider/sweep.ts']);
    expect(callersOf('deliverSpiderTexts')).toEqual(['src/services/spider/sweep.ts']);
    for (const fn of ['deliverSpiderEmails', 'deliverSpiderTexts']) {
      expect(code(SWEEP).match(callRe(fn)), fn).toHaveLength(1);
      expect(bodyOf('sendAlertMessages'), fn).toMatch(callRe(fn));
    }
    // sendAlertMessages: once from the sweep's sendAlert, once from the check's sendBatch (#3469).
    expect(callersOf('sendAlertMessages').sort()).toEqual(['src/services/spider/sweep.ts', 'src/services/spider/tick.ts']);
    expect(code(SWEEP).match(callRe('sendAlertMessages'))).toHaveLength(1);
    expect(bodyOf('sendAlert')).toMatch(callRe('sendAlertMessages'));
    expect(code(TICK).match(callRe('sendAlertMessages'))).toHaveLength(1);
    expect(code(SWEEP).match(callRe('sendAlert'))).toHaveLength(1);
    const alerts = bodyOf('alertLeads');
    const send = alerts.indexOf('sendAlert(');
    const loop = alerts.indexOf('for (const [i, p] of mine.entries())');
    expect(loop).toBeGreaterThan(0);
    expect(alerts.indexOf('a.stillHeld()', loop)).toBeLessThan(send);
    expect(alerts.indexOf('a.timeUp()', loop)).toBeGreaterThan(loop);
    expect(alerts.indexOf('a.timeUp()', loop)).toBeLessThan(send);
  });

  it("the check (#3469) claims only the due statement's capped share, and sends after its stop check", () => {
    expect(callersOf('claimWatchedStays')).toEqual(['src/services/spider/tick.ts']);
    expect(code(TICK).match(callRe('claimWatchedStays'))).toHaveLength(1);
    const claim = bodyOf('claimAndShow', TICK);
    expect(claim).toMatch(/\bclaimWatchedStays\(/);
    // The share: pickThisRun (people to tell, oldest overdue first), then the plans, then the claim.
    expect(claim.indexOf('pickThisRun(')).toBeGreaterThan(0);
    expect(claim.indexOf('pickThisRun(')).toBeLessThan(claim.indexOf('buildAlertPlans('));
    expect(claim.indexOf('buildAlertPlans(')).toBeLessThan(claim.indexOf('claimWatchedStays('));
    // claimAndShow is reached only from the check, with the stays findDueStays handed over.
    expect(code(TICK).match(callRe('claimAndShow'))).toHaveLength(1);
    expect(code(TICK).match(callRe('findDueStays'))).toHaveLength(1);
    // The due statement caps each company by the shared constant, over a window, counting every per-lead alert.
    const due = bodyOf('findDueStays', TICK);
    expect(due).toMatch(/r\.rank <= \$\{SPIDER_ALERTS_PER_COMPANY_RUN\} - COALESCE\(s\.n, 0\)/);
    expect(due).toMatch(/a\.kind = 'ALERTED'[\s\S]*\$\{FLOOD_WINDOW_MS\}/);
    // The check's one call of sendAlertMessages is deliverAlert. Each send comes after the check's stop-budget check
    // (stopping, an alert is sent while the stop's bounded wait has room for it; the rest are recorded interrupted, never
    // sent later); the only other caller records an alert interrupted.
    expect(bodyOf('deliverAlert', TICK)).toMatch(callRe('sendAlertMessages'));
    expect(callersOf('deliverAlert')).toEqual(['src/services/spider/tick.ts']);
    expect(code(TICK).match(callRe('deliverAlert'))).toHaveLength(2);
    const send = bodyOf('sendBatch', TICK);
    const budget = send.indexOf('if (stopRequested() && stopTimeLeftMs() <= SEND_STOP_MARGIN_MS)');
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(send.indexOf('deliverAlert('));
    expect(send).toMatch(/deliverAlert\(batch, p, company, \{ writes, outcome: p\.outcome, interrupted: false, sendProgress: progress \}\)/);
    expect(bodyOf('queueInterrupted', TICK)).toMatch(
      /deliverAlert\(batch, p, company, \{ writes, outcome: structuredClone\(p\.outcome\), interrupted: true, sendProgress: progress \}\)/,
    );
  });

  it('the limits are constants in runCaps.ts only, and the starting summary never reads them', () => {
    for (const name of ['SPIDER_ALERTS_PER_COMPANY_RUN', 'SPIDER_COMPANY_RUN_MS']) {
      const declared = sourceFiles(SRC).filter((f) => new RegExp(`\\b(const|let|var)\\s+${name}\\b`).test(code(f)));
      expect(declared.map((f) => relative(BACKEND, f)), name).toEqual(['src/services/spider/runCaps.ts']);
      expect(code(join(SPIDER, 'summary.ts')), name).not.toMatch(new RegExp(`\\b${name}\\b`));
      // Not a company setting: the settings reader never mentions it.
      expect(code(join(SPIDER, 'config.ts')), name).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(code(join(SPIDER, 'summary.ts'))).not.toMatch(/runCaps|timeUp/);
  });
});
