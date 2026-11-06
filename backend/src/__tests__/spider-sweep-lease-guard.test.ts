/* =============================================================================
   Spider sweep lease (#2993), source guard: every way into the sweep's work goes through the lease, and the sweep
   runs on the app's shared client.

   The ways in, from a sweep of the source: the 2-minute timer in index.ts calls runSpiderSweep, which is the only
   function that reaches sweepAllCompanies, and it reaches it only through withSweepLease. Each company's work
   (sweepCompany, which raises the per-lead alerts and the starting summary) is reached only from sweepAllCompanies.
   This file fails when a new caller appears outside that path, when anything under services/spider opens a client of
   its own again, or when a transaction-held advisory lock comes back. The behaviour itself is proven against a real
   database in spider-sweep-lease-db.test.ts.
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

/** Files (relative to backend/) whose code calls `fn(`, leaving out its own declaration. */
function callersOf(fn: string): string[] {
  const call = new RegExp(`(?<!function\\s)\\b${fn}\\s*\\(`, 'g');
  return sourceFiles(SRC).filter((f) => (code(f).match(call) ?? []).length > 0).map((f) => relative(BACKEND, f));
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

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe('Spider sweep lease: every way in goes through the lease (source guard)', () => {
  it('the sweep is started only by the timer in index.ts', () => {
    expect(callersOf('runSpiderSweep')).toEqual(['src/index.ts']);
  });

  it('runSpiderSweep reaches the work only through the lease, and the work is reached from nowhere else', () => {
    expect(callersOf('sweepAllCompanies')).toEqual(['src/services/spider/sweep.ts']);
    expect(callersOf('sweepCompany')).toEqual(['src/services/spider/sweep.ts']);
    expect(callersOf('withSweepLease')).toEqual(['src/services/spider/sweep.ts']);

    const sweep = code(SWEEP);
    // One call each (declarations are not calls): runSpiderSweep -> withSweepLease -> sweepAllCompanies -> sweepCompany.
    expect(count(sweep, /(?<!function\s)\bwithSweepLease\s*\(/g)).toBe(1);
    expect(count(sweep, /(?<!function\s)\bsweepAllCompanies\s*\(/g)).toBe(1);
    expect(count(sweep, /(?<!function\s)\bsweepCompany\s*\(/g)).toBe(1);
    expect(bodyOf('runSpiderSweep')).toMatch(/\bwithSweepLease\s*\(/);
    expect(bodyOf('withSweepLease')).toMatch(/\bclaimSweepLease\s*\(/);
    expect(bodyOf('withSweepLease')).toMatch(/\bsweepAllCompanies\s*\(/);
    expect(bodyOf('sweepAllCompanies')).toMatch(/\bsweepCompany\s*\(/);
  });

  it('the run checks it still holds the lease before each company, each per-lead alert and the starting summary', () => {
    const all = bodyOf('sweepAllCompanies');
    expect(all.indexOf('stillHeld()')).toBeGreaterThanOrEqual(0);
    expect(all.indexOf('stillHeld()')).toBeLessThan(all.indexOf('sweepCompany('));

    const company = bodyOf('sweepCompany');
    const summary = company.indexOf('runStartingSummary(');
    const perLead = company.indexOf('alertLeads(');
    expect(summary).toBeGreaterThan(0);
    expect(perLead).toBeGreaterThan(summary);
    expect(company.lastIndexOf('stillHeld()', summary)).toBeGreaterThanOrEqual(0);
    // The per-lead alerts (#2990: claimed in one insert, then sent one by one) get the check itself.
    expect(company.indexOf('stillHeld', perLead)).toBeGreaterThan(perLead);
    const alerts = bodyOf('alertLeads');
    const claim = alerts.indexOf('claimVisits(');
    const send = alerts.indexOf('sendAlert(');
    expect(claim).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(claim);
    // Before the claims are written, and inside the loop before each alert is sent.
    expect(alerts.lastIndexOf('stillHeld()', claim)).toBeGreaterThanOrEqual(0);
    expect(alerts.lastIndexOf('stillHeld()', send)).toBeGreaterThan(claim);
  });

  it('nothing in the Spider service opens a database client of its own or holds a transaction-scoped lock', () => {
    const offenders = sourceFiles(SPIDER).flatMap((f) => {
      const src = code(f);
      const found: string[] = [];
      if (/new\s+PrismaClient\b/.test(src)) found.push('new PrismaClient');
      if (/pg_(try_)?advisory(_xact)?_lock/.test(src)) found.push('advisory lock');
      if (/\$transaction\s*\(/.test(src) && f === SWEEP) found.push('$transaction in the sweep');
      return found.map((what) => `${relative(BACKEND, f)}: ${what}`);
    });
    expect(offenders).toEqual([]);
    // The sweep and its lease use the app's one shared client.
    for (const f of [SWEEP, join(SPIDER, 'sweepLease.ts')]) {
      expect(code(f), relative(BACKEND, f)).toMatch(/import\s*\{\s*prisma\s*\}\s*from\s*'\.\.\/\.\.\/lib\/prisma'/);
    }
  });
});
