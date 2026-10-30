/* =============================================================================
   Payments go-live, slice 32c - a payment link never rewrites a paid or part-paid invoice's status.

   A DRAFT can take a hand-recorded payment (it becomes PARTIAL or PAID with no public token);
   pressing "payment link" afterwards used to flip it back to SENT. Driven through the real doors
   against a real, migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
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

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

suite('a payment link keeps a paid or part-paid invoice status (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  }, 120_000);

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /** A $50 standalone DRAFT invoice with no token, optionally already marked as sent once. */
  async function fixture(opts: { sentAt?: Date } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const invoice = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `pay32c-${tag}`, email: `pay32c-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: {
        id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Pat', last_name: 'Payer', email: `pat-${tag}@example.test`,
      },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `I-${tag}`,
        subtotal: 50, tax_amount: 0, total_amount: 50, amount_due: 50, net_collected: 0,
        status: 'DRAFT', sent_at: opts.sentAt ?? null,
      },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    const bearer = `Bearer pay32c-${tag}`;
    const post = (path: string, body: object = {}) => request(app).post(path).set('Authorization', bearer).send(body);
    const read = () => db.invoice.findUniqueOrThrow({ where: { id: invoice } });
    const payCash = (amount: number) => post(`/api/invoices/${invoice}/payments`, { amount, method: 'CASH' });
    const link = () => post(`/api/invoices/${invoice}/payment-link`);
    const timelineCount = () => db.timelineEvent.count({ where: { organization_id: org, entity_id: invoice, event_type: { in: ['INVOICE_SENT', 'INVOICE_PAYMENT_LINK_CREATED'] } } });
    const timelineText = async () => (await db.timelineEvent.findFirstOrThrow({ where: { organization_id: org, entity_id: invoice, event_type: { in: ['INVOICE_SENT', 'INVOICE_PAYMENT_LINK_CREATED'] } } })).description;
    /** The next findUnique (the handler's first read) answers with the row as it is NOW, then `between` runs
     *  before the handler goes on - a deterministic "something committed after the read". */
    const afterNextRead = (between: () => Promise<unknown>) => {
      const spy = vi.spyOn(db.invoice, 'findUnique');
      const original = db.invoice.findUnique.bind(db.invoice) as (a: unknown) => Promise<unknown>;
      spy.mockImplementationOnce((async (args: unknown) => {
        const stale = await original(args);
        spy.mockRestore();
        await between();
        return stale;
      }) as never);
    };
    return { invoice, read, payCash, link, timelineCount, timelineText, afterNextRead };
  }

  it('a DRAFT part-paid by hand stays PARTIAL when a payment link is made', async () => {
    const f = await fixture();
    expect((await f.payCash(1)).status).toBe(201);
    const before = await f.read();
    expect(before.status).toBe('PARTIAL');
    expect(before.public_token).toBeNull();

    const res = await f.link();

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('/p/invoices/');
    const after = await f.read();
    expect(after.status).toBe('PARTIAL');
    expect(Number(after.amount_due)).toBe(49);
    expect(Number(after.net_collected)).toBe(1);
    expect(after.public_token).not.toBeNull();
    expect(await f.timelineText()).toBe(`Payment link created for invoice ${after.invoice_number}`);
  });

  it('a DRAFT paid in full by hand stays PAID, with its paid date untouched', async () => {
    const f = await fixture();
    expect((await f.payCash(50)).status).toBe(201);
    const before = await f.read();
    expect(before.status).toBe('PAID');
    expect(before.paid_at).not.toBeNull();

    expect((await f.link()).status).toBe(200);

    const after = await f.read();
    expect(after.status).toBe('PAID');
    expect(after.paid_at!.getTime()).toBe(before.paid_at!.getTime());
    expect(after.public_token).not.toBeNull();
  });

  it('a plain DRAFT stays DRAFT with no sent date (W4)', async () => {
    const f = await fixture();

    expect((await f.link()).status).toBe(200);

    const after = await f.read();
    expect(after.status).toBe('DRAFT');
    expect(after.sent_at).toBeNull();
  });

  it('an invoice that was sent before keeps its original sent date', async () => {
    const original = new Date('2026-01-02T03:04:05.000Z');
    const f = await fixture({ sentAt: original });
    expect((await f.payCash(1)).status).toBe(201);

    expect((await f.link()).status).toBe(200);

    expect((await f.read()).sent_at!.getTime()).toBe(original.getTime());
  });

  it('a hand payment that commits between the read and the write is not undone (stays PARTIAL)', async () => {
    const f = await fixture();
    f.afterNextRead(async () => { expect((await f.payCash(1)).status).toBe(201); });

    const res = await f.link();

    expect(res.status).toBe(200);
    const after = await f.read();
    expect(after.status).toBe('PARTIAL');
    expect(Number(after.amount_due)).toBe(49);
    expect(after.public_token).not.toBeNull();
  });

  it('a token set between the read and the write is returned unchanged, with one timeline entry', async () => {
    const f = await fixture();
    const first = randomUUID();
    f.afterNextRead(async () => {
      await db.invoice.update({ where: { id: f.invoice }, data: { public_token: first, status: 'SENT', sent_at: new Date() } });
    });

    const res = await f.link();

    expect(res.status).toBe(200);
    expect(res.body.url).toContain(`token=${first}`);
    expect((await f.read()).public_token).toBe(first);
    expect(await f.timelineCount()).toBe(0);
  });

  it('an invoice voided between the read and the write is refused and left VOIDED', async () => {
    const f = await fixture();
    f.afterNextRead(async () => { await db.invoice.update({ where: { id: f.invoice }, data: { status: 'VOIDED' } }); });

    const res = await f.link();

    expect(res.status).toBe(400);
    const after = await f.read();
    expect(after.status).toBe('VOIDED');
    expect(after.public_token).toBeNull();
    expect(await f.timelineCount()).toBe(0);
  });
});
