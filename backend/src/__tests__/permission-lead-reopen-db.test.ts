/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.19 - Reopen lead on Won and Lost leads, and the status menu that locks closed leads.

   POST /api/leads/:id/reopen brings a Won or Lost lead back. It lands the lead on the status it had just before it closed
   (read from the lead's status ledger, reading back past a closed-to-closed entry such as a migrated lead's
   Cancelled-to-Lost one), or on the furthest status the lead's data still supports. It writes one History event with who,
   when, the restored status and the reason. It needs Reopen leads, whatever Change lead status by hand says, and it never
   touches a cancelled walkthrough, an archived estimate, the won or lost date, or a job made from the lead.

   The other half: a Won or Lost lead takes no hand status change from the status menu, whatever role asks. The lead's
   `status_options` mark every other status locked with "To change the status, reopen the lead first.", and the lead
   update refuses such a move with the same words.

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

/** Every switch in the catalog on (a choice at its widest option, a list empty). */
const ALL_ON: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [
    s.key,
    s.kind === 'choice' ? (s.choices!.includes('all') ? 'all' : s.choices![s.choices!.length - 1]!) : s.kind === 'list' ? [] : true,
  ]),
);

/** The wording the PRD gives (its own text, not read from the code). */
const LOCK_TEXT = 'To change the status, reopen the lead first.';
const ALREADY_OPEN = 'This lead is already open.';
const GIVE_A_REASON = 'Give a reason to reopen this lead.';
const REASON = 'The customer called back about the same job';

/** A role holding Reopen leads and nothing that changes a status by hand. */
const REOPEN_ONLY = { ...ALL_ON, change_lead_status_by_hand: false };

