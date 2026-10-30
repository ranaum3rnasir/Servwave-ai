/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.14 - the closed-lead lock on the lead's own contact entries.

   On a Won or Lost lead (and a Cancelled one until that status is retired) every write to the lead's own phones, emails,
   name and company is refused for everyone: no switch overrides it, and Change locked jobs, which is about jobs, never
   applies. The two walkthrough statuses are open. The customer's own record never locks.

   Everything goes through the lead routes, called as people on custom roles (never a built-in role name) holding the
   switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it
   creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { LeadStatus, PrismaClient } from '@prisma/client';

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
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog on (a choice at its widest option, a list empty): the lock must hold against all of them. */
const ALL_ON: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [
    s.key,
    s.kind === 'choice' ? (s.choices!.includes('all') ? 'all' : s.choices![s.choices!.length - 1]!) : s.kind === 'list' ? [] : true,
  ]),
);

/** The wording the slice gives the refusal (the PRD's own text, not read from the code). */
const CLOSED_MESSAGE = 'This lead is closed. Reopen it to change it.';

suite("the closed-lead lock on a lead's own entries (real database)", () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding these switch values on top of the Technician preset. */
  async function personWith(org: string, values: Record<string, SwitchValue>): Promise<Person> {
    const key = `lead-lock-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    return fx.addUser(org, `llk${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
  }

  /** A lead the person owns, on a customer with a phone and an email, holding one live phone entry. */
  async function setup(status: LeadStatus, values: Record<string, SwitchValue> = ALL_ON) {
    const { org, customer } = await fx.newOrg();
    await db.customer.update({
      where: { id: customer },
      data: { phone: '6175550101', email: 'pat@example.test', first_name: 'Pat', last_name: 'Jones', company_name: 'Jones Hardware' },
    });
    const me = await personWith(org, values);
    const lead = await fx.addLead(org, customer, { owner: me.id });
    const api = await fx.signedInAs(me);
    const seeded = await api.post(`/api/leads/${lead.id}/contact-entries`, { kind: 'PHONE', value: '6175550199' });
    expect(seeded.status).toBe(201);
    const entryId = (seeded.body.entries as { id: string }[])[0]!.id;
    await db.lead.update({ where: { id: lead.id }, data: { status } });
    return { org, customer, me, lead, api, entryId };
  }

  const base = (leadId: string) => `/api/leads/${leadId}/contact-entries`;

  /** Every write to a lead's own entries, as the call a control makes. */
  const WRITES: Record<string, (api: Api, leadId: string, entryId: string) => Promise<{ status: number; body: Record<string, unknown> }>> = {
    'add a phone': (api, id) => api.post(base(id), { kind: 'PHONE', value: '6175550123' }),
    'add an email': (api, id) => api.post(base(id), { kind: 'EMAIL', value: 'wife@example.test' }),
    "change the customer's phone": (api, id) => api.post(`${base(id)}/change`, { kind: 'PHONE', replaces: '6175550101', value: '6175550188' }),
    "change the customer's name": (api, id) => api.post(`${base(id)}/name`, { kind: 'FIRST_NAME', value: 'Patrick' }),
    'correct an entry': (api, id, entryId) => api.patch(`${base(id)}/${entryId}`, { label: 'Wife' }),
    'remove an entry': (api, id, entryId) => api.delete(`${base(id)}/${entryId}`),
  };

  const entryCount = (leadId: string) => db.recordContactEntry.count({ where: { lead_id: leadId } });
  const liveCount = (leadId: string) => db.recordContactEntry.count({ where: { lead_id: leadId, removed_at: null } });

  for (const status of ['WON', 'LOST'] as const) {
    describe(`a ${status} lead`, () => {
      for (const [name, write] of Object.entries(WRITES)) {
        it(`refuses "${name}" for a person holding every switch, Change locked jobs included`, async () => {
          const { lead, api, entryId } = await setup(status);
          expect(ALL_ON.change_locked_jobs).toBe(true);

          const res = await write(api, lead.id, entryId);

          expect(res.status).toBe(403);
          expect(res.body.error).toBe(CLOSED_MESSAGE);
          expect(res.body.code).toBe('LEAD_CLOSED');
        });
      }

      it('changes nothing and writes no history when a write is refused', async () => {
        const { lead, api, entryId } = await setup(status);
        const timelineBefore = (await api.get(`/api/leads/${lead.id}/timeline`)).body.events.length;

        for (const write of Object.values(WRITES)) await write(api, lead.id, entryId);

        expect(await entryCount(lead.id)).toBe(1);
        expect(await liveCount(lead.id)).toBe(1);
        expect((await api.get(`/api/leads/${lead.id}/timeline`)).body.events.length).toBe(timelineBefore);
      });
    });
  }

  for (const status of ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'] as const) {
    it(`accepts every write on a ${status} lead under the ordinary switches`, async () => {
      const { lead, api, entryId } = await setup(status);

      const results: Record<string, number> = {};
      for (const name of ['add a phone', 'add an email', "change the customer's phone", "change the customer's name", 'correct an entry', 'remove an entry']) {
        results[name] = (await WRITES[name]!(api, lead.id, entryId)).status;
      }

      expect(results).toEqual({
        'add a phone': 201,
        'add an email': 201,
        "change the customer's phone": 201,
        "change the customer's name": 201,
        'correct an entry': 200,
        'remove an entry': 200,
      });
    });
  }

  it('lifts the lock when the lead is open again, and puts it back when it closes again', async () => {
    const { lead, api } = await setup('LOST');
    expect((await WRITES['add an email']!(api, lead.id, '')).status).toBe(403);

    await db.lead.update({ where: { id: lead.id }, data: { status: 'CONTACTED' } });
    expect((await WRITES['add an email']!(api, lead.id, '')).status).toBe(201);

    await db.lead.update({ where: { id: lead.id }, data: { status: 'WON' } });
    expect((await WRITES['add a phone']!(api, lead.id, '')).status).toBe(403);
  });

  it('keeps the ordinary refusal first: a person without the switch is told they lack permission, not that the lead is closed', async () => {
    const { org, lead } = await setup('LOST');
    const nobody = await personWith(org, { ...ALL_ON, edit_job_and_lead_contact_details: false, change_lead_status_by_hand: false, edit_leads: false, create_leads: false, leads_scope: 'all' });

    const res = await WRITES['add a phone']!(await fx.signedInAs(nobody), lead.id, '');

    expect(res.status).toBe(403);
    expect(res.body.error).not.toBe(CLOSED_MESSAGE);
    expect(res.body.code).toBeUndefined();
  });

  it('never tells anyone the status of a lead they cannot open: not found, the same as across companies', async () => {
    const { org, lead } = await setup('LOST');
    await db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: null } });
    const scoped = await personWith(org, { ...ALL_ON, leads_scope: 'attached' });

    const off = await WRITES['add a phone']!(await fx.signedInAs(scoped), lead.id, '');
    expect(off.status).toBe(404);
    expect(off.body.error).not.toBe(CLOSED_MESSAGE);

    const other = await fx.newOrg();
    const foreign = await fx.addLead(other.org, other.customer, {});
    await db.lead.update({ where: { id: foreign.id }, data: { status: 'LOST' } });
    const across = await WRITES['add a phone']!(await fx.signedInAs(scoped), foreign.id, '');
    expect(across.status).toBe(404);
    expect(across.body.error).not.toBe(CLOSED_MESSAGE);
  });

  it("refuses a closed lead's creator, still attached, the same way", async () => {
    const { org, customer } = await fx.newOrg();
    const creator = await personWith(org, { ...ALL_ON, change_lead_status_by_hand: false });
    const lead = await fx.addLead(org, customer, { createdBy: creator.id, assignees: [creator.id] });
    await db.lead.update({ where: { id: lead.id }, data: { status: 'WON' } });

    const res = await WRITES["change the customer's name"]!(await fx.signedInAs(creator), lead.id, '');

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(CLOSED_MESSAGE);
  });

  it("never locks the customer's own record: a person with Edit customers still changes the phone and email", async () => {
    const { customer, api } = await setup('LOST');
    const before = await db.customer.findUniqueOrThrow({ where: { id: customer } });

    const res = await api.patch(`/api/customers/${customer}`, { phone: '6175550177', email: 'new@example.test' });

    expect(res.status).toBe(200);
    const after = await db.customer.findUniqueOrThrow({ where: { id: customer } });
    expect(before.phone).toBe('6175550101');
    expect(after.phone).toBe('6175550177');
    expect(after.email).toBe('new@example.test');
  });

  it('still returns the closed lead entries on the lead detail', async () => {
    const { lead, api } = await setup('WON');

    const res = await api.get(`/api/leads/${lead.id}`);

    expect(res.status).toBe(200);
    expect((res.body.lead.contact_entries as { value: string }[]).map((e) => e.value)).toEqual(['6175550199']);
  });
});
