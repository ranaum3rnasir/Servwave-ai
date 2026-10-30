/* =============================================================================
   Payments go-live, slice 39 - the sandbox verification suite is complete and honest.

   The suite itself talks to the processor's sandbox and a running backend, so it is run by hand
   (`npm run verify:stripe`). What is pinned here is what must not rot between runs: the
   flow list covers every scenario the go-live needs, the fixtures send events in the pinned
   version's payload shape, a run against a shared database never deletes, the report is dated,
   and the old harness traps (a hardcoded port, a dead table) stay gone.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { databaseIsLocal, keepFixtures } from '../verify-stripe/policy';
import { FLOWS, SCENARIOS, flowFilePath, uncoveredScenarios } from '../verify-stripe/flows';
import { acaciaEvent, ACACIA_VERSION } from '../verify-stripe/events';
import { renderReport, reportFileName, suiteVerdict, type FlowResult } from '../verify-stripe/report';

const TESTS_DIR = path.resolve(__dirname, '../verify-stripe/tests');

describe('slice 39: which database a run may delete from', () => {
  it('only a database on this machine is cleaned up after; a shared one is left and listed', () => {
    expect(databaseIsLocal('postgresql://me@localhost:5433/x')).toBe(true);
    expect(databaseIsLocal('postgresql://me@127.0.0.1:5432/x')).toBe(true);
    expect(databaseIsLocal('postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres')).toBe(false);
    expect(databaseIsLocal('not a url')).toBe(false);
    expect(databaseIsLocal(undefined)).toBe(false);
  });

  it('keepFixtures: shared database keeps by default, local deletes by default, and the env can force either', () => {
    const shared = 'postgresql://u:p@db.example.com:5432/x';
    const local = 'postgresql://u@localhost:5433/x';
    expect(keepFixtures({ DATABASE_URL: shared })).toBe(true);
    expect(keepFixtures({ DATABASE_URL: local })).toBe(false);
    expect(keepFixtures({ DATABASE_URL: local, VERIFY_STRIPE_KEEP_FIXTURES: '1' })).toBe(true);
    // Forcing deletion on a shared database is not allowed.
    expect(keepFixtures({ DATABASE_URL: shared, VERIFY_STRIPE_KEEP_FIXTURES: '0' })).toBe(true);
    expect(keepFixtures({})).toBe(true);
  });
});

describe('slice 39: the flow list covers every scenario in the slice', () => {
  // Written out here on purpose: an independent copy of the slice's "What changes" list.
  const REQUIRED = [
    'card-invoice', 'card-deposit', 'card-partial-tip', 'ach-success', 'ach-failure', 'ach-partial-refund',
    'refund-by-id-one-row', 'in-app-refund', 'dispute', 'link-display', 'klarna-absent',
    'idempotency-double-fire', 'signature-mismatch', 'missing-metadata', 'unknown-account-event',
    'connected-account-event', 'hosted-bank-connected', 'hosted-bank-deposit', 'link-hidden-fallback',
    'nightly-reconcile',
  ];

  it('names every required scenario', () => {
    for (const s of REQUIRED) expect(SCENARIOS, s).toContain(s);
  });

  it('every scenario is claimed by at least one flow', () => {
    expect(uncoveredScenarios()).toEqual([]);
  });

  it('every flow id has a file, and every file is a flow', () => {
    const files = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.ts$/, '')).sort();
    expect(FLOWS.map((f) => f.id).sort()).toEqual(files);
    for (const f of FLOWS) expect(flowFilePath(f.id)).toContain(`${f.id}.ts`);
  });

  it('flow ids are unique and the nightly check runs after every payment flow', () => {
    const ids = FLOWS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[ids.length - 1]).toBe('nightly-reconcile');
  });

  it('the two launch-gate flows from the Link/Klarna slice stay in the one-command run', () => {
    const ids = FLOWS.map((f) => f.id);
    expect(ids).toContain('link-klarna-gate');
    expect(ids).toContain('link-hidden-fallback');
  });
});

describe('slice 39: fixtures send events in the pinned (acacia) payload shape', () => {
  it('builds a full event envelope', () => {
    expect(ACACIA_VERSION).toBe('2025-02-24.acacia');
    const e = acaciaEvent('checkout.session.completed', { id: 'cs_1' });
    expect(e).toMatchObject({ object: 'event', api_version: '2025-02-24.acacia', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
    expect(e.id).toMatch(/^evt_qa39_/);
    expect(typeof e.created).toBe('number');
    expect('account' in e).toBe(false);
  });

  it('a connected-account event carries `account`; ids are unique per call; an id can be pinned', () => {
    const a = acaciaEvent('charge.refunded', {}, { account: 'acct_1' });
    const b = acaciaEvent('charge.refunded', {}, { account: 'acct_1' });
    expect(a.account).toBe('acct_1');
    expect(a.id).not.toBe(b.id);
    expect(acaciaEvent('x', {}, { id: 'evt_fixed' }).id).toBe('evt_fixed');
  });
});

describe('slice 39: the dated report', () => {
  const results: FlowResult[] = [
    { id: 'flow-A-deposit-checkout', status: 'pass', assertions: 14, ms: 1200 },
    { id: 'flow-K-in-app-refund', status: 'fail', assertions: 0, ms: 300, error: 'Assertion failed: one Refund row per id' },
    { id: 'flow-O-hosted-bank-connected', status: 'skip', assertions: 0, ms: 0, reason: 'no charging account' },
  ];
  const meta = { startedAt: new Date('2026-10-11T08:30:00Z'), apiUrl: 'https://staging.example', databaseKind: 'shared' as const, fixtures: ['qa-39-org-1'] };

  it('is named for the day it ran', () => {
    expect(reportFileName(new Date('2026-10-11T23:59:00Z'))).toBe('sandbox-suite-report-2026-10-11.md');
  });

  it('lists every flow with its outcome, the failure text, and what was left behind', () => {
    const md = renderReport(results, meta);
    expect(md).toContain('2026-10-11');
    expect(md).toContain('flow-A-deposit-checkout');
    expect(md).toContain('14');
    expect(md).toMatch(/flow-K-in-app-refund[^\n]*FAIL/);
    expect(md).toContain('Assertion failed: one Refund row per id');
    expect(md).toMatch(/flow-O-hosted-bank-connected[^\n]*SKIP/);
    expect(md).toContain('no charging account');
    expect(md).toContain('qa-39-org-1');
    expect(md).toMatch(/NOT GREEN/);
  });

  it('says GREEN only when nothing failed and nothing was skipped', () => {
    expect(renderReport([results[0]], meta)).toMatch(/\bGREEN\b/);
    expect(renderReport([results[0]], meta)).not.toMatch(/NOT GREEN/);
  });

  it('verdict: a failure always fails; a skip fails in strict mode only', () => {
    expect(suiteVerdict([results[0]], { strict: true })).toBe('green');
    expect(suiteVerdict(results, { strict: false })).toBe('red');
    expect(suiteVerdict([results[0], results[2]], { strict: false })).toBe('green');
    expect(suiteVerdict([results[0], results[2]], { strict: true })).toBe('red');
    expect(suiteVerdict([], { strict: false })).toBe('red');
  });
});

describe('slice 39: old harness traps stay gone', () => {
  const sources = readdirSync(TESTS_DIR).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(path.join(TESTS_DIR, f), 'utf8')] as const);

  it('no flow hardcodes the backend port (a worktree runs on its own)', () => {
    for (const [name, src] of sources) expect(src, name).not.toMatch(/localhost:3000/);
  });

  it('no flow reads the deleted deposit table or a metadata key no handler reads', () => {
    for (const [name, src] of sources) {
      expect(src, name).not.toMatch(/prisma\.deposit\b/);
      expect(src, name).not.toMatch(/metadata:\s*\{\s*depositId/);
    }
  });

  it('every flow builds its own data: none takes the shared fixtures that used to crash the run', () => {
    for (const [name, src] of sources) expect(src, name).not.toMatch(/from '\.\.\/fixtures'/);
  });
});

describe('slice 39: the run stays inside demo orgs, tagged qa-39', () => {
  const dir = path.resolve(__dirname, '../verify-stripe');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));

  it('every organization the suite creates is a demo org named with the qa-39 tag', () => {
    let seen = 0;
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), 'utf8');
      for (const m of src.matchAll(/prisma\.organization\.create\(\{\s*data:\s*\{([\s\S]*?)\}\s*,?\s*\}\)/g)) {
        seen++;
        expect(m[1], f).toMatch(/is_demo:\s*true/);
      }
      for (const m of src.matchAll(/const tag = `([^`]*)`/g)) expect(m[1], f).toMatch(/^qa-39-/);
    }
    expect(seen).toBeGreaterThan(8);
  });
});

describe('slice 40: one filter finds everything a run created', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, '../verify-stripe', rel), 'utf8');
  it('every fixture tag in every flow file starts with qa-39-', () => {
    const files = [
      ...readdirSync(TESTS_DIR).map((f) => `tests/${f}`),
      ...readdirSync(path.resolve(__dirname, '../verify-stripe')).filter((f) => f.endsWith('-events.ts') || f === 'estimate-deposit-flows.ts'),
    ];
    for (const f of files) {
      const bad = read(f).match(/`(?!qa-39-)VERIFY-[A-Z]+-/g);
      expect(bad, f).toBeNull();
    }
  });
});

describe('slice 40: the dispute flow cannot lose the race with the processor', () => {
  it('books the payment row (naming the payment intent) BEFORE the charge is confirmed, so the processor-delivered event finds its organization', () => {
    const src = readFileSync(path.resolve(__dirname, '../verify-stripe/dispute-events.ts'), 'utf8');
    const first = src.slice(0, src.indexOf('export async function disputeBeforeTheBookingIsPickedUp'));
    const bookAt = first.indexOf('prisma.payment.create');
    const confirmAt = first.indexOf('paymentIntents.confirm');
    expect(bookAt).toBeGreaterThan(-1);
    expect(confirmAt).toBeGreaterThan(-1);
    expect(bookAt).toBeLessThan(confirmAt);
    // The charge is not made at creation any more.
    expect(first).not.toMatch(/paymentIntents\.create\([^)]*confirm: true/s);
  });
});
