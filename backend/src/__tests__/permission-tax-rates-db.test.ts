/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.22 - Tax rates load on forms; tax settings stay with Company settings.

   Everything goes through the public interface: the routes, called as a person on a custom role (never a
   built-in role name) who can create estimates and invoices but does NOT hold Company settings. Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
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
// ...and so is the numbering allocator (the setup's stub hands every document the same number).
vi.unmock('../lib/numbering');

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const COMPANY_SETTINGS = keyOf('Company settings');
const FORM_SWITCHES = ['View estimates', 'Create estimates', 'Standalone estimates', 'View invoices', 'Create invoices', 'Standalone invoices'].map(keyOf);

suite('tax rates load on the estimate and invoice forms; tax settings stay with Company settings (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role made from blank, holding exactly these switches on and every other off. */
  async function personWith(org: string, on: string[]): Promise<Person & { api: () => Promise<Api> }> {
    const key = `tax-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'SALES', { madeFromBlank: true, copyGrants: false });
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    const values = { ...allOff, ...Object.fromEntries(on.map((k) => [k, true])) };
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `t${sequence}`, 'SALES', { customRoleId: role.id, basedOnRoleKey: key });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** An org whose own Massachusetts rate differs from the national list, and a customer with a service location there. */
  async function orgWithLocalRate() {
    const made = await fx.newOrg();
    const rate = await db.orgTaxRate.create({
      data: { organization_id: made.org, name: 'Boston combined', rate: 0.0825, state_code: 'MA' },
    });
    await db.serviceLocation.create({
      data: { id: randomUUID(), customer_id: made.customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108', is_primary: true },
    });
    return { ...made, rate };
  }

  const taxableLine = [{ description: 'Service', quantity: 1, unit_price: 100, is_taxable: true }];

  it('gives a person without Company settings the org tax rates the forms\' pickers fill from', async () => {
    const { org, rate } = await orgWithLocalRate();
    const person = await personWith(org, FORM_SWITCHES);
    const api = await person.api();

    const picker = await api.get('/api/state-tax-rates');
    expect(picker.status).toBe(200);
    expect(JSON.stringify(picker.body)).toContain(rate.name);
    expect((await api.get('/api/org-tax-rates')).status).toBe(200);
  });

  it('prices an estimate at the chosen org rate for a person without Company settings', async () => {
    const { org, customer } = await orgWithLocalRate();
    const person = await personWith(org, FORM_SWITCHES);

    const res = await (await person.api()).post('/api/estimates', { customer_id: customer, tax_rate: 0.0825, line_items: taxableLine });
    expect(res.status).toBe(201);
    expect(Number(res.body.estimate.tax_rate)).toBeCloseTo(0.0825, 6);
    expect(Number(res.body.estimate.total_amount)).toBeCloseTo(108.25, 2);
  });

  it('prices an invoice at the org rate for the customer\'s location for a person without Company settings', async () => {
    const { org, customer } = await orgWithLocalRate();
    const person = await personWith(org, FORM_SWITCHES);

    const res = await (await person.api()).post('/api/invoices', { customer_id: customer, line_items: taxableLine });
    expect(res.status).toBe(201);
    expect(Number(res.body.invoice.tax_rate)).toBeCloseTo(0.0825, 6);
    expect(Number(res.body.invoice.tax_amount)).toBeCloseTo(8.25, 2);
    expect(Number(res.body.invoice.total_amount)).toBeCloseTo(108.25, 2);
  });

  it('refuses the tax settings writes (add, edit, delete) without Company settings, and lets them through with it', async () => {
    const { org, rate } = await orgWithLocalRate();
    const without = await (await personWith(org, FORM_SWITCHES)).api();

    expect((await without.post('/api/org-tax-rates', { name: 'Nope', rate: 0.01 })).status).toBe(403);
    expect((await without.patch(`/api/org-tax-rates/${rate.id}`, { rate: 0.2 })).status).toBe(403);
    expect((await without.delete(`/api/org-tax-rates/${rate.id}`)).status).toBe(403);
    expect(Number((await db.orgTaxRate.findUniqueOrThrow({ where: { id: rate.id } })).rate)).toBeCloseTo(0.0825, 6);

    const withIt = await (await personWith(org, [...FORM_SWITCHES, COMPANY_SETTINGS])).api();
    expect((await withIt.post('/api/org-tax-rates', { name: 'Yes', rate: 0.01 })).status).toBe(201);
    expect((await withIt.patch(`/api/org-tax-rates/${rate.id}`, { rate: 0.09 })).status).toBe(200);
  });
});
