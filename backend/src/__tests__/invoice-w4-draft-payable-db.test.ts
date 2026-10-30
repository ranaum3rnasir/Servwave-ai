/* =============================================================================
   Payments go-live, slice W4 - a DRAFT invoice that has a public token is payable through its link.

   A payment link no longer issues the invoice (it stays DRAFT), so the public page and the
   checkout door must serve a DRAFT with a token. Driven through the real public routes against a
   real, migrated database (TEST_DATABASE_URL); only the processor SDK underneath the session
   builder is replaced, by a recorder. Skips when TEST_DATABASE_URL is unset. Every org it creates
   is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const { sessionsCreate } = vi.hoisted(() => ({ sessionsCreate: vi.fn() }));

// The suite-wide setup mocks the app's client; here it is a real one, built by the one factory.
vi.mock('../lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const clientAt = (url: string) => new PrismaClient({ datasources: { db: { url } } });
  const url = process.env.TEST_DATABASE_URL;
  return { prisma: url ? clientAt(url) : undefined };
});

// The real session builder runs; only the processor SDK underneath it records.
vi.unmock('../lib/stripe');
vi.mock('stripe', () => ({
  default: class RecordingProcessorClient {
    checkout = {
      sessions: {
        create: sessionsCreate,
        list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
        expire: vi.fn().mockResolvedValue({}),
      },
    };
  },
}));

import { prisma } from '../lib/prisma';
import { env } from '../config/env';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite('a DRAFT invoice with a token is payable through its public link (real database)', () => {
  const db = prisma;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_payw4_draft_db';
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  }, 120_000);
  beforeEach(() => {
    sessionsCreate.mockReset();
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'customers']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  async function draftWithToken(opts: { kind?: 'STANDARD' | 'DEPOSIT'; status?: 'DRAFT' | 'SENT' | 'VOIDED' } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const token = `tok-${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `payw4-draft-${tag}`, email: `draft-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: `acct_payw4_${tag}`, stripe_charges_enabled: true,
        accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`, status: opts.status ?? 'DRAFT',
        ...(opts.kind ? { kind: opts.kind } : {}),
        subtotal: 150, tax_amount: 0, total_amount: 150, amount_due: 150, public_token: token,
      },
    });
    sessionsCreate.mockResolvedValue({ id: `cs_${tag}`, url: 'https://checkout.example/draft' });
    const view = () => request(app).get(`/api/invoices/${invoice}/public?token=${token}`);
    const checkout = (body: object = { method: 'card' }) => request(app).post(`/api/invoices/${invoice}/public/checkout?token=${token}`).send(body);
    return { org, invoice, token, view, checkout };
  }

  it('the public page serves a DRAFT with a token as payable, with the amount due', async () => {
    const f = await draftWithToken();

    const res = await f.view();

    expect(res.status).toBe(200);
    expect(res.body.pay_state).toBe('PAYABLE');
    expect(res.body.payable_now).toBe(150);
  });

  it('a checkout session can be created on a DRAFT with a token, for the amount due', async () => {
    const f = await draftWithToken();

    const res = await f.checkout();

    expect(res.status).toBe(200);
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params] = sessionsCreate.mock.calls[0];
    expect(params.metadata).toMatchObject({ organizationId: f.org, invoiceId: f.invoice, kind: 'invoice', payableNowCents: '15000' });
  });

  it('a wrong token still gets nothing, and a VOIDED invoice still takes no checkout', async () => {
    const f = await draftWithToken();
    expect((await request(app).get(`/api/invoices/${f.invoice}/public?token=nope`)).status).toBe(404);
    expect((await request(app).post(`/api/invoices/${f.invoice}/public/checkout?token=nope`).send({ method: 'card' })).status).toBe(404);

    const voided = await draftWithToken({ status: 'VOIDED' });
    expect((await voided.checkout()).status).toBe(400);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('a deposit invoice still takes no checkout while it is a DRAFT (slice 15 rule unchanged)', async () => {
    const f = await draftWithToken({ kind: 'DEPOSIT' });

    const res = await f.checkout();

    expect(res.status).toBe(400);
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});
