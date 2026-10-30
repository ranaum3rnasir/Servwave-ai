/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.15 - the creator pre-fill rule and the new-lead form's Owner and
   Dispatcher.

   One shared rule says where a creator lands on what they make: Can own leads / be Sold By on gives Owner;
   off with Can be a dispatcher on gives Dispatcher; both off gives Owner; both on (the Admin preset) gives
   Owner, never Dispatcher. The new-lead form shows that result and the create route applies the same rule, so
   what the form shows is what is saved: a person with Assign people to leads saves what they submit (each newly
   named person through slot eligibility), anyone else gets the rule whatever the request names.

   Every case uses people on custom roles whose base role and slot switch disagree (a Dispatcher base with Can
   own leads on, a Technician base with it off), so no role-name or base-role check can pass. Everything goes
   through the lead routes. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every
   org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';

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
// ...and so is the numbering allocator (the setup's stub hands every lead the same number, so a second lead in a
// company would collide on it).
vi.unmock('../lib/numbering');

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = realClient ? describe : describe.skip;

const NOT_OWNER = "This person can't own leads or be Sold By.";
const NOT_DISPATCHER = "This person can't be a dispatcher.";
const INACTIVE = 'This person is inactive.';

suite('the creator pre-fill rule and the new-lead form people (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;
  let phoneSequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role,
    opts: { active?: boolean } = {},
  ): Promise<Person & { roleKey: string; api: () => Promise<Api> }> {
    const key = `prefill-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { roleKey: key, api: () => fx.signedInAs(person) });
  }

  /** The people of a lead as stored: Owner (commission owner, with the assignee rows that mirror it) and Dispatcher. */
  async function peopleOf(leadId: string) {
    const lead = await db.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: { commission_owner_id: true, dispatcher_id: true, lead_assignees: { select: { user_id: true } } },
    });
    return { owner: lead.commission_owner_id, assignees: lead.lead_assignees.map((a) => a.user_id), dispatcher: lead.dispatcher_id };
  }

  const newLead = (customer: string, extra: object = {}) => ({ customer_id: customer, service_request: 'Fix the door', ...extra });

  describe('the rule', () => {
    // [switches, base role, who the creator lands as]
    const cases: Array<[string, Record<string, boolean>, Role, 'owner' | 'dispatcher']> = [
      ['Can own leads on, on a Dispatcher base', { can_own_leads: true, can_be_dispatcher: false }, 'DISPATCHER', 'owner'],
      ['Can own leads off and Can be a dispatcher on, on a Technician base', { can_own_leads: false, can_be_dispatcher: true }, 'TECHNICIAN', 'dispatcher'],
      ['both off, on a Dispatcher base', { can_own_leads: false, can_be_dispatcher: false }, 'DISPATCHER', 'owner'],
      ['both off, on a Technician base', { can_own_leads: false, can_be_dispatcher: false }, 'TECHNICIAN', 'owner'],
      ['both on (the Admin preset), on a Technician base', { can_own_leads: true, can_be_dispatcher: true }, 'TECHNICIAN', 'owner'],
    ];

    it.each(cases)('gives the answer for %s, through the module and through the form pre-fill route', async (_label, values, base, expected) => {
      const { org } = await fx.newOrg();
      const creator = await personWith(org, { create_leads: true, edit_leads: true, view_customers: true, create_customers: true, edit_customers: true, ...values }, base);
      const { creatorPrefillSlot } = await import('../lib/permissions/creatorPrefill.js');
      const stored = await db.user.findUniqueOrThrow({
        where: { id: creator.id },
        select: { id: true, organization_id: true, role: true, is_admin: true, based_on_role_key: true, custom_role_id: true, custom_role: { select: { key: true } } },
      });
      expect(await creatorPrefillSlot(stored)).toBe(expected);

      const res = await (await creator.api()).get('/api/leads/creator-prefill');
      expect(res.status).toBe(200);
      expect(res.body.prefill).toEqual({
        owner_id: expected === 'owner' ? creator.id : null,
        dispatcher_id: expected === 'dispatcher' ? creator.id : null,
      });
    });

    it('is the built-in Admin box for an Admin: Owner, never Dispatcher', async () => {
      const { admin } = await fx.newOrg();
      const res = await (await fx.signedInAs(admin)).get('/api/leads/creator-prefill');
      expect(res.status).toBe(200);
      expect(res.body.prefill).toEqual({ owner_id: admin.id, dispatcher_id: null });
    });

    it('is refused to a person who cannot create leads', async () => {
      const { org } = await fx.newOrg();
      const cannot = await personWith(org, { create_leads: false }, 'SALES');
      const res = await (await cannot.api()).get('/api/leads/creator-prefill');
      expect(res.status).toBe(403);
    });
  });

  const createdLeadCount = (customer: string) => db.lead.count({ where: { customer_id: customer } });

  describe('without Assign people to leads', () => {
    it('saves the rule\'s result whatever people the request names, on an existing and on a new customer', async () => {
      const { org, customer } = await fx.newOrg();
      const named = await personWith(org, { can_own_leads: true, can_be_dispatcher: true }, 'TECHNICIAN');
      // A new customer typed into the lead form is a Create customers action (A7), so these creators hold it.
      const addsCustomers = { view_customers: true, create_customers: true, edit_customers: true };
      // Creators whose base role disagrees with their switches: Owner by Can own leads, Dispatcher by Can be a dispatcher alone.
      const asOwner = await personWith(org, { ...addsCustomers, assign_people_to_leads: false, can_own_leads: true, can_be_dispatcher: false }, 'DISPATCHER');
      const asDispatcher = await personWith(org, { ...addsCustomers, assign_people_to_leads: false, can_own_leads: false, can_be_dispatcher: true }, 'TECHNICIAN');
      const asNeither = await personWith(org, { ...addsCustomers, assign_people_to_leads: false, can_own_leads: false, can_be_dispatcher: false }, 'DISPATCHER');
      const asBoth = await personWith(org, { ...addsCustomers, assign_people_to_leads: false, can_own_leads: true, can_be_dispatcher: true }, 'TECHNICIAN');

      const expectations: Array<[string, typeof asOwner, 'owner' | 'dispatcher']> = [
        ['Owner', asOwner, 'owner'], ['Dispatcher', asDispatcher, 'dispatcher'], ['neither switch', asNeither, 'owner'], ['both switches', asBoth, 'owner'],
      ];
      for (const [label, creator, slot] of expectations) {
        const api = await creator.api();
        const people = { assigned_to: named.id, dispatcher_id: named.id };
        const existing = await api.post('/api/leads', newLead(customer, people));
        expect(existing.status, `${label}, existing customer`).toBe(201);
        const viaNew = await api.post('/api/leads', {
          new_customer: { first_name: 'New', last_name: `Person${creator.id.slice(0, 4)}`, phone: `617555${String(++phoneSequence).padStart(4, '0')}` },
          service_request: 'Fix the door', ...people,
        });
        expect(viaNew.status, `${label}, new customer`).toBe(201);

        for (const res of [existing, viaNew]) {
          expect(await peopleOf(res.body.lead.id), label).toEqual({
            owner: slot === 'owner' ? creator.id : null,
            assignees: slot === 'owner' ? [creator.id] : [],
            dispatcher: slot === 'dispatcher' ? creator.id : null,
          });
        }
      }
    });

    it('saves the creator even when the creator could not be named (both switches off): nobody is refused on the creator\'s own record', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await personWith(org, { assign_people_to_leads: false, can_own_leads: false, can_be_dispatcher: false }, 'SALES');
      const res = await (await creator.api()).post('/api/leads', newLead(customer));
      expect(res.status).toBe(201);
      expect((await peopleOf(res.body.lead.id)).owner).toBe(creator.id);
    });
  });

  describe('with Assign people to leads', () => {
    it('saves what was submitted: kept, changed or cleared, whatever the role is based on', async () => {
      const { org, customer } = await fx.newOrg();
      const owner = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      const dispatcher = await personWith(org, { can_be_dispatcher: true }, 'SALES');
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const holder = await personWith(org, { assign_people_to_leads: true, can_own_leads: true, can_be_dispatcher: false }, base);
        const api = await holder.api();

        // Kept: the pre-fill, as the form holds it.
        const prefill = (await api.get('/api/leads/creator-prefill')).body.prefill;
        const kept = await api.post('/api/leads', newLead(customer, { assigned_to: prefill.owner_id, dispatcher_id: prefill.dispatcher_id }));
        expect(kept.status, `${base}, kept`).toBe(201);
        expect(await peopleOf(kept.body.lead.id), `${base}, kept`).toEqual({ owner: holder.id, assignees: [holder.id], dispatcher: null });

        // Changed: other people in both fields.
        const changed = await api.post('/api/leads', newLead(customer, { assigned_to: owner.id, dispatcher_id: dispatcher.id }));
        expect(changed.status, `${base}, changed`).toBe(201);
        expect(await peopleOf(changed.body.lead.id), `${base}, changed`).toEqual({ owner: owner.id, assignees: [owner.id], dispatcher: dispatcher.id });
        expect(changed.body.lead.dispatcher, `${base}, changed`).toMatchObject({ id: dispatcher.id });

        // Cleared: both fields emptied on purpose.
        const cleared = await api.post('/api/leads', newLead(customer, { assigned_to: null, dispatcher_id: null }));
        expect(cleared.status, `${base}, cleared`).toBe(201);
        expect(await peopleOf(cleared.body.lead.id), `${base}, cleared`).toEqual({ owner: null, assignees: [], dispatcher: null });
      }
    });

    it('refuses a pick who cannot hold the slot, or is inactive, in plain words, and creates nothing', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const dispatcherBaseWhoCannotOwn = await personWith(org, { can_own_leads: false, can_be_dispatcher: true }, 'DISPATCHER');
      const technicianBaseWhoCannotDispatch = await personWith(org, { can_own_leads: true, can_be_dispatcher: false }, 'TECHNICIAN');
      const inactive = await personWith(org, { can_own_leads: true, can_be_dispatcher: true }, 'TECHNICIAN', { active: false });

      const before = await createdLeadCount(customer);
      const cases: Array<[string, object, string]> = [
        ['Owner who cannot own leads', { assigned_to: dispatcherBaseWhoCannotOwn.id }, NOT_OWNER],
        ['Dispatcher who cannot be a dispatcher', { dispatcher_id: technicianBaseWhoCannotDispatch.id }, NOT_DISPATCHER],
        ['inactive Owner', { assigned_to: inactive.id }, INACTIVE],
        ['inactive Dispatcher', { dispatcher_id: inactive.id }, INACTIVE],
      ];
      for (const [label, people, message] of cases) {
        const res = await api.post('/api/leads', newLead(customer, people));
        expect(res.status, label).toBe(400);
        expect(res.body.error, label).toBe(message);
      }
      expect(await createdLeadCount(customer), 'nothing created').toBe(before);
    });

    it('refuses the holder naming themselves when their own switch is off, and takes themselves when it is on', async () => {
      const { org, customer } = await fx.newOrg();
      const cannot = await personWith(org, { assign_people_to_leads: true, can_own_leads: false, can_be_dispatcher: false }, 'SALES');
      const can = await personWith(org, { assign_people_to_leads: true, can_own_leads: false, can_be_dispatcher: true }, 'TECHNICIAN');

      const refused = await (await cannot.api()).post('/api/leads', newLead(customer, { dispatcher_id: cannot.id }));
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(NOT_DISPATCHER);

      const taken = await (await can.api()).post('/api/leads', newLead(customer, { dispatcher_id: can.id, assigned_to: null }));
      expect(taken.status).toBe(201);
      expect(await peopleOf(taken.body.lead.id)).toEqual({ owner: null, assignees: [], dispatcher: can.id });
    });

    it('saves the kept pre-fill when the holder\'s own switches are both off: what the form shows is what saves', async () => {
      const { org, customer } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_leads: true, can_own_leads: false, can_be_dispatcher: false }, 'SALES');
      const api = await holder.api();
      const prefill = (await api.get('/api/leads/creator-prefill')).body.prefill;
      expect(prefill).toEqual({ owner_id: holder.id, dispatcher_id: null });

      const kept = await api.post('/api/leads', newLead(customer, { assigned_to: prefill.owner_id, dispatcher_id: prefill.dispatcher_id }));
      expect(kept.status).toBe(201);
      expect(await peopleOf(kept.body.lead.id)).toEqual({ owner: holder.id, assignees: [holder.id], dispatcher: null });
    });

    it('says a person outside the company is not found', async () => {
      const { org, customer } = await fx.newOrg();
      const other = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_leads: true }, 'SALES');
      const res = await (await holder.api()).post('/api/leads', newLead(customer, { dispatcher_id: other.admin.id }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Target user not found');
    });
  });

  describe('a lead made from a call', () => {
    it('gets exactly the same people as one made from the Leads page by the same user (the dialer and the text inbox post to the same route)', async () => {
      const { org, customer } = await fx.newOrg();
      for (const values of [
        { assign_people_to_leads: false, can_own_leads: true, can_be_dispatcher: false },
        { assign_people_to_leads: false, can_own_leads: false, can_be_dispatcher: true },
        { assign_people_to_leads: true, can_own_leads: true, can_be_dispatcher: true },
      ]) {
        const creator = await personWith(org, values, 'SALES');
        const api = await creator.api();
        const prefill = (await api.get('/api/leads/creator-prefill')).body.prefill;
        const body = { assigned_to: prefill.owner_id, dispatcher_id: prefill.dispatcher_id };
        const fromLeadsPage = await api.post('/api/leads', newLead(customer, body));
        const fromCall = await api.post('/api/leads', newLead(customer, { ...body, phone: '6175550199' }));
        expect([fromLeadsPage.status, fromCall.status]).toEqual([201, 201]);
        expect(await peopleOf(fromCall.body.lead.id)).toEqual(await peopleOf(fromLeadsPage.body.lead.id));
      }
    });
  });

  describe('a role copied from the Dispatcher preset', () => {
    it('creates a lead and is pre-filled as Dispatcher, with Owner empty, exactly like the preset', async () => {
      const { org, customer } = await fx.newOrg();
      // The preset's own values: Can be a dispatcher on, Can own leads off, no Assign people to leads.
      const secretary = await personWith(org, { assign_people_to_leads: false, can_own_leads: false, can_be_dispatcher: true }, 'DISPATCHER');
      const api = await secretary.api();
      expect((await api.get('/api/leads/creator-prefill')).body.prefill).toEqual({ owner_id: null, dispatcher_id: secretary.id });
      const res = await api.post('/api/leads', newLead(customer));
      expect(res.status).toBe(201);
      expect(await peopleOf(res.body.lead.id)).toEqual({ owner: null, assignees: [], dispatcher: secretary.id });
      // The Dispatcher is attached to the lead, so the creator opens it at once.
      expect((await api.get(`/api/leads/${res.body.lead.id}`)).status).toBe(200);
    });
  });

  describe('#2283: a creator who can own leads but cannot assign people', () => {
    it('is the Owner and the assignee, lists and opens the lead at once, and a second person on Attached scope cannot', async () => {
      const { org, customer } = await fx.newOrg();
      const attached = { leads_scope: 'attached', view_leads: true, edit_leads: true, create_leads: true, assign_people_to_leads: false, can_own_leads: true };
      const creator = await personWith(org, attached, 'DISPATCHER');
      const second = await personWith(org, attached, 'DISPATCHER');

      const api = await creator.api();
      const created = await api.post('/api/leads', newLead(customer));
      expect(created.status).toBe(201);
      const id = created.body.lead.id;
      expect(await peopleOf(id)).toEqual({ owner: creator.id, assignees: [creator.id], dispatcher: null });

      const listed = await api.get('/api/leads');
      expect(listed.status).toBe(200);
      expect(listed.body.leads.map((l: { id: string }) => l.id)).toContain(id);
      expect((await api.get(`/api/leads/${id}`)).status).toBe(200);

      const secondApi = await second.api();
      const secondList = await secondApi.get('/api/leads');
      expect(secondList.body.leads.map((l: { id: string }) => l.id)).not.toContain(id);
      expect((await secondApi.get(`/api/leads/${id}`)).status).toBe(404);
    });
  });

  describe('no save checks', () => {
    it('accepts a lead saved with every people field empty, and sends "New lead with no owner"', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_leads: true }, 'SALES');
      // Someone to tell: a holder of Assign people to leads is who the alert goes to for a new lead.
      const res = await (await holder.api()).post('/api/leads', newLead(customer, { assigned_to: null, dispatcher_id: null }));
      expect(res.status).toBe(201);
      expect(await peopleOf(res.body.lead.id)).toEqual({ owner: null, assignees: [], dispatcher: null });
      // The alert is sent after the response, through the chain: the company's Admin-box person holds Assign people to leads.
      await reviewAttentionSettled();
      const alerts = await db.notification.findMany({ where: { organization_id: org, verb: 'lead.unassigned_created', object_id: res.body.lead.id }, include: { recipients: true } });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.recipients.map((r) => r.recipient_id)).toEqual([admin.id]);
    });

    it('does not send "New lead with no owner" when the pre-fill gave the lead an Owner', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await personWith(org, { assign_people_to_leads: false, can_own_leads: true }, 'TECHNICIAN');
      const res = await (await creator.api()).post('/api/leads', newLead(customer));
      expect(res.status).toBe(201);
      await reviewAttentionSettled();
      expect(await db.notification.count({ where: { organization_id: org, verb: 'lead.unassigned_created', object_id: res.body.lead.id } })).toBe(0);
    });

    it('sends it for a creator the rule makes Dispatcher only: the lead has a Dispatcher and no Owner', async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await personWith(org, { assign_people_to_leads: false, can_own_leads: false, can_be_dispatcher: true }, 'TECHNICIAN');
      const res = await (await creator.api()).post('/api/leads', newLead(customer));
      expect(res.status).toBe(201);
      await reviewAttentionSettled();
      expect(await db.notification.count({ where: { organization_id: org, verb: 'lead.unassigned_created', object_id: res.body.lead.id } })).toBe(1);
    });

    it('lets a role be saved with Create leads on and both slot switches off', async () => {
      const { org } = await fx.newOrg();
      const key = `prefill-no-slots-${++sequence}`;
      await fx.addCustomRole(org, key, 'SALES');
      await expect(setRoleSwitchValues({
        organizationId: org, roleKey: key, values: { edit_leads: true, create_leads: true, can_own_leads: false, can_be_dispatcher: false }, actorId: null, reason: 'manual',
      })).resolves.toMatchObject({ edit_leads: true, create_leads: true, can_own_leads: false, can_be_dispatcher: false });
    });
  });

  describe('history', () => {
    const timelineOf = async (leadId: string, org: string, admin: Person) => {
      const res = await (await fx.signedInAs(admin)).get(`/api/leads/${leadId}/timeline`);
      expect(res.status).toBe(200);
      void org;
      return res.body.events as Array<{ event_type: string; description: string; metadata: Record<string, unknown> | null }>;
    };

    it('says "set to the creator at creation" when the pre-fill was kept, and nothing about a slot left empty', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const owner = await personWith(org, { assign_people_to_leads: false, can_own_leads: true }, 'TECHNICIAN');
      const dispatcher = await personWith(org, { assign_people_to_leads: false, can_own_leads: false, can_be_dispatcher: true }, 'SALES');

      const ownerLead = (await (await owner.api()).post('/api/leads', newLead(customer))).body.lead.id;
      const ownerEvents = await timelineOf(ownerLead, org, admin);
      expect(ownerEvents.filter((e) => e.event_type === 'OWNER_CHANGED').map((e) => e.description)).toEqual([
        expect.stringContaining('set to the creator at creation'),
      ]);
      expect(ownerEvents.filter((e) => e.event_type === 'DISPATCHER_CHANGED')).toEqual([]);

      const dispatcherLead = (await (await dispatcher.api()).post('/api/leads', newLead(customer))).body.lead.id;
      const dispatcherEvents = await timelineOf(dispatcherLead, org, admin);
      expect(dispatcherEvents.filter((e) => e.event_type === 'DISPATCHER_CHANGED').map((e) => e.description)).toEqual([
        expect.stringContaining('set to the creator at creation'),
      ]);
      expect(dispatcherEvents.filter((e) => e.event_type === 'OWNER_CHANGED')).toEqual([]);
    });

    it('records a holder\'s picks as picked, and keeping the pre-fill as the creator', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const owner = await personWith(org, { can_own_leads: true }, 'TECHNICIAN');
      const dispatcher = await personWith(org, { can_be_dispatcher: true }, 'SALES');
      const holder = await personWith(org, { assign_people_to_leads: true, can_own_leads: true }, 'SALES');
      const api = await holder.api();

      const picked = (await api.post('/api/leads', newLead(customer, { assigned_to: owner.id, dispatcher_id: dispatcher.id }))).body.lead.id;
      const pickedEvents = await timelineOf(picked, org, admin);
      for (const type of ['OWNER_CHANGED', 'DISPATCHER_CHANGED']) {
        const events = pickedEvents.filter((e) => e.event_type === type);
        expect(events, type).toHaveLength(1);
        expect(events[0]!.description, type).not.toContain('set to the creator at creation');
        expect(events[0]!.metadata, type).toMatchObject({ source: 'picked' });
      }

      const kept = (await api.post('/api/leads', newLead(customer, { assigned_to: holder.id }))).body.lead.id;
      const keptOwner = (await timelineOf(kept, org, admin)).filter((e) => e.event_type === 'OWNER_CHANGED');
      expect(keptOwner).toHaveLength(1);
      expect(keptOwner[0]!.description).toContain('set to the creator at creation');
      expect(keptOwner[0]!.metadata).toMatchObject({ source: 'creator' });
    });

    it('writes nothing when the holder cleared both fields', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const holder = await personWith(org, { assign_people_to_leads: true }, 'SALES');
      const id = (await (await holder.api()).post('/api/leads', newLead(customer, { assigned_to: null, dispatcher_id: null }))).body.lead.id;
      const events = await timelineOf(id, org, admin);
      expect(events.filter((e) => e.event_type === 'OWNER_CHANGED' || e.event_type === 'DISPATCHER_CHANGED')).toEqual([]);
    });
  });
});
