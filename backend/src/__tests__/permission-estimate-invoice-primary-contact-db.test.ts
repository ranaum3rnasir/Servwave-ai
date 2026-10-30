/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.4 - the estimate and invoice detail answers carry the customer's
   PRIMARY phone and primary email only, and carry them to a person who can open the record even when
   Customers View is off. The job detail's full contact set (S05.1) does not leak into either answer.

   Everything goes through the estimate and invoice detail routes, called as people on custom roles (never a
   built-in role name) whose switch values are the ones under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { findSwitch } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('estimate and invoice details carry the primary phone and email only (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role who cannot view customers, and reaches only what is attached to them. */
  async function personWithoutCustomers(org: string): Promise<Person> {
    const key = `epc-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({
      organizationId: org,
      roleKey: key,
      values: {
        view_customers: false, view_estimates: true, view_invoices: true,
        leads_scope: 'attached', jobs_scope: 'attached',
      },
      actorId: null,
      reason: 'manual',
    });
    return fx.addUser(org, `epc${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
  }

  /** The org's customer, given a full contact set: a second number and a list of phones and emails. */
  async function fillContactSet(customer: string) {
    await db.customer.update({
      where: { id: customer },
      data: { phone: '+16175550101', secondary_phone: '+16175550102', email: 'pat@example.test' },
    });
    await db.customerPhone.createMany({
      data: [
        { customer_id: customer, phone: '+16175550101', label: 'Mobile', is_primary: true },
        { customer_id: customer, phone: '+16175550103', label: "Wife's cell", is_primary: false },
      ],
    });
    await db.customerEmail.create({ data: { customer_id: customer, email: 'billing@example.test', label: 'Billing' } });
  }

  const PRIMARY_ONLY = (customer: Record<string, unknown>) => {
    expect(customer).toMatchObject({ phone: '+16175550101', email: 'pat@example.test' });
    expect(customer).not.toHaveProperty('phones');
    expect(customer).not.toHaveProperty('emails');
    expect(customer).not.toHaveProperty('secondary_phone');
  };

  it('sends the invoice customer\'s primary phone and email, and no other number or address, to a person with View customers off', async () => {
    const { org, customer } = await fx.newOrg();
    await fillContactSet(customer);
    expect(findSwitch('view_customers')).toBeDefined();
    const me = await personWithoutCustomers(org);
    const job = await fx.addJob(org, customer, { crew: [me.id] });
    const invoice = await fx.addInvoice(org, customer, { jobId: job.id });

    const res = await (await fx.signedInAs(me)).get(`/api/invoices/${invoice.id}`);

    expect(res.status).toBe(200);
    PRIMARY_ONLY(res.body.invoice.customer);
    if (res.body.invoice.job?.customer) PRIMARY_ONLY(res.body.invoice.job.customer);
  });

  it('sends the estimate customer\'s primary phone and email, and no other number or address, to a person with View customers off', async () => {
    const { org, customer, admin } = await fx.newOrg();
    await fillContactSet(customer);
    const me = await personWithoutCustomers(org);
    const lead = await fx.addLead(org, customer, { assignees: [me.id] });
    const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });

    const res = await (await fx.signedInAs(me)).get(`/api/estimates/${estimate.id}`);

    expect(res.status).toBe(200);
    PRIMARY_ONLY(res.body.estimate.customer ?? res.body.estimate.lead.customer);
    if (res.body.estimate.lead?.customer) PRIMARY_ONLY(res.body.estimate.lead.customer);
  });
});
