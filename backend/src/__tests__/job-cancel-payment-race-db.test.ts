/* =============================================================================
   #891 - a job cancel and a payment on one of its open invoices, AT THE SAME TIME,
   against a real, migrated database. The race is Postgres's row locking and snapshot
   behaviour, which no mock can reproduce.

   The cancel voids each open invoice with a conditional update ("still SENT/PARTIAL and
   still carries no money"). That re-check cannot see a payment another transaction has
   inserted but not committed, and inserting a payment only takes a KEY SHARE lock on the
   invoice, which does not block the cancel's update. So without real locking:
     - a payment in flight when the cancel starts: the cancel voids the invoice, then the
       payment's own invoice update lands on top and turns VOIDED back into PAID;
     - a cancel in flight when a payment starts: the payment reads SENT, books itself, and
       its invoice update (queued behind the cancel's row lock) overwrites VOIDED with PAID.
   Either way: a PAID invoice still marked voided, a cancelled job, and the deposit credit
   released for a bill that was actually paid.

   Each test holds ONE side's transaction open at a deterministic point with a plain
   interactive transaction on a second client, and runs the OTHER side through the real
   code (the cancel route, the record-payment route, the card-checkout webhook).

   Skips when TEST_DATABASE_URL is unset, the same idiom as the other *-db suites.
   Every org this suite creates is removed again in afterAll.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import type { Prisma } from '@prisma/client';

/*
 * Both clients here come from one factory, and a transaction is typed as what $transaction
 * hands its callback (Prisma.TransactionClient), never cast to a client. A `new
 * PrismaClient({ datasources })` carries a different options generic from the bare
 * `PrismaClient` a transaction client is built on, so casting one to the other makes tsc
 * relate the whole generated client structurally: about 3M extra type instantiations and
 * ~450MB of heap, enough to push the backend type-check past the CI runner's heap limit.
 */
const { realClient, clientAt } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, clientAt };
});
type Tx = Prisma.TransactionClient;

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