suite('reopening a closed lead, and the status lock on a closed lead (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role holding these switch values on top of the Technician preset. */
  async function personWith(org: string, values: Record<string, SwitchValue>): Promise<Person> {
    const key = `lead-reopen-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    return fx.addUser(org, `lro${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
  }

  /** An org, a person on the role under test, and a lead they own that sits in `status`. */
  async function setup(values: Record<string, SwitchValue> = REOPEN_ONLY, opts: { status?: LeadStatus; walkthrough?: boolean } = {}) {
    const { org, customer, admin } = await fx.newOrg();
    await db.customer.update({
      where: { id: customer },
      data: { phone: '6175550101', email: 'pat@example.test', first_name: 'Pat', last_name: 'Jones' },
    });
    const me = await personWith(org, values);
    const lead = await fx.addLead(org, customer, { owner: me.id, ...(opts.walkthrough ? { walkthroughCrew: [] } : {}) });
    if (opts.status) await db.lead.update({ where: { id: lead.id }, data: { status: opts.status } });
    const api = await fx.signedInAs(me);
    return { org, customer, admin, me, lead, api };
  }

  /** Close the lead as Lost through the Mark lost door, so the ledger carries the entry a real close leaves. */
  async function markLost(api: Awaited<ReturnType<typeof fx.signedInAs>>, leadId: string) {
    const res = await api.post(`/api/leads/${leadId}/mark-lost`, { lost_reason: 'Went with another company' });
    expect(res.status).toBe(200);
  }

  /** A lead that was `from` and is now Lost, closed through the real door. */
  async function lostFrom(from: LeadStatus, opts: { walkthrough?: boolean } = {}) {
    const base = await setup(ALL_ON, { status: from, walkthrough: opts.walkthrough });
    await markLost(base.api, base.lead.id);
    return base;
  }

  /** A status ledger row, shaped the way the lead's status writer leaves it. */
  async function ledgerRow(org: string, leadId: string, from: string, to: string, at: Date, extra: Record<string, unknown> = {}) {
    await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'LEAD', entity_id: leadId, event_type: 'STATUS_CHANGE',
        description: `Lead status changed to ${to}`, metadata: { from, to, ...extra }, created_at: at,
      },
    });
  }

  const reopen = (api: Awaited<ReturnType<typeof fx.signedInAs>>, leadId: string, body: object = { reason: REASON }) =>
    api.post(`/api/leads/${leadId}/reopen`, body);
  const statusOf = async (leadId: string) => (await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status;

  describe('what Reopen lead does', () => {
    it('puts a Lost lead that was Contacted back to Contacted, for a role with Reopen leads on and Change lead status by hand off', async () => {
      const { org, lead } = await lostFrom('CONTACTED');
      expect(await statusOf(lead.id)).toBe('LOST');
      const closed = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      // The person under test holds Reopen leads and not the hand status switch (the person who closed it held both).
      const reopener = await personWith(org, REOPEN_ONLY);
      await db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: reopener.id } });
      const api = await fx.signedInAs(reopener);

      const res = await reopen(api, lead.id);

      expect(res.status).toBe(200);
      expect(res.body.lead.status).toBe('CONTACTED');
      expect(await statusOf(lead.id)).toBe('CONTACTED');

      // History: one event with who, when, the restored status and the reason.
      const events = (await api.get(`/api/leads/${lead.id}/timeline`)).body.events as Array<{
        description: string; created_at: string; metadata: Record<string, unknown>; creator: { id: string } | null;
      }>;
      const reopened = events.filter((e) => /^Lead reopened/.test(e.description));
      expect(reopened).toHaveLength(1);
      expect(reopened[0]!.creator?.id).toBe(reopener.id);
      expect(Number.isNaN(Date.parse(reopened[0]!.created_at))).toBe(false);
      expect(reopened[0]!.description).toContain('Contacted');
      expect(reopened[0]!.description).toContain(REASON);
      expect(reopened[0]!.metadata).toMatchObject({ from: 'LOST', to: 'CONTACTED', reason: REASON });

      // The lost date and reason stay on the lead.
      const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(after.lost_at).toEqual(closed.lost_at);
      expect(after.lost_reason).toBe(closed.lost_reason);

      // Normal editing works again: a phone entry can be added, which was refused while it was closed.
      const added = await api.post(`/api/leads/${lead.id}/contact-entries`, { kind: 'PHONE', value: '6175550199' });
      expect(added.status).toBe(201);
    });

    it('puts a Won lead that converted into a job back to its previous status, and leaves the job and its carried entries alone', async () => {
      const { org, customer, lead, api } = await setup(REOPEN_ONLY, { status: 'WON' });
      const job = await fx.addJob(org, customer, { fromLead: lead.id, crew: [] });
      await db.estimate.updateMany({ where: { lead_id: lead.id }, data: { status: 'WON', sent_at: new Date() } });
      await ledgerRow(org, lead.id, 'ESTIMATED', 'WON', new Date(Date.now() - 60_000));
      // An entry carried onto the job at conversion, and the job's state before the reopen.
      await db.recordContactEntry.create({
        data: { organization_id: org, job_id: job.id, kind: 'PHONE', intent: 'ADDED', value: '+16175550177', created_by_id: (await db.user.findFirstOrThrow({ where: { organization_id: org } })).id },
      });
      const jobBefore = await db.job.findUniqueOrThrow({ where: { id: job.id } });
      const visitsBefore = await db.visit.count({ where: { job_id: job.id } });
      const jobEntriesBefore = await db.recordContactEntry.count({ where: { job_id: job.id } });
      const wonAtBefore = (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).won_at;

      const res = await reopen(api, lead.id);

      expect(res.status).toBe(200);
      expect(await statusOf(lead.id)).toBe('ESTIMATED');
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).won_at).toEqual(wonAtBefore);
      expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toEqual(jobBefore);
      expect(await db.visit.count({ where: { job_id: job.id } })).toBe(visitsBefore);

      // A phone entry added on the reopened lead does not appear on the job.
      const added = await api.post(`/api/leads/${lead.id}/contact-entries`, { kind: 'PHONE', value: '6175550199' });
      expect(added.status).toBe(201);
      expect(await db.recordContactEntry.count({ where: { job_id: job.id } })).toBe(jobEntriesBefore);
    });

    it('reopens a lead that was Walkthrough Scheduled when marked Lost, its visit cancelled and nothing finished, as Contacted, and the visit stays cancelled', async () => {
      const { lead, api } = await lostFrom('WALKTHROUGH_SCHEDULED', { walkthrough: true });
      const visit = await db.visit.findFirstOrThrow({ where: { lead_id: lead.id } });
      expect(visit.status).toBe('CANCELLED');

      const res = await reopen(api, lead.id);

      expect(res.status).toBe(200);
      expect(await statusOf(lead.id)).toBe('CONTACTED');
      expect((await db.visit.findUniqueOrThrow({ where: { id: visit.id } })).status).toBe('CANCELLED');
    });

    it('reopens it as Walkthrough Completed when one visit on the lead was finished', async () => {
      const { org, lead, me } = await setup(ALL_ON, { status: 'WALKTHROUGH_SCHEDULED', walkthrough: true });
      await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: -2, seq: 2 });
      const api = await fx.signedInAs(me);
      await markLost(api, lead.id);

      const res = await reopen(api, lead.id);

      expect(res.status).toBe(200);
      expect(await statusOf(lead.id)).toBe('WALKTHROUGH_COMPLETED');
    });

    it("reopens a migrated lead (Estimate Sent, then Cancelled before the release, a declined estimate on it) as Estimate Sent, reading back past the migration's Cancelled-to-Lost entry", async () => {
      const { org, customer, admin, lead, api } = await setup(REOPEN_ONLY, { status: 'LOST' });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      await db.estimate.update({ where: { id: estimate.id }, data: { status: 'DECLINED', sent_at: new Date(Date.now() - 86_400_000) } });
      // The ledger the way the migration left it: the entry that cancelled the lead, then the migration's own entry 1 ms later.
      const cancelledAt = new Date(Date.now() - 3_600_000);
      await ledgerRow(org, lead.id, 'NEW', 'ESTIMATED', new Date(cancelledAt.getTime() - 86_400_000));
      await ledgerRow(org, lead.id, 'ESTIMATED', 'CANCELLED', cancelledAt);
      await ledgerRow(org, lead.id, 'CANCELLED', 'LOST', new Date(cancelledAt.getTime() + 1), {
        via: 'lead_cancelled_retired', cancelled_at: cancelledAt.toISOString(), cancelled_reason: null,
      });

      const res = await reopen(api, lead.id);

      expect(res.status).toBe(200);
      expect(await statusOf(lead.id)).toBe('ESTIMATED');
    });

    it('reopens a migrated lead with no sent estimate left to the furthest status its data supports, never Lost or Cancelled', async () => {
      const { org, lead, api } = await setup(REOPEN_ONLY, { status: 'LOST' });
      const cancelledAt = new Date(Date.now() - 3_600_000);
      await ledgerRow(org, lead.id, 'ESTIMATED', 'CANCELLED', cancelledAt);
      await ledgerRow(org, lead.id, 'CANCELLED', 'LOST', new Date(cancelledAt.getTime() + 1), { via: 'lead_cancelled_retired' });

      const res = await reopen(api, lead.id);

      expect(res.status).toBe(200);
      expect(await statusOf(lead.id)).toBe('CONTACTED');
    });

    it('reads back past a Won-to-Lost entry of an older close to the entry that closed the lead', async () => {
      const { org, lead, api } = await setup(REOPEN_ONLY, { status: 'LOST' });
      const at = Date.now() - 3_600_000;
      // Won straight from New with no estimate (the menu allows it), then marked Lost from Won.
      await ledgerRow(org, lead.id, 'NEW', 'WON', new Date(at));
      await ledgerRow(org, lead.id, 'WON', 'LOST', new Date(at + 1_000));

      expect((await reopen(api, lead.id)).status).toBe(200);
      expect(await statusOf(lead.id)).toBe('NEW');
    });

    it('reads back to the status before a migrated Cancelled-to-Lost entry even when that is a step the fallback would not pick', async () => {
      const { org, lead, api } = await setup(REOPEN_ONLY, { status: 'LOST' });
      const cancelledAt = new Date(Date.now() - 3_600_000);
      await ledgerRow(org, lead.id, 'NEW', 'CANCELLED', cancelledAt);
      await ledgerRow(org, lead.id, 'CANCELLED', 'LOST', new Date(cancelledAt.getTime() + 1), { via: 'lead_cancelled_retired' });

      expect((await reopen(api, lead.id)).status).toBe(200);
      expect(await statusOf(lead.id)).toBe('NEW');
    });

    it('does not restore a status the lead no longer supports: an Estimate Sent lead whose estimate was archived by the close lands on Contacted', async () => {
      const { org, customer, admin, lead, api } = await setup(ALL_ON, { status: 'ESTIMATED' });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      await db.estimate.update({ where: { id: estimate.id }, data: { status: 'SENT', sent_at: new Date() } });
      await markLost(api, lead.id);
      expect((await db.estimate.findUniqueOrThrow({ where: { id: estimate.id } })).status).toBe('ARCHIVED');

      expect((await reopen(api, lead.id)).status).toBe(200);

      expect(await statusOf(lead.id)).toBe('CONTACTED');
      // The archived estimate stays archived.
      expect((await db.estimate.findUniqueOrThrow({ where: { id: estimate.id } })).status).toBe('ARCHIVED');
    });

    it('falls back to the furthest supported status when the ledger has no entry for the lead at all', async () => {
      const { org, customer, admin, lead, api } = await setup(REOPEN_ONLY, { status: 'WON' });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      await db.estimate.update({ where: { id: estimate.id }, data: { status: 'SENT', sent_at: new Date() } });

      expect((await reopen(api, lead.id)).status).toBe(200);
      expect(await statusOf(lead.id)).toBe('ESTIMATED');
    });

    it('lands on the status it had before the close when the lead still supports it', async () => {
      const { lead, api } = await lostFrom('NEW');

      expect((await reopen(api, lead.id)).status).toBe(200);
      expect(await statusOf(lead.id)).toBe('NEW');
    });

    it('reopens the lead again after it closes again, from the newest close', async () => {
      const { lead, api } = await lostFrom('CONTACTED');
      expect((await reopen(api, lead.id)).status).toBe(200);
      await markLost(api, lead.id);

      expect((await reopen(api, lead.id)).status).toBe(200);
      expect(await statusOf(lead.id)).toBe('CONTACTED');
    });
  });

  describe('who may reopen, and what is refused', () => {
    it('refuses a person without Reopen leads, even with Change lead status by hand on, and changes nothing', async () => {
      const { org, lead } = await setup(REOPEN_ONLY, { status: 'LOST' });
      const without = await personWith(org, { ...ALL_ON, reopen_leads: false, change_lead_status_by_hand: true });

      const res = await reopen(await fx.signedInAs(without), lead.id);

      expect(res.status).toBe(403);
      expect(await statusOf(lead.id)).toBe('LOST');
    });

    it('refuses a missing, empty or blank reason with the plain sentence, and changes nothing', async () => {
      const { lead, api } = await setup(REOPEN_ONLY, { status: 'LOST' });

      for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
        const res = await reopen(api, lead.id, body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe(GIVE_A_REASON);
      }
      expect(await statusOf(lead.id)).toBe('LOST');
    });

    it('refuses an open lead with "This lead is already open."', async () => {
      for (const status of ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'] as const) {
        const { lead, api } = await setup(REOPEN_ONLY, { status });
        const res = await reopen(api, lead.id);
        expect(res.status, status).toBe(400);
        expect(res.body.error, status).toBe(ALREADY_OPEN);
        expect(await statusOf(lead.id)).toBe(status);
      }
    });

    it('refuses a person who cannot open the lead (forbidden), and a lead in another company (not found)', async () => {
      const { org, lead } = await setup(REOPEN_ONLY, { status: 'LOST' });
      await db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: null } });
      const scoped = await personWith(org, { ...REOPEN_ONLY, leads_scope: 'attached' });
      const asScoped = await fx.signedInAs(scoped);

      const forbidden = await reopen(asScoped, lead.id);
      expect(forbidden.status).toBe(403);
      expect(await statusOf(lead.id)).toBe('LOST');

      const other = await fx.newOrg();
      const foreign = await fx.addLead(other.org, other.customer, {});
      await db.lead.update({ where: { id: foreign.id }, data: { status: 'LOST' } });
      const across = await reopen(asScoped, foreign.id);
      expect(across.status).toBe(404);
      expect(await statusOf(foreign.id)).toBe('LOST');
    });

    it('answers a malformed lead id as not found', async () => {
      const { api } = await setup(REOPEN_ONLY);
      const res = await reopen(api, 'not-a-uuid');
      expect(res.status).toBe(404);
      expect((await reopen(api, randomUUID())).status).toBe(404);
    });
  });

  describe('the closed-lead lock on the status menu', () => {
    /** A role that changes statuses by hand, with Reopen leads on or off. */
    const BY_HAND = { ...ALL_ON, change_lead_status_by_hand: true };

    for (const closed of ['WON', 'LOST'] as const) {
      it(`marks every other status locked on a ${closed} lead, with the PRD's words, and the lead's own status as picked`, async () => {
        const { lead, api } = await setup(BY_HAND, { status: closed });

        const res = await api.get(`/api/leads/${lead.id}`);

        expect(res.status).toBe(200);
        const options = res.body.lead.status_options as Array<{ status: string; available: boolean; reason: string | null }>;
        expect(options.length).toBeGreaterThan(5);
        for (const option of options) {
          if (option.status === closed) {
            expect(option, option.status).toMatchObject({ available: true, reason: null });
          } else {
            expect(option, option.status).toMatchObject({ available: false, reason: LOCK_TEXT });
          }
        }
        expect(JSON.stringify(res.body)).not.toContain('Use Reopen lead to bring a closed lead back.');
      });

      it(`refuses a hand move off a ${closed} lead to any status for a role with Change lead status by hand on, with the same words`, async () => {
        const { lead, api } = await setup(BY_HAND, { status: closed });
        const targets: LeadStatus[] = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', closed === 'WON' ? 'LOST' : 'WON'];

        for (const status of targets) {
          const res = await api.patch(`/api/leads/${lead.id}`, status === 'LOST' ? { status, lost_reason: 'Changed our mind' } : { status });
          expect(res.status, status).toBe(409);
          expect(res.body.error, status).toBe(LOCK_TEXT);
        }
        expect(await statusOf(lead.id)).toBe(closed);
      });
    }

    it('refuses closing a Won lead as Lost through the Mark lost door, with the same words', async () => {
      const { lead, api } = await setup(BY_HAND, { status: 'WON' });

      const res = await api.post(`/api/leads/${lead.id}/mark-lost`, { lost_reason: 'Changed our mind' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe(LOCK_TEXT);
      expect(await statusOf(lead.id)).toBe('WON');
    });

    it('still lets an echo of the stored status through as the plain edit it is', async () => {
      const { lead, api } = await setup(BY_HAND, { status: 'WON' });

      const res = await api.patch(`/api/leads/${lead.id}`, { status: 'WON', service_request: 'Fix the other door' });

      expect(res.status).toBe(200);
      expect(await statusOf(lead.id)).toBe('WON');
    });

    it('does not lock an open lead: the menu still offers every status the lead supports', async () => {
      const { lead, api } = await setup(BY_HAND, { status: 'CONTACTED' });

      const options = (await api.get(`/api/leads/${lead.id}`)).body.lead.status_options as Array<{ reason: string | null }>;

      expect(options.some((o) => o.reason === LOCK_TEXT)).toBe(false);
      expect((await api.patch(`/api/leads/${lead.id}`, { status: 'NEW' })).status).toBe(200);
    });

    it('lets the lead move again after it is reopened', async () => {
      const { lead, api } = await lostFrom('CONTACTED');
      expect((await api.patch(`/api/leads/${lead.id}`, { status: 'NEW' })).status).toBe(409);

      expect((await reopen(api, lead.id)).status).toBe(200);

      expect((await api.patch(`/api/leads/${lead.id}`, { status: 'NEW' })).status).toBe(200);
    });
  });

  describe('what the lead page is told', () => {
    it('lists Reopen among the actions for a person holding Reopen leads, closed or not, and not for one without', async () => {
      const { org, lead, api } = await setup(REOPEN_ONLY, { status: 'LOST' });
      const without = await personWith(org, { ...REOPEN_ONLY, reopen_leads: false });

      const withIt = (await api.get(`/api/leads/${lead.id}`)).body.lead.actions as string[];
      const noIt = (await (await fx.signedInAs(without)).get(`/api/leads/${lead.id}`)).body.lead.actions as string[];

      expect(withIt).toContain('reopen');
      expect(noIt).not.toContain('reopen');
    });

    it('lists Reopen for a person who can open the lead but cannot edit it (Edit leads off)', async () => {
      const { lead, api } = await setup({ ...REOPEN_ONLY, edit_leads: false, edit_job_and_lead_contact_details: false }, { status: 'WON' });

      expect(((await api.get(`/api/leads/${lead.id}`)).body.lead.actions as string[])).toContain('reopen');
    });
  });
});
