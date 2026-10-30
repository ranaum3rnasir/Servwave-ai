/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.2 - the lead detail carries the customer's full contact set.

   Everything goes through the lead detail route, called as people on custom roles (never a built-in role
   name) whose switch values are the ones under test. Real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
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

suite('the lead detail carries the customer contact set (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values on top of the Technician preset. */
  async function personWith(org: string, values: Record<string, boolean | string>): Promise<Person> {
    const key = `lcc-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    return fx.addUser(org, `lcc${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
  }

  /** The org's customer, given a full set of phones and emails. */
  async function fillContactSet(customer: string) {
    await db.customer.update({
      where: { id: customer },
      data: {
        phone: '+16175550101', phone_ext: '12', secondary_phone: '+16175550102', secondary_phone_ext: null,
        email: 'pat@example.test',
      },
    });
    await db.customerPhone.createMany({
      data: [
        // The same number as the primary, so it must not show twice.
        { customer_id: customer, phone: '+16175550101', label: 'Mobile', extension: '12', is_primary: true },
        { customer_id: customer, phone: '+16175550103', label: "Wife's cell", extension: null, is_primary: false },
      ],
    });
    await db.customerEmail.create({ data: { customer_id: customer, email: 'billing@example.test', label: 'Billing' } });
  }

  it('returns every phone with label and extension and every email to a lead owner with View customers off', async () => {
    const { org, customer } = await fx.newOrg();
    await fillContactSet(customer);
    // Read from the catalog, not assumed: the switch the person is missing really is View customers.
    expect(findSwitch('view_customers')).toBeDefined();
    const me = await personWith(org, { view_customers: false, leads_scope: 'attached' });
    const lead = await fx.addLead(org, customer, { owner: me.id });

    const res = await (await fx.signedInAs(me)).get(`/api/leads/${lead.id}`);

    expect(res.status).toBe(200);
    const body = res.body.lead.customer as {
      phones: { phone: string; label: string | null; extension: string | null; is_primary: boolean }[];
      emails: { email: string; label: string | null; is_primary: boolean }[];
    };
    expect(body.phones).toEqual([
      { phone: '+16175550101', label: 'Mobile', extension: '12', is_primary: true },
      { phone: '+16175550102', label: null, extension: null, is_primary: false },
      { phone: '+16175550103', label: "Wife's cell", extension: null, is_primary: false },
    ]);
    expect(body.emails).toEqual([
      { email: 'pat@example.test', label: null, is_primary: true },
      { email: 'billing@example.test', label: 'Billing', is_primary: false },
    ]);
    // The raw lists the select reads are folded into those two, never sent beside them.
    expect(res.body.lead.customer).not.toHaveProperty('extra_emails');
    expect(res.body.lead.customer).not.toHaveProperty('secondary_phone');
  });

  it('returns empty lists for a customer with no phone and no email', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { view_customers: false, leads_scope: 'attached' });
    const lead = await fx.addLead(org, customer, { owner: me.id });

    const res = await (await fx.signedInAs(me)).get(`/api/leads/${lead.id}`);

    expect(res.status).toBe(200);
    expect(res.body.lead.customer.phones).toEqual([]);
    expect(res.body.lead.customer.emails).toEqual([]);
  });

  it('carries the same set on the answer to a write that returns the lead', async () => {
    const { org, customer } = await fx.newOrg();
    await fillContactSet(customer);
    const me = await personWith(org, { view_customers: false, leads_scope: 'attached', edit_leads: true });
    const lead = await fx.addLead(org, customer, { owner: me.id });

    const res = await (await fx.signedInAs(me)).patch(`/api/leads/${lead.id}`).send({ service_request: 'Fix the gate' });

    expect(res.status).toBe(200);
    expect(res.body.lead.customer.phones).toHaveLength(3);
    expect(res.body.lead.customer.emails).toHaveLength(2);
  });

  it('answers not found to a person who is not on the lead, the same as for another company or a missing id', async () => {
    const { org, customer } = await fx.newOrg();
    await fillContactSet(customer);
    const me = await personWith(org, { view_customers: false, leads_scope: 'attached' });
    const lead = await fx.addLead(org, customer, {});

    const refused = await (await fx.signedInAs(me)).get(`/api/leads/${lead.id}`);
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.body)).not.toContain('example.test');

    const other = await fx.newOrg();
    const foreignLead = await fx.addLead(other.org, other.customer, {});
    expect((await (await fx.signedInAs(me)).get(`/api/leads/${foreignLead.id}`)).status).toBe(404);
    expect((await (await fx.signedInAs(me)).get(`/api/leads/${randomUUID()}`)).status).toBe(404);
  });
});
