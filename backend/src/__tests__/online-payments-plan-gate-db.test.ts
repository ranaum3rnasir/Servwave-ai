/* =============================================================================
   Payments go-live, slice 16 - no checkout opens for an org whose plan lacks online payments.

   The public pay route has no signed-in user, so the plan is read off the invoice's org row. A
   mocked client returns whatever the fixture says and cannot show that the real lookup reads the
   plan at all, so this drives the real route against a real, migrated database: one org whose
   plan has the entitlement switched off (the way the change-org-plan flow takes it away) and one
   that keeps it, each with a payable invoice on an account that can take cards.

   The app's client is swapped for one pointed at TEST_DATABASE_URL, and only the processor SDK is
   replaced, by a recorder. Skips when TEST_DATABASE_URL is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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

suite('public invoice checkout and the online payments plan (real database)', () => {
  const db = prisma;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_plan_gate_db';
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  beforeEach(() => {
    sessionsCreate.mockReset().mockResolvedValue({ id: 'cs_plan_gate', url: 'https://checkout.example/plan-gate' });
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['timeline_events', 'notifications', 'audit_logs', 'invoices', 'customers']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /** An org on `plan` with `overrides`, whose account takes cards, and one SENT $120 invoice. */
  async function orgWithPayableInvoice(plan: 'STARTER' | 'PRO', overrides: Record<string, boolean>) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const customer = randomUUID();
    const invoice = randomUUID();
    const token = `tok-${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay16-plan-${tag}`, email: `plan-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        plan, feature_overrides: overrides,
        stripe_account_id: `acct_pay16_${tag}`, stripe_charges_enabled: true,
        accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
      },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`, status: 'SENT',
        subtotal: 120, tax_amount: 0, total_amount: 120, amount_due: 120, public_token: token,
      },
    });
    const checkout = (method: 'card' | 'bank') =>
      request(app).post(`/api/invoices/${invoice}/public/checkout?token=${token}`).send({ method });
    return { org, invoice, checkout };
  }

  it('an org whose plan has online payments switched off gets 403 for card and bank, and nothing reaches the processor', async () => {
    const f = await orgWithPayableInvoice('PRO', { online_payments: false });

    for (const method of ['card', 'bank'] as const) {
      const res = await f.checkout(method);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ code: 'ONLINE_PAYMENT_UNAVAILABLE', error: "Paying online isn't available for this invoice." });
      expect(JSON.stringify(res.body)).not.toMatch(/plan/i);
    }
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it('an org whose plan includes online payments opens the checkout', async () => {
    const f = await orgWithPayableInvoice('STARTER', {});

    const res = await f.checkout('card');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checkout_url: 'https://checkout.example/plan-gate' });
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });
});
