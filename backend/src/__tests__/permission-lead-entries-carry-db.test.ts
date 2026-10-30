/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.15 - a lead's own entries are carried onto the job at conversion.

   Converting a lead (one estimate or several) copies the lead's LIVE entries onto the new job: the same kind, intent,
   value, extension, label, overridden customer field or row and author, each linked to the lead entry it came from. A
   removed entry is not carried. The copy is not a person's edit: it is not checked against the converter's switches and
   the job's history names the lead entry's author and date, not the converter's. Converting again never doubles it.
   Afterwards a Won lead is closed (read-only), and a reopened lead's entries are editable again without reaching the
   job. The carried entries are ordinary live job entries: the job page, the job lock and the office review read them.

   Everything goes through the job and lead routes, called as people on custom roles (never a built-in role name).
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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

// The suite-wide setup hands every record the same number; these cases create several jobs in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog on (a choice at its widest option, a list empty). */
const ALL_ON: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [
    s.key,
    s.kind === 'choice' ? (s.choices!.includes('all') ? 'all' : s.choices![s.choices!.length - 1]!) : s.kind === 'list' ? [] : true,
  ]),
);

/** The PRD's own wording for a closed lead. */
const CLOSED_MESSAGE = 'This lead is closed. Reopen it to change it.';

suite("carrying a lead's entries onto the job at conversion (real database)", () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding these switch values on top of the Technician preset. */
  async function personWith(org: string, values: Record<string, SwitchValue>, name?: string): Promise<Person> {
    const key = `carry-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `carry${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
    await db.user.update({ where: { id: person.id }, data: { first_name: name ?? `Carry${sequence}`, last_name: 'Author' } });
    return person;
  }

  /** The author of the lead's entries: holds every switch. */
  const author = (org: string, name = 'Ana') => personWith(org, ALL_ON, name);

  /** The converter holds the switches a conversion needs and NOTHING that edits a contact detail. */
  const converterWithoutContactEdit = (org: string) =>
    personWith(org, {
      create_jobs: true,
      view_estimates: true,
      view_jobs: true,
      jobs_scope: 'all',
      leads_scope: 'all',
      edit_job_and_lead_contact_details: false,
      edit_jobs: false,
      edit_leads: false,
    }, 'Con');

  /** A lead with a customer that has a phone, an email and a name, and `estimates` WON estimates ready to convert. */
  async function leadToConvert(org: string, customer: string, adminId: string, estimates = 1) {
    await db.customer.update({
      where: { id: customer },
      data: { phone: '6175550101', email: 'pat@example.test', first_name: 'Pat', last_name: 'Jones', company_name: 'Jones Hardware' },
    });
    const location = randomUUID();
    await db.serviceLocation.create({
      data: { id: location, customer_id: customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
    });
    const lead = await fx.addLead(org, customer, {});
    const estimateIds: string[] = [];
    for (let i = 0; i < estimates; i++) {
      const estimate = await fx.addEstimate(org, customer, adminId, { leadId: lead.id });
      await db.estimate.update({ where: { id: estimate.id }, data: { status: 'WON' } });
      estimateIds.push(estimate.id);
    }
    return { lead: lead.id, estimateIds, location };
  }

  type Conversion = Awaited<ReturnType<typeof leadToConvert>>;

  /** Convert the lead's estimates the way the Convert dialog does: one id for one estimate, a list for several. */
  async function convert(api: Api, c: Conversion) {
    const body = c.estimateIds.length === 1
      ? { estimate_id: c.estimateIds[0], service_location_id: c.location }
      : { estimate_ids: c.estimateIds, service_location_id: c.location };
    const res = await api.post('/api/jobs', body);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return { id: (res.body as { job: { id: string } }).job.id, response: res };
  }

  const leadBase = (leadId: string) => `/api/leads/${leadId}/contact-entries`;

  /** The lead's entries as the author wrote them: two live ones and one removed. */
  async function writeLeadEntries(api: Api, leadId: string) {
    const phone = await api.post(leadBase(leadId), { kind: 'PHONE', value: '6175550199', extension: '12', label: 'Wife' });
    expect(phone.status).toBe(201);
    const email = await api.post(leadBase(leadId), { kind: 'EMAIL', value: 'wife@example.test', label: 'Billing' });
    expect(email.status).toBe(201);
    const gone = await api.post(leadBase(leadId), { kind: 'PHONE', value: '6175550123' });
    expect(gone.status).toBe(201);
    const goneId = (gone.body.entries as { id: string; value: string }[]).find((e) => e.value === '6175550123')!.id;
    expect((await api.delete(`${leadBase(leadId)}/${goneId}`)).status).toBe(200);
  }

  const jobEntries = (jobId: string) =>
    db.recordContactEntry.findMany({ where: { job_id: jobId }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] });
  const leadEntries = (leadId: string) =>
    db.recordContactEntry.findMany({ where: { lead_id: leadId }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] });

  const sources = [
    ['a single estimate', 1],
    ['several estimates', 2],
  ] as const;

  describe.each(sources)('converting %s', (_label, estimates) => {
    it('gives the job exactly the lead\'s live entries, each linked to its lead entry and keeping its author', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org);
      const c = await leadToConvert(org, customer, admin.id, estimates);
      await writeLeadEntries(await fx.signedInAs(ana), c.lead);
      const onLead = await leadEntries(c.lead);
      expect(onLead).toHaveLength(3);
      const liveOnLead = onLead.filter((e) => e.removed_at === null);
      expect(liveOnLead).toHaveLength(2);

      const job = await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), c);

      const carried = await jobEntries(job.id);
      expect(carried).toHaveLength(2);
      expect(carried.map((e) => e.source_entry_id).sort()).toEqual(liveOnLead.map((e) => e.id).sort());
      for (const entry of carried) {
        const from = liveOnLead.find((l) => l.id === entry.source_entry_id)!;
        expect({
          kind: entry.kind, intent: entry.intent, value: entry.value, extension: entry.extension, label: entry.label,
          overridden_field: entry.overridden_field, overridden_row_id: entry.overridden_row_id,
          customer_value_at_change: entry.customer_value_at_change,
          created_by_id: entry.created_by_id, created_by_name: entry.created_by_name,
        }).toEqual({
          kind: from.kind, intent: from.intent, value: from.value, extension: from.extension, label: from.label,
          overridden_field: from.overridden_field, overridden_row_id: from.overridden_row_id,
          customer_value_at_change: from.customer_value_at_change,
          created_by_id: ana.id, created_by_name: from.created_by_name,
        });
        expect(entry.removed_at).toBeNull();
        expect(entry.lead_id).toBeNull();
      }
    });

    it("writes the carry-over on the job's history under the LEAD entry's author, not the converter's", async () => {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org, 'Ana');
      const c = await leadToConvert(org, customer, admin.id, estimates);
      await writeLeadEntries(await fx.signedInAs(ana), c.lead);
      const onLead = (await leadEntries(c.lead)).filter((e) => e.removed_at === null);
      const converter = await converterWithoutContactEdit(org);

      const job = await convert(await fx.signedInAs(converter), c);

      const events = await db.timelineEvent.findMany({
        where: { entity_type: 'JOB', entity_id: job.id, event_type: { startsWith: 'JOB_CONTACT_ENTRY_' } },
        orderBy: { created_at: 'asc' },
      });
      expect(events).toHaveLength(2);
      const carried = await jobEntries(job.id);
      for (const event of events) {
        expect(event.created_by).toBe(ana.id);
        expect(event.created_by).not.toBe(converter.id);
        expect(event.description).toContain('carried from the lead');
        expect(event.description).toContain('Ana Author');
        const meta = event.metadata as { entry_id: string; source_entry_id: string; carried_from_lead: boolean; entry_created_at: string };
        expect(meta.carried_from_lead).toBe(true);
        const entry = carried.find((e) => e.id === meta.entry_id)!;
        expect(entry.source_entry_id).toBe(meta.source_entry_id);
        // The date is the lead entry's own, not the day of the conversion.
        expect(meta.entry_created_at).toBe(onLead.find((l) => l.id === meta.source_entry_id)!.created_at.toISOString());
      }

      // And the job's history feed shows them to anyone who opens the job.
      const feed = await (await fx.signedInAs(admin)).get(`/api/jobs/${job.id}/timeline`);
      const shown = (feed.body.events as { description: string; creator: { id: string } | null }[]).filter((e) => e.description.includes('carried from the lead'));
      expect(shown).toHaveLength(2);
      expect(shown.every((e) => e.creator?.id === ana.id)).toBe(true);
    });

    it('carries a live change of the customer\'s phone and name with the field it overrides, and not a removed one', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org, 'Ana');
      const c = await leadToConvert(org, customer, admin.id, estimates);
      const api = await fx.signedInAs(ana);
      const phone = await api.post(`${leadBase(c.lead)}/change`, { kind: 'PHONE', replaces: '6175550101', value: '6175550188' });
      expect(phone.status).toBe(201);
      expect((await api.post(`${leadBase(c.lead)}/name`, { kind: 'FIRST_NAME', value: 'Patrick' })).status).toBe(201);
      const company = await api.post(`${leadBase(c.lead)}/name`, { kind: 'COMPANY_NAME', value: 'Jones Hardware Inc' });
      expect(company.status).toBe(201);
      const companyId = (company.body.entries as { id: string; kind: string }[]).find((e) => e.kind === 'COMPANY_NAME')!.id;
      expect((await api.delete(`${leadBase(c.lead)}/${companyId}`)).status).toBe(200);

      const job = await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), c);

      const carried = await jobEntries(job.id);
      expect(carried.map((e) => [e.kind, e.intent, e.value, e.overridden_field, e.customer_value_at_change])).toEqual([
        ['PHONE', 'CHANGED', '6175550188', 'phone', '6175550101'],
        ['FIRST_NAME', 'CHANGED', 'Patrick', 'first_name', 'Pat'],
      ]);
      const events = await db.timelineEvent.findMany({ where: { entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_CONTACT_ENTRY_CHANGED' } });
      const sentences = events.map((e) => e.description);
      expect(sentences).toHaveLength(2);
      expect(sentences.some((d) => d.startsWith('Phone (617) 555-0101 changed to (617) 555-0188, carried from the lead'))).toBe(true);
      expect(sentences.some((d) => d.startsWith('First name Pat changed to Patrick, carried from the lead'))).toBe(true);
    });

    it('is not checked against the converter: the converter really holds no switch that edits a contact detail, and the job still gets the entries', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org);
      const c = await leadToConvert(org, customer, admin.id, estimates);
      await writeLeadEntries(await fx.signedInAs(ana), c.lead);
      const converter = await converterWithoutContactEdit(org);
      const converterApi = await fx.signedInAs(converter);

      const job = await convert(converterApi, c);

      // The converter cannot add a phone to the job by hand ...
      const byHand = await converterApi.post(`/api/jobs/${job.id}/contact-entries`, { kind: 'PHONE', value: '6175550777' });
      expect(byHand.status).toBe(403);
      // ... and the copy still landed.
      expect(await jobEntries(job.id)).toHaveLength(2);
    });

    it('leaves the lead with every entry it had, removed one included, and writes nothing on the lead', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org);
      const c = await leadToConvert(org, customer, admin.id, estimates);
      await writeLeadEntries(await fx.signedInAs(ana), c.lead);
      const before = await leadEntries(c.lead);
      const leadEventsBefore = await db.timelineEvent.count({ where: { entity_type: 'LEAD', entity_id: c.lead } });

      await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), c);

      expect(await leadEntries(c.lead)).toEqual(before);
      expect(await db.timelineEvent.count({ where: { entity_type: 'LEAD', entity_id: c.lead } })).toBe(leadEventsBefore);
    });

    it('carries nothing for a lead with no entries, and does not fail the conversion', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const c = await leadToConvert(org, customer, admin.id, estimates);

      const job = await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), c);

      expect(await jobEntries(job.id)).toHaveLength(0);
    });
  });

  describe('the lead afterwards', () => {
    const closedLead = (leadId: string, status: 'WON' | 'LOST') => db.lead.update({ where: { id: leadId }, data: { status } });

    it('is closed once Won: its entries stay, read-only for everyone, and the lead page still lists them', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org);
      const anaApi = await fx.signedInAs(ana);
      const c = await leadToConvert(org, customer, admin.id);
      await writeLeadEntries(anaApi, c.lead);
      await closedLead(c.lead, 'WON');
      const before = await leadEntries(c.lead);

      const job = await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), c);

      expect(await jobEntries(job.id)).toHaveLength(2);
      const liveId = before.find((e) => e.removed_at === null)!.id;
      for (const res of [
        await anaApi.post(leadBase(c.lead), { kind: 'PHONE', value: '6175550444' }),
        await anaApi.patch(`${leadBase(c.lead)}/${liveId}`, { label: 'Changed' }),
        await anaApi.delete(`${leadBase(c.lead)}/${liveId}`),
      ]) {
        expect(res.status).toBe(403);
        expect(res.body.error).toBe(CLOSED_MESSAGE);
      }
      expect(await leadEntries(c.lead)).toEqual(before);
      const page = await anaApi.get(`/api/leads/${c.lead}`);
      expect((page.body.lead.contact_entries as unknown[]).length).toBe(2);
    });

    it('keeps a Lost lead\'s entries on the lead, read-only, with no job to carry them to', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org);
      const anaApi = await fx.signedInAs(ana);
      const c = await leadToConvert(org, customer, admin.id);
      await writeLeadEntries(anaApi, c.lead);
      await closedLead(c.lead, 'LOST');

      const refused = await anaApi.post(leadBase(c.lead), { kind: 'PHONE', value: '6175550444' });

      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe(CLOSED_MESSAGE);
      expect((await leadEntries(c.lead)).filter((e) => e.removed_at === null)).toHaveLength(2);
      expect(await db.recordContactEntry.count({ where: { organization_id: org, job_id: { not: null } } })).toBe(0);
    });

    it('becomes editable again when a Won lead is reopened, and nothing written on the lead reaches the job', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org);
      const anaApi = await fx.signedInAs(ana);
      const c = await leadToConvert(org, customer, admin.id);
      await writeLeadEntries(anaApi, c.lead);
      await closedLead(c.lead, 'WON');
      const job = await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), c);
      const carriedBefore = await jobEntries(job.id);
      expect(carriedBefore).toHaveLength(2);

      const reopened = await anaApi.post(`/api/leads/${c.lead}/reopen`, { reason: 'The customer called back' });
      expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);

      const phone = (await leadEntries(c.lead)).find((e) => e.kind === 'PHONE' && e.removed_at === null)!;
      expect((await anaApi.patch(`${leadBase(c.lead)}/${phone.id}`, { label: 'Daughter' })).status).toBe(200);
      expect((await anaApi.post(leadBase(c.lead), { kind: 'PHONE', value: '6175550444' })).status).toBe(201);
      expect((await anaApi.delete(`${leadBase(c.lead)}/${phone.id}`)).status).toBe(200);

      expect(await jobEntries(job.id)).toEqual(carriedBefore);
    });
  });

  describe('converting twice', () => {
    it('never doubles an entry already on the job, never brings back one taken off it, and carries one added to the lead since', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org);
      const anaApi = await fx.signedInAs(ana);
      const c = await leadToConvert(org, customer, admin.id);
      await writeLeadEntries(anaApi, c.lead);
      const job = await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), c);
      const { carryLeadEntriesToJob } = await import('../lib/record-contact-entries.js');
      const again = () => db.$transaction((tx) => carryLeadEntriesToJob(tx, { orgId: org, leadId: c.lead, jobId: job.id }));

      expect(await again()).toEqual([]);
      expect(await jobEntries(job.id)).toHaveLength(2);

      // The office takes one off the job; a retry does not put it back.
      const gone = (await jobEntries(job.id)).find((e) => e.kind === 'EMAIL')!;
      await db.recordContactEntry.update({ where: { id: gone.id }, data: { removed_at: new Date() } });
      expect(await again()).toEqual([]);
      expect((await jobEntries(job.id)).filter((e) => e.removed_at === null)).toHaveLength(1);

      // An entry written on the lead since is the only thing a second run adds.
      const added = await anaApi.post(leadBase(c.lead), { kind: 'PHONE', value: '6175550555' });
      expect(added.status).toBe(201);
      const second = await again();
      expect(second.map((e) => e.value)).toEqual(['6175550555']);
      expect(await jobEntries(job.id)).toHaveLength(3);
    });

    it('answers a second conversion of the same estimate with the same job and no second copy', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org);
      const c = await leadToConvert(org, customer, admin.id);
      await writeLeadEntries(await fx.signedInAs(ana), c.lead);
      const api = await fx.signedInAs(await converterWithoutContactEdit(org));
      const job = await convert(api, c);

      const twice = await convert(api, c);

      expect(twice.id).toBe(job.id);
      expect(await jobEntries(job.id)).toHaveLength(2);
      expect(await db.timelineEvent.count({ where: { entity_type: 'JOB', entity_id: job.id, event_type: { startsWith: 'JOB_CONTACT_ENTRY_' } } })).toBe(2);
    });

    it('carries the lead\'s entries again onto the job of a new conversion after the lead was reopened', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org);
      const anaApi = await fx.signedInAs(ana);
      const c = await leadToConvert(org, customer, admin.id);
      await writeLeadEntries(anaApi, c.lead);
      await db.lead.update({ where: { id: c.lead }, data: { status: 'WON' } });
      const first = await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), c);
      expect((await anaApi.post(`/api/leads/${c.lead}/reopen`, { reason: 'More work' })).status).toBe(200);

      // A second estimate on the same lead becomes a second job; it gets the lead's live entries as they are now.
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: c.lead });
      await db.estimate.update({ where: { id: estimate.id }, data: { status: 'WON' } });
      const second = await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), { ...c, estimateIds: [estimate.id] });

      expect(second.id).not.toBe(first.id);
      expect(await jobEntries(second.id)).toHaveLength(2);
      expect(await jobEntries(first.id)).toHaveLength(2);
    });
  });

  describe('on the job afterwards', () => {
    /** A converted job with the lead's two live entries on it. */
    async function convertedJob() {
      const { org, admin, customer } = await fx.newOrg();
      const ana = await author(org);
      const c = await leadToConvert(org, customer, admin.id);
      await writeLeadEntries(await fx.signedInAs(ana), c.lead);
      const job = await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), c);
      return { org, admin, customer, ana, lead: c.lead, job: job.id };
    }

    const editor = (org: string, over: Record<string, SwitchValue> = {}) => personWith(org, { ...ALL_ON, change_locked_jobs: false, ...over }, 'Ed');

    it('lists them on the job page with the lead entry each came from', async () => {
      const { org, job, lead } = await convertedJob();
      const viewer = await personWith(org, { view_jobs: true, jobs_scope: 'all' }, 'View');

      const res = await (await fx.signedInAs(viewer)).get(`/api/jobs/${job}`);

      expect(res.status).toBe(200);
      const entries = res.body.job.contact_entries as { kind: string; value: string; intent: string; source_entry_id: string | null; created_by: { name: string | null } }[];
      const fromLead = (await leadEntries(lead)).filter((e) => e.removed_at === null).map((e) => e.id).sort();
      expect(entries.map((e) => e.source_entry_id).sort()).toEqual(fromLead);
      expect(entries.map((e) => [e.kind, e.value, e.intent])).toEqual([
        ['PHONE', '6175550199', 'ADDED'],
        ['EMAIL', 'wife@example.test', 'ADDED'],
      ]);
      expect(entries.every((e) => e.created_by.name === 'Ana Author')).toBe(true);
    });

    it('are corrected and removed like any job entry by whoever holds the pencil, with the usual history, and the lead entry stays as it was', async () => {
      const { org, job, lead } = await convertedJob();
      const api = await fx.signedInAs(await editor(org));
      const [phone, email] = await jobEntries(job);
      const leadBefore = await leadEntries(lead);

      const corrected = await api.patch(`/api/jobs/${job}/contact-entries/${phone!.id}`, { label: 'Daughter' });
      const removed = await api.delete(`/api/jobs/${job}/contact-entries/${email!.id}`);

      expect(corrected.status).toBe(200);
      expect(removed.status).toBe(200);
      expect((await jobEntries(job)).map((e) => [e.label, e.removed_at === null])).toEqual([['Daughter', true], ['Billing', false]]);
      expect(await db.timelineEvent.count({ where: { entity_type: 'JOB', entity_id: job, event_type: { in: ['JOB_CONTACT_ENTRY_CORRECTED', 'JOB_CONTACT_ENTRY_REMOVED'] } } })).toBe(2);
      expect(await leadEntries(lead)).toEqual(leadBefore);
    });

    it('count as the job\'s own entries for the job lock: refused once the job is Completed without Change locked jobs, accepted with it', async () => {
      const { org, job } = await convertedJob();
      await db.job.update({ where: { id: job }, data: { status: 'COMPLETED' } });
      const [phone] = await jobEntries(job);
      const locked = await (await fx.signedInAs(await editor(org))).patch(`/api/jobs/${job}/contact-entries/${phone!.id}`, { label: 'Daughter' });
      const keyHolder = await (await fx.signedInAs(await editor(org, { change_locked_jobs: true }))).patch(`/api/jobs/${job}/contact-entries/${phone!.id}`, { label: 'Daughter' });

      expect(locked.status).toBe(403);
      expect(locked.body.code).toBe('JOB_LOCKED');
      expect(keyHolder.status).toBe(200);
    });

    /** A reviewer who may read and finish the review, and the job put into Office review with its first round open from the job's creation. */
    async function inOfficeReview(org: string, job: string) {
      const reviewer = await personWith(org, {
        ...Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, typeof ALL_ON[k] === 'boolean' ? false : ALL_ON[k]!])),
        view_jobs: true, jobs_scope: 'all', office_review: true,
      }, 'Rev');
      const created = await db.job.findUniqueOrThrow({ where: { id: job }, select: { created_at: true } });
      // The first round starts at the job's creation, so what was carried at conversion is inside it.
      await db.job.update({ where: { id: job }, data: { status: 'OFFICE_REVIEW', completed_at: new Date() } });
      await db.jobReview.create({ data: { organization_id: org, job_id: job, window_start: created.created_at } });
      await db.timelineEvent.create({
        data: { organization_id: org, entity_type: 'JOB', entity_id: job, event_type: 'OFFICE_REVIEW_STARTED', description: 'Office review started', created_at: new Date(Date.now() + 5) },
      });
      return fx.signedInAs(reviewer);
    }

    it('are normal live job entries for the office review: listed as customer items, ticked, and applied to the customer at Finish', async () => {
      const { org, customer, job } = await convertedJob();
      const api = await inOfficeReview(org, job);
      type Item = { key: string; kind: string; checked: boolean; latest_entry_id: string; contact?: { kind: string; removed: boolean; choice: string | null; options: string[] } };
      type Review = { summary: { checked: boolean; latest_entry_id: string | null }; groups: { key: string; items: Item[] }[]; version: string };
      const read = async (): Promise<Review> => (await api.get(`/api/jobs/${job}/review`)).body.review;
      const contacts = (r: Review) => r.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items).filter((i) => i.kind === 'contact');

      const review = await read();
      expect(contacts(review).map((i) => [i.contact!.kind, i.contact!.removed, i.contact!.options])).toEqual([
        ['PHONE', false, ['ADD', 'THIS_JOB_ONLY']],
        ['EMAIL', false, ['ADD', 'THIS_JOB_ONLY']],
      ]);
      const mixed = await api.get(`/api/jobs/${job}/review`);
      expect(JSON.stringify(mixed.body)).toContain('Ana Author');

      if (!review.summary.checked && review.summary.latest_entry_id) {
        const plain = [{ item_key: 'summary', entry_id: review.summary.latest_entry_id }];
        expect((await api.post(`/api/jobs/${job}/review/checks/all`, { items: plain })).status).toBe(200);
      }
      for (const item of contacts(await read())) {
        const res = await api.post(`/api/jobs/${job}/review/decisions`, { item_key: item.key, entry_id: item.latest_entry_id, choice: item.contact!.choice });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      const done = await api.post(`/api/jobs/${job}/review/finish`, { version: (await read()).version });
      expect(done.status, JSON.stringify(done.body)).toBe(200);

      const updated = await db.customer.findUniqueOrThrow({ where: { id: customer }, include: { phones: true, extra_emails: true } });
      expect(updated.phones.map((p) => p.phone)).toEqual(['6175550199']);
      expect(updated.extra_emails.map((e) => e.email)).toEqual(['wife@example.test']);
    });

    /** Two ids that sort the same way every time: `first` after `second`, whatever the database or the clock does. */
    const idsInReverse = () => ({ high: `ffffffff${randomUUID().slice(8)}`, low: `00000000${randomUUID().slice(8)}` });

    describe.each([
      ['phone then email', ['PHONE', 'EMAIL']],
      ['email then phone', ['EMAIL', 'PHONE']],
    ] as const)('when the lead had %s and the carried entries share one moment', (_label, order) => {
      const values = { PHONE: { kind: 'PHONE', value: '6175550199' }, EMAIL: { kind: 'EMAIL', value: 'wife@example.test' } } as const;

      it("lists the review's customer items in the lead's order, on every read", async () => {
        const { org, admin, customer } = await fx.newOrg();
        const anaApi = await fx.signedInAs(await author(org));
        const c = await leadToConvert(org, customer, admin.id);
        for (const kind of order) expect((await anaApi.post(leadBase(c.lead), values[kind])).status).toBe(201);
        const job = await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), c);

        // One statement carries them at conversion, so their history entries can land in the same millisecond (the
        // column keeps no finer time). Force that, and give the entry that came FIRST the id that sorts LAST, so an
        // order that falls back on the id cannot match the lead's by luck.
        const carriedEvents = await db.timelineEvent.findMany({
          where: { entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_CONTACT_ENTRY_ADDED' },
        });
        const bySource = new Map(carriedEvents.map((e) => [(e.metadata as { source_entry_id: string }).source_entry_id, e]));
        const { high, low } = idsInReverse();
        const sameMoment = new Date();
        const onLead = (await leadEntries(c.lead)).filter((e) => e.removed_at === null);
        expect(onLead.map((e) => e.kind)).toEqual(order);
        await db.timelineEvent.update({ where: { id: bySource.get(onLead[0]!.id)!.id }, data: { id: high, created_at: sameMoment } });
        await db.timelineEvent.update({ where: { id: bySource.get(onLead[1]!.id)!.id }, data: { id: low, created_at: sameMoment } });

        const api = await inOfficeReview(org, job.id);
        type Item = { key: string; kind: string; contact?: { kind: string } };
        const read = async () => {
          const review = (await api.get(`/api/jobs/${job.id}/review`)).body.review as { groups: { key: string; items: Item[] }[] };
          return review.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items).filter((i) => i.kind === 'contact');
        };

        const first = await read();
        expect(first.map((i) => i.contact!.kind)).toEqual(order);
        for (let i = 0; i < 3; i++) expect(await read()).toEqual(first);
        // The items keep their keys: one per job entry, so a tick made against one still finds it.
        expect(first.map((i) => i.key).sort()).toEqual((await jobEntries(job.id)).map((e) => `contact:${e.id}`).sort());
      });

      it('lists the job page entries in the lead\'s order even when the lead\'s entries share one moment', async () => {
        const { org, admin, customer } = await fx.newOrg();
        const anaApi = await fx.signedInAs(await author(org));
        const c = await leadToConvert(org, customer, admin.id);
        for (const kind of order) expect((await anaApi.post(leadBase(c.lead), values[kind])).status).toBe(201);
        // The same moment on the lead: its own list now falls back on the entry ids.
        await db.recordContactEntry.updateMany({ where: { lead_id: c.lead }, data: { created_at: new Date() } });
        const onLead = await leadEntries(c.lead);
        const job = await convert(await fx.signedInAs(await converterWithoutContactEdit(org)), c);

        // The job's entries get fresh ids when they are carried; make the id order the OPPOSITE of the lead's.
        const { high, low } = idsInReverse();
        for (const [index, id] of [high, low].entries()) {
          const carried = await db.recordContactEntry.findFirstOrThrow({ where: { job_id: job.id, source_entry_id: onLead[index]!.id } });
          await db.recordContactEntry.update({ where: { id: carried.id }, data: { id } });
        }

        const viewer = await fx.signedInAs(admin);
        const onJobPage = (await viewer.get(`/api/jobs/${job.id}`)).body.job.contact_entries as { value: string }[];
        const onLeadPage = (await viewer.get(`/api/leads/${c.lead}`)).body.lead.contact_entries as { value: string }[];
        expect(onLeadPage.map((e) => e.value)).toEqual(onLead.map((e) => e.value));
        expect(onJobPage.map((e) => e.value)).toEqual(onLeadPage.map((e) => e.value));
      });
    });

    it('are found by the lookup Finish uses, which refuses an entry of another job', async () => {
      const { org, job } = await convertedJob();
      const other = await convertedJob();
      const { findLiveJobEntry } = await import('../lib/record-contact-entries.js');
      const [phone] = await jobEntries(job);

      expect((await findLiveJobEntry(db, org, job, phone!.id))?.source_entry_id).toBe(phone!.source_entry_id);
      expect(await findLiveJobEntry(db, org, other.job, phone!.id)).toBeNull();
    });
  });
});