// How long the held transaction stays open after its first write. Long enough that the
// other side, started at that moment, has run to its own blocking point (or, without the
// fix, all the way to commit).
const HOLD_MS = 800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('a job cancel racing a payment on its open invoice (real database)', () => {
  const db = realClient!;
  const side = realClient ? clientAt(process.env.TEST_DATABASE_URL!) : undefined!;
  const orgs: string[] = [];
  const eventIds: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  async function fixture() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const job = randomUUID();
    const invoice = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `pay17-race-${tag}`, email: `race-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        accepted_payment_methods: ['CARD', 'CASH', 'CHECK'],
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const location = await db.serviceLocation.create({
      data: { customer_id: customer, address_line1: '5 Test St', city: 'Testville', state: 'MA', zip: '02108' },
    });
    await db.job.create({
      data: {
        id: job, organization_id: org, customer_id: customer, service_location_id: location.id,
        job_number: `J-${tag}`, status: 'SCHEDULED', amount_invoiced: 500,
      },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, job_id: job, invoice_number: `INV-${tag}`,
        status: 'SENT', kind: 'STANDARD', subtotal: 500, tax_amount: 0, total_amount: 500, amount_due: 500,
      },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    // One bearer token per fixture: the auth layer caches the resolved user by token.
    return { org, job, invoice, auth: `Bearer local-db-test-${tag}` };
  }

  /** Runs `first` in a transaction on the side client, then `during` once `first` has landed,
   *  holding the transaction open HOLD_MS before `last` and the commit. */
  async function holdOpen<T>(
    first: (tx: Tx) => Promise<unknown>,
    during: () => Promise<T>,
    last: (tx: Tx) => Promise<unknown> = async () => undefined,
  ): Promise<T> {
    let landed!: () => void;
    const firstLanded = new Promise<void>((r) => { landed = r; });
    const held = side.$transaction(async (tx) => {
      await first(tx);
      landed();
      await sleep(HOLD_MS);
      await last(tx);
    }, { timeout: 15_000 });
    await firstLanded;
    const other = during();
    const [result] = await Promise.all([other, held]);
    return result;
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'jobs']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM service_locations WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = '${org}')`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    for (const id of eventIds) await quietly(db.stripeEvent.deleteMany({ where: { stripe_event_id: id } }));
    await side.$disconnect();
    await db.$disconnect();
  });

  it('a payment still in flight when the cancel starts wins: the cancel answers 409 and the invoice ends PAID, never voided', async () => {
    const { job, invoice, auth } = await fixture();

    // The payment writer's shape: insert the payment, then (later, same transaction) mark the
    // invoice paid.
    const cancel = await holdOpen(
      (tx) => tx.payment.create({ data: { invoice_id: invoice, amount: 500, method: 'CASH', paid_at: new Date() } }),
      () => request(app).post(`/api/jobs/${job}/cancel`).set('Authorization', auth).send({ cancel_reason_code: 'OTHER', cancelled_reason: 'Customer changed plans' }),
      (tx) => tx.invoice.update({ where: { id: invoice }, data: { status: 'PAID', amount_due: 0, paid_at: new Date() } }),
    );

    expect(cancel.status).toBe(409);
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    expect([inv.status, inv.voided_at, Number(inv.amount_due)]).toEqual(['PAID', null, 0]);
    const j = await db.job.findUniqueOrThrow({ where: { id: job } });
    expect([j.status, Number(j.amount_invoiced)]).toEqual(['SCHEDULED', 500]);
  });

  // The cancel's shape for the next two: void the invoice, then hold the transaction open.
  const voidLikeTheCancel = (invoice: string) => (tx: Tx) =>
    tx.invoice.update({ where: { id: invoice }, data: { status: 'VOIDED', voided_at: new Date(), voided_reason: 'Job cancelled', amount_due: 0 } });

  it('a staff payment that starts while a cancel is voiding the invoice is refused and books nothing', async () => {
    const { invoice, auth } = await fixture();

    const pay = await holdOpen(
      voidLikeTheCancel(invoice),
      () => request(app).post(`/api/invoices/${invoice}/payments`).set('Authorization', auth).send({ amount: 500, method: 'CASH' }),
    );

    expect(pay.status).toBe(400);
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    expect([inv.status, Number(inv.amount_due)]).toEqual(['VOIDED', 0]);
    expect(await db.payment.count({ where: { invoice_id: invoice } })).toBe(0);
  });

  it('a card checkout that completes while a cancel is voiding the invoice books no payment and records the charge as unapplied', async () => {
    const { invoice } = await fixture();
    const { processStripeEvent } = await import('../controllers/webhook.controller.js');
    const eventId = `evt_pay17_${randomUUID()}`;
    eventIds.push(eventId);
    const event = {
      id: eventId,
      type: 'checkout.session.completed',
      data: { object: { id: `cs_${randomUUID()}`, payment_intent: `pi_${randomUUID()}`, amount_total: 50000, metadata: { invoiceId: invoice } } },
    };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };

    await holdOpen(voidLikeTheCancel(invoice), () => processStripeEvent(event, res as unknown as Response));

    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    expect([inv.status, Number(inv.amount_due)]).toEqual(['VOIDED', 0]);
    expect(await db.payment.count({ where: { invoice_id: invoice } })).toBe(0);
    const unrecorded = await db.timelineEvent.findMany({ where: { entity_id: invoice, event_type: 'PAYMENT_UNRECORDED' } });
    expect(unrecorded.map((e) => (e.metadata as { reason?: string }).reason)).toEqual(['INVOICE_NOT_PAYABLE']);
    // Recorded as handled, so the processor does not re-deliver into the same refusal.
    expect(await db.stripeEvent.count({ where: { stripe_event_id: eventId } })).toBe(1);
  });
});
