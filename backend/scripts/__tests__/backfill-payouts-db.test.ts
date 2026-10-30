/* =============================================================================
   Payments go-live, slice P2 - the payout backfill script (scripts/backfill-payouts.ts).

   Real migrated database (TEST_DATABASE_URL; skips when unset), the processor's lists as recorded
   fixtures handed to the mocked calls. Proves: it refuses to run without an explicit org list or
   --all; a dry run prints counts and writes nothing; a real run fills the payouts and links the
   payments, and running it twice changes nothing; an org that is not named is left alone.
   ========================================================================== */

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';

// One factory for every client in this file (see job-cancel-payment-race-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../../src/lib/prisma', () => ({ prisma: realClient }));

import { listAccountPayouts, listPayoutBalanceTransactions } from '../../src/lib/stripe';
import { parseBackfillArgs, runBackfill } from '../backfill-payouts';

const payoutsList = listAccountPayouts as unknown as ReturnType<typeof vi.fn>;
const balanceTransactions = listPayoutBalanceTransactions as unknown as ReturnType<typeof vi.fn>;
const suite = realClient ? describe : describe.skip;

const NOW = new Date('2026-10-11T03:00:00.000Z');
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

describe('parseBackfillArgs', () => {
  it('refuses to run without an explicit org list or --all', () => {
    expect(parseBackfillArgs([])).toEqual({ ok: false, error: expect.stringContaining('--org') });
    expect(parseBackfillArgs(['--dry-run'])).toEqual({ ok: false, error: expect.stringContaining('--all') });
  });

  it('reads the org list, --all, --dry-run and --days', () => {
    expect(parseBackfillArgs(['--org', 'a', '--org', 'b'])).toEqual({ ok: true, orgIds: ['a', 'b'], dryRun: false, days: 120 });
    expect(parseBackfillArgs(['--all', '--dry-run', '--days', '30'])).toEqual({ ok: true, orgIds: 'all', dryRun: true, days: 30 });
  });

  it('refuses a days value that is not a positive whole number', () => {
    expect(parseBackfillArgs(['--all', '--days', 'x']).ok).toBe(false);
    expect(parseBackfillArgs(['--all', '--days', '0']).ok).toBe(false);
  });
});

suite('backfill-payouts (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  const processor = new Map<string, Record<string, unknown>[]>();
  const contents = new Map<string, string[]>();

  async function seedOrg() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const account = `acct_p2b_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `p2b-${tag}`, email: `p2b-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account, accepted_payment_methods: ['CARD'],
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: { id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`, subtotal: 100, tax_amount: 0, total_amount: 100, status: 'PAID', amount_due: 0 },
    });
    const payment = await db.payment.create({
      data: {
        invoice_id: invoice, amount: 100, method: 'CARD', paid_at: NOW, state: 'SUCCEEDED',
        stripe_account_id: account, stripe_payment_intent_id: `pi_${tag}`, stripe_charge_id: `ch_${tag}`, stripe_balance_transaction_id: `txn_${tag}`,
      },
    });
    const payoutId = `po_p2b_${tag}`;
    processor.set(account, [{
      id: payoutId, object: 'payout', amount: 9700, status: 'paid', automatic: true, arrival_date: unix(NOW), created: unix(NOW), failure_code: null, destination: null,
    }]);
    contents.set(payoutId, [`txn_${tag}`]);
    return { org, tag, account, payment, payoutId };
  }

  beforeEach(() => {
    processor.clear();
    contents.clear();
    payoutsList.mockReset().mockImplementation(async (account: string) => processor.get(account) ?? []);
    balanceTransactions.mockReset().mockImplementation(async (_a: string, payoutId: string) => (contents.get(payoutId) ?? []).map((id) => ({ id })));
  });

  afterAll(async () => {
    for (const org of orgs) {
      await db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}'::uuid)`);
      await db.$executeRawUnsafe(`DELETE FROM payouts WHERE organization_id = '${org}'::uuid`);
      for (const table of ['invoices', 'customers']) await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'::uuid`);
      await db.organization.delete({ where: { id: org } });
    }
    await db.$disconnect();
  });

  it('a dry run counts what it would do and writes nothing', async () => {
    const o = await seedOrg();

    const summary = await runBackfill({ orgIds: [o.org], dryRun: true, days: 120 }, NOW);

    expect(summary.orgs).toEqual([{ orgId: o.org, listed: 1, missing: 1, linked: 0, unreadable: 0 }]);
    expect(await db.payout.count({ where: { organization_id: o.org } })).toBe(0);
    expect((await db.payment.findUniqueOrThrow({ where: { id: o.payment.id } })).payout_id).toBeNull();
    expect(balanceTransactions).not.toHaveBeenCalled();
  });

  it('a real run writes the payout and links the payment, and a second run changes nothing', async () => {
    const o = await seedOrg();

    const first = await runBackfill({ orgIds: [o.org], dryRun: false, days: 120 }, NOW);

    expect(first.orgs).toEqual([{ orgId: o.org, listed: 1, missing: 1, linked: 1, unreadable: 0 }]);
    const payout = await db.payout.findFirstOrThrow({ where: { organization_id: o.org } });
    expect(payout).toMatchObject({ stripe_payout_id: o.payoutId, status: 'PAID' });
    expect((await db.payment.findUniqueOrThrow({ where: { id: o.payment.id } })).payout_id).toBe(payout.id);

    const second = await runBackfill({ orgIds: [o.org], dryRun: false, days: 120 }, NOW);

    expect(second.orgs).toEqual([{ orgId: o.org, listed: 1, missing: 0, linked: 0, unreadable: 0 }]);
    expect(await db.payout.findMany({ where: { organization_id: o.org } })).toEqual([payout]);
  });

  it('looks back only as many days as asked', async () => {
    const o = await seedOrg();

    await runBackfill({ orgIds: [o.org], dryRun: true, days: 30 }, NOW);

    expect(payoutsList).toHaveBeenCalledWith(o.account, unix(new Date(NOW.getTime() - 30 * 86400_000)));
  });

  it('leaves an org that is not named alone', async () => {
    const named = await seedOrg();
    const other = await seedOrg();

    await runBackfill({ orgIds: [named.org], dryRun: false, days: 120 }, NOW);

    expect(await db.payout.count({ where: { organization_id: other.org } })).toBe(0);
    expect(payoutsList).not.toHaveBeenCalledWith(other.account, expect.anything());
  });

  it('reports an org id that has no payout account instead of skipping it quietly', async () => {
    const summary = await runBackfill({ orgIds: [randomUUID()], dryRun: true, days: 120 }, NOW);

    expect(summary.orgs[0]).toMatchObject({ error: expect.stringContaining('with a payout account') });
  });
});
