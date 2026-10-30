/* =============================================================================
   Roles & Permissions security fixes, ticket 33b: editing a service plan keeps its customer and its address.

   Ran, 2026-10-29: "editing a plan can no longer change its customer or address". A PATCH that names `customer_id` or
   `service_location_id` is refused with one validation answer, whatever the id is: another customer of the company, a
   customer of another company, an id that does not exist, or a customer the person cannot read. Nothing is looked up for
   it, so the answers cannot differ, nothing is stored, and no other company's name or street comes back. The edits the
   plan screens make (the materials, and the other draft fields) still work.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, presetSwitchSet, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

suite('editing a service plan keeps its customer and address (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  let org = '';
  let customer = '';
  let admin: Person;
  /** Every switch on, every scope Their own: may edit any plan, reads only some customers. */
  let narrow: Person;
  let otherOrg: { customer: string; loc: string };

  afterAll(async () => {
    await db.servicePlanMaterialLine.deleteMany({ where: { organization_id: org } }).catch(() => undefined);
    await db.priceBookItem.deleteMany({ where: { organization_id: org } }).catch(() => undefined);
    await fx.cleanup();
  });

  async function location(customerId: string, street: string) {
    const id = randomUUID();
    await db.serviceLocation.create({ data: { id, customer_id: customerId, address_line1: street, city: 'Testville', state: 'MA', zip: '02108' } });
    return id;
  }
  async function newCustomer(orgId: string, name: string) {
    const id = randomUUID();
    await db.customer.create({ data: { id, organization_id: orgId, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: name, last_name: 'Elsewhere' } });
    return id;
  }

  beforeAll(async () => {
    const o = await fx.newOrg();
    ({ org, customer, admin } = o);
    const values: Record<string, SwitchValue> = { ...presetSwitchSet('ADMIN') } as Record<string, SwitchValue>;
    for (const s of SWITCH_CATALOG) if (s.kind === 'choice' && s.key.endsWith('_scope')) values[s.key] = 'attached';
    await fx.addCustomRole(org, 'plan-editor', 'DISPATCHER');
    await fx.setRoleSwitches(org, 'plan-editor', values);
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key: 'plan-editor' } });
    narrow = await fx.addUser(org, 'planeditor', 'DISPATCHER', { customRoleId: role.id });

    const other = await fx.newOrg();
    otherOrg = { customer: other.customer, loc: await location(other.customer, '77 Other Company St') };
  }, 120_000);

  /** A draft plan on the company's customer, at its first address. */
  async function draftPlan() {
    const plan = await fx.addServicePlan(org, customer, {});
    await db.servicePlan.update({ where: { id: plan.id }, data: { status: 'DRAFT' } });
    return plan;
  }

  const stored = (id: string) => db.servicePlan.findUniqueOrThrow({ where: { id }, select: { customer_id: true, service_location_id: true, updated_at: true } });

  type Target = { name: string; who: () => Person; ids: () => Promise<{ customer_id: string; service_location_id: string }> };
  const targets: Target[] = [
    {
      name: 'another customer of the company',
      who: () => admin,
      ids: async () => { const c = await newCustomer(org, 'Sibling'); return { customer_id: c, service_location_id: await location(c, '12 Sibling Rd') }; },
    },
    { name: "another company's customer and address", who: () => admin, ids: async () => ({ customer_id: otherOrg.customer, service_location_id: otherOrg.loc }) },
    { name: 'ids that do not exist', who: () => admin, ids: async () => ({ customer_id: randomUUID(), service_location_id: randomUUID() }) },
    {
      name: 'a customer the person cannot read',
      who: () => narrow,
      ids: async () => { const c = await newCustomer(org, 'Unread'); return { customer_id: c, service_location_id: await location(c, '9 Unread Ln') }; },
    },
  ];

  for (const fields of [['customer_id', 'service_location_id'], ['customer_id'], ['service_location_id']] as const) {
    it(`a draft edit naming ${fields.join(' and ')} is refused the same way for every kind of id, and changes nothing`, async () => {
      const answers: { name: string; status: number; body: string }[] = [];
      for (const t of targets) {
        const plan = await draftPlan();
        const before = await stored(plan.id);
        const ids = await t.ids();
        const body = Object.fromEntries(fields.map((f) => [f, ids[f]]));
        const res = await (await fx.signedInAs(t.who())).patch(`/api/service-plans/${plan.id}`, { ...body, name: 'Renamed' });
        let text = JSON.stringify(res.body);
        for (const v of Object.values(body)) text = text.split(v).join('<id>');
        answers.push({ name: t.name, status: res.status, body: text });
        expect(await stored(plan.id), t.name).toEqual(before);
        expect(text, t.name).not.toContain('Other Company');
        expect(res.status, t.name).not.toBe(500);
      }
      // One answer for all four: nothing tells one kind of id from another.
      expect(new Set(answers.map((a) => `${a.status} ${a.body}`)).size, JSON.stringify(answers)).toBe(1);
      expect(answers[0]!.status).toBe(400);
    });
  }

  it('an active plan refuses the fields the same way', async () => {
    const plan = await fx.addServicePlan(org, customer, {}); // ACTIVE
    const before = await stored(plan.id);
    const res = await (await fx.signedInAs(admin)).patch(`/api/service-plans/${plan.id}`, { customer_id: otherOrg.customer, service_location_id: otherOrg.loc });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('Other Company');
    expect(await stored(plan.id)).toEqual(before);
  });

  it('the edits the plan screens make still work: materials, and the other draft fields', async () => {
    const plan = await draftPlan();
    const item = await db.priceBookItem.create({
      data: { organization_id: org, name: 'Filter', sku: `F-${plan.id.slice(0, 6)}`, type: 'MATERIAL', unit_price: 5, track_inventory: true },
      select: { id: true },
    });
    const api = await fx.signedInAs(admin);
    const materials = await api.patch(`/api/service-plans/${plan.id}`, { material_lines: [{ item_id: item.id, qty: 2 }] });
    expect(materials.status, JSON.stringify(materials.body)).toBe(200);
    expect(await db.servicePlanMaterialLine.count({ where: { service_plan_id: plan.id } })).toBe(1);

    const fields = await (await fx.signedInAs(admin)).patch(`/api/service-plans/${plan.id}`, { name: 'Twice a year', contract_price: 250, visit_cadence: 'SEMIANNUAL' });
    expect(fields.status, JSON.stringify(fields.body)).toBe(200);
    expect(fields.body.servicePlan).toMatchObject({ name: 'Twice a year', visit_cadence: 'SEMIANNUAL' });
    expect((await db.servicePlan.findUniqueOrThrow({ where: { id: plan.id } })).customer_id).toBe(customer);
  });
});
