/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.6 - while the company's Email plan feature is off, a customer's reply on a reply
   token is kept, hidden and silent.

   The three kinds of reply the token path takes are driven through the real inbound entry point (`processResendEvent`, the
   handler behind the delivery webhook) with fixture payloads; only the call that fetches the received message from the
   provider is replaced, so nothing is sent or received from this machine:
     - a reply from the address we mailed (stored in the token's conversation),
     - a reply from another address (stored with no conversation: a sender mismatch),
     - a reply on a token whose conversation is gone (stored in a fresh conversation about the same record).
   With the feature off each is stored exactly as with it on, rings nobody (no bell, no live-update ping, no alert chain),
   and shows nowhere: no Email list, mailbox list, unmatched list, single read, attachment link, count, record tab. When the
   feature returns the same rows appear, unread and with their arrival dates, and still ring nobody; a new reply rings as
   normal. The company's "Send emails to customers and staff" switch is a sending rule and never touches any of it.

   People are on custom roles (never a built-in role name) holding exactly the switch values under test, plus the Admin box.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient, fetchReceived, emitSpy, publishEmailsSpy } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  return {
    realClient: dbUrl ? clientAt(dbUrl) : undefined,
    fetchReceived: vi.fn(),
    emitSpy: vi.fn(),
    publishEmailsSpy: vi.fn(),
  };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The provider call that fetches a received message is the only thing replaced.
vi.mock('../lib/inbound-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inbound-email')>()),
  fetchReceivedEmail: fetchReceived,
}));

// The real bell and the real live-update ping, watched: every call is counted, none is stopped.
vi.mock('../services/notifications/notificationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/notifications/notificationService')>();
  emitSpy.mockImplementation(actual.emit);
  return { ...actual, emit: emitSpy };
});
vi.mock('../services/notifications/realtimePublish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/notifications/realtimePublish')>();
  publishEmailsSpy.mockImplementation(actual.publishEmailsChanged);
  return { ...actual, publishEmailsChanged: publishEmailsSpy };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { clearTokenCache } from '../middleware/authenticate';
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;

