/* =============================================================================
   Payments go-live, slice 22 - the refund permission is its own switch.

   Before: the one grant that lets a person send money back ('refund Invoice') rode inside the
   Roles screen's "Record & refund payments" switch, together with recording payments. An owner
   could not let the office record a cheque without also letting it refund cards, and the per-user
   permission screen did not offer refunds at all.

   Now "Refund payments" is a switch of its own, and every route that sends money back refuses a caller without it.

   Staff calls go through the real routes with a real role, against a real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { PERMISSION_CATALOG } from '../lib/permissions/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

describe('the refund permission in the permissions catalog', () => {
  it('is described as refunding payments, naming no payment processor', () => {
    const refund = PERMISSION_CATALOG.find((e) => e.action === 'refund' && e.subject === 'Invoice');
    expect(refund?.description).toMatch(/^Refund payments/);
    expect(refund?.description).not.toMatch(/stripe/i);
  });
});

suite('refund permission switch (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });

  /** Sign in as this user for the next calls (the auth layer caches the resolved user by token). */
  function signedInAs(user: { id: string; email: string }) {
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user.id, email: user.email } },
      error: null,
    });
    const bearer = `Bearer pay22-${user.id}`;
    return {
      get: (path: string) => request(app).get(path).set('Authorization', bearer),
      post: (path: string, body: object = {}) => request(app).post(path).set('Authorization', bearer).send(body),
      put: (path: string, body: object = {}) => request(app).put(path).set('Authorization', bearer).send(body),
    };
  }

  /**
   * An org with an admin, a dispatcher whose role may read invoices (and nothing else), a
   * customer, and an invoice paid in full by a $200 cash payment, so a refund needs no processor.
   */
  async function orgWithPaidInvoice() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const admin = { id: randomUUID(), email: `admin-${tag}@example.test` };
    const dispatcher = { id: randomUUID(), email: `dispatch-${tag}@example.test` };
    const customer = randomUUID();
    const invoice = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `pay22-${tag}`, email: `pay22-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    await db.user.create({
      data: { id: admin.id, organization_id: org, email: admin.email, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.user.create({
      data: { id: dispatcher.id, organization_id: org, email: dispatcher.email, first_name: 'Dee', last_name: 'Spatch', role: 'DISPATCHER' },
    });
    await db.rolePermission.create({ data: { organization_id: org, role: 'DISPATCHER', action: 'read', subject: 'Invoice' } });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    await db.invoice.create({
      data: {
        id: invoice, organization_id: org, customer_id: customer, invoice_number: `INV-${tag}`,
        subtotal: 200, tax_amount: 0, total_amount: 200, amount_due: 0, status: 'PAID',
      },
    });
    await db.payment.create({
      data: { invoice_id: invoice, amount: 200, method: 'CASH', paid_at: new Date(), state: 'SUCCEEDED' },
    });
    clearPermissionCache(org);
    return { org, tag, admin, dispatcher, customer, invoice };
  }

  /** Turn the "Apply credits" switch on for the dispatcher role (the catalog owns credit, so a stored role row no longer counts). */
  async function allowCredits(f: { org: string; admin: { id: string } }) {
    await setRoleSwitchValues({
      organizationId: f.org, roleKey: 'DISPATCHER', values: { apply_credits: true }, actorId: f.admin.id, reason: 'manual',
    });
    clearPermissionCache(f.org);
  }

  /** Turn the "Refund payments" switch on or off for the dispatcher role (the catalog owns refund, so a stored role row no longer counts). */
  async function setRefundSwitch(f: { org: string; admin: { id: string } }, on: boolean) {
    await setRoleSwitchValues({
      organizationId: f.org, roleKey: 'DISPATCHER', values: { refund_payments: on, view_payments: true }, actorId: f.admin.id, reason: 'manual',
    });
    clearPermissionCache(f.org);
  }

  const refundBody = { amount: 50, reason_category: 'CUSTOMER_REQUEST', reason: 'Customer asked' };

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_permission_overrides WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM role_permissions WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
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

  it('"Refund payments" is its own switch; turning it on lets the role refund, turning it off refuses again', async () => {
    const f = await orgWithPaidInvoice();

    // Without the switch, a direct call is refused and nothing is refunded.
    expect((await signedInAs(f.dispatcher).post(`/api/invoices/${f.invoice}/refund`, refundBody)).status).toBe(403);
    expect(await db.refund.count({ where: { organization_id: f.org } })).toBe(0);

    // The owner turns on only "Refund payments"; recording a payment is a switch of its own.
    await setRefundSwitch(f, true);
    expect((await signedInAs(f.dispatcher).post(`/api/invoices/${f.invoice}/refund`, refundBody)).status).toBe(200);
    expect(await db.refund.count({ where: { organization_id: f.org } })).toBe(1);

    // Turned off again, the next refund is refused.
    await setRefundSwitch(f, false);
    expect((await signedInAs(f.dispatcher).post(`/api/invoices/${f.invoice}/refund`, refundBody)).status).toBe(403);
    expect(await db.refund.count({ where: { organization_id: f.org } })).toBe(1);
  });
  /** Store one switch value on this person alone (their own set, over whatever their role says). */
  async function setPersonSwitch(f: { org: string }, user: { id: string }, key: string, value: boolean) {
    await db.permissionUserSwitch.upsert({
      where: { user_id_switch_key: { user_id: user.id, switch_key: key } },
      create: { organization_id: f.org, user_id: user.id, switch_key: key, value },
      update: { value },
    });
    clearPermissionCache(f.org);
  }

  it('"Refund payments" set on one dispatcher alone: that person refunds and the role\'s other people still cannot', async () => {
    const f = await orgWithPaidInvoice();
    const other = { id: randomUUID(), email: `dispatch2-${f.tag}@example.test` };
    await db.user.create({
      data: { id: other.id, organization_id: f.org, email: other.email, first_name: 'Other', last_name: 'Dispatcher', role: 'DISPATCHER' },
    });

    await setPersonSwitch(f, f.dispatcher, 'refund_payments', true);

    expect((await signedInAs(other).post(`/api/invoices/${f.invoice}/refund`, refundBody)).status).toBe(403);
    expect((await signedInAs(f.dispatcher).post(`/api/invoices/${f.invoice}/refund`, refundBody)).status).toBe(200);
  });

  it('a person with "Refund payments" off is refused even though their role holds it', async () => {
    const f = await orgWithPaidInvoice();
    await setRefundSwitch(f, true);
    await setPersonSwitch(f, f.dispatcher, 'refund_payments', false);

    expect((await signedInAs(f.dispatcher).post(`/api/invoices/${f.invoice}/refund`, refundBody)).status).toBe(403);
    expect((await signedInAs(f.dispatcher).get('/api/payments-needing-attention')).status).toBe(403);
    expect(await db.refund.count({ where: { organization_id: f.org } })).toBe(0);
  });
  it('the payments needing attention list follows the switch: refused without it, listed with it', async () => {
    const f = await orgWithPaidInvoice();
    expect((await signedInAs(f.dispatcher).get('/api/payments-needing-attention')).status).toBe(403);

    await setRefundSwitch(f, true);

    const listed = await signedInAs(f.dispatcher).get('/api/payments-needing-attention');
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([]);
  });

  it('a give-back that sends cash back is a refund: refused without the switch, and nothing is written', async () => {
    const f = await orgWithPaidInvoice();
    // The role may apply credits (a grant only an owner can hand out), but not refund.
    await allowCredits(f);
    clearPermissionCache(f.org);

    const cashBack = { amount: 50, reason: 'Goodwill', refund_instead: true };
    const refused = await signedInAs(f.dispatcher).post(`/api/invoices/${f.invoice}/credit`, cashBack);
    expect(refused.status).toBe(403);
    expect(await db.refund.count({ where: { organization_id: f.org } })).toBe(0);

    await setRefundSwitch(f, true);
    expect((await signedInAs(f.dispatcher).post(`/api/invoices/${f.invoice}/credit`, cashBack)).status).toBe(200);
    expect(await db.refund.count({ where: { organization_id: f.org } })).toBe(1);
  });

  it('a credit that only takes money off what is still owed sends nothing back, so it needs no refund permission', async () => {
    const f = await orgWithPaidInvoice();
    await db.invoice.update({ where: { id: f.invoice }, data: { status: 'PARTIAL', total_amount: 300, subtotal: 300, amount_due: 100 } });
    await allowCredits(f);
    clearPermissionCache(f.org);

    const res = await signedInAs(f.dispatcher).post(`/api/invoices/${f.invoice}/credit`, { amount: 40, reason: 'Goodwill' });
    expect(res.status).toBe(200);
  });
});
