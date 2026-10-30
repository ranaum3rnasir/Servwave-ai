/* =============================================================================
   Payments go-live, slice W4 - POST /api/invoices/:id/mark-sent ("Mark as sent").

   A DRAFT the office delivered outside the app is marked sent without an email: it becomes SENT
   (or PAID when its deposit credit covers it), gets its sent date, a public token and a due date,
   and writes one history line and one audit row. It rides the Send grant (`edit_invoices` plus the
   creator rule), exactly as the estimate twin does. Driven through the real route as people on
   custom roles, against a real, migrated database (TEST_DATABASE_URL); skips when it is unset.
   Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
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

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { sendInvoiceEmail } from '../lib/email';
import { dispatchAutomationEvent } from '../services/automations/dispatch';

const suite = realClient ? describe : describe.skip;

suite('POST /api/invoices/:id/mark-sent (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  beforeEach(() => {
    vi.mocked(sendInvoiceEmail).mockClear();
    vi.mocked(dispatchAutomationEvent).mockClear();
  });

  let sequence = 0;
  /** A person on a fresh custom role holding exactly these switch values on top of the base role's preset. */
  async function personWith(org: string, values: Record<string, boolean | string>) {
    const key = `w4-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    clearPermissionCache(org);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `w4p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return { person, api: () => fx.signedInAs(person) };
  }
  const read = (id: string) => db.invoice.findUniqueOrThrow({ where: { id } });

  it('an admin marks a DRAFT as sent: SENT, sent date, token and due date set, one history line, one audit row, no email', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const api = await fx.signedInAs(admin);
    const inv = await fx.addInvoice(org, customer);

    const res = await api.post(`/api/invoices/${inv.id}/mark-sent`);

    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('SENT');
    const after = await read(inv.id);
    expect(after.status).toBe('SENT');
    expect(after.sent_at).not.toBeNull();
    expect(after.public_token).not.toBeNull();
    expect(after.due_date).not.toBeNull();
    const rows = await db.timelineEvent.findMany({ where: { organization_id: org, entity_id: inv.id, event_type: 'INVOICE_SENT' } });
    expect(rows.map((r) => r.description)).toEqual([`Invoice ${after.invoice_number} marked as sent (no email sent)`]);
    expect(await db.auditLog.count({ where: { org_id: org, action: 'invoice.marked_sent', resource_id: inv.id } })).toBe(1);
    expect(sendInvoiceEmail).not.toHaveBeenCalled();
  });

  it('keeps a token the invoice already has (a payment link made earlier) and fires the invoice-sent automation event once', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const api = await fx.signedInAs(admin);
    const inv = await fx.addInvoice(org, customer);
    expect((await api.post(`/api/invoices/${inv.id}/payment-link`)).status).toBe(200);
    const linked = await read(inv.id);
    expect(linked.status).toBe('DRAFT');

    expect((await api.post(`/api/invoices/${inv.id}/mark-sent`)).status).toBe(200);

    const after = await read(inv.id);
    expect(after.status).toBe('SENT');
    expect(after.public_token).toBe(linked.public_token);
    expect(dispatchAutomationEvent).toHaveBeenCalledTimes(1);
    expect(dispatchAutomationEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'INVOICE_SENT', organizationId: org, entity: expect.objectContaining({ type: 'invoice', id: inv.id }),
    }));
  });

  it('Send on a DRAFT that already has a payment link keeps that link alive (same token)', async () => {
    const { org, customer, admin } = await fx.newOrg();
    await db.customer.update({ where: { id: customer }, data: { email: 'delivered@resend.dev' } });
    // Send goes out from the sender's own mailbox (PRD 10, S10.12); mark-sent sends nothing, so only these cases need one.
    await fx.addUserMailbox(org, admin);
    const api = await fx.signedInAs(admin);
    const inv = await fx.addInvoice(org, customer);
    expect((await api.post(`/api/invoices/${inv.id}/payment-link`)).status).toBe(200);
    const linked = await read(inv.id);
    expect(linked.status).toBe('DRAFT');
    expect(linked.public_token).not.toBeNull();

    const res = await api.post(`/api/invoices/${inv.id}/send`).send({});

    expect(res.status).toBe(200);
    const after = await read(inv.id);
    expect(after.status).toBe('SENT');
    expect(after.public_token).toBe(linked.public_token);
    expect(vi.mocked(sendInvoiceEmail).mock.calls[0][0].publicUrl).toContain(`token=${linked.public_token}`);
  });

  it('Send refuses with 409 when a payment lands while the email goes out, and leaves the paid status, sent date and history alone', async () => {
    const { org, customer, admin } = await fx.newOrg();
    await db.customer.update({ where: { id: customer }, data: { email: 'delivered@resend.dev' } });
    // Send goes out from the sender's own mailbox (PRD 10, S10.12); mark-sent sends nothing, so only these cases need one.
    await fx.addUserMailbox(org, admin);
    const api = await fx.signedInAs(admin);
    const inv = await fx.addInvoice(org, customer);
    expect((await api.post(`/api/invoices/${inv.id}/payment-link`)).status).toBe(200);
    const paidAt = new Date('2026-01-02T03:04:05Z');
    // The customer pays on the link while the email is still being sent.
    vi.mocked(sendInvoiceEmail).mockImplementationOnce(async () => {
      await db.invoice.update({ where: { id: inv.id }, data: { status: 'PAID', amount_due: 0, paid_at: paidAt } });
      return { status: 'sent' } as never;
    });

    const res = await api.post(`/api/invoices/${inv.id}/send`).send({});

    expect(res.status).toBe(409);
    const after = await read(inv.id);
    expect(after.status).toBe('PAID');
    expect(after.sent_at).toBeNull();
    expect(await db.timelineEvent.count({ where: { organization_id: org, entity_id: inv.id, event_type: 'INVOICE_SENT' } })).toBe(0);
    expect(dispatchAutomationEvent).not.toHaveBeenCalled();
  });

  it('a DRAFT whose deposit credit covers the whole balance goes to PAID, with a paid date', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const api = await fx.signedInAs(admin);
    const inv = await fx.addInvoice(org, customer);
    await db.invoice.update({ where: { id: inv.id }, data: { deposit_credit: 100, amount_due: 0 } });

    expect((await api.post(`/api/invoices/${inv.id}/mark-sent`)).status).toBe(200);

    const after = await read(inv.id);
    expect(after.status).toBe('PAID');
    expect(after.paid_at).not.toBeNull();
    expect(after.sent_at).not.toBeNull();
  });

  it('refuses anything but a DRAFT with 409, and repeating it writes no second history line', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const api = await fx.signedInAs(admin);
    const inv = await fx.addInvoice(org, customer);
    expect((await api.post(`/api/invoices/${inv.id}/mark-sent`)).status).toBe(200);

    const again = await api.post(`/api/invoices/${inv.id}/mark-sent`);

    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/draft/i);
    expect(await db.timelineEvent.count({ where: { organization_id: org, entity_id: inv.id, event_type: 'INVOICE_SENT' } })).toBe(1);
    expect(dispatchAutomationEvent).toHaveBeenCalledTimes(1);
    for (const status of ['PARTIAL', 'PAID', 'VOIDED'] as const) {
      const other = await fx.addInvoice(org, customer);
      await db.invoice.update({ where: { id: other.id }, data: { status } });
      expect((await api.post(`/api/invoices/${other.id}/mark-sent`)).status, status).toBe(409);
      expect((await read(other.id)).status).toBe(status);
    }
  });

  it('answers 404 for another organization\'s invoice and leaves it untouched', async () => {
    const mine = await fx.newOrg();
    const theirs = await fx.newOrg();
    const api = await fx.signedInAs(mine.admin);
    const inv = await fx.addInvoice(theirs.org, theirs.customer);

    const res = await api.post(`/api/invoices/${inv.id}/mark-sent`);

    expect(res.status).toBe(404);
    expect((await read(inv.id)).status).toBe('DRAFT');
  });

  it('is refused (403) for someone without the Send grant who is not the creator, and allowed for the creator who lacks the switch', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { invoices_scope: 'all', edit_invoices: false });
    const api = await me.api();
    const colleagues = await fx.addInvoice(org, customer, { createdBy: admin.id });
    const mine = await fx.addInvoice(org, customer, { createdBy: me.person.id });

    expect((await api.post(`/api/invoices/${colleagues.id}/mark-sent`)).status).toBe(403);
    expect((await read(colleagues.id)).status).toBe('DRAFT');
    expect((await api.post(`/api/invoices/${mine.id}/mark-sent`)).status).toBe(200);
    expect((await read(mine.id)).status).toBe('SENT');
  });

  it('with the Send switch on, marks someone else\'s DRAFT as sent', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { invoices_scope: 'all', edit_invoices: true });
    const inv = await fx.addInvoice(org, customer, { createdBy: admin.id });

    expect((await (await me.api()).post(`/api/invoices/${inv.id}/mark-sent`)).status).toBe(200);
  });

  it('the invoice payload lists "send" in its actions for exactly the people who may mark it sent (W5 draws the button from it)', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const api = await fx.signedInAs(admin);
    const reader = await personWith(org, { invoices_scope: 'all', edit_invoices: false });
    const inv = await fx.addInvoice(org, customer, { createdBy: admin.id });

    expect((await api.get(`/api/invoices/${inv.id}`)).body.invoice.actions).toContain('send');
    expect((await (await reader.api()).get(`/api/invoices/${inv.id}`)).body.invoice.actions).not.toContain('send');
  });
});