suite('the Email plan feature off: token replies are kept, hidden and silent (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM notifications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM resend_events WHERE (payload->'data'->>'email_id') LIKE 'rp-s10-6-${org.slice(0, 8)}%'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  beforeEach(() => {
    emitSpy.mockClear();
    publishEmailsSpy.mockClear();
    fetchReceived.mockReset();
  });

  let sequence = 0;
  const token = () => randomBytes(16).toString('base64url');
  const ARRIVED = new Date('2026-07-01T15:00:00.000Z');

  /** A company with a job and a lead (each with an estimate), the main mailbox, and one sent estimate email per record. */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, customer, admin } = made;
    const mainId = randomUUID();
    await db.mailbox.create({ data: { id: mainId, organization_id: org, kind: 'main', status: 'active' } });

    const seq = ++sequence;
    const roleOf = async (key: string, values: Record<string, boolean | string>) => {
      const role = await fx.addCustomRole(org, `${key}-${seq}`, 'DISPATCHER');
      await setRoleSwitchValues({
        organizationId: org, roleKey: `${key}-${seq}`,
        values: {
          view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
          view_estimates: true, estimates_scope: 'attached', view_invoices: true, invoices_scope: 'attached',
          access_communication: true, show_email: true, view_communication: true, ...values,
        },
        actorId: null, reason: 'manual',
      });
      const person = await fx.addUser(org, `${key}${seq}`, 'DISPATCHER', { customRoleId: role.id });
      return Object.assign(person, { api: () => fx.signedInAs(person) });
    };
    // On the job's crew, so one of the record's people; and a reader of every mailbox.
    const crew = await roleOf('crew', { communication_scope: 'linked_to_me' });
    const wide = await roleOf('wide', { communication_scope: 'all' });
    const adminBox: Person & { api: () => ReturnType<typeof fx.signedInAs> } = Object.assign(admin, { api: () => fx.signedInAs(admin) });

    const job = await fx.addJob(org, customer, { crew: [crew.id] });
    const lead = await fx.addLead(org, customer, { owner: crew.id });
    const jobEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
    const leadEstimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
    // An entry that is not an email, on the job: the tab keeps it whatever happens to mail.
    await db.manualCommunicationLog.create({
      data: {
        organization_id: org, channel: 'CALL', direction: 'IN', occurred_at: new Date(), performed_by: admin.id, logged_by: admin.id,
        notes: 'rp-s10-6 call note', job_id: job.id,
      },
    });

    /** A conversation a send opened about an estimate, with its sent email and the reply token the customer was given. */
    const conversation = async (estimateId: string, owner: { jobId?: string; leadId?: string }) => {
      const thread = randomUUID();
      await db.emailThread.create({
        data: { id: thread, organization_id: org, mailbox_id: mainId, origin: 'record', record_type: 'estimate', record_id: estimateId },
      });
      const sent = randomUUID();
      await db.email.create({
        data: {
          id: sent, organization_id: org, thread_id: thread, customer_id: customer, job_id: owner.jobId ?? null, lead_id: owner.leadId ?? null,
          account: 'system', direction: 'out', folder: 'sent', from: { name: null, email: 'office@example.com' }, to: 'angel@example.com',
          subject: 'Your estimate', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now() - 86_400_000),
        },
        select: { id: true },
      });
      const tok = token();
      await db.replyToken.create({
        data: {
          token: tok, organization_id: org, thread_id: thread, entity_type: 'estimate', entity_id: estimateId, customer_id: customer,
          expected_from: 'angel@example.com',
        },
      });
      return { thread, sent, token: tok };
    };
    const onJob = await conversation(jobEstimate.id, { jobId: job.id });
    const onLead = await conversation(leadEstimate.id, { leadId: lead.id });
    // A token whose conversation is gone (the conversation was deleted; the token kept its record).
    const lostToken = token();
    await db.replyToken.create({
      data: {
        token: lostToken, organization_id: org, thread_id: null, entity_type: 'estimate', entity_id: leadEstimate.id, customer_id: customer,
        expected_from: 'angel@example.com',
      },
    });
    return { org, customer, admin: adminBox, crew, wide, job, lead, mainId, onJob, onLead, lostToken };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const setEmailFeature = async (org: string, on: boolean) => {
    await db.organization.update({ where: { id: org }, data: { feature_overrides: on ? {} : { email: false } } });
    clearTokenCache();
  };

  /** A customer's reply arriving through the delivery webhook's handler. Resolves with the id the message was stored under. */
  async function receive(w: World, tok: string, opts: { from?: string; note?: string } = {}) {
    const providerId = `rp-s10-6-${w.org.slice(0, 8)}-${++sequence}`;
    fetchReceived.mockResolvedValueOnce({
      providerId,
      from: opts.from ?? 'Angel <angel@example.com>',
      receivedFor: [`${tok}@reply.test.com`],
      to: [`${tok}@reply.test.com`],
      subject: 'Re: Your estimate',
      messageId: `<${providerId}@mail.example.com>`,
      receivedAt: ARRIVED,
      text: opts.note ?? 'Sounds good, go ahead.',
      html: '<div>Sounds good.</div>',
      headers: { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' },
    });
    const { processResendEvent } = await import('../controllers/resend-webhook.controller.js');
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await processResendEvent(
      `svix-${providerId}`,
      { type: 'email.received', created_at: ARRIVED.toISOString(), data: { email_id: providerId } } as never,
      res as never,
    );
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
    const row = await db.email.findUnique({ where: { provider_message_id: providerId } });
    return { providerId, row };
  }

  const storedRow = async (providerId: string) => db.email.findUniqueOrThrow({ where: { provider_message_id: providerId } });
  const ringsOf = (org: string) => db.notification.count({ where: { organization_id: org } });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  const tabIds = (body: { items: { id: string; channel: string }[] }, channel = 'email') =>
    body.items.filter((i) => i.channel === channel).map((i) => i.id);

  describe('with the feature off', () => {
    it('stores each of the three replies where it would go with the feature on, unread and with its arrival date', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);

      const matched = await receive(w, w.onJob.token);
      const mismatched = await receive(w, w.onJob.token, { from: 'Their Spouse <spouse@example.com>' });
      const lost = await receive(w, w.lostToken);

      expect(matched.row).toMatchObject({
        thread_id: w.onJob.thread, inbound_match: 'MATCHED', unread: true, direction: 'in', folder: 'inbox', customer_id: w.customer,
      });
      expect(Number(matched.row!.ts)).toBe(ARRIVED.getTime());
      // A sender mismatch is held with no conversation and no customer, as ever.
      expect(mismatched.row).toMatchObject({ thread_id: null, inbound_match: 'UNMATCHED_SENDER', unread: true, customer_id: null });
      expect(Number(mismatched.row!.ts)).toBe(ARRIVED.getTime());
      // A token that lost its conversation gets a fresh one about the same record, in the main mailbox.
      const fresh = await db.emailThread.findUniqueOrThrow({ where: { id: lost.row!.thread_id! } });
      expect(fresh).toMatchObject({ origin: 'record', record_type: 'estimate', mailbox_id: w.mainId });
      expect(lost.row).toMatchObject({ inbound_match: 'MATCHED', unread: true });
      expect(Number(lost.row!.ts)).toBe(ARRIVED.getTime());
    });

    it('rings nobody: no bell, no copy, no live-update ping, no alert chain and so no "nobody to tell" line', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);
      const warn = vi.spyOn(logger, 'warn');
      try {
        await receive(w, w.onJob.token);
        await receive(w, w.onJob.token, { from: 'Their Spouse <spouse@example.com>' });
        await receive(w, w.lostToken);

        expect(emitSpy).not.toHaveBeenCalled();
        expect(publishEmailsSpy).not.toHaveBeenCalled();
        expect(await ringsOf(w.org)).toBe(0);
        expect(await db.notificationRecipient.count({ where: { organization_id: w.org } })).toBe(0);
        expect(warn.mock.calls.filter(([line]) => String(line).includes('nobody to tell'))).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    it('shows them nowhere, to the Admin box or to anyone: no Email list, mailbox list, unmatched list, single read, attachment link or record tab, and the badge says 0', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);
      const a = await receive(w, w.onJob.token);
      const b = await receive(w, w.onJob.token, { from: 'Their Spouse <spouse@example.com>' });
      const c = await receive(w, w.lostToken);
      const kept = [a, b, c].map((k) => k.row!.id);

      for (const person of [w.admin, w.wide, w.crew]) {
        const api: Api = await person.api();
        // The Email page's own routes are closed by the plan feature, for everybody, the same way for a kept message and
        // for an id that was never there: nothing says the message exists, and nothing of it comes back.
        const never = await api.get(`/api/communication/emails/${randomUUID()}`);
        expect(never.status).toBe(402);
        for (const path of [
          '/api/communication/emails', '/api/communication/emails?mailbox=all', '/api/communication/emails?mailbox=mine',
          `/api/communication/emails?mailbox=${w.mainId}`, '/api/communication/emails/unmatched', '/api/communication/mailboxes',
          ...kept.flatMap((id) => [`/api/communication/emails/${id}`, `/api/communication/emails/${id}/attachments/0`]),
        ]) {
          const res = await api.get(path);
          expect(res.status, path).toBe(402);
          expect(res.body.error, path).toBe('FEATURE_NOT_IN_PLAN');
          expect(JSON.stringify(res.body), path).not.toMatch(/Sounds good|angel@|spouse@/);
        }
        // The badge answers, with nothing for email.
        const badge = await api.get('/api/communication/unread-counts');
        expect(badge.status).toBe(200);
        expect(badge.body.email).toBe(0);
      }

      // The record tabs open; the whole email channel is gone from them (sent and received), the rest stays.
      const admin: Api = await w.admin.api();
      const jobTab = await admin.get(`/api/jobs/${w.job.id}/communications`);
      expect(jobTab.status).toBe(200);
      expect(tabIds(jobTab.body)).toEqual([]);
      expect(tabIds(jobTab.body, 'call')).toHaveLength(1);
      const leadTab = await admin.get(`/api/leads/${w.lead.id}/communications`);
      expect(leadTab.status).toBe(200);
      expect(tabIds(leadTab.body)).toEqual([]);
      const customerTab = await admin.get(`/api/customers/${w.customer}/communications`);
      expect(customerTab.status).toBe(200);
      expect(tabIds(customerTab.body)).toEqual([]);
      const crewJobTab = await (await w.crew.api()).get(`/api/jobs/${w.job.id}/communications`);
      expect(crewJobTab.status).toBe(200);
      expect(tabIds(crewJobTab.body)).toEqual([]);
    });
  });

  describe('when the feature is turned back on', () => {
    it('shows the kept mail unread with its arrival dates in the places it would have been, and rings nobody for it', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);
      const a = await receive(w, w.onJob.token);
      const b = await receive(w, w.onJob.token, { from: 'Their Spouse <spouse@example.com>' });
      const c = await receive(w, w.lostToken);
      expect(await ringsOf(w.org)).toBe(0);

      await setEmailFeature(w.org, true);

      // The Email page, for a reader of every mailbox.
      const wide: Api = await w.wide.api();
      const list = await wide.get('/api/communication/emails?mailbox=all');
      expect(list.status).toBe(200);
      const listed = new Map((list.body.emails as { id: string; unread: boolean; ts?: number }[]).map((e) => [e.id, e]));
      expect([...listed.keys()]).toEqual(expect.arrayContaining([a.row!.id, c.row!.id]));
      expect(listed.get(a.row!.id)).toMatchObject({ unread: true });
      const unmatched = await wide.get('/api/communication/emails/unmatched');
      expect(unmatched.status).toBe(200);
      expect((unmatched.body.emails as { id: string }[]).map((e) => e.id)).toContain(b.row!.id);
      const one = await wide.get(`/api/communication/emails/${a.row!.id}`);
      expect(one.status).toBe(200);

      // One of the record's people finds the job's reply on the Email page.
      const mine = await (await w.crew.api()).get('/api/communication/emails?mailbox=mine');
      expect((mine.body.emails as { id: string }[]).map((e) => e.id)).toContain(a.row!.id);

      // The badge and the mailbox list count it again.
      // The sender-mismatched reply is held for review (S10.18), and held mail is never unread mail: it is in the Needs review
      // count instead, which the mailbox list carries.
      const badge = await (await w.admin.api()).get('/api/communication/unread-counts');
      expect(badge.body.email).toBe(2);
      const boxes = await wide.get('/api/communication/mailboxes');
      expect(boxes.status).toBe(200);
      expect(boxes.body.total_unread).toBe(2);
      expect(boxes.body.needs_review.total).toBe(1);
      expect(boxes.body.main.unread).toBe(2);

      // The record tabs.
      const admin: Api = await w.admin.api();
      expect(tabIds((await admin.get(`/api/jobs/${w.job.id}/communications`)).body)).toEqual(expect.arrayContaining([w.onJob.sent, a.row!.id]));
      expect(tabIds((await admin.get(`/api/leads/${w.lead.id}/communications`)).body)).toEqual(expect.arrayContaining([w.onLead.sent, c.row!.id]));
      expect(tabIds((await admin.get(`/api/customers/${w.customer}/communications`)).body)).toEqual(expect.arrayContaining([a.row!.id, c.row!.id]));
      expect(tabIds((await (await w.crew.api()).get(`/api/jobs/${w.job.id}/communications`)).body)).toContain(a.row!.id);

      // Turning the feature on rang nobody about the old mail, and nothing ran: no catch-up at switch-on.
      expect(emitSpy).not.toHaveBeenCalled();
      expect(publishEmailsSpy).not.toHaveBeenCalled();
      expect(await ringsOf(w.org)).toBe(0);
      // The arrival dates are the ones the mail came with.
      for (const k of [a, b, c]) expect(Number((await storedRow(k.providerId)).ts)).toBe(ARRIVED.getTime());
    });

    it('delivers and rings a new reply as normal', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);
      await receive(w, w.onJob.token);
      await setEmailFeature(w.org, true);

      const fresh = await receive(w, w.onJob.token, { note: 'One more thing, please.' });

      expect(fresh.row).toMatchObject({ thread_id: w.onJob.thread, inbound_match: 'MATCHED', unread: true });
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy.mock.calls[0]![0]).toMatchObject({ verb: 'communication.email_inbound', dedupKey: `email_inbound:${fresh.providerId}` });
      expect(await db.notification.count({ where: { organization_id: w.org, dedup_key: `email_inbound:${fresh.providerId}` } })).toBe(1);
      expect(publishEmailsSpy).toHaveBeenCalledTimes(1);
      // Only the new reply rang: the one kept while the feature was off still has no bell.
      expect(await ringsOf(w.org)).toBe(1);
    });
  });

  describe('the company switch "Send emails to customers and staff"', () => {
    it('is a sending rule: with it off and the feature on, a reply is received, listed and rings as normal', async () => {
      const w = await world();
      await db.organization.update({ where: { id: w.org }, data: { email_sending_enabled: false } });
      await setEmailFeature(w.org, true);

      const reply = await receive(w, w.onJob.token);

      expect(reply.row).toMatchObject({ thread_id: w.onJob.thread, inbound_match: 'MATCHED' });
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(await ringsOf(w.org)).toBe(1);
      const list = await (await w.wide.api()).get('/api/communication/emails?mailbox=all');
      expect(list.status).toBe(200);
      expect((list.body.emails as { id: string }[]).map((e) => e.id)).toContain(reply.row!.id);
    });
  });
});
