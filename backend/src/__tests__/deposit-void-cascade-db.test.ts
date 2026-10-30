/* =============================================================================
   Payments go-live, slice 15 (from the slice 14 review) - closing an estimate or its lead voids
   only a deposit that holds no money, judged under the deposit's lock.

   Before: the lead doors (cancel, lost) read the deposits with their payments, then voided them by
   id in a separate write, with no transaction and no lock. A payment booked on the deposit in
   between was written over: the deposit went VOIDED with the customer's money on it. The estimate
   doors (cancel, decline) voided every DRAFT/SENT deposit in one write with no payment check at
   all, so a bank payment still clearing (which leaves the deposit SENT) was voided under it.

   Driven through the real routes against a real, migrated database. Skips when TEST_DATABASE_URL
   is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
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
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

suite('closing an estimate or its lead voids only a deposit with no money on it (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimates WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM lead_status_history WHERE lead_id IN (SELECT id FROM leads WHERE organization_id = '${org}')`));
      for (const table of ['leads', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /** A lead with a sent $1,000 estimate and its $500 deposit invoice, SENT and unpaid. */
  async function sentDeposit() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const lead = randomUUID();
    const estimate = randomUUID();
    const deposit = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `pay15v-${tag}`, email: `pay15v-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        accepted_payment_methods: ['CARD', 'ACH', 'CHECK'],
        // Leads are a paid module; the lead doors need a plan that includes them.
        plan: 'ENTERPRISE',
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.lead.create({
      data: { id: lead, organization_id: org, lead_number: `L-${tag}`, customer_id: customer, service_request: 'New door', status: 'ESTIMATED' },
    });
    await db.estimate.create({
      data: {
        id: estimate, organization_id: org, lead_id: lead, customer_id: customer, created_by: user, estimate_number: `E-${tag}`,
        status: 'SENT', subtotal: 1000, tax_amount: 0, total_amount: 1000, public_token: `est-${tag}`,
      },
    });
    await db.invoice.create({
      data: {
        id: deposit, organization_id: org, customer_id: customer, estimate_id: estimate, kind: 'DEPOSIT',
        invoice_number: `D-${tag}`, status: 'SENT', subtotal: 500, tax_amount: 0, total_amount: 500, amount_due: 500,
      },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    const bearer = `Bearer pay15v-${tag}`;
    const staff = (path: string, body: object) => request(app).post(path).set('Authorization', bearer).send(body);
    const readDeposit = () => db.invoice.findUniqueOrThrow({ where: { id: deposit } });
    return { org, lead, estimate, deposit, tag, staff, readDeposit };
  }

  // A bank payment still clearing leaves the deposit SENT; it is money on its way, not nothing.
  describe('a deposit with a bank payment still clearing is not voided', () => {
    const clearing = (deposit: string) => db.payment.create({
      data: { invoice_id: deposit, amount: 500, method: 'ACH', state: 'PROCESSING', paid_at: new Date(), created_by_source: 'CLIENT' },
    });

    it('when staff cancel the estimate', async () => {
      const f = await sentDeposit();
      await clearing(f.deposit);

      const res = await f.staff(`/api/estimates/${f.estimate}/cancel`, { cancelled_reason: 'Customer went elsewhere' });

      expect(res.status).toBe(200);
      expect((await f.readDeposit()).status).toBe('SENT');
    });

    it('when the customer declines the estimate', async () => {
      const f = await sentDeposit();
      await clearing(f.deposit);

      const res = await request(app).post(`/api/estimates/${f.estimate}/decline?token=est-${f.tag}`).send({});

      expect(res.status).toBe(200);
      expect((await f.readDeposit()).status).toBe('SENT');
    });

    it('when staff mark the lead lost', async () => {
      const f = await sentDeposit();
      await clearing(f.deposit);

      const res = await f.staff(`/api/leads/${f.lead}/mark-lost`, { lost_reason: 'Duplicate' });

      expect(res.status).toBe(200);
      expect((await f.readDeposit()).status).toBe('SENT');
    });
  });

  // The waive door (action 'waive' wins the estimate, 'cancel' archives it) voids the deposit too.
  // A deposit with money on its way cannot be waived or cancelled away; the action is refused and
  // nothing changes, so the money is refunded, never left on a voided document.
  describe('waiving or cancelling a deposit through the waive door', () => {
    const clearing = (deposit: string) => db.payment.create({
      data: { invoice_id: deposit, amount: 500, method: 'ACH', state: 'PROCESSING', paid_at: new Date(), created_by_source: 'CLIENT' },
    });
    const readEstimate = (id: string) => db.estimate.findUniqueOrThrow({ where: { id } });

    for (const action of ['waive', 'cancel'] as const) {
      it(`is refused with a bank payment still clearing on the deposit (action '${action}')`, async () => {
        const f = await sentDeposit();
        await clearing(f.deposit);

        const res = await f.staff(`/api/estimates/${f.estimate}/waive-deposit`, { action });

        expect(res.status).toBe(409);
        expect((await f.readDeposit()).status).toBe('SENT');
        expect((await readEstimate(f.estimate)).status).toBe('SENT');
      });
    }

    it('still voids a deposit with nothing on it and wins the estimate', async () => {
      const f = await sentDeposit();

      const res = await f.staff(`/api/estimates/${f.estimate}/waive-deposit`, { action: 'waive' });

      expect(res.status).toBe(200);
      const deposit = await f.readDeposit();
      expect(deposit.status).toBe('VOIDED');
      expect(deposit.voided_reason).toBe('Deposit waived');
      expect((await readEstimate(f.estimate)).status).toBe('WON');
    });

    // The race: a payment is being booked on the deposit (it holds the lock) when staff waive it.
    // The waive must wait for that payment, then refuse, and the payment stands.
    it('waits for a payment being booked on the deposit, then refuses and keeps the payment', async () => {
      const f = await sentDeposit();

      let release!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      let locked!: (pid: number) => void;
      const holderPid = new Promise<number>((r) => { locked = r; });
      const holder = db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT id FROM invoices WHERE id = '${f.deposit}' FOR UPDATE`);
        await tx.$executeRawUnsafe(
          `INSERT INTO payments (id, invoice_id, amount, method, state, paid_at, created_by_source) VALUES ('${randomUUID()}', '${f.deposit}', 200, 'CHECK', 'SUCCEEDED', now(), 'USER')`,
        );
        await tx.$executeRawUnsafe(`UPDATE invoices SET amount_due = 300, status = 'PARTIAL' WHERE id = '${f.deposit}'`);
        const [{ pid }] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
        locked(pid);
        await released;
      }, { timeout: 20_000 });
      const pid = await Promise.race([holderPid, holder.then(() => { throw new Error('the payment never held the lock'); })]);
      const waived = f.staff(`/api/estimates/${f.estimate}/waive-deposit`, { action: 'waive' }).then((r) => r);
      try {
        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i++) {
          const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`,
          );
          blocked = n > 0;
          if (!blocked) await new Promise((r) => setTimeout(r, 50));
        }
        expect(blocked, 'the waive never waited on the deposit').toBe(true);
      } finally {
        release();
        await holder;
      }
      expect((await waived).status).toBe(409);

      const deposit = await f.readDeposit();
      expect(deposit.status).toBe('PARTIAL');
      expect(Number(deposit.amount_due)).toBe(300);
      expect((await readEstimate(f.estimate)).status).toBe('SENT');
    });
  });

  it('a deposit with nothing on it is still voided when the customer declines', async () => {
    const f = await sentDeposit();

    const res = await request(app).post(`/api/estimates/${f.estimate}/decline?token=est-${f.tag}`).send({});

    expect(res.status).toBe(200);
    const deposit = await f.readDeposit();
    expect(deposit.status).toBe('VOIDED');
    expect(deposit.voided_at).not.toBeNull();
  });

  // The race: staff record $200 against the deposit (lock, book, PARTIAL) while the lead is being
  // marked lost. The mark lost must wait for that payment and then leave the deposit alone.
  it('a payment booked on the deposit while the lead is marked lost is kept, and the deposit is not voided', async () => {
    const f = await sentDeposit();

    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: (pid: number) => void;
    const holderPid = new Promise<number>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT id FROM invoices WHERE id = '${f.deposit}' FOR UPDATE`);
      await tx.$executeRawUnsafe(
        `INSERT INTO payments (id, invoice_id, amount, method, state, paid_at, created_by_source) VALUES ('${randomUUID()}', '${f.deposit}', 200, 'CHECK', 'SUCCEEDED', now(), 'USER')`,
      );
      await tx.$executeRawUnsafe(`UPDATE invoices SET amount_due = 300, status = 'PARTIAL' WHERE id = '${f.deposit}'`);
      const [{ pid }] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
      locked(pid);
      await released;
    }, { timeout: 20_000 });
    const pid = await Promise.race([holderPid, holder.then(() => { throw new Error('the payment never held the lock'); })]);
    const cancelled = f.staff(`/api/leads/${f.lead}/mark-lost`, { lost_reason: 'Duplicate' }).then((r) => r);
    try {
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`,
        );
        blocked = n > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked, 'the mark lost never waited on the deposit').toBe(true);
    } finally {
      release();
      await holder;
    }
    expect((await cancelled).status).toBe(200);

    const deposit = await f.readDeposit();
    expect(deposit.status).toBe('PARTIAL');
    expect(Number(deposit.amount_due)).toBe(300);
  });
});
