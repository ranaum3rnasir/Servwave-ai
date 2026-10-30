/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.7 - a job-only phone or email, added with the pencil.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) whose
   switch values are the ones under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it
   is unset. Every org it creates is removed again.
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

suite('job-only phones and emails (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values on top of the Technician preset. */
  async function personWith(org: string, values: Record<string, boolean | string>): Promise<Person> {
    const key = `jce-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    return fx.addUser(org, `jce${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
  }

  /** Holds the pencil through Edit job and lead contact details alone. */
  const contactOnly = { edit_job_and_lead_contact_details: true, edit_jobs: false, jobs_scope: 'attached' };

  async function fillCustomer(customer: string) {
    await db.customer.update({
      where: { id: customer },
      data: { phone: '6175550101', email: 'pat@example.test' },
    });
  }

  async function setup(values: Record<string, boolean | string> = contactOnly) {
    const { org, customer } = await fx.newOrg();
    await fillCustomer(customer);
    const me = await personWith(org, values);
    const job = await fx.addJob(org, customer, { crew: [me.id] });
    return { org, customer, me, job, api: await fx.signedInAs(me) };
  }

  const addPath = (jobId: string) => `/api/jobs/${jobId}/contact-entries`;

  describe('adding an entry', () => {
    it('lets a person with Edit job and lead contact details add a phone and an email, and leaves the customer record alone', async () => {
      expect(findSwitch('edit_job_and_lead_contact_details')).toBeDefined();
      const { customer, job, api } = await setup();
      const before = await db.customer.findUniqueOrThrow({ where: { id: customer }, include: { phones: true, extra_emails: true } });

      const phone = await api.post(addPath(job.id), { kind: 'PHONE', value: '(617) 555-0199', extension: '4', label: "Wife's cell" });
      const email = await api.post(addPath(job.id), { kind: 'EMAIL', value: 'wife@example.test', label: 'Wife' });

      expect(phone.status).toBe(201);
      expect(email.status).toBe(201);
      const after = await db.customer.findUniqueOrThrow({ where: { id: customer }, include: { phones: true, extra_emails: true } });
      expect(after).toEqual(before);
      // The answer is the job's live entries after the add.
      const entries = email.body.entries as Entry[];
      expect(entries.map((e) => [e.kind, e.value])).toEqual([['PHONE', '6175550199'], ['EMAIL', 'wife@example.test']]);
    });

    it('returns the entries on the job detail to anyone who can open the job, View customers off included', async () => {
      const { org, customer, job, api } = await setup();
      await api.post(addPath(job.id), { kind: 'PHONE', value: '6175550199', label: 'Wife' });
      const reader = await personWith(org, { view_customers: false, edit_job_and_lead_contact_details: false, edit_jobs: false, jobs_scope: 'all' });
      expect(customer).toBeTruthy();

      const res = await (await fx.signedInAs(reader)).get(`/api/jobs/${job.id}`);

      expect(res.status).toBe(200);
      const entries = res.body.job.contact_entries as Entry[];
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'PHONE', intent: 'ADDED', value: '6175550199', label: 'Wife' });
    });

    it('pins the entry fields the office review reads', async () => {
      const { me, job, api } = await setup();
      const res = await api.post(addPath(job.id), { kind: 'PHONE', value: '6175550199', extension: '12', label: 'Wife' });
      const entry = (res.body.entries as Entry[])[0]!;

      expect(Object.keys(entry).sort()).toEqual([
        'created_at', 'created_by', 'customer_value_at_change', 'extension', 'id', 'intent', 'kind', 'label',
        'overridden_field', 'overridden_row_id', 'source_entry_id', 'updated_at', 'updated_by', 'value',
      ]);
      expect(entry).toMatchObject({
        kind: 'PHONE', intent: 'ADDED', value: '6175550199', extension: '12', label: 'Wife',
        overridden_field: null, overridden_row_id: null, customer_value_at_change: null, source_entry_id: null,
        created_by: { id: me.id, name: expect.stringMatching(/^jce\d+ Tester$/) },
      });
      expect(entry.updated_by.id).toBe(me.id);
      expect(Number.isNaN(Date.parse(entry.created_at))).toBe(false);
    });

    it('stores one row for the job and no row for any other record', async () => {
      const { org, customer, job, api } = await setup();
      const otherJob = await fx.addJob(org, customer, {});
      await api.post(addPath(job.id), { kind: 'EMAIL', value: 'wife@example.test' });

      expect(await db.recordContactEntry.count({ where: { job_id: job.id, organization_id: org } })).toBe(1);
      expect(await db.recordContactEntry.count({ where: { job_id: otherJob.id } })).toBe(0);
    });

    it('writes exactly one history event per add with who, when, kind, intent, the new value and the label', async () => {
      const { me, job, api } = await setup();
      await api.post(addPath(job.id), { kind: 'PHONE', value: '6175550199', label: 'Wife' });

      const timeline = await api.get(`/api/jobs/${job.id}/timeline`);
      const events = (timeline.body.events as { event_type: string; metadata: Record<string, unknown>; created_at: string; creator: { id: string } | null }[])
        .filter((e) => e.event_type === 'JOB_CONTACT_ENTRY_ADDED');

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.creator?.id).toBe(me.id);
      expect(Number.isNaN(Date.parse(event.created_at))).toBe(false);
      expect(event.metadata).toMatchObject({ kind: 'PHONE', intent: 'ADDED', old: null, new: { value: '6175550199', label: 'Wife' } });
    });
  });

  describe('the gate', () => {
    it('refuses the add with Edit job and lead contact details off and Edit jobs off, even with Add notes on', async () => {
      const { job, api } = await setup({ edit_job_and_lead_contact_details: false, edit_jobs: false, add_notes: true, jobs_scope: 'attached' });

      const res = await api.post(addPath(job.id), { kind: 'PHONE', value: '6175550199' });

      expect(res.status).toBe(403);
    });

    it('accepts the add with Edit jobs on alone', async () => {
      const { job, api } = await setup({ edit_job_and_lead_contact_details: false, edit_jobs: true, jobs_scope: 'attached' });

      const res = await api.post(addPath(job.id), { kind: 'EMAIL', value: 'wife@example.test' });

      expect(res.status).toBe(201);
    });

    it('asks who may open the job first: forbidden once taken off the crew, not found for another company or a missing id', async () => {
      const { me, job, api } = await setup();
      expect((await api.post(addPath(job.id), { kind: 'EMAIL', value: 'one@example.test' })).status).toBe(201);

      await fx.removeCrew(job.visitId!, me.id);
      const off = await (await fx.signedInAs(me)).post(addPath(job.id), { kind: 'EMAIL', value: 'two@example.test' });
      expect(off.status).toBe(403);

      const other = await fx.newOrg();
      const foreign = await fx.addJob(other.org, other.customer, {});
      expect((await (await fx.signedInAs(me)).post(addPath(foreign.id), { kind: 'EMAIL', value: 'x@example.test' })).status).toBe(404);
      expect((await (await fx.signedInAs(me)).post(addPath(randomUUID()), { kind: 'EMAIL', value: 'x@example.test' })).status).toBe(404);
      expect(await db.recordContactEntry.count({ where: { job_id: job.id } })).toBe(1);
    });
  });

  describe('what is refused', () => {
    it('refuses a phone or an email that is not valid, with a plain message', async () => {
      const { job, api } = await setup();

      const phone = await api.post(addPath(job.id), { kind: 'PHONE', value: '12' });
      const email = await api.post(addPath(job.id), { kind: 'EMAIL', value: 'not-an-email' });
      const kind = await api.post(addPath(job.id), { kind: 'FIRST_NAME', value: 'Pat' });

      expect(phone.status).toBe(400);
      expect(JSON.stringify(phone.body)).toContain('Enter a valid phone number');
      expect(email.status).toBe(400);
      expect(JSON.stringify(email.body)).toContain('Enter a valid email address');
      expect(kind.status).toBe(400);
      expect(await db.recordContactEntry.count({ where: { job_id: job.id } })).toBe(0);
    });

    it('refuses a value already on the customer, however it is typed', async () => {
      const { customer, job, api } = await setup();
      await db.customerPhone.create({ data: { customer_id: customer, phone: '6175550102', label: 'Cell', is_primary: false } });

      const primary = await api.post(addPath(job.id), { kind: 'PHONE', value: '+1 (617) 555-0101' });
      const listed = await api.post(addPath(job.id), { kind: 'PHONE', value: '617-555-0102' });
      const email = await api.post(addPath(job.id), { kind: 'EMAIL', value: ' PAT@example.test ' });

      expect(primary.status).toBe(409);
      expect(primary.body.error).toBe('That number is already on this customer');
      expect(listed.status).toBe(409);
      expect(email.status).toBe(409);
      expect(email.body.error).toBe('That email is already on this customer');
    });

    it('refuses a value already live on the job, and takes it again once that entry is removed', async () => {
      const { job, api } = await setup();
      const first = await api.post(addPath(job.id), { kind: 'PHONE', value: '6175550199' });
      const entryId = (first.body.entries as Entry[])[0]!.id;

      const again = await api.post(addPath(job.id), { kind: 'PHONE', value: '(617) 555-0199' });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('That number is already on this job');
      expect((await api.post(addPath(job.id), { kind: 'EMAIL', value: 'a@example.test' })).status).toBe(201);
      expect((await api.post(addPath(job.id), { kind: 'EMAIL', value: 'A@example.test' })).body.error).toBe('That email is already on this job');

      await db.recordContactEntry.update({ where: { id: entryId }, data: { removed_at: new Date() } });
      expect((await api.post(addPath(job.id), { kind: 'PHONE', value: '6175550199' })).status).toBe(201);
    });

    it('does not show a removed entry on the job detail', async () => {
      const { job, api } = await setup();
      const first = await api.post(addPath(job.id), { kind: 'PHONE', value: '6175550199' });
      await db.recordContactEntry.update({ where: { id: (first.body.entries as Entry[])[0]!.id }, data: { removed_at: new Date() } });

      const res = await api.get(`/api/jobs/${job.id}`);

      expect(res.body.job.contact_entries).toEqual([]);
    });
  });

  describe('changing a customer phone or email for this job', () => {
    const changePath = (jobId: string) => `/api/jobs/${jobId}/contact-entries/change`;

    it('records the customer\'s value at change time, answers with the entry and leaves the customer record alone', async () => {
      const { customer, me, job, api } = await setup();
      const before = await db.customer.findUniqueOrThrow({ where: { id: customer }, include: { phones: true, extra_emails: true } });

      const res = await api.post(changePath(job.id), { kind: 'PHONE', replaces: '(617) 555-0101', value: '(617) 555-0188', extension: '7', label: 'New cell' });

      expect(res.status).toBe(201);
      const entries = res.body.entries as Entry[];
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: 'PHONE', intent: 'CHANGED', value: '6175550188', extension: '7', label: 'New cell',
        overridden_field: 'phone', overridden_row_id: null, customer_value_at_change: '6175550101',
        created_by: { id: me.id },
      });
      const after = await db.customer.findUniqueOrThrow({ where: { id: customer }, include: { phones: true, extra_emails: true } });
      expect(after).toEqual(before);
    });

    it('names the customer row it replaces when the number sits in the customer\'s phone list or extra emails', async () => {
      const { customer, job, api } = await setup();
      const phoneRow = await db.customerPhone.create({ data: { customer_id: customer, phone: '6175550102', label: 'Cell', is_primary: false } });
      const emailRow = await db.customerEmail.create({ data: { customer_id: customer, email: 'billing@example.test', label: 'Billing' } });

      const phone = await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550102', value: '6175550177' });
      const email = await api.post(changePath(job.id), { kind: 'EMAIL', replaces: 'Billing@example.test', value: 'ap@example.test' });
      const primary = await api.post(changePath(job.id), { kind: 'EMAIL', replaces: 'pat@example.test', value: 'pat.new@example.test' });

      expect(phone.status).toBe(201);
      expect(email.status).toBe(201);
      expect(primary.status).toBe(201);
      const byValue = Object.fromEntries((primary.body.entries as Entry[]).map((e) => [e.value, e]));
      expect(byValue['6175550177']).toMatchObject({ overridden_field: 'customer_phones', overridden_row_id: phoneRow.id, customer_value_at_change: '6175550102' });
      expect(byValue['ap@example.test']).toMatchObject({ overridden_field: 'extra_emails', overridden_row_id: emailRow.id, customer_value_at_change: 'billing@example.test' });
      expect(byValue['pat.new@example.test']).toMatchObject({ overridden_field: 'email', overridden_row_id: null, customer_value_at_change: 'pat@example.test' });
    });

    it('refuses a value that is no change, however it is typed, and takes a changed extension', async () => {
      const { customer, job, api } = await setup();
      await db.customer.update({ where: { id: customer }, data: { phone_ext: '5' } });

      const same = await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '+1 (617) 555-0101', extension: '5' });
      const email = await api.post(changePath(job.id), { kind: 'EMAIL', replaces: 'pat@example.test', value: ' PAT@example.test ' });
      const extension = await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550101', extension: '9' });

      expect(same.status).toBe(409);
      expect(same.body.error).toBe("No change: that is already this customer's number");
      expect(email.status).toBe(409);
      expect(email.body.error).toBe("No change: that is already this customer's email");
      expect(extension.status).toBe(201);
      expect(await db.recordContactEntry.count({ where: { job_id: job.id } })).toBe(1);
    });

    it('refuses a value that is not on the customer, a value already elsewhere on the customer or the job, and a second change of the same value', async () => {
      const { customer, job, api } = await setup();
      await db.customerPhone.create({ data: { customer_id: customer, phone: '6175550102', label: 'Cell', is_primary: false } });
      await api.post(addPath(job.id), { kind: 'PHONE', value: '6175550199' });

      const missing = await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550999', value: '6175550188' });
      const onCustomer = await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550102' });
      const onJob = await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '(617) 555-0199' });
      const invalid = await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '12' });
      const first = await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550188' });
      const again = await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550166' });

      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('That number is not on this customer');
      expect(onCustomer.status).toBe(409);
      expect(onCustomer.body.error).toBe('That number is already on this customer');
      expect(onJob.status).toBe(409);
      expect(onJob.body.error).toBe('That number is already on this job');
      expect(invalid.status).toBe(400);
      expect(first.status).toBe(201);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('That number is already changed on this job');
      expect(await db.recordContactEntry.count({ where: { job_id: job.id } })).toBe(2);
    });

    it('writes exactly one history event per change with the old value and the new value', async () => {
      const { me, job, api } = await setup();
      await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550188', label: 'New cell' });

      const timeline = await api.get(`/api/jobs/${job.id}/timeline`);
      const events = (timeline.body.events as { event_type: string; metadata: Record<string, unknown>; creator: { id: string } | null }[])
        .filter((e) => e.event_type === 'JOB_CONTACT_ENTRY_CHANGED');

      expect(events).toHaveLength(1);
      expect(events[0]!.creator?.id).toBe(me.id);
      expect(events[0]!.metadata).toMatchObject({
        kind: 'PHONE', intent: 'CHANGED',
        old: { value: '6175550101' },
        new: { value: '6175550188', label: 'New cell' },
      });
    });

    it('is refused with neither switch even with Add notes on, and accepted with Edit jobs alone', async () => {
      const neither = await setup({ edit_job_and_lead_contact_details: false, edit_jobs: false, add_notes: true, jobs_scope: 'attached' });
      const refused = await neither.api.post(changePath(neither.job.id), { kind: 'EMAIL', replaces: 'pat@example.test', value: 'new@example.test' });
      const jobsOnly = await setup({ edit_job_and_lead_contact_details: false, edit_jobs: true, jobs_scope: 'attached' });
      const accepted = await jobsOnly.api.post(changePath(jobsOnly.job.id), { kind: 'EMAIL', replaces: 'pat@example.test', value: 'new@example.test' });

      expect(refused.status).toBe(403);
      expect(await db.recordContactEntry.count({ where: { job_id: neither.job.id } })).toBe(0);
      expect(accepted.status).toBe(201);
    });

    it('asks who may open the job first: forbidden off the crew, not found for another company or a missing id', async () => {
      const { me, job, api } = await setup();
      await fx.removeCrew(job.visitId!, me.id);
      const off = await (await fx.signedInAs(me)).post(changePath(job.id), { kind: 'EMAIL', replaces: 'pat@example.test', value: 'two@example.test' });
      expect(off.status).toBe(403);

      const other = await fx.newOrg();
      const foreign = await fx.addJob(other.org, other.customer, {});
      expect((await api.post(changePath(foreign.id), { kind: 'EMAIL', replaces: 'x@example.test', value: 'y@example.test' })).status).toBe(404);
      expect((await api.post(changePath(randomUUID()), { kind: 'EMAIL', replaces: 'x@example.test', value: 'y@example.test' })).status).toBe(404);
      expect(await db.recordContactEntry.count({ where: { job_id: job.id } })).toBe(0);
    });

    it('leaves the customer on the job detail, the list and the history of the customer with the customer\'s own value', async () => {
      const { org, job, api } = await setup();
      await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550188' });
      await api.post(changePath(job.id), { kind: 'EMAIL', replaces: 'pat@example.test', value: 'new@example.test' });
      const admin = await db.user.findFirstOrThrow({ where: { organization_id: org, role: 'ADMIN' } });

      const detail = await api.get(`/api/jobs/${job.id}`);
      const list = await (await fx.signedInAs({ id: admin.id, email: admin.email })).get('/api/jobs');

      expect(detail.body.job.customer.phones.map((p: { phone: string }) => p.phone)).toEqual(['6175550101']);
      expect(detail.body.job.customer.emails.map((e: { email: string }) => e.email)).toEqual(['pat@example.test']);
      expect((detail.body.job.contact_entries as Entry[]).map((e) => e.intent)).toEqual(['CHANGED', 'CHANGED']);
      expect(JSON.stringify(list.body)).not.toContain('6175550188');
      expect(JSON.stringify(list.body)).not.toContain('new@example.test');
    });
  });

  describe('correcting and removing an entry, whoever added it (S05.9)', () => {
    const entryPath = (jobId: string, entryId: string) => `/api/jobs/${jobId}/contact-entries/${entryId}`;
    const changePath = (jobId: string) => `/api/jobs/${jobId}/contact-entries/change`;

    /** A job with a colleague who holds `values` and one who added a phone, both on the crew. */
    async function withColleagueEntry(values: Record<string, boolean | string> = contactOnly) {
      const { org, customer } = await fx.newOrg();
      await fillCustomer(customer);
      const author = await personWith(org, contactOnly);
      const fixer = await personWith(org, values);
      const job = await fx.addJob(org, customer, { crew: [author.id, fixer.id] });
      const authorApi = await fx.signedInAs(author);
      const added = await authorApi.post(addPath(job.id), { kind: 'PHONE', value: '6175550199', label: 'Wife' });
      const entry = (added.body.entries as Entry[])[0]!;
      return { org, customer, author, authorApi, fixer, fixerApi: await fx.signedInAs(fixer), job, entry };
    }

    it('lets a colleague correct and remove another person\'s phone entry with Edit job and lead contact details only', async () => {
      const { job, entry, fixer, fixerApi } = await withColleagueEntry();

      const fixed = await fixerApi.patch(entryPath(job.id, entry.id), { value: '(617) 555-0123', extension: '8', label: 'Husband' });
      expect(fixed.status).toBe(200);
      expect((fixed.body.entries as Entry[])[0]).toMatchObject({
        id: entry.id, value: '6175550123', extension: '8', label: 'Husband',
        created_by: { id: entry.created_by.id }, updated_by: { id: fixer.id },
      });

      const removed = await fixerApi.delete(entryPath(job.id, entry.id));
      expect(removed.status).toBe(200);
      expect(removed.body.entries).toEqual([]);
    });

    it('lets a colleague with Edit jobs only do the same', async () => {
      const { job, entry, fixerApi } = await withColleagueEntry({ edit_job_and_lead_contact_details: false, edit_jobs: true, jobs_scope: 'attached' });

      expect((await fixerApi.patch(entryPath(job.id, entry.id), { label: 'Husband' })).status).toBe(200);
      expect((await fixerApi.delete(entryPath(job.id, entry.id))).status).toBe(200);
    });

    it('refuses a person with neither switch, the entry\'s own author included, and changes nothing', async () => {
      const { org, customer, job, entry, fixerApi, author } = await withColleagueEntry({ edit_job_and_lead_contact_details: false, edit_jobs: false, add_notes: true, jobs_scope: 'attached' });

      expect((await fixerApi.patch(entryPath(job.id, entry.id), { label: 'Nope' })).status).toBe(403);
      expect((await fixerApi.delete(entryPath(job.id, entry.id))).status).toBe(403);

      // The author loses the switch: being the author gives nothing extra.
      await setRoleSwitchValues({
        organizationId: org,
        roleKey: (await db.user.findUniqueOrThrow({ where: { id: author.id }, include: { custom_role: true } })).custom_role!.key,
        values: { edit_job_and_lead_contact_details: false, edit_jobs: false },
        actorId: null,
        reason: 'manual',
      });
      const authorApi = await fx.signedInAs(author);
      expect((await authorApi.patch(entryPath(job.id, entry.id), { label: 'Mine' })).status).toBe(403);
      expect((await authorApi.delete(entryPath(job.id, entry.id))).status).toBe(403);

      const row = await db.recordContactEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(row).toMatchObject({ label: 'Wife', removed_at: null });
      expect(customer).toBeTruthy();
    });

    it('asks who may open the job first: forbidden off the crew, not found for another company, a missing job or a missing entry', async () => {
      const { job, entry, fixer, fixerApi } = await withColleagueEntry();
      const other = await fx.newOrg();
      const foreign = await fx.addJob(other.org, other.customer, {});

      expect((await fixerApi.patch(entryPath(foreign.id, entry.id), { label: 'x' })).status).toBe(404);
      expect((await fixerApi.delete(entryPath(randomUUID(), entry.id))).status).toBe(404);
      expect((await fixerApi.patch(entryPath(job.id, randomUUID()), { label: 'x' })).status).toBe(404);
      expect((await fixerApi.delete(entryPath(job.id, randomUUID()))).status).toBe(404);
      // An entry of another job is not found under this one.
      const second = await fx.addJob((await db.job.findUniqueOrThrow({ where: { id: job.id } })).organization_id, (await db.job.findUniqueOrThrow({ where: { id: job.id } })).customer_id, { crew: [fixer.id] });
      expect((await fixerApi.delete(entryPath(second.id, entry.id))).status).toBe(404);

      await fx.removeCrew(job.visitId!, fixer.id);
      expect((await (await fx.signedInAs(fixer)).patch(entryPath(job.id, entry.id), { label: 'x' })).status).toBe(403);
      expect((await (await fx.signedInAs(fixer)).delete(entryPath(job.id, entry.id))).status).toBe(403);
      expect((await db.recordContactEntry.findUniqueOrThrow({ where: { id: entry.id } })).removed_at).toBeNull();
    });

    it('removing an added entry keeps the row for history, drops it from the job detail and frees the number', async () => {
      const { job, entry, fixerApi } = await withColleagueEntry();

      await fixerApi.delete(entryPath(job.id, entry.id));

      const row = await db.recordContactEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(row.removed_at).not.toBeNull();
      expect((await fixerApi.get(`/api/jobs/${job.id}`)).body.job.contact_entries).toEqual([]);
      expect((await fixerApi.post(addPath(job.id), { kind: 'PHONE', value: '6175550199' })).status).toBe(201);
    });

    it('removing a changed entry brings the job back to the customer\'s value, and the customer can be changed again', async () => {
      const { org, customer } = await fx.newOrg();
      await fillCustomer(customer);
      const author = await personWith(org, contactOnly);
      const fixer = await personWith(org, contactOnly);
      const job = await fx.addJob(org, customer, { crew: [author.id, fixer.id] });
      const changed = await (await fx.signedInAs(author)).post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550188' });
      const entry = (changed.body.entries as Entry[])[0]!;
      const api = await fx.signedInAs(fixer);

      const undone = await api.delete(entryPath(job.id, entry.id));

      expect(undone.status).toBe(200);
      expect(undone.body.entries).toEqual([]);
      const detail = await api.get(`/api/jobs/${job.id}`);
      expect(detail.body.job.contact_entries).toEqual([]);
      expect(detail.body.job.customer.phones.map((p: { phone: string }) => p.phone)).toEqual(['6175550101']);
      expect((await db.customer.findUniqueOrThrow({ where: { id: customer } })).phone).toBe('6175550101');
      expect((await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550166' })).status).toBe(201);
    });

    it('refuses a correction that is not valid, is a duplicate, or is no change from the customer, with plain words', async () => {
      const { customer, job, entry, fixerApi } = await withColleagueEntry();
      await fixerApi.post(addPath(job.id), { kind: 'EMAIL', value: 'wife@example.test' });
      const email = (await db.recordContactEntry.findFirstOrThrow({ where: { job_id: job.id, kind: 'EMAIL' } })).id;

      const bad = await fixerApi.patch(entryPath(job.id, entry.id), { value: '12' });
      const onCustomer = await fixerApi.patch(entryPath(job.id, entry.id), { value: '617-555-0101' });
      const badEmail = await fixerApi.patch(entryPath(job.id, email), { value: 'nope' });
      const dupEmail = await fixerApi.patch(entryPath(job.id, email), { value: 'PAT@example.test' });
      const empty = await fixerApi.patch(entryPath(job.id, entry.id), {});

      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toContain('Enter a valid phone number');
      expect(onCustomer.status).toBe(409);
      expect(onCustomer.body.error).toBe('That number is already on this customer');
      expect(badEmail.status).toBe(400);
      expect(dupEmail.status).toBe(409);
      expect(dupEmail.body.error).toBe('That email is already on this customer');
      expect(empty.status).toBe(400);
      expect(customer).toBeTruthy();

      // Correcting only the label never trips a duplicate check against itself.
      expect((await fixerApi.patch(entryPath(job.id, entry.id), { value: '6175550199', label: 'Husband' })).status).toBe(200);
    });

    it('corrects a changed entry\'s value, refusing the customer\'s own value as no change', async () => {
      const { org, customer } = await fx.newOrg();
      await fillCustomer(customer);
      const me = await personWith(org, contactOnly);
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const api = await fx.signedInAs(me);
      const changed = await api.post(changePath(job.id), { kind: 'PHONE', replaces: '6175550101', value: '6175550188' });
      const entry = (changed.body.entries as Entry[])[0]!;

      const same = await api.patch(entryPath(job.id, entry.id), { value: '(617) 555-0101' });
      const fixed = await api.patch(entryPath(job.id, entry.id), { value: '6175550177' });

      expect(same.status).toBe(409);
      expect(same.body.error).toBe("No change: that is already this customer's number");
      expect(fixed.status).toBe(200);
      expect((fixed.body.entries as Entry[])[0]).toMatchObject({ intent: 'CHANGED', value: '6175550177', customer_value_at_change: '6175550101', overridden_field: 'phone' });
    });

    it('writes exactly one history event per correction and per removal, with the old and the new value', async () => {
      const { job, entry, fixer, fixerApi } = await withColleagueEntry();
      await fixerApi.patch(entryPath(job.id, entry.id), { value: '6175550123', label: 'Husband' });
      await fixerApi.delete(entryPath(job.id, entry.id));

      const timeline = await fixerApi.get(`/api/jobs/${job.id}/timeline`);
      type Event = { event_type: string; metadata: Record<string, unknown>; creator: { id: string } | null };
      const events = (timeline.body.events as Event[]).filter((e) => e.event_type.startsWith('JOB_CONTACT_ENTRY_'));
      const of = (type: string) => events.filter((e) => e.event_type === type);

      expect(of('JOB_CONTACT_ENTRY_CORRECTED')).toHaveLength(1);
      expect(of('JOB_CONTACT_ENTRY_CORRECTED')[0]!.creator?.id).toBe(fixer.id);
      expect(of('JOB_CONTACT_ENTRY_CORRECTED')[0]!.metadata).toMatchObject({
        entry_id: entry.id, kind: 'PHONE',
        old: { value: '6175550199', label: 'Wife' },
        new: { value: '6175550123', label: 'Husband' },
      });
      expect(of('JOB_CONTACT_ENTRY_REMOVED')).toHaveLength(1);
      expect(of('JOB_CONTACT_ENTRY_REMOVED')[0]!.metadata).toMatchObject({
        entry_id: entry.id, kind: 'PHONE', intent: 'ADDED',
        old: { value: '6175550123', label: 'Husband' }, new: null,
      });
    });

    it('records the customer\'s value that comes back when a changed entry is removed', async () => {
      const { org, customer } = await fx.newOrg();
      await fillCustomer(customer);
      const me = await personWith(org, contactOnly);
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const api = await fx.signedInAs(me);
      const entry = ((await api.post(changePath(job.id), { kind: 'EMAIL', replaces: 'pat@example.test', value: 'new@example.test' })).body.entries as Entry[])[0]!;
      await api.delete(entryPath(job.id, entry.id));

      const timeline = await api.get(`/api/jobs/${job.id}/timeline`);
      const removed = (timeline.body.events as { event_type: string; metadata: Record<string, unknown> }[]).find((e) => e.event_type === 'JOB_CONTACT_ENTRY_REMOVED')!;
      expect(removed.metadata).toMatchObject({ intent: 'CHANGED', old: { value: 'new@example.test' }, new: null, restored_customer_value: 'pat@example.test' });
    });

    it('refuses a second removal of an entry that is already gone', async () => {
      const { job, entry, fixerApi } = await withColleagueEntry();
      await fixerApi.delete(entryPath(job.id, entry.id));

      expect((await fixerApi.delete(entryPath(job.id, entry.id))).status).toBe(404);
      expect((await fixerApi.patch(entryPath(job.id, entry.id), { label: 'x' })).status).toBe(404);
    });

    it('lets a name entry be corrected or removed only with Edit jobs, never with Edit job and lead contact details alone', async () => {
      const { org, customer } = await fx.newOrg();
      await fillCustomer(customer);
      const contact = await personWith(org, contactOnly);
      const jobsEditor = await personWith(org, { edit_job_and_lead_contact_details: false, edit_jobs: true, jobs_scope: 'attached' });
      const job = await fx.addJob(org, customer, { crew: [contact.id, jobsEditor.id] });
      // Name entries are written by a later slice; a row is seeded the way that slice will write one.
      const name = await db.recordContactEntry.create({
        data: { organization_id: org, job_id: job.id, kind: 'FIRST_NAME', intent: 'CHANGED', value: 'Patricia', customer_value_at_change: 'Pat', created_by_id: jobsEditor.id },
        select: { id: true },
      });
      // The sign-in is read on a person's first request, so each person makes theirs before the next signs in.
      const contactApi = await fx.signedInAs(contact);

      expect((await contactApi.patch(entryPath(job.id, name.id), { value: 'Pete' })).status).toBe(403);
      expect((await contactApi.delete(entryPath(job.id, name.id))).status).toBe(403);
      const editorApi = await fx.signedInAs(jobsEditor);
      expect((await editorApi.patch(entryPath(job.id, name.id), { value: 'Pete' })).status).toBe(200);
      expect((await editorApi.delete(entryPath(job.id, name.id))).status).toBe(200);
    });
  });

  describe("changing the customer's name or company for this job (S05.10)", () => {
    const namePath = (jobId: string) => `/api/jobs/${jobId}/contact-entries/name`;
    const entryPath = (jobId: string, entryId: string) => `/api/jobs/${jobId}/contact-entries/${entryId}`;
    /** Edit jobs alone: names are Edit jobs only, never Edit job and lead contact details. */
    const jobsOnly = { edit_job_and_lead_contact_details: false, edit_jobs: true, jobs_scope: 'attached' };

    async function setupNamed(values: Record<string, boolean | string> = jobsOnly) {
      const made = await setup(values);
      await db.customer.update({ where: { id: made.customer }, data: { first_name: 'Pat', last_name: 'Rivera', company_name: 'Rivera Tile' } });
      return made;
    }

    it("changes the first name, last name and company name for the job, records the customer's value and leaves the customer alone", async () => {
      const { customer, me, job, api } = await setupNamed();
      const before = await db.customer.findUniqueOrThrow({ where: { id: customer } });

      const first = await api.post(namePath(job.id), { kind: 'FIRST_NAME', value: ' Patricia ' });
      const last = await api.post(namePath(job.id), { kind: 'LAST_NAME', value: 'Rivera-Soto' });
      const company = await api.post(namePath(job.id), { kind: 'COMPANY_NAME', value: 'Rivera Tile and Stone' });

      expect([first.status, last.status, company.status]).toEqual([201, 201, 201]);
      const entries = company.body.entries as Entry[];
      expect(entries.map((e) => [e.kind, e.intent, e.value, e.customer_value_at_change, e.overridden_field])).toEqual([
        ['FIRST_NAME', 'CHANGED', 'Patricia', 'Pat', 'first_name'],
        ['LAST_NAME', 'CHANGED', 'Rivera-Soto', 'Rivera', 'last_name'],
        ['COMPANY_NAME', 'CHANGED', 'Rivera Tile and Stone', 'Rivera Tile', 'company_name'],
      ]);
      expect(entries[0]).toMatchObject({ extension: null, label: null, overridden_row_id: null, created_by: { id: me.id } });
      expect(await db.customer.findUniqueOrThrow({ where: { id: customer } })).toEqual(before);
      // Every person who can open the job reads them on the detail.
      const detail = await api.get(`/api/jobs/${job.id}`);
      expect((detail.body.job.contact_entries as Entry[]).map((e) => e.kind)).toEqual(['FIRST_NAME', 'LAST_NAME', 'COMPANY_NAME']);
      expect(detail.body.job.customer).toMatchObject({ first_name: 'Pat', last_name: 'Rivera', company_name: 'Rivera Tile' });
    });

    it('takes a company name where the customer has none, and records that the customer held nothing', async () => {
      const { customer, job, api } = await setupNamed();
      await db.customer.update({ where: { id: customer }, data: { company_name: null } });

      const res = await api.post(namePath(job.id), { kind: 'COMPANY_NAME', value: 'Rivera Tile' });

      expect(res.status).toBe(201);
      expect((res.body.entries as Entry[])[0]).toMatchObject({ kind: 'COMPANY_NAME', customer_value_at_change: '' });
    });

    it('is accepted with Edit jobs and refused with only Edit job and lead contact details on, or neither', async () => {
      // The sign-in is read on a person's first request, so each person makes theirs before the next signs in.
      const contact = await setupNamed(contactOnly);
      const refused = await contact.api.post(namePath(contact.job.id), { kind: 'FIRST_NAME', value: 'Patricia' });
      // The same person still adds a phone: the contact switch covers phones and emails, not names.
      const added = await contact.api.post(addPath(contact.job.id), { kind: 'EMAIL', value: 'wife@example.test' });
      const neither = await setupNamed({ edit_job_and_lead_contact_details: false, edit_jobs: false, add_notes: true, jobs_scope: 'attached' });
      const none = await neither.api.post(namePath(neither.job.id), { kind: 'COMPANY_NAME', value: 'Other Co' });
      const editor = await setupNamed();
      const accepted = await editor.api.post(namePath(editor.job.id), { kind: 'COMPANY_NAME', value: 'Other Co' });

      expect(refused.status).toBe(403);
      expect(added.status).toBe(201);
      expect(none.status).toBe(403);
      expect(accepted.status).toBe(201);
      expect(await db.recordContactEntry.count({ where: { job_id: { in: [contact.job.id, neither.job.id] }, kind: { not: 'EMAIL' } } })).toBe(0);
    });

    it('asks who may open the job first: forbidden off the crew, not found for another company or a missing id', async () => {
      const { me, job, api } = await setupNamed();
      expect((await api.post(namePath(job.id), { kind: 'FIRST_NAME', value: 'Patricia' })).status).toBe(201);

      await fx.removeCrew(job.visitId!, me.id);
      const off = await (await fx.signedInAs(me)).post(namePath(job.id), { kind: 'LAST_NAME', value: 'Soto' });
      expect(off.status).toBe(403);

      const other = await fx.newOrg();
      const foreign = await fx.addJob(other.org, other.customer, {});
      expect((await (await fx.signedInAs(me)).post(namePath(foreign.id), { kind: 'LAST_NAME', value: 'Soto' })).status).toBe(404);
      expect((await (await fx.signedInAs(me)).post(namePath(randomUUID()), { kind: 'LAST_NAME', value: 'Soto' })).status).toBe(404);
      expect(await db.recordContactEntry.count({ where: { job_id: job.id } })).toBe(1);
    });

    it('refuses an empty name, one past the form limits, a kind that is not a name, a no-change and a second change of the same field', async () => {
      const { job, api } = await setupNamed();

      const empty = await api.post(namePath(job.id), { kind: 'FIRST_NAME', value: '   ' });
      const longFirst = await api.post(namePath(job.id), { kind: 'FIRST_NAME', value: 'a'.repeat(101) });
      const longCompany = await api.post(namePath(job.id), { kind: 'COMPANY_NAME', value: 'a'.repeat(201) });
      const phone = await api.post(namePath(job.id), { kind: 'PHONE', value: '6175550199' });
      const same = await api.post(namePath(job.id), { kind: 'LAST_NAME', value: ' Rivera ' });
      const edge = await api.post(namePath(job.id), { kind: 'COMPANY_NAME', value: 'a'.repeat(200) });
      const first = await api.post(namePath(job.id), { kind: 'FIRST_NAME', value: 'Patricia' });
      const again = await api.post(namePath(job.id), { kind: 'FIRST_NAME', value: 'Trish' });

      expect([empty.status, longFirst.status, longCompany.status, phone.status]).toEqual([400, 400, 400, 400]);
      expect(JSON.stringify(empty.body)).toContain('Enter a name');
      expect(same.status).toBe(409);
      expect(same.body.error).toBe("No change: that is already this customer's last name");
      expect(edge.status).toBe(201);
      expect(first.status).toBe(201);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('That first name is already changed on this job');
      expect(await db.recordContactEntry.count({ where: { job_id: job.id } })).toBe(2);
    });

    it('writes exactly one history event per name change with who, when, the old value and the new value', async () => {
      const { me, job, api } = await setupNamed();
      await api.post(namePath(job.id), { kind: 'FIRST_NAME', value: 'Patricia' });

      const timeline = await api.get(`/api/jobs/${job.id}/timeline`);
      const events = (timeline.body.events as { event_type: string; description: string; metadata: Record<string, unknown>; created_at: string; creator: { id: string } | null }[])
        .filter((e) => e.event_type.startsWith('JOB_CONTACT_ENTRY_'));

      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe('JOB_CONTACT_ENTRY_CHANGED');
      expect(events[0]!.creator?.id).toBe(me.id);
      expect(Number.isNaN(Date.parse(events[0]!.created_at))).toBe(false);
      expect(events[0]!.description).toBe('First name Pat changed to Patricia for this job only');
      expect(events[0]!.metadata).toMatchObject({ kind: 'FIRST_NAME', intent: 'CHANGED', old: { value: 'Pat' }, new: { value: 'Patricia' } });
    });

    it('lets a name entry be corrected or removed only with Edit jobs, end to end, and a removal puts the customer name back', async () => {
      const { org, customer } = await fx.newOrg();
      await fillCustomer(customer);
      await db.customer.update({ where: { id: customer }, data: { first_name: 'Pat' } });
      const contact = await personWith(org, contactOnly);
      const editor = await personWith(org, jobsOnly);
      const job = await fx.addJob(org, customer, { crew: [contact.id, editor.id] });
      const editorApi = await fx.signedInAs(editor);
      const made = await editorApi.post(namePath(job.id), { kind: 'FIRST_NAME', value: 'Patricia' });
      const entry = (made.body.entries as Entry[])[0]!;
      const contactApi = await fx.signedInAs(contact);

      expect((await contactApi.patch(entryPath(job.id, entry.id), { value: 'Trish' })).status).toBe(403);
      expect((await contactApi.delete(entryPath(job.id, entry.id))).status).toBe(403);

      const fixed = await editorApi.patch(entryPath(job.id, entry.id), { value: 'Trish' });
      expect(fixed.status).toBe(200);
      expect((fixed.body.entries as Entry[])[0]).toMatchObject({ value: 'Trish', customer_value_at_change: 'Pat', created_by: { id: editor.id } });
      const same = await editorApi.patch(entryPath(job.id, entry.id), { value: 'Pat' });
      expect(same.status).toBe(409);
      expect(same.body.error).toBe("No change: that is already this customer's first name");
      const removed = await editorApi.delete(entryPath(job.id, entry.id));
      expect(removed.body.entries).toEqual([]);
      expect((await db.customer.findUniqueOrThrow({ where: { id: customer } })).first_name).toBe('Pat');
      // With the entry gone the name can be changed again.
      expect((await editorApi.post(namePath(job.id), { kind: 'FIRST_NAME', value: 'Patty' })).status).toBe(201);
    });
  });

  describe('where an entry takes no effect', () => {
    it('leaves the job list and the customer on the job detail with only the customer record', async () => {
      const { org, customer, job, api } = await setup();
      await api.post(addPath(job.id), { kind: 'PHONE', value: '6175550199' });
      await api.post(addPath(job.id), { kind: 'EMAIL', value: 'wife@example.test' });
      const admin = await db.user.findFirstOrThrow({ where: { organization_id: org, role: 'ADMIN' } });

      const detail = await api.get(`/api/jobs/${job.id}`);
      const list = await (await fx.signedInAs({ id: admin.id, email: admin.email })).get('/api/jobs');

      expect(detail.body.job.customer.phones.map((p: { phone: string }) => p.phone)).toEqual(['6175550101']);
      expect(detail.body.job.customer.emails.map((e: { email: string }) => e.email)).toEqual(['pat@example.test']);
      const row = (list.body.jobs as { id: string; customer: { phone: string; email: string } }[]).find((j) => j.id === job.id)!;
      expect(row.customer).toMatchObject({ phone: '6175550101', email: 'pat@example.test' });
      expect(JSON.stringify(list.body)).not.toContain('6175550199');
      expect(JSON.stringify(list.body)).not.toContain('wife@example.test');
      expect(customer).toBeTruthy();
    });
  });
});
