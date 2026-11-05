/* =============================================================================
   #2981 - a customer who signs and pays on a public link is counted per connection AND document, and
   has room to try again; declining is counted apart.

   Driven through the real app (the full middleware stack, the canonical-id guard included) against a
   real migrated database (TEST_DATABASE_URL). The suite-wide setup turns the limiters into
   passthroughs (no Redis), so the two new ones are rebuilt here on in-memory stores with the production
   numbers; everything else is the real thing. Skips when TEST_DATABASE_URL is unset, like every other
   *-db suite. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { RequestListener, Server } from 'http';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { listenOnLoopback, closeServer } from './loopback-app';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

vi.mock('../middleware/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rate-limit')>();
  return {
    ...actual,
    publicDocumentActionLimiter: actual.publicDocumentActionUserLimiter(
      new RateLimiterMemory({ points: actual.PUBLIC_DOCUMENT_ACTIONS_PER_CONNECTION, duration: 900 }),
    ),
    publicDeclineLimiter: actual.publicDeclineConnectionLimiter(
      new RateLimiterMemory({ points: actual.PUBLIC_DECLINES_PER_CONNECTION, duration: 900 }),
    ),
  };
});

const suite = realClient ? describe : describe.skip;

suite('public approval, checkout and decline allowances (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Server;

  beforeAll(async () => {
    app = await listenOnLoopback((await import('../app.js')).default as unknown as RequestListener);
  });

  afterAll(async () => {
    await closeServer(app);
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'estimates', 'leads', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /** An org with a SENT estimate and a SENT invoice, each with a public link. */
  async function documents() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const user = randomUUID();
    const lead = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `lim2981-${tag}`, email: `lim2981-${tag}@example.test`, phone: '5550142020',
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await db.lead.create({
      data: { id: lead, organization_id: org, lead_number: `L-${tag}`, customer_id: customer, service_request: 'Door', status: 'ESTIMATED' },
    });
    const estimate = async () => {
      const id = randomUUID();
      const token = `lim-est-${randomUUID()}`;
      await db.estimate.create({
        data: {
          id, organization_id: org, lead_id: lead, customer_id: customer, created_by: user, estimate_number: `E-${randomUUID().slice(0, 8)}`,
          status: 'SENT', subtotal: 400, tax_amount: 0, total_amount: 400, public_token: token,
        },
      });
      return { id, token };
    };
    const invoice = async () => {
      const id = randomUUID();
      const token = `lim-inv-${randomUUID()}`;
      await db.invoice.create({
        data: {
          id, organization_id: org, customer_id: customer, invoice_number: `INV-${randomUUID().slice(0, 8)}`,
          status: 'SENT', subtotal: 200, tax_amount: 0, total_amount: 200, amount_due: 200, public_token: token,
        },
      });
      return { id, token };
    };
    return { estimate, invoice };
  }

  const approve = (e: { id: string; token: string }, ip: string) =>
    request(app).post(`/api/estimates/${e.id}/approve?token=${e.token}`).set('X-Forwarded-For', ip).send({});
  const decline = (e: { id: string; token: string }, ip: string) =>
    request(app).post(`/api/estimates/${e.id}/decline?token=${e.token}`).set('X-Forwarded-For', ip).send({});
  const checkout = (i: { id: string; token: string }, ip: string) =>
    request(app).post(`/api/invoices/${i.id}/public/checkout?token=${i.token}`).set('X-Forwarded-For', ip).send({ method: 'nonsense' });

  it('the journey: 20 tries on one estimate pass to the handler, the 21st is 429 with retryAfter, another estimate and the same estimate from another connection are untouched', async () => {
    const d = await documents();
    const first = await d.estimate();
    const second = await d.estimate();

    for (let i = 0; i < 20; i++) expect((await approve(first, '198.51.100.20')).status).not.toBe(429);
    const blocked = await approve(first, '198.51.100.20');
    expect(blocked.status).toBe(429);
    expect(blocked.body.retryAfter).toBeGreaterThan(0);

    expect((await approve(second, '198.51.100.20')).status).not.toBe(429);
    expect((await approve(first, '203.0.113.20')).status).not.toBe(429);
  });

  it('checkout is counted per invoice the same way, and a payment try never spends the decline allowance', async () => {
    const d = await documents();
    const inv = await d.invoice();
    const other = await d.invoice();
    const est = await d.estimate();

    for (let i = 0; i < 20; i++) expect((await checkout(inv, '198.51.100.21')).status).not.toBe(429);
    expect((await checkout(inv, '198.51.100.21')).status).toBe(429);
    expect((await checkout(other, '198.51.100.21')).status).not.toBe(429);

    // 20 payment tries on that connection, and its decline allowance is whole.
    expect((await decline(est, '198.51.100.21')).status).toBe(200);
  });

  it('declining has its own 5 per connection; payment tries are still open once it is spent', async () => {
    const d = await documents();
    const est = await d.estimate();

    for (let i = 0; i < 5; i++) expect((await decline(est, '198.51.100.22')).status).not.toBe(429);
    const blocked = await decline(est, '198.51.100.22');
    expect(blocked.status).toBe(429);
    expect(blocked.body.retryAfter).toBeGreaterThan(0);

    expect((await approve(est, '198.51.100.22')).status).not.toBe(429);
  });

  it('a record id in another spelling is refused 404 before it can touch any allowance', async () => {
    const d = await documents();
    const est = await d.estimate();
    for (let i = 0; i < 25; i++) {
      const res = await request(app).post(`/api/estimates/${est.id.toUpperCase()}/approve?token=${est.token}`).set('X-Forwarded-For', '198.51.100.23').send({});
      expect(res.status).toBe(404);
    }
    expect((await approve(est, '198.51.100.23')).status).not.toBe(429);
  });
});
