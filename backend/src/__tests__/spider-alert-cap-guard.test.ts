/* =============================================================================
   #2991, source guard: every way to a per-lead Spider alert goes through the run's cap.

   The ways in, from a sweep of the source (claims, sends and the end step of a per-lead alert):
   - claimVisits (alertLog.ts), the only writer of per-lead claims, is called once, in sweep.ts alertLeads, on the
     alerts planned from pickThisRun's share (at most SPIDER_ALERTS_PER_COMPANY_RUN);
   - planAlerts is called only there, with that share;
   - sendAlert, the only caller of deliverSpiderEmails and deliverSpiderTexts (the per-lead email and text), is called
     once, in alertLeads' loop, after the lease/stop check and the company's time check;
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

/** The body of a top-level function in sweep.ts. */
function bodyOf(fn: string): string {
  const src = code(SWEEP);
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
    expect(alerts).toMatch(/const \{ chosen, capped \} = pickThisRun\(a\.visits\)/);
    expect(alerts).toMatch(/const planned = await planAlerts\(a\.orgId, a\.now, chosen, a\.channels\)/);
    // The claims are written once, from the capped share (the call above is the only caller of claimVisits).
    expect(alerts).toMatch(/\bclaimVisits\(/);
    // pickThisRun's own body (its return type is an object, so bodyOf's first brace would be the wrong one).
    const pick = code(SWEEP).match(/function pickThisRun\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(pick).toMatch(/\.slice\(0, SPIDER_ALERTS_PER_COMPANY_RUN\)/);
  });

  it('each per-lead send comes after the lease/stop check and the time check', () => {
    expect(callersOf('deliverSpiderEmails')).toEqual(['src/services/spider/sweep.ts']);
    expect(callersOf('deliverSpiderTexts')).toEqual(['src/services/spider/sweep.ts']);
    for (const fn of ['deliverSpiderEmails', 'deliverSpiderTexts']) {
      expect(code(SWEEP).match(callRe(fn)), fn).toHaveLength(1);
      expect(bodyOf('sendAlert'), fn).toMatch(callRe(fn));
    }
    expect(code(SWEEP).match(callRe('sendAlert'))).toHaveLength(1);
    const alerts = bodyOf('alertLeads');
    const send = alerts.indexOf('sendAlert(');
    const loop = alerts.indexOf('for (const [i, p] of mine.entries())');
    expect(loop).toBeGreaterThan(0);
    expect(alerts.indexOf('a.stillHeld()', loop)).toBeLessThan(send);
    expect(alerts.indexOf('a.timeUp()', loop)).toBeGreaterThan(loop);
    expect(alerts.indexOf('a.timeUp()', loop)).toBeLessThan(send);
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
