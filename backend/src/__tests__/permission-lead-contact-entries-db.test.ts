/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.13 - a lead's own phones, emails, name and company.

   The same add, change, correct and remove endpoints the job has, under the lead, on the same storage. Everything goes
   through the routes, called as people on custom roles (never a built-in role name) whose switch values are the ones
   under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is
   removed again.
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

type Entry = {
  id: string; kind: string; intent: string; value: string; extension: string | null; label: string | null;
  overridden_field: string | null; overridden_row_id: string | null; customer_value_at_change: string | null;
  created_by: { id: string | null; name: string | null }; created_at: string;
  updated_by: { id: string | null; name: string | null }; updated_at: string; source_entry_id: string | null;
};

type TimelineEvent = { event_type: string; description: string; metadata: Record<string, unknown>; creator: { id: string } | null };

suite("a lead's own phones, emails, name and company (real database)", () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values on top of the Technician preset. */
  async function personWith(org: string, values: Record<string, boolean | string>): Promise<Person> {
    const key = `lce-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    return fx.addUser(org, `lce${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
  }

  /** Holds the pencil through Edit job and lead contact details alone. */
  const contactOnly = { edit_job_and_lead_contact_details: true, edit_leads: false, create_leads: false, leads_scope: 'attached' };
  /** Holds the pencil through Edit leads alone. */
  const leadsOnly = { edit_job_and_lead_contact_details: false, edit_leads: true, leads_scope: 'attached' };

  async function setup(values: Record<string, boolean | string> = contactOnly) {
    const { org, customer } = await fx.newOrg();
    await db.customer.update({
      where: { id: customer },
      data: { phone: '6175550101', email: 'pat@example.test', first_name: 'Pat', last_name: 'Jones', company_name: 'Jones Hardware' },
    });
    const me = await personWith(org, values);
    const lead = await fx.addLead(org, customer, { owner: me.id });
    return { org, customer, me, lead, api: await fx.signedInAs(me) };
  }

  const base = (leadId: string) => `/api/leads/${leadId}/contact-entries`;

  const customerRecord = (customer: string) =>
    db.customer.findUniqueOrThrow({ where: { id: customer }, include: { phones: true, extra_emails: true } });

  const leadEvents = async (api: Awaited<ReturnType<typeof fx.signedInAs>>, leadId: string) =>
    ((await api.get(`/api/leads/${leadId}/timeline`)).body.events as TimelineEvent[]).filter((e) => e.event_type.startsWith('LEAD_CONTACT_ENTRY_'));

  describe('adding a phone or email', () => {
    it('lets a person with Edit job and lead contact details add a phone and an email, and leaves the customer alone', async () => {
      expect(findSwitch('edit_job_and_lead_contact_details')).toBeDefined();
      const { customer, lead, api } = await setup();
      const before = await customerRecord(customer);

      const phone = await api.post(base(lead.id), { kind: 'PHONE', value: '(617) 555-0199', extension: '4', label: "Wife's cell" });
      const email = await api.post(base(lead.id), { kind: 'EMAIL', value: 'wife@example.test', label: 'Wife' });

      expect(phone.status).toBe(201);
      expect(email.status).toBe(201);
      expect(await customerRecord(customer)).toEqual(before);
      expect((email.body.entries as Entry[]).map((e) => [e.kind, e.intent, e.value])).toEqual([
        ['PHONE', 'ADDED', '6175550199'],
        ['EMAIL', 'ADDED', 'wife@example.test'],
      ]);
    });

    it('stores the row on the lead and on no job', async () => {
      const { org, customer, lead, api } = await setup();
      const otherLead = await fx.addLead(org, customer, {});
      await api.post(base(lead.id), { kind: 'EMAIL', value: 'wife@example.test' });

      expect(await db.recordContactEntry.count({ where: { lead_id: lead.id, job_id: null, organization_id: org } })).toBe(1);
      expect(await db.recordContactEntry.count({ where: { lead_id: otherLead.id } })).toBe(0);
    });

    it("returns the lead's live entries on the lead detail to anyone who can open it, View customers off included", async () => {
      const { org, lead, api } = await setup();
      const first = await api.post(base(lead.id), { kind: 'PHONE', value: '6175550199', label: 'Wife' });
      await api.post(base(lead.id), { kind: 'EMAIL', value: 'wife@example.test' });
      await db.recordContactEntry.update({ where: { id: (first.body.entries as Entry[])[0]!.id }, data: { removed_at: new Date() } });
      const reader = await personWith(org, { view_customers: false, edit_job_and_lead_contact_details: false, edit_leads: false, create_leads: false, leads_scope: 'all' });

      const res = await (await fx.signedInAs(reader)).get(`/api/leads/${lead.id}`);

      expect(res.status).toBe(200);
      const entries = res.body.lead.contact_entries as Entry[];
      expect(entries.map((e) => [e.kind, e.value])).toEqual([['EMAIL', 'wife@example.test']]);
    });

    it('answers a lead detail with no entries as an empty list', async () => {
      const { lead, api } = await setup();

      const res = await api.get(`/api/leads/${lead.id}`);

      expect(res.body.lead.contact_entries).toEqual([]);
    });

    it('refuses a phone or an email that is not valid, and a kind the add does not take', async () => {
      const { lead, api } = await setup();

      const phone = await api.post(base(lead.id), { kind: 'PHONE', value: '12' });
      const email = await api.post(base(lead.id), { kind: 'EMAIL', value: 'not-an-email' });
      const kind = await api.post(base(lead.id), { kind: 'FIRST_NAME', value: 'Pat' });

      expect(phone.status).toBe(400);
      expect(JSON.stringify(phone.body)).toContain('Enter a valid phone number');
      expect(email.status).toBe(400);
      expect(JSON.stringify(email.body)).toContain('Enter a valid email address');
      expect(kind.status).toBe(400);
      expect(await db.recordContactEntry.count({ where: { lead_id: lead.id } })).toBe(0);
    });

    it('refuses a value already on the customer or already live on the lead, in words that name the lead', async () => {
      const { lead, api } = await setup();

      const onCustomer = await api.post(base(lead.id), { kind: 'PHONE', value: '+1 (617) 555-0101' });
      await api.post(base(lead.id), { kind: 'PHONE', value: '6175550199' });
      const onLead = await api.post(base(lead.id), { kind: 'PHONE', value: '(617) 555-0199' });
      await api.post(base(lead.id), { kind: 'EMAIL', value: 'a@example.test' });
      const emailOnLead = await api.post(base(lead.id), { kind: 'EMAIL', value: 'A@example.test' });

      expect(onCustomer.status).toBe(409);
      expect(onCustomer.body.error).toBe('That number is already on this customer');
      expect(onLead.status).toBe(409);
      expect(onLead.body.error).toBe('That number is already on this lead');
      expect(emailOnLead.body.error).toBe('That email is already on this lead');
    });

    it('does not count a job-only value of the same number as a duplicate', async () => {
      const { org, customer, me, lead, api } = await setup();
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      await db.recordContactEntry.create({
        data: { organization_id: org, job_id: job.id, kind: 'PHONE', intent: 'ADDED', value: '6175550199' },
      });

      const res = await api.post(base(lead.id), { kind: 'PHONE', value: '6175550199' });

      expect(res.status).toBe(201);
    });
  });

  describe('the gate on phones and emails', () => {
    it('refuses the add with Edit job and lead contact details off and Edit leads off, even with Add notes on', async () => {
      const { lead, api } = await setup({ edit_job_and_lead_contact_details: false, edit_leads: false, create_leads: false, add_notes: true, leads_scope: 'attached' });

      const res = await api.post(base(lead.id), { kind: 'PHONE', value: '6175550199' });

      expect(res.status).toBe(403);
    });

    it('accepts the add with Edit leads on alone', async () => {
      const { lead, api } = await setup(leadsOnly);

      const res = await api.post(base(lead.id), { kind: 'EMAIL', value: 'wife@example.test' });

      expect(res.status).toBe(201);
    });

    it('does not let Edit jobs stand in for Edit leads', async () => {
      const { lead, api } = await setup({ edit_job_and_lead_contact_details: false, edit_leads: false, create_leads: false, edit_jobs: true, leads_scope: 'attached' });

      const res = await api.post(base(lead.id), { kind: 'EMAIL', value: 'wife@example.test' });

      expect(res.status).toBe(403);
    });

    it('asks who may open the lead first: not found once taken off it, the same as for another company or a missing id', async () => {
      const { me, lead, api } = await setup();
      expect((await api.post(base(lead.id), { kind: 'EMAIL', value: 'one@example.test' })).status).toBe(201);

      await db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: null } });
      const off = await (await fx.signedInAs(me)).post(base(lead.id), { kind: 'EMAIL', value: 'two@example.test' });
      expect(off.status).toBe(404);

      const other = await fx.newOrg();
      const foreign = await fx.addLead(other.org, other.customer, {});
      expect((await (await fx.signedInAs(me)).post(base(foreign.id), { kind: 'EMAIL', value: 'x@example.test' })).status).toBe(404);
      expect((await (await fx.signedInAs(me)).post(base(randomUUID()), { kind: 'EMAIL', value: 'x@example.test' })).status).toBe(404);
      expect(await db.recordContactEntry.count({ where: { lead_id: lead.id } })).toBe(1);
    });
  });

  describe("changing a customer's phone or email for this lead", () => {
    const changePath = (leadId: string) => `${base(leadId)}/change`;

    it("records the customer's value at change time, answers with the entry and leaves the customer record alone", async () => {
      const { customer, me, lead, api } = await setup();
      const before = await customerRecord(customer);

      const res = await api.post(changePath(lead.id), { kind: 'PHONE', replaces: '(617) 555-0101', value: '(617) 555-0188', extension: '7', label: 'New cell' });
      const email = await api.post(changePath(lead.id), { kind: 'EMAIL', replaces: 'pat@example.test', value: 'pat.new@example.test' });

      expect(res.status).toBe(201);
      expect(email.status).toBe(201);
      const entries = email.body.entries as Entry[];
      expect(entries[0]).toMatchObject({
        kind: 'PHONE', intent: 'CHANGED', value: '6175550188', extension: '7', label: 'New cell',
        overridden_field: 'phone', customer_value_at_change: '6175550101', created_by: { id: me.id },
      });
      expect(entries[1]).toMatchObject({ kind: 'EMAIL', intent: 'CHANGED', value: 'pat.new@example.test', overridden_field: 'email', customer_value_at_change: 'pat@example.test' });
      expect(await customerRecord(customer)).toEqual(before);
    });

    it('refuses a value that is no change, with the message that names the customer', async () => {
      const { lead, api } = await setup();

      const res = await api.post(changePath(lead.id), { kind: 'PHONE', replaces: '6175550101', value: '+1 (617) 555-0101' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("No change: that is already this customer's number");
    });

    it('refuses a second change of the same value in words that name the lead', async () => {
      const { lead, api } = await setup();
      await api.post(changePath(lead.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550188' });

      const again = await api.post(changePath(lead.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550166' });

      expect(again.status).toBe(409);
      expect(again.body.error).toBe('That number is already changed on this lead');
    });

    it('takes the same gate as adding: refused with neither switch, accepted with Edit leads alone', async () => {
      const refused = await setup({ edit_job_and_lead_contact_details: false, edit_leads: false, create_leads: false, leads_scope: 'attached' });
      const accepted = await setup(leadsOnly);

      // A fresh sign-in for each call: the fixture's client holds one person at a time.
      const no = await (await fx.signedInAs(refused.me)).post(changePath(refused.lead.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550188' });
      const yes = await (await fx.signedInAs(accepted.me)).post(changePath(accepted.lead.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550188' });

      expect(no.status).toBe(403);
      expect(yes.status).toBe(201);
    });

    it('asks who may open the lead first', async () => {
      const { me, lead } = await setup();
      await db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: null } });
      const other = await fx.newOrg();
      const foreign = await fx.addLead(other.org, other.customer, {});
      const api = await fx.signedInAs(me);

      expect((await api.post(changePath(lead.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550188' })).status).toBe(404);
      expect((await api.post(changePath(foreign.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550188' })).status).toBe(404);
      expect((await api.post(changePath(randomUUID()), { kind: 'PHONE', replaces: '6175550101', value: '6175550188' })).status).toBe(404);
    });
  });

  describe("changing the customer's name or company for this lead", () => {
    const namePath = (leadId: string) => `${base(leadId)}/name`;

    it('needs Edit leads: accepted with it, refused with only Edit job and lead contact details', async () => {
      const allowed = await setup(leadsOnly);
      const refused = await setup(contactOnly);
      const before = await customerRecord(allowed.customer);

      // A fresh sign-in for each call: the fixture's client holds one person at a time.
      const first = await (await fx.signedInAs(allowed.me)).post(namePath(allowed.lead.id), { kind: 'FIRST_NAME', value: 'Patricia' });
      const company = await (await fx.signedInAs(allowed.me)).post(namePath(allowed.lead.id), { kind: 'COMPANY_NAME', value: 'Jones & Sons' });
      const no = await (await fx.signedInAs(refused.me)).post(namePath(refused.lead.id), { kind: 'FIRST_NAME', value: 'Patricia' });

      expect(first.status).toBe(201);
      expect(company.status).toBe(201);
      expect(no.status).toBe(403);
      expect(await db.recordContactEntry.count({ where: { lead_id: refused.lead.id } })).toBe(0);
      expect((company.body.entries as Entry[]).map((e) => [e.kind, e.intent, e.value, e.customer_value_at_change])).toEqual([
        ['FIRST_NAME', 'CHANGED', 'Patricia', 'Pat'],
        ['COMPANY_NAME', 'CHANGED', 'Jones & Sons', 'Jones Hardware'],
      ]);
      expect(await customerRecord(allowed.customer)).toEqual(before);
    });

    it("refuses the customer's own name and a name already changed on the lead", async () => {
      const { lead, api } = await setup(leadsOnly);

      const same = await api.post(namePath(lead.id), { kind: 'LAST_NAME', value: 'Jones' });
      await api.post(namePath(lead.id), { kind: 'LAST_NAME', value: 'Smith' });
      const again = await api.post(namePath(lead.id), { kind: 'LAST_NAME', value: 'Brown' });

      expect(same.status).toBe(409);
      expect(same.body.error).toBe("No change: that is already this customer's last name");
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('That last name is already changed on this lead');
    });

    it("refuses the lead's creator, still on the lead, a name change without Edit leads: having made the lead is no way in (P7)", async () => {
      const { org, customer } = await fx.newOrg();
      const creator = await personWith(org, { edit_job_and_lead_contact_details: false, edit_leads: false, create_leads: false, leads_scope: 'attached' });
      const lead = await fx.addLead(org, customer, { owner: creator.id, createdBy: creator.id });

      const res = await (await fx.signedInAs(creator)).post(namePath(lead.id), { kind: 'FIRST_NAME', value: 'Patricia' });

      expect(res.status).toBe(403);
    });

    it("lets a person with Edit leads change the name of a lead they are on, and not once taken off it", async () => {
      const { org, customer } = await fx.newOrg();
      const editor = await personWith(org, { edit_job_and_lead_contact_details: false, edit_leads: true, leads_scope: 'attached' });
      const lead = await fx.addLead(org, customer, { owner: editor.id, createdBy: editor.id });
      const api = await fx.signedInAs(editor);

      const on = await api.post(namePath(lead.id), { kind: 'FIRST_NAME', value: 'Patricia' });
      await db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: null } });
      const off = await (await fx.signedInAs(editor)).post(namePath(lead.id), { kind: 'COMPANY_NAME', value: 'Other Co' });

      expect(on.status).toBe(201);
      expect(off.status).toBe(404);
    });

    it('does not let a person attached to a lead they did not create, with Edit leads off, change a name', async () => {
      const { org, customer } = await fx.newOrg();
      const someone = await personWith(org, { edit_job_and_lead_contact_details: false, edit_leads: false, create_leads: false, leads_scope: 'attached' });
      const maker = await personWith(org, {});
      const lead = await fx.addLead(org, customer, { owner: someone.id, createdBy: maker.id });

      const res = await (await fx.signedInAs(someone)).post(namePath(lead.id), { kind: 'FIRST_NAME', value: 'Patricia' });

      expect(res.status).toBe(403);
    });

    it('asks who may open the lead first', async () => {
      const { me, lead } = await setup(leadsOnly);
      await db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: null } });
      const other = await fx.newOrg();
      const foreign = await fx.addLead(other.org, other.customer, {});
      const api = await fx.signedInAs(me);

      expect((await api.post(namePath(lead.id), { kind: 'FIRST_NAME', value: 'Patricia' })).status).toBe(404);
      expect((await api.post(namePath(foreign.id), { kind: 'FIRST_NAME', value: 'Patricia' })).status).toBe(404);
      expect((await api.post(namePath(randomUUID()), { kind: 'FIRST_NAME', value: 'Patricia' })).status).toBe(404);
    });
  });

  describe('correcting and removing an entry, whoever added it', () => {
    /** The lead's entry added by one person, to be corrected or removed by another. */
    async function entryBy(adderValues: Record<string, boolean | string>, ...entryBodies: object[]) {
      const { org, customer, me, lead } = await setup(adderValues);
      const adder = await fx.signedInAs(me);
      let entries: Entry[] = [];
      for (const body of entryBodies) {
        const res = await adder.post(base(lead.id) + ((body as { kind: string }).kind.endsWith('NAME') ? '/name' : ''), body);
        entries = res.body.entries as Entry[];
      }
      return { org, customer, me, lead, entries };
    }

    it('lets another person with Edit job and lead contact details only, or with Edit leads only, correct and remove a phone', async () => {
      const { org, lead, entries } = await entryBy(leadsOnly, { kind: 'PHONE', value: '6175550199', label: 'Wife' });
      const entry = entries[0]!;
      const viaContact = await personWith(org, contactOnly);
      const viaLeads = await personWith(org, leadsOnly);
      await db.lead.update({ where: { id: lead.id }, data: { dispatcher_id: viaContact.id } });
      await db.leadAssignee.create({ data: { lead_id: lead.id, user_id: viaLeads.id, organization_id: org } });

      const fixed = await (await fx.signedInAs(viaContact)).patch(`${base(lead.id)}/${entry.id}`, { value: '6175550177', label: 'Cell' });
      const removed = await (await fx.signedInAs(viaLeads)).delete(`${base(lead.id)}/${entry.id}`);

      expect(fixed.status).toBe(200);
      expect(fixed.body.entries[0]).toMatchObject({ value: '6175550177', label: 'Cell' });
      expect(removed.status).toBe(200);
      expect(removed.body.entries).toEqual([]);
      const row = await db.recordContactEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(row.removed_at).not.toBeNull();
    });

    it("refuses a person with neither switch, the entry's own author included", async () => {
      const { org, customer } = await fx.newOrg();
      const author = await personWith(org, contactOnly);
      const lead = await fx.addLead(org, customer, { owner: author.id });
      const made = await (await fx.signedInAs(author)).post(base(lead.id), { kind: 'PHONE', value: '6175550199' });
      const entry = (made.body.entries as Entry[])[0]!;
      await setRoleSwitchValues({
        organizationId: org,
        roleKey: (await db.user.findUniqueOrThrow({ where: { id: author.id }, include: { custom_role: true } })).custom_role!.key,
        values: { edit_job_and_lead_contact_details: false, edit_leads: false, create_leads: false },
        actorId: null,
        reason: 'manual',
      });
      const api = await fx.signedInAs(author);

      expect((await api.patch(`${base(lead.id)}/${entry.id}`, { label: 'Mine' })).status).toBe(403);
      expect((await api.delete(`${base(lead.id)}/${entry.id}`)).status).toBe(403);
    });

    it('lets removing a changed entry bring the lead back to the customer value', async () => {
      const { lead, api } = await setup(leadsOnly);
      const changed = await api.post(`${base(lead.id)}/change`, { kind: 'EMAIL', replaces: 'pat@example.test', value: 'pat.new@example.test' });

      const removed = await api.delete(`${base(lead.id)}/${(changed.body.entries as Entry[])[0]!.id}`);

      expect(removed.status).toBe(200);
      expect(removed.body.entries).toEqual([]);
      const events = await leadEvents(api, lead.id);
      const event = events.find((e) => e.event_type === 'LEAD_CONTACT_ENTRY_REMOVED')!;
      expect(event.metadata).toMatchObject({ restored_customer_value: 'pat@example.test' });
      expect(event.description).toContain('this lead');
    });

    it('keeps name and company entries to Edit leads: a contact-details holder is refused correcting or removing one', async () => {
      const { org, lead, entries } = await entryBy(leadsOnly, { kind: 'FIRST_NAME', value: 'Patricia' });
      const entry = entries[0]!;
      const contactHolder = await personWith(org, contactOnly);
      const leadsHolder = await personWith(org, leadsOnly);
      await db.lead.update({ where: { id: lead.id }, data: { dispatcher_id: contactHolder.id } });
      await db.leadAssignee.create({ data: { lead_id: lead.id, user_id: leadsHolder.id, organization_id: org } });

      const patch = await (await fx.signedInAs(contactHolder)).patch(`${base(lead.id)}/${entry.id}`, { value: 'Pat2' });
      const del = await (await fx.signedInAs(contactHolder)).delete(`${base(lead.id)}/${entry.id}`);
      const allowed = await (await fx.signedInAs(leadsHolder)).patch(`${base(lead.id)}/${entry.id}`, { value: 'Patty' });

      expect(patch.status).toBe(403);
      expect(del.status).toBe(403);
      expect(allowed.status).toBe(200);
      expect(allowed.body.entries[0]).toMatchObject({ kind: 'FIRST_NAME', value: 'Patty' });
    });

    it("does not reach another lead's entry, nor a job's, through this lead's path", async () => {
      const { org, customer, me, lead, api } = await setup(leadsOnly);
      const otherLead = await fx.addLead(org, customer, { owner: me.id });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const theirs = await db.recordContactEntry.create({ data: { organization_id: org, lead_id: otherLead.id, kind: 'PHONE', intent: 'ADDED', value: '6175550123' } });
      const jobs = await db.recordContactEntry.create({ data: { organization_id: org, job_id: job.id, kind: 'PHONE', intent: 'ADDED', value: '6175550124' } });

      expect((await api.patch(`${base(lead.id)}/${theirs.id}`, { label: 'x' })).status).toBe(404);
      expect((await api.delete(`${base(lead.id)}/${jobs.id}`)).status).toBe(404);
    });

    it('asks who may open the lead first', async () => {
      const { me, lead, entries } = await entryBy(leadsOnly, { kind: 'PHONE', value: '6175550199' });
      await db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: null } });
      const api = await fx.signedInAs(me);

      expect((await api.patch(`${base(lead.id)}/${entries[0]!.id}`, { label: 'x' })).status).toBe(404);
      expect((await api.delete(`${base(lead.id)}/${entries[0]!.id}`)).status).toBe(404);
      expect((await api.patch(`${base(randomUUID())}/${entries[0]!.id}`, { label: 'x' })).status).toBe(404);
      expect((await api.delete(`${base(randomUUID())}/${entries[0]!.id}`)).status).toBe(404);
    });
  });

  describe("the lead's history", () => {
    it('writes exactly one event per write on the lead timeline, with who, when, kind, intent and the values', async () => {
      const { me, lead, api } = await setup(leadsOnly);

      const added = await api.post(base(lead.id), { kind: 'PHONE', value: '6175550199', label: 'Wife' });
      const entryId = (added.body.entries as Entry[])[0]!.id;
      await api.post(`${base(lead.id)}/change`, { kind: 'EMAIL', replaces: 'pat@example.test', value: 'pat.new@example.test' });
      await api.post(`${base(lead.id)}/name`, { kind: 'FIRST_NAME', value: 'Patricia' });
      await api.patch(`${base(lead.id)}/${entryId}`, { value: '6175550177' });
      await api.delete(`${base(lead.id)}/${entryId}`);

      const events = await leadEvents(api, lead.id);
      const types = events.map((e) => e.event_type).sort();
      expect(types).toEqual([
        'LEAD_CONTACT_ENTRY_ADDED', 'LEAD_CONTACT_ENTRY_CHANGED', 'LEAD_CONTACT_ENTRY_CHANGED',
        'LEAD_CONTACT_ENTRY_CORRECTED', 'LEAD_CONTACT_ENTRY_REMOVED',
      ]);
      const of = (type: string) => events.filter((e) => e.event_type === type);
      expect(of('LEAD_CONTACT_ENTRY_ADDED')[0]).toMatchObject({
        creator: { id: me.id },
        description: 'Phone (617) 555-0199 added for this lead only',
        metadata: { kind: 'PHONE', intent: 'ADDED', old: null, new: { value: '6175550199', label: 'Wife' } },
      });
      expect(of('LEAD_CONTACT_ENTRY_CORRECTED')[0]!.metadata).toMatchObject({ old: { value: '6175550199' }, new: { value: '6175550177' } });
      expect(events.every((e) => e.description.includes('this lead'))).toBe(true);
    });

    it('writes nothing to a job timeline, and a refused write leaves no event', async () => {
      const { org, customer, me, lead, api } = await setup(leadsOnly);
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      await api.post(base(lead.id), { kind: 'PHONE', value: '12' });
      await api.post(base(lead.id), { kind: 'PHONE', value: '6175550101' });
      await api.post(base(lead.id), { kind: 'EMAIL', value: 'wife@example.test' });

      expect(await leadEvents(api, lead.id)).toHaveLength(1);
      expect(await db.timelineEvent.count({ where: { entity_type: 'JOB', entity_id: job.id, event_type: { startsWith: 'JOB_CONTACT_ENTRY_' } } })).toBe(0);
      expect(await db.timelineEvent.count({ where: { entity_type: 'JOB', entity_id: lead.id } })).toBe(0);
    });
  });
});
