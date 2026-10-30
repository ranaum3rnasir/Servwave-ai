/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.9 - the customer's estimate decisions as entries on the record tab.

   An estimate approved or declined in the customer portal shows on the job's or lead's Communication tab as an entry
   (a decline with the reason the customer picked and their own words), read from what the product already records for
   the decision. An entry shows only to people who can open that estimate, never lists in a section or an unread count,
   and on the customer's tab follows the per-row rule.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding exactly the
   switch values under test, against a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('the customer\'s estimate decisions on the record Communication tab (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM timeline_events WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM lost_reason_options WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** Every switch that needs one of these goes off with it, so the set stays storable. */
  const withDependantsOff = (off: string[]): Record<string, boolean> => {
    const out: Record<string, boolean> = Object.fromEntries(off.map((k) => [k, false]));
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of SWITCH_CATALOG) {
        if (!(s.key in out) && s.requires.some((r) => out[r] === false)) { out[s.key] = false; grew = true; }
      }
    }
    return out;
  };
  const ESTIMATES_VIEW_OFF = withDependantsOff(['view_estimates']);

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `decision-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, access_communication: true, view_communication: true,
        communication_scope: 'attached', ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `d${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  type Entry = {
    id: string; channel: string; direction: string; who: string; title: string; preview: string; at: string;
    jobId?: string; leadId?: string; entry?: string; reason?: string; reasonNote?: string;
  };
  const entriesOf = (body: { items: Entry[] }) => body.items.filter((i) => i.entry);
  const estimateNumberOf = async (id: string) => (await db.estimate.findUniqueOrThrow({ where: { id }, select: { estimate_number: true } })).estimate_number;

  /**
   * What the product writes to the estimate's history when the customer decides in the portal: an event with no
   * signed-in person behind it. A decline from the portal carries the reason code and the customer's words in its
   * metadata; an approval carries none.
   */
  async function addPortalDecision(
    org: string, estimateId: string, kind: 'APPROVED' | 'DECLINED',
    opts: { at?: Date; metadata?: object | null } = {},
  ) {
    const number = await estimateNumberOf(estimateId);
    const row = await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'ESTIMATE', entity_id: estimateId, event_type: kind,
        description: `Estimate ${number} ${kind === 'APPROVED' ? 'approved' : 'declined'} by customer`,
        metadata: opts.metadata === null ? undefined : (opts.metadata ?? (kind === 'DECLINED' ? { method: 'public', lost_reason: null, lost_reason_note: null } : undefined)),
        created_by: null, ...(opts.at ? { created_at: opts.at } : {}),
      },
      select: { id: true },
    });
    return row.id;
  }

  /** What the office does from the app: an event with a signed-in person behind it. It is not the customer's decision. */
  async function addOfficeDecision(org: string, estimateId: string, kind: 'APPROVED' | 'DECLINED', by: string) {
    const row = await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'ESTIMATE', entity_id: estimateId, event_type: kind,
        description: `Estimate ${kind === 'APPROVED' ? 'approved internally (verbal win)' : 'declined internally'}`,
        metadata: { method: 'internal' }, created_by: by,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function builtInLabel(code: string) {
    const { BUILT_IN_LOST_REASONS } = await import('../lib/lostReasonOptions.js');
    return BUILT_IN_LOST_REASONS.find((r) => r.code === code)!.label;
  }

  describe('the job tab', () => {
    it('shows the customer\'s approval and decline of the job\'s estimate, the decline with the reason they picked and their own words', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const approvedEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const declinedEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const approved = await addPortalDecision(org, approvedEstimate.id, 'APPROVED');
      const declined = await addPortalDecision(org, declinedEstimate.id, 'DECLINED', {
        metadata: { method: 'public', lost_reason: 'PRICE', lost_reason_note: 'Another quote came in lower' },
      });

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(tab.status).toBe(200);
      const entries = entriesOf(tab.body);
      expect(entries.map((e) => e.id).sort()).toEqual([approved, declined].sort());

      const approval = entries.find((e) => e.id === approved)!;
      expect(approval.entry).toBe('estimate_approved');
      expect(approval.title).toContain(await estimateNumberOf(approvedEstimate.id));
      expect(approval.jobId).toBe(job.id);

      const decline = entries.find((e) => e.id === declined)!;
      expect(decline.entry).toBe('estimate_declined');
      expect(decline.reason).toBe(await builtInLabel('PRICE'));
      expect(decline.reasonNote).toBe('Another quote came in lower');
    });

    it('carries no total, and says the customer did it', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      await addPortalDecision(org, estimate.id, 'APPROVED');

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      const [entry] = entriesOf(tab.body);
      expect(JSON.stringify(entry)).not.toMatch(/total|amount|subtotal|\b100(\.00)?\b/i);
      expect(entry.direction).toBe('in');
    });

    it('leaves out a decision the office made from the app', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      await addOfficeDecision(org, estimate.id, 'APPROVED', admin.id);
      await addOfficeDecision(org, estimate.id, 'DECLINED', admin.id);

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(entriesOf(tab.body)).toEqual([]);
    });
  });

  describe('the lead tab', () => {
    it('shows a lead-stage estimate\'s entries on the lead, and after conversion on the lead and on the job', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const lead = await fx.addLead(org, customer, { assignees: [person.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      const approved = await addPortalDecision(org, estimate.id, 'APPROVED');
      const api = await person.api();

      const leadTab = await api.get(`/api/leads/${lead.id}/communications`);
      expect(leadTab.status).toBe(200);
      expect(entriesOf(leadTab.body).map((e) => e.id)).toEqual([approved]);

      // The lead converts: the job is made from the estimate and the estimate points at it.
      const job = await fx.addJob(org, customer, { crew: [person.id], fromLead: lead.id });
      await db.estimate.update({ where: { id: estimate.id }, data: { job_id: job.id } });

      const after = await api.get(`/api/leads/${lead.id}/communications`);
      expect(entriesOf(after.body).map((e) => e.id)).toEqual([approved]);
      const jobTab = await api.get(`/api/jobs/${job.id}/communications`);
      expect(entriesOf(jobTab.body).map((e) => e.id)).toEqual([approved]);
    });

    it('does not show a job-anchored estimate\'s entries on a lead that has no estimate of its own', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const lead = await fx.addLead(org, customer, { assignees: [person.id] });
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      await addPortalDecision(org, estimate.id, 'APPROVED');

      const tab = await (await person.api()).get(`/api/leads/${lead.id}/communications`);
      expect(entriesOf(tab.body)).toEqual([]);
    });
  });

  describe('decisions from before the release', () => {
    it('shows an old approval, and an old decline that stored no metadata, with the reason the estimate still holds', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const approvedEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const declinedEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      await db.estimate.update({
        where: { id: declinedEstimate.id },
        data: { status: 'DECLINED', declined_at: new Date('2025-03-01'), lost_reason: 'TIMING', lost_reason_note: 'Not before spring' },
      });
      const longAgo = new Date('2025-03-01T15:00:00Z');
      const approved = await addPortalDecision(org, approvedEstimate.id, 'APPROVED', { at: longAgo });
      const declined = await addPortalDecision(org, declinedEstimate.id, 'DECLINED', { at: longAgo, metadata: null });

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      const entries = entriesOf(tab.body);
      expect(entries.map((e) => e.id).sort()).toEqual([approved, declined].sort());
      const decline = entries.find((e) => e.id === declined)!;
      expect(decline.reason).toBe(await builtInLabel('TIMING'));
      expect(decline.reasonNote).toBe('Not before spring');
      expect(new Date(decline.at).toISOString()).toBe(longAgo.toISOString());
    });

    it('names a reason the organization added by the words it gave it, even once that reason is switched off', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      await db.lostReasonOption.create({ data: { organization_id: org, code: 'WENT_WITH_A_DESIGNER', label: 'Went with a designer', is_active: false } });
      const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      await addPortalDecision(org, estimate.id, 'DECLINED', { metadata: { method: 'public', lost_reason: 'WENT_WITH_A_DESIGNER', lost_reason_note: null } });

      const tab = await (await person.api()).get(`/api/jobs/${job.id}/communications`);
      expect(entriesOf(tab.body)[0].reason).toBe('Went with a designer');
    });

    it('shows a decline that picked nothing, with neither reason nor words', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, {});
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      await addPortalDecision(org, estimate.id, 'DECLINED');

      const [entry] = entriesOf(await (await (await person.api()).get(`/api/jobs/${job.id}/communications`)).body);
      expect(entry.entry).toBe('estimate_declined');
      expect(entry.reason).toBeUndefined();
      expect(entry.reasonNote).toBeUndefined();
    });
  });

  describe('who gets an entry', () => {
    it('leaves it out for a person on the job who cannot open the estimate, the estimate\'s creator included (P7)', async () => {
      const { org, customer } = await newOrg();
      const creator = await personWith(org, { ...ESTIMATES_VIEW_OFF });
      const colleague = await personWith(org, { ...ESTIMATES_VIEW_OFF });
      const job = await fx.addJob(org, customer, { crew: [creator.id, colleague.id] });
      const estimate = await fx.addEstimate(org, customer, creator.id, { jobId: job.id });
      const approved = await addPortalDecision(org, estimate.id, 'APPROVED');

      const mine = await (await creator.api()).get(`/api/jobs/${job.id}/communications`);
      expect(mine.status).toBe(200);
      expect(entriesOf(mine.body)).toEqual([]);
      expect(approved).toBeTruthy();

      const theirs = await (await colleague.api()).get(`/api/jobs/${job.id}/communications`);
      expect(theirs.status).toBe(200);
      expect(entriesOf(theirs.body)).toEqual([]);
    });

    it('gives it to a person whose estimates data scope is All, on a job they are not on', async () => {
      const { org, admin, customer } = await newOrg();
      const wide = await personWith(org, { jobs_scope: 'all', leads_scope: 'all' });
      const job = await fx.addJob(org, customer, { crew: [admin.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const approved = await addPortalDecision(org, estimate.id, 'APPROVED');

      const tab = await (await wide.api()).get(`/api/jobs/${job.id}/communications`);
      expect(entriesOf(tab.body).map((e) => e.id)).toEqual([approved]);
    });
  });

  describe('the customer tab', () => {
    it('leaves a job\'s entry out for a person who can open the customer but not the job, and keeps a customer-only estimate\'s', async () => {
      const { org, admin, customer } = await newOrg();
      // Opens the customer through a lead they are on, never the job.
      const person = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached' });
      await fx.addLead(org, customer, { assignees: [person.id] });
      const job = await fx.addJob(org, customer, { crew: [admin.id] });
      const jobEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      // Theirs, made for the customer alone: the one estimate with no lead or job a narrow scope reaches (P7).
      const customerEstimate = await fx.addEstimate(org, customer, person.id);
      await addPortalDecision(org, jobEstimate.id, 'APPROVED');
      const customerOnly = await addPortalDecision(org, customerEstimate.id, 'APPROVED');

      const tab = await (await person.api()).get(`/api/customers/${customer}/communications`);
      expect(tab.status).toBe(200);
      expect(entriesOf(tab.body).map((e) => e.id)).toEqual([customerOnly]);
    });

    it('lists every entry for a person who can open the customer\'s job', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, { jobs_scope: 'all', leads_scope: 'all' });
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const jobEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const customerEstimate = await fx.addEstimate(org, customer, admin.id);
      const a = await addPortalDecision(org, jobEstimate.id, 'APPROVED');
      const b = await addPortalDecision(org, customerEstimate.id, 'APPROVED');

      const tab = await (await person.api()).get(`/api/customers/${customer}/communications`);
      expect(entriesOf(tab.body).map((e) => e.id).sort()).toEqual([a, b].sort());
    });
  });

  describe('what the entries are not', () => {
    it('never appear in a section list or an unread count, and send no alert', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, { communication_scope: 'all', jobs_scope: 'all', leads_scope: 'all' });
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const api = await person.api();

      const before = {
        counts: (await api.get('/api/communication/unread-counts')).body,
        calls: (await api.get('/api/communication/calls')).body.calls,
        threads: (await api.get('/api/communication/threads')).body.threads,
      };
      const alertsBefore = await db.notification.count({ where: { organization_id: org } });
      const approved = await addPortalDecision(org, estimate.id, 'APPROVED');
      expect(entriesOf((await api.get(`/api/jobs/${job.id}/communications`)).body).map((e) => e.id)).toEqual([approved]);

      expect((await api.get('/api/communication/unread-counts')).body).toEqual(before.counts);
      expect((await api.get('/api/communication/calls')).body.calls).toEqual(before.calls);
      expect((await api.get('/api/communication/threads')).body.threads).toEqual(before.threads);
      expect(await db.notification.count({ where: { organization_id: org } })).toBe(alertsBefore);
    });
  });
});
