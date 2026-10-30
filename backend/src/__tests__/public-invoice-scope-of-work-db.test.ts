/* =============================================================================
   Payments go-live, slice 24 - the public invoice shows the scope of work (#1073).

   A homeowner opening their invoice link must see what they are paying for. The scope-of-work
   blocks are folded into the stored subtotal, so a public payload without them prints rows that
   do not add up to the Subtotal above them. The route is unauthenticated, so each block reaches
   the customer with its customer-safe fields only (title, body, flat price, taxable flag): the
   staff margin (`internal_cost`) is absent, not null.

   Driven through the real route against a real migrated database (TEST_DATABASE_URL), because
   the defect was a missing column in a Prisma select, which a mocked client cannot catch. Skips
   when TEST_DATABASE_URL is unset, like every other *-db suite. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { RequestListener, Server } from 'http';
import { listenOnLoopback, closeServer } from './loopback-app';

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

const suite = realClient ? describe : describe.skip;

const PRICED_SCOPE = {
  id: 'scope-a', title: 'Panel upgrade', body: 'Replace the 100A panel with a 200A panel.',
  flat_price: 1200, is_taxable: true, internal_cost: 700,
};
const NARRATIVE_SCOPE = {
  id: 'scope-b', title: 'Permit handling', body: 'We file the city permit and book the inspection.',
  flat_price: null, is_taxable: false, internal_cost: 40,
};

suite('public invoice scope of work (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Server;

  beforeAll(async () => {
    app = await listenOnLoopback((await import('../app.js')).default as unknown as RequestListener);
  });

  /** A sent invoice with a public link. `scopes: undefined` leaves the JSONB column unset. */
  async function sentInvoice(opts: { scopes?: unknown[]; onJob?: boolean; lines?: string[] } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const token = `pay24-${randomUUID()}`;
    await db.organization.create({
      data: {
        id: org, name: `pay24-${tag}`, email: `pay24-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    await db.customer.create({
      data: {
        id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: 'Pat', last_name: 'Payer', email: `payer-${tag}@example.test`, phone: '5550001111',
      },
    });
    let job: string | null = null;
    if (opts.onJob) {
      job = randomUUID();
      const location = await db.serviceLocation.create({
        data: { customer_id: customer, address_line1: '5 Test St', city: 'Testville', state: 'MA', zip: '02108' },
      });
      await db.job.create({
        data: { id: job, organization_id: org, customer_id: customer, service_location_id: location.id, job_number: `J-${tag}`, status: 'COMPLETED' },
      });
    }
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, job_id: job, invoice_number: `INV-${tag}`, status: 'SENT',
        public_token: token, subtotal: 1500, tax_amount: 0, total_amount: 1500, amount_due: 1500,
        ...(opts.scopes ? { scopes: opts.scopes as object[] } : {}),
        line_items: {
          create: (opts.lines ?? ['Service call']).map((description, i) => ({
            sequence: i + 1, description, quantity: 1, unit_price: 300, line_total: 300, unit_cost: 120,
          })),
        },
      },
    });
    return request(app).get(`/api/invoices/${invoice}/public?token=${encodeURIComponent(token)}`);
  }

  afterAll(async () => {
    await closeServer(app);
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['timeline_events', 'audit_logs', 'invoices', 'jobs']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM service_locations WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM customers WHERE organization_id = '${org}'`));
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  it('carries every scope block in stored order, priced and narrative alike', async () => {
    const res = await sentInvoice({ scopes: [PRICED_SCOPE, NARRATIVE_SCOPE] });

    expect(res.status).toBe(200);
    expect(res.body.invoice.scopes).toEqual([
      { id: 'scope-a', title: 'Panel upgrade', body: 'Replace the 100A panel with a 200A panel.', flat_price: 1200, is_taxable: true },
      { id: 'scope-b', title: 'Permit handling', body: 'We file the city permit and book the inspection.', flat_price: null, is_taxable: false },
    ]);
  });

  it('an invoice that never had a scope carries an empty list, not null', async () => {
    const res = await sentInvoice();

    expect(res.status).toBe(200);
    expect(res.body.invoice.scopes).toEqual([]);
  });

  // Extends the public-token redaction rules (public-token-redaction.test.ts, F-55) to the whole
  // public payload: this route has no requester, so nothing internal may ride along.
  it('leaks no internal field: no margin, no token, no tenant id, no payer contact (the street is shown, Ran 2026-10-08)', async () => {
    const res = await sentInvoice({ scopes: [PRICED_SCOPE], onJob: true });

    expect(res.status).toBe(200);
    const inv = res.body.invoice;
    for (const key of ['organization_id', 'public_token', 'payment_methods_override', 'allow_partial_payment', 'estimate']) {
      expect(key in inv, `invoice.${key}`).toBe(false);
    }
    expect('internal_cost' in inv.scopes[0]).toBe(false);
    for (const line of inv.line_items) {
      expect('unit_cost' in line).toBe(false);
      expect('markup_percent' in line).toBe(false);
    }
    expect(Object.keys(inv.customer).sort()).toEqual(['company_name', 'first_name', 'last_name']);
    expect(Object.keys(inv.job.customer).sort()).toEqual(['company_name', 'first_name', 'last_name']);
    // Ran 2026-10-08: the customer's invoice shows the full address, street included (billing needs
    // it, like the PDF and the public estimate). Lifts F-55 for this route only.
    expect(Object.keys(inv.job.service_location).sort()).toEqual(['address_line1', 'address_line2', 'city', 'state', 'zip']);
    expect(inv.job.service_location.address_line1).toBe('5 Test St');
  });
});
