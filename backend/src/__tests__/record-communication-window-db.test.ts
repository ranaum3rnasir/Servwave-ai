/* =============================================================================
   #3022 - A lead's or job's Communication tab shows every text with its numbers (Q39).

   The tab lists the texts whose other number is one of the record's numbers (those its contact card shows) between the
   record's creation and its close, plus every text tied to it at any time. A lead closes when it is converted (Won) or
   lost; a job when it is Done or Cancelled (Completed, Office review and Ready to close are still open). Calls and emails
   keep today's rule: only what is tied to the record.

   Driven through the real HTTP doors (the two Communication reads, the pencil, and in the journey the incoming-text
   webhook, Mark lost and the send) against a real migrated database (TEST_DATABASE_URL; the suite skips when it is unset).
   The phone system is faked at its network edge only. Texts at chosen times are stored as the writers store them (#3014:
   the other party's number in E.164). Every org the suite makes is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { JobStatus, LeadStatus, PrismaClient, Role } from '@prisma/client';

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
// The suite-wide setup replaces the phone-system client; here the real one runs, and only its network edge is faked.
vi.unmock('../lib/ctm/client');

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

const PROVIDER = 'https://phone-provider.test/api/v1';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The phone system at its network edge: no one has opted out, and every send is accepted with a fresh message id. */
async function fakeProvider(url: unknown, init?: { method?: string; body?: unknown }) {
  const u = String(url);
  if (!u.startsWith(PROVIDER)) throw new Error(`unexpected network call: ${u}`);
  const path = u.slice(PROVIDER.length);
  if ((init?.method ?? 'GET') === 'GET' && path.includes('/opt_out_texts')) return json({ opt_out_texts: [] });
  if (init?.method === 'POST' && /\/sms$/.test(path)) return json({ id: `MSG-3022-${randomUUID()}` });
  return json({ error: 'not found' }, 404);
}

const DAY = 86_400_000;
/** The record is made 30 days ago; every text below is placed in days from then. */
const MADE = new Date(Date.now() - 30 * DAY);
const day = (n: number) => new Date(MADE.getTime() + n * DAY);

suite("a lead's or job's Communication tab shows every text with its numbers (real database)", () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const WEBHOOK_TOKEN = randomUUID();

  beforeAll(async () => {
    await fx.listener();
    Object.assign(env as Record<string, unknown>, {
      CTM_ACCESS_KEY: randomUUID(), CTM_SECRET_KEY: randomUUID(), CTM_API_BASE: PROVIDER, CTM_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
    });
    vi.stubGlobal('fetch', fakeProvider);
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    vi.unstubAllGlobals();
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['message_thread_read_states', 'notification_recipients', 'notifications', 'timeline_events', 'messages',
        'message_threads', 'call_sessions', 'emails', 'email_threads', 'mailbox_addresses', 'record_contact_entries']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}' AND kind = 'user'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM jobs WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM leads WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  let sequence = 0;

  /** A company connected to the phone system with a main line, and a customer whose phone is (555) 010-3002. */
  async function company() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const account = `3022${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: { ctm_account_id: account, ctm_sms_ready: true, sms_sending_enabled: true },
    });
    const mainLine = `+1555030${String(++sequence).padStart(4, '0')}`;
    const line = await db.phoneNumber.create({
      data: {
        organization_id: made.org, e164: mainLine, label: 'Main line', is_org_default: true, status: 'active',
        sms_enabled: true, ctm_number_id: `TPN3022${made.tag}`,
      },
    });
    await db.customer.update({ where: { id: made.customer }, data: { phone: '5550103002' } });
    return { ...made, account, mainLine, lineId: line.id };
  }

  type Company = Awaited<ReturnType<typeof company>>;
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  /** A lead (L19835 in the issue) on the company's customer, made 30 days ago, in `status`. */
  async function leadMade(w: Company, status: LeadStatus = 'NEW') {
    const lead = await fx.addLead(w.org, w.customer);
    await db.lead.update({ where: { id: lead.id }, data: { created_at: MADE, status } });
    return lead.id;
  }

  /** A job on the company's customer, made 30 days ago, in `status`. */
  async function jobMade(w: Company, status: JobStatus = 'SCHEDULED') {
    const job = await fx.addJob(w.org, w.customer, { status });
    await db.job.update({ where: { id: job.id }, data: { created_at: MADE } });
    return job.id;
  }

  /** The record's pencil (the contact card), as a person uses it: change a customer phone (by default (555) 010-3002) to another number. */
  async function changePhone(api: Api, kind: 'lead' | 'job', id: string, to: string, replaces = '(555) 010-3002') {
    const res = await api.post(`/api/${kind}s/${id}/contact-entries/change`, { kind: 'PHONE', replaces, value: to });
    expect(res.status).toBe(201);
  }

  /** The record's pencil: add a number only this record carries. */
  async function addOwnPhone(api: Api, kind: 'lead' | 'job', id: string, value: string) {
    const res = await api.post(`/api/${kind}s/${id}/contact-entries`, { kind: 'PHONE', value });
    expect(res.status).toBe(201);
  }

  type TextOpts = {
    at: Date;
    direction?: 'in' | 'out';
    leadId?: string;
    jobId?: string;
    /** The customer the conversation is filed on (default the company's customer); null for a conversation with nobody. */
    customer?: string | null;
    /** A conversation with a member of staff instead of a customer. */
    staff?: string;
  };

  /** One text with `number` (E.164, as #3014 stores the other party) in a conversation of its own. Returns its id. */
  async function text(w: { org: string; customer: string }, number: string, opts: TextOpts) {
    const thread = await db.messageThread.create({
      data: {
        organization_id: w.org, channel: 'sms', campaign_type: 'customer_care',
        ...(opts.staff
          ? { kind: 'team', user_id: opts.staff, title: 'Staff' }
          : { kind: 'customer', customer_id: opts.customer === undefined ? w.customer : opts.customer }),
      },
      select: { id: true },
    });
    const row = await db.message.create({
      data: {
        organization_id: w.org, thread_id: thread.id, direction: opts.direction ?? 'in', body: `text-${++sequence}`, ts: opts.at,
        status: (opts.direction ?? 'in') === 'in' ? 'received' : 'sent', other_party_e164: number,
        lead_id: opts.leadId ?? null, job_id: opts.jobId ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** The ids the record's Communication tab lists, read through the route as `api`. */
  async function listed(api: Api, kind: 'lead' | 'job', id: string): Promise<string[]> {
    const res = await api.get(`/api/${kind}s/${id}/communications`);
    expect(res.status).toBe(200);
    return (res.body.items as { id: string }[]).map((i) => i.id);
  }

  describe('a lead (L19835) whose phone was changed to (555) 010-5252 on its card', () => {
    it('lists an untied reply from (555) 010-5252 sent after it was made', async () => {
      const w = await company();
      const lead = await leadMade(w);
      const admin = await fx.signedInAs(w.admin);
      await changePhone(admin, 'lead', lead, '(555) 010-5252');
      const reply = await text(w, '+15550105252', { at: day(2) });

      expect(await listed(admin, 'lead', lead)).toContain(reply);
    });

    it('does not list a text from before the lead was made', async () => {
      const w = await company();
      const lead = await leadMade(w);
      const admin = await fx.signedInAs(w.admin);
      await changePhone(admin, 'lead', lead, '(555) 010-5252');
      const before = await text(w, '+15550105252', { at: day(-1) });
      const during = await text(w, '+15550105252', { at: day(1) });

      const ids = await listed(admin, 'lead', lead);
      expect(ids).toContain(during);
      expect(ids).not.toContain(before);
    });

    it('lists a text tied to the lead after it closed (a review request), and not an untied one sent after it closed', async () => {
      const w = await company();
      const lead = await leadMade(w);
      const admin = await fx.signedInAs(w.admin);
      await changePhone(admin, 'lead', lead, '(555) 010-5252');
      await db.lead.update({ where: { id: lead }, data: { status: 'LOST', lost_at: day(5) } });
      const reviewRequest = await text(w, '+15550105252', { at: day(9), direction: 'out', leadId: lead });
      const untiedAfter = await text(w, '+15550105252', { at: day(6) });
      const untiedBefore = await text(w, '+15550105252', { at: day(4) });

      const ids = await listed(admin, 'lead', lead);
      expect(ids).toContain(reviewRequest);
      expect(ids).toContain(untiedBefore);
      expect(ids).not.toContain(untiedAfter);
    });

    it('closes at Won (converted) on the day it was won', async () => {
      const w = await company();
      const lead = await leadMade(w);
      const admin = await fx.signedInAs(w.admin);
      await changePhone(admin, 'lead', lead, '(555) 010-5252');
      await db.lead.update({ where: { id: lead }, data: { status: 'WON', won_at: day(5) } });
      const during = await text(w, '+15550105252', { at: day(4) });
      const after = await text(w, '+15550105252', { at: day(6) });

      const ids = await listed(admin, 'lead', lead);
      expect(ids).toContain(during);
      expect(ids).not.toContain(after);
    });

    it('is still open at every other status, so a reply long after it was made is listed', async () => {
      const w = await company();
      const admin = await fx.signedInAs(w.admin);
      for (const status of ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'] as const) {
        const lead = await leadMade(w, status);
        // Close days and a last update long ago: none of them may end the window of a lead that is still open.
        await db.$executeRaw`UPDATE leads SET lost_at = ${day(1)}, won_at = ${day(1)}, updated_at = ${day(2)} WHERE id = ${lead}::uuid`;
        const late = await text(w, '+15550103002', { at: day(29) });
        expect(await listed(admin, 'lead', lead), status).toContain(late);
      }
    });

    it('closes on its last update when it closed before the close day was recorded', async () => {
      const w = await company();
      const lead = await leadMade(w);
      const admin = await fx.signedInAs(w.admin);
      await db.$executeRaw`UPDATE leads SET status = 'LOST', lost_at = NULL, updated_at = ${day(5)} WHERE id = ${lead}::uuid`;
      const during = await text(w, '+15550103002', { at: day(4) });
      const after = await text(w, '+15550103002', { at: day(6) });

      const ids = await listed(admin, 'lead', lead);
      expect(ids).toContain(during);
      expect(ids).not.toContain(after);
    });

    it('counts the numbers its card shows: the changed number, the customer phone it replaced, the second phone and its own number', async () => {
      const w = await company();
      await db.customer.update({ where: { id: w.customer }, data: { secondary_phone: '5550104004' } });
      const lead = await leadMade(w);
      const admin = await fx.signedInAs(w.admin);
      await changePhone(admin, 'lead', lead, '(555) 010-5252');
      await addOwnPhone(admin, 'lead', lead, '(555) 010-5353');
      const fromChanged = await text(w, '+15550105252', { at: day(1) });
      const fromSecond = await text(w, '+15550104004', { at: day(1) });
      const fromOwn = await text(w, '+15550105353', { at: day(1), customer: null });
      const fromReplaced = await text(w, '+15550103002', { at: day(1) });
      const fromNobody = await text(w, '+15550109999', { at: day(1) });

      const ids = await listed(admin, 'lead', lead);
      expect(ids).toEqual(expect.arrayContaining([fromChanged, fromReplaced, fromSecond, fromOwn]));
      expect(ids).not.toContain(fromNobody);
    });

    it('lists a text in the window that is tied to another lead of the customer too ("every text")', async () => {
      const w = await company();
      const lead = await leadMade(w);
      const other = await leadMade(w);
      const admin = await fx.signedInAs(w.admin);
      const onOther = await text(w, '+15550103002', { at: day(1), direction: 'out', leadId: other });

      expect(await listed(admin, 'lead', lead)).toContain(onOther);
    });

    it('keeps calls and emails on today\'s rule: only those tied to the lead', async () => {
      const w = await company();
      const lead = await leadMade(w);
      const admin = await fx.signedInAs(w.admin);
      await changePhone(admin, 'lead', lead, '(555) 010-5252');
      const call = (tie: { lead_id?: string }) =>
        db.callSession.create({
          data: {
            organization_id: w.org, direction: 'in', from_number: '+15550105252', to_number: w.mainLine, status: 'completed',
            answered_by: {}, started_at: day(1), customer_id: w.customer, ...tie,
          },
          select: { id: true },
        });
      const mailbox = await db.mailbox.create({ data: { organization_id: w.org, kind: 'user', status: 'active' }, select: { id: true } });
      const email = async (tie: { lead_id?: string }) => {
        const thread = await db.emailThread.create({ data: { organization_id: w.org, mailbox_id: mailbox.id, origin: 'started' }, select: { id: true } });
        return db.email.create({
          data: {
            organization_id: w.org, account: 'user', from: { name: null, email: 'pat@example.com' }, to: 'office@example.com',
            subject: 'About the door', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(day(1).getTime()), folder: 'inbox',
            thread_id: thread.id, customer_id: w.customer, created_at: day(1), ...tie,
          },
          select: { id: true },
        });
      };
      const tiedCall = await call({ lead_id: lead });
      const untiedCall = await call({});
      const tiedEmail = await email({ lead_id: lead });
      const untiedEmail = await email({});

      const ids = await listed(admin, 'lead', lead);
      expect(ids).toEqual(expect.arrayContaining([tiedCall.id, tiedEmail.id]));
      expect(ids).not.toContain(untiedCall.id);
      expect(ids).not.toContain(untiedEmail.id);
    });

    it("never lists a second company's text from the same number, though that company's lead carries it", async () => {
      const w = await company();
      const lead = await leadMade(w);
      const admin = await fx.signedInAs(w.admin);
      await changePhone(admin, 'lead', lead, '(555) 010-5252');
      await listed(admin, 'lead', lead);
      const elsewhere = await company();
      const theirLead = await leadMade(elsewhere);
      await changePhone(await fx.signedInAs(elsewhere.admin), 'lead', theirLead, '(555) 010-5252');
      const theirs = await text(elsewhere, '+15550105252', { at: day(1) });
      const theirsTied = await text(elsewhere, '+15550105252', { at: day(1), leadId: theirLead });
      const ours = await text(w, '+15550105252', { at: day(1) });

      const ids = await listed(await fx.signedInAs(w.admin), 'lead', lead);
      expect(ids).toContain(ours);
      expect(ids).not.toContain(theirs);
      expect(ids).not.toContain(theirsTied);
    });

    it('does not list a text with a member of staff, though it is the same number', async () => {
      const w = await company();
      const lead = await leadMade(w);
      const admin = await fx.signedInAs(w.admin);
      const staff = await fx.addUser(w.org, 'staffer', 'TECHNICIAN');
      const withStaff = await text(w, '+15550103002', { at: day(1), staff: staff.id, direction: 'out' });
      const withCustomer = await text(w, '+15550103002', { at: day(1) });

      const ids = await listed(admin, 'lead', lead);
      expect(ids).toContain(withCustomer);
      expect(ids).not.toContain(withStaff);
    });
  });

  describe('a job whose phone was changed to (555) 010-5252 on its card', () => {
    it('lists an untied reply from (555) 010-5252 sent after it was made, and not one from before', async () => {
      const w = await company();
      const job = await jobMade(w);
      const admin = await fx.signedInAs(w.admin);
      await changePhone(admin, 'job', job, '(555) 010-5252');
      const before = await text(w, '+15550105252', { at: day(-1) });
      const reply = await text(w, '+15550105252', { at: day(2) });

      const ids = await listed(admin, 'job', job);
      expect(ids).toContain(reply);
      expect(ids).not.toContain(before);
    });

    for (const [status, stamp] of [['DONE', 'closed_at'], ['CANCELLED', 'cancelled_at']] as const) {
      it(`at ${status}: lists a text tied to the job after it closed (a review request), and not an untied one`, async () => {
        const w = await company();
        const job = await jobMade(w);
        const admin = await fx.signedInAs(w.admin);
        await changePhone(admin, 'job', job, '(555) 010-5252');
        await db.job.update({ where: { id: job }, data: { status, [stamp]: day(5) } });
        const untiedBefore = await text(w, '+15550105252', { at: day(4) });
        const reviewRequest = await text(w, '+15550105252', { at: day(9), direction: 'out', jobId: job });
        const untiedAfter = await text(w, '+15550105252', { at: day(6) });

        const ids = await listed(admin, 'job', job);
        expect(ids).toEqual(expect.arrayContaining([untiedBefore, reviewRequest]));
        expect(ids).not.toContain(untiedAfter);
      });
    }

    it('is still open at Completed, Office review and Ready to close', async () => {
      const w = await company();
      const admin = await fx.signedInAs(w.admin);
      for (const status of ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE'] as const) {
        const job = await jobMade(w, status);
        // Close days and a last update long ago: none of them may end the window of a job that is still open.
        await db.$executeRaw`UPDATE jobs SET completed_at = ${day(1)}, closed_at = ${day(1)}, cancelled_at = ${day(1)}, updated_at = ${day(2)} WHERE id = ${job}::uuid`;
        const late = await text(w, '+15550103002', { at: day(29) });
        expect(await listed(admin, 'job', job), status).toContain(late);
      }
    });

    it("counts the job's own number, and never a second company's text from the same number", async () => {
      const w = await company();
      const job = await jobMade(w);
      const admin = await fx.signedInAs(w.admin);
      await addOwnPhone(admin, 'job', job, '(555) 010-5353');
      const elsewhere = await company();
      const theirJob = await jobMade(elsewhere);
      await addOwnPhone(await fx.signedInAs(elsewhere.admin), 'job', theirJob, '(555) 010-5353');
      const theirs = await text(elsewhere, '+15550105353', { at: day(1) });
      const ours = await text(w, '+15550105353', { at: day(1), customer: null });

      const ids = await listed(await fx.signedInAs(w.admin), 'job', job);
      expect(ids).toContain(ours);
      expect(ids).not.toContain(theirs);
    });

    it("keeps calls on today's rule: only those tied to the job", async () => {
      const w = await company();
      const job = await jobMade(w);
      const admin = await fx.signedInAs(w.admin);
      const call = (tie: { job_id?: string }) =>
        db.callSession.create({
          data: {
            organization_id: w.org, direction: 'in', from_number: '+15550103002', to_number: w.mainLine, status: 'completed',
            answered_by: {}, started_at: day(1), customer_id: w.customer, ...tie,
          },
          select: { id: true },
        });
      const tied = await call({ job_id: job });
      const untied = await call({});

      const ids = await listed(admin, 'job', job);
      expect(ids).toContain(tied.id);
      expect(ids).not.toContain(untied.id);
    });
  });

  // Ran, 2026-11-06: the customer phone a lead or a job replaced is still one of its numbers (its card still shows it, as
  // "Customer record"), so the texts on it inside the record's window are listed like those on its other numbers. Which numbers
  // the record may text, and where a text sent from it goes, are not changed (anchored-text-destination-db.test.ts).
  describe('the customer phone the record replaced, (555) 010-3002, still shown on its card as "Customer record"', () => {
    for (const kind of ['lead', 'job'] as const) {
      /** A record of `kind` made 30 days ago whose card changed (555) 010-3002 to (555) 010-5252. */
      async function changedRecord(w: Company) {
        const id = kind === 'lead' ? await leadMade(w) : await jobMade(w);
        await changePhone(await fx.signedInAs(w.admin), kind, id, '(555) 010-5252');
        return id;
      }

      /** Close the record on day 5 (a lead lost, a job done). */
      const close = (id: string) =>
        kind === 'lead'
          ? db.lead.update({ where: { id }, data: { status: 'LOST', lost_at: day(5) } })
          : db.job.update({ where: { id }, data: { status: 'DONE', closed_at: day(5) } });

      it(`a ${kind} lists an untied text from (555) 010-3002 inside its window, as it lists one from (555) 010-5252`, async () => {
        const w = await company();
        const id = await changedRecord(w);
        const fromReplaced = await text(w, '+15550103002', { at: day(1) });
        const fromReplacedOnNobody = await text(w, '+15550103002', { at: day(2), customer: null });
        const fromChanged = await text(w, '+15550105252', { at: day(3) });

        expect(await listed(await fx.signedInAs(w.admin), kind, id))
          .toEqual(expect.arrayContaining([fromReplaced, fromReplacedOnNobody, fromChanged]));
      });

      it(`a ${kind} does not list an untied text from (555) 010-3002 before it was made or after it closed, and lists one tied to it`, async () => {
        const w = await company();
        const id = await changedRecord(w);
        await close(id);
        const before = await text(w, '+15550103002', { at: day(-1) });
        const during = await text(w, '+15550103002', { at: day(4) });
        const after = await text(w, '+15550103002', { at: day(6) });
        const tiedAfter = await text(w, '+15550103002', { at: day(9), direction: 'out', ...(kind === 'lead' ? { leadId: id } : { jobId: id }) });

        const ids = await listed(await fx.signedInAs(w.admin), kind, id);
        expect(ids).toEqual(expect.arrayContaining([during, tiedAfter]));
        expect(ids).not.toContain(before);
        expect(ids).not.toContain(after);
      });

      it(`a ${kind} whose card changed both customer phones lists the texts from each phone it replaced`, async () => {
        const w = await company();
        await db.customer.update({ where: { id: w.customer }, data: { secondary_phone: '5550104004' } });
        const id = await changedRecord(w);
        await changePhone(await fx.signedInAs(w.admin), kind, id, '(555) 010-5454', '(555) 010-4004');
        const fromFirst = await text(w, '+15550103002', { at: day(1) });
        const fromSecond = await text(w, '+15550104004', { at: day(2) });
        const fromNobody = await text(w, '+15550109999', { at: day(2) });

        const ids = await listed(await fx.signedInAs(w.admin), kind, id);
        expect(ids).toEqual(expect.arrayContaining([fromFirst, fromSecond]));
        expect(ids).not.toContain(fromNobody);
      });

      it(`a ${kind} never lists a second company's text from (555) 010-3002, though that company's ${kind} replaced it too`, async () => {
        const w = await company();
        const id = await changedRecord(w);
        const elsewhere = await company();
        const theirs = kind === 'lead' ? await leadMade(elsewhere) : await jobMade(elsewhere);
        await changePhone(await fx.signedInAs(elsewhere.admin), kind, theirs, '(555) 010-5252');
        const theirText = await text(elsewhere, '+15550103002', { at: day(1) });
        const theirTextOnNobody = await text(elsewhere, '+15550103002', { at: day(1), customer: null });
        const ours = await text(w, '+15550103002', { at: day(1) });

        const ids = await listed(await fx.signedInAs(w.admin), kind, id);
        expect(ids).toContain(ours);
        expect(ids).not.toContain(theirText);
        expect(ids).not.toContain(theirTextOnNobody);
      });
    }
  });

  describe("reach: the read keeps today's checks", () => {
    /** A person on a fresh custom role who opens only the leads and jobs they are on. */
    async function attachedPerson(org: string, base: Role = 'TECHNICIAN'): Promise<Person> {
      const key = `window-role-${++sequence}`;
      const role = await fx.addCustomRole(org, key, base);
      await setRoleSwitchValues({
        organizationId: org, roleKey: key,
        values: {
          view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
          access_communication: true, view_communication: true, communication_scope: 'attached',
        },
        actorId: null, reason: 'manual',
      });
      return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    }

    it('a person who cannot open the lead or the job gets the same refusal as for one that does not exist', async () => {
      const w = await company();
      const lead = await leadMade(w);
      const job = await jobMade(w);
      await text(w, '+15550103002', { at: day(1) });
      const outsider = await attachedPerson(w.org);
      const api = await fx.signedInAs(outsider);

      for (const kind of ['lead', 'job'] as const) {
        const id = kind === 'lead' ? lead : job;
        const refused = await api.get(`/api/${kind}s/${id}/communications`);
        const missing = await api.get(`/api/${kind}s/${randomUUID()}/communications`);
        expect(refused.status, kind).toBeGreaterThanOrEqual(400);
        expect({ status: refused.status, body: refused.body }, kind).toEqual({ status: missing.status, body: missing.body });
      }
    });

    it('a text in the window tied to a job the person cannot open stays off the lead they can open', async () => {
      const w = await company();
      const person = await attachedPerson(w.org, 'SALES');
      const lead = await fx.addLead(w.org, w.customer, { assignees: [person.id], owner: person.id });
      await db.lead.update({ where: { id: lead.id }, data: { created_at: MADE } });
      const hiddenJob = await jobMade(w);
      const onHiddenJob = await text(w, '+15550103002', { at: day(1), jobId: hiddenJob, direction: 'out' });
      const onLead = await text(w, '+15550103002', { at: day(1), leadId: lead.id, direction: 'out' });

      const ids = await listed(await fx.signedInAs(person), 'lead', lead.id);
      expect(ids).toContain(onLead);
      expect(ids).not.toContain(onHiddenJob);
    });
  });

  // #3013 decision 4: a text tied to no lead or job is readable by anyone who can open at least one customer carrying its
  // number, or who holds Communication "All". The record's customer carries every number the record's card shows, so a person
  // who can open that customer (View customers, and the record brings its customer into their reach) reads the record's window
  // texts even when the conversation is filed on another customer of a shared number, or on nobody. Opening the record alone
  // is not opening its customer: without View customers (the preset Technician) the untied texts stay off, as before #3022.
  describe('reach: a person who opens only the record reads its untied texts on a shared number', () => {
    async function attachedPerson(org: string, base: Role, switches: Record<string, unknown> = {}): Promise<Person> {
      const key = `window-shared-role-${++sequence}`;
      const role = await fx.addCustomRole(org, key, base);
      await setRoleSwitchValues({
        organizationId: org, roleKey: key,
        values: {
          view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
          access_communication: true, view_communication: true, communication_scope: 'attached', ...switches,
        },
        actorId: null, reason: 'manual',
      });
      return fx.addUser(org, `s${sequence}`, base, { customRoleId: role.id });
    }

    /** Another customer of the company whose own phone is `phone`: the number it shares with the record. */
    async function otherCustomerWith(org: string, phone: string) {
      const id = randomUUID();
      await db.customer.create({
        data: {
          id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
          first_name: 'Riley', last_name: 'Brooks', phone,
        },
      });
      return id;
    }

    /**
     * The texts around a record whose card shows `shared` (also the other customer's phone) and its own (555) 010-5353. `shown`
     * are the untied texts in the window, filed on the record's customer, on the other customer and on nobody; `hidden` must
     * stay off the tab of a person who reaches neither the other customer nor its lead.
     */
    async function textsAround(w: Company, other: string, shared: string) {
      const otherLead = await fx.addLead(w.org, other);
      const elsewhere = await company();
      return {
        shown: [
          await text(w, shared, { at: day(1) }),
          await text(w, shared, { at: day(2), customer: other }),
          await text(w, shared, { at: day(3), customer: null }),
          await text(w, '+15550105353', { at: day(4), customer: null }),
        ],
        hidden: {
          beforeOnOther: await text(w, shared, { at: day(-2), customer: other }),
          otherNumberOnOther: await text(w, '+15550107777', { at: day(2), customer: other }),
          tiedToOtherLead: await text(w, shared, { at: day(2), customer: other, leadId: otherLead.id, direction: 'out' }),
          inAnotherCompany: await text(elsewhere, shared, { at: day(2), customer: null }),
        },
      };
    }

    function expectShownOnly(ids: string[], t: Awaited<ReturnType<typeof textsAround>>) {
      expect(ids).toEqual(expect.arrayContaining(t.shown));
      for (const [what, id] of Object.entries(t.hidden)) expect(ids, what).not.toContain(id);
    }

    async function refusedLikeMissing(api: Api, kind: 'lead' | 'job', id: string) {
      const refused = await api.get(`/api/${kind}s/${id}/communications`);
      const missing = await api.get(`/api/${kind}s/${randomUUID()}/communications`);
      expect(refused.status, kind).toBeGreaterThanOrEqual(400);
      expect({ status: refused.status, body: refused.body }, kind).toEqual({ status: missing.status, body: missing.body });
    }

    it("the lead's owner reads its untied texts filed on its customer, on another customer sharing (555) 010-5252, and on nobody", async () => {
      const w = await company();
      const owner = await attachedPerson(w.org, 'SALES');
      const lead = await fx.addLead(w.org, w.customer, { assignees: [owner.id], owner: owner.id });
      await db.lead.update({ where: { id: lead.id }, data: { created_at: MADE } });
      const admin = await fx.signedInAs(w.admin);
      await changePhone(admin, 'lead', lead.id, '(555) 010-5252');
      await addOwnPhone(admin, 'lead', lead.id, '(555) 010-5353');
      const t = await textsAround(w, await otherCustomerWith(w.org, '5550105252'), '+15550105252');

      expect(await listed(admin, 'lead', lead.id)).toEqual(expect.arrayContaining(t.shown));
      expectShownOnly(await listed(await fx.signedInAs(owner), 'lead', lead.id), t);

      // Someone who cannot open the lead still gets the answer for a lead that does not exist.
      await refusedLikeMissing(await fx.signedInAs(await attachedPerson(w.org, 'SALES')), 'lead', lead.id);
    });

    it("the job's crew reads its untied texts filed on its customer, on another customer sharing (555) 010-3002, and on nobody", async () => {
      const w = await company();
      const crew = await attachedPerson(w.org, 'TECHNICIAN');
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      await db.job.update({ where: { id: job.id }, data: { created_at: MADE } });
      const admin = await fx.signedInAs(w.admin);
      await addOwnPhone(admin, 'job', job.id, '(555) 010-5353');
      const t = await textsAround(w, await otherCustomerWith(w.org, '5550103002'), '+15550103002');

      expect(await listed(admin, 'job', job.id)).toEqual(expect.arrayContaining(t.shown));
      expectShownOnly(await listed(await fx.signedInAs(crew), 'job', job.id), t);

      // Someone who is not on the job still gets the answer for a job that does not exist.
      await refusedLikeMissing(await fx.signedInAs(await attachedPerson(w.org, 'TECHNICIAN')), 'job', job.id);
    });

    /** View customers off (and the two customer switches that need it, on a Sales-based role). */
    const NO_CUSTOMERS = { view_customers: false, create_customers: false, edit_customers: false };

    /** The texts of the record's tab as `api` reads it: id -> who (the name on the row). */
    async function textRows(api: Api, kind: 'lead' | 'job', id: string): Promise<Map<string, string>> {
      const res = await api.get(`/api/${kind}s/${id}/communications`);
      expect(res.status).toBe(200);
      const items = res.body.items as { id: string; channel: string; who: string }[];
      return new Map(items.filter((i) => i.channel === 'sms').map((i) => [i.id, i.who]));
    }

    /** A job made 30 days ago with `crew` on a visit, its own (555) 010-5353, and a text tied to it inside and before its window. */
    async function sharedJob(w: Company, crew: Person) {
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      await db.job.update({ where: { id: job.id }, data: { created_at: MADE } });
      await addOwnPhone(await fx.signedInAs(w.admin), 'job', job.id, '(555) 010-5353');
      const tied = [
        await text(w, '+15550103002', { at: day(1), jobId: job.id, direction: 'out' }),
        await text(w, '+15550103002', { at: day(-5), jobId: job.id, direction: 'out' }),
      ];
      return { id: job.id, tied };
    }

    /** A lead made 30 days ago owned by `owner`, changed to (555) 010-5252 with its own 5353, and texts tied to it in and before its window. */
    async function sharedLead(w: Company, owner: Person) {
      const lead = await fx.addLead(w.org, w.customer, { assignees: [owner.id], owner: owner.id });
      await db.lead.update({ where: { id: lead.id }, data: { created_at: MADE } });
      const admin = await fx.signedInAs(w.admin);
      await changePhone(admin, 'lead', lead.id, '(555) 010-5252');
      await addOwnPhone(admin, 'lead', lead.id, '(555) 010-5353');
      const tied = [
        await text(w, '+15550105252', { at: day(1), leadId: lead.id, direction: 'out' }),
        await text(w, '+15550105252', { at: day(-5), leadId: lead.id, direction: 'out' }),
      ];
      return { id: lead.id, tied };
    }

    it("the job's crew on the preset Technician role (View customers off) reads only the texts tied to the job, as before #3022", async () => {
      const w = await company();
      const crew = await fx.addUser(w.org, `t${++sequence}`, 'TECHNICIAN');
      const job = await sharedJob(w, crew);
      const t = await textsAround(w, await otherCustomerWith(w.org, '5550103002'), '+15550103002');

      // The untied texts are in the job's window: the admin, who opens every customer, reads them.
      expect(await listed(await fx.signedInAs(w.admin), 'job', job.id)).toEqual(expect.arrayContaining(t.shown));
      // The Technician opens the job but no customer: of the texts, only the two tied to the job are theirs, none untied
      // (filed on the job's customer, on another customer with (555) 010-3002, or on nobody).
      const rows = await textRows(await fx.signedInAs(crew), 'job', job.id);
      expect([...rows.keys()].sort()).toEqual([...job.tied].sort());

      // A Technician who is not on the job still gets the answer for a job that does not exist.
      await refusedLikeMissing(await fx.signedInAs(await fx.addUser(w.org, `t${++sequence}`, 'TECHNICIAN')), 'job', job.id);
    });

    it("the lead's owner on a role with View customers off reads only the texts tied to the lead", async () => {
      const w = await company();
      const owner = await attachedPerson(w.org, 'SALES', NO_CUSTOMERS);
      const lead = await sharedLead(w, owner);
      const t = await textsAround(w, await otherCustomerWith(w.org, '5550105252'), '+15550105252');

      expect(await listed(await fx.signedInAs(w.admin), 'lead', lead.id)).toEqual(expect.arrayContaining(t.shown));
      const rows = await textRows(await fx.signedInAs(owner), 'lead', lead.id);
      expect([...rows.keys()].sort()).toEqual([...lead.tied].sort());

      await refusedLikeMissing(await fx.signedInAs(await attachedPerson(w.org, 'SALES', NO_CUSTOMERS)), 'lead', lead.id);
    });

    it('a crew member who holds Communication "All" without View customers reads the job\'s untied texts wherever they are filed', async () => {
      const w = await company();
      const all = { ...NO_CUSTOMERS, communication_scope: 'all' };
      const crew = await attachedPerson(w.org, 'TECHNICIAN', all);
      const job = await sharedJob(w, crew);
      const t = await textsAround(w, await otherCustomerWith(w.org, '5550103002'), '+15550103002');

      const ids = await listed(await fx.signedInAs(crew), 'job', job.id);
      expectShownOnly(ids, t);
      expect(ids).toEqual(expect.arrayContaining(job.tied));

      // Communication "All" opens no job: someone not on the job still gets the answer for a job that does not exist.
      await refusedLikeMissing(await fx.signedInAs(await attachedPerson(w.org, 'TECHNICIAN', all)), 'job', job.id);
    });

    it('a lead owner who holds Communication "All" without View customers reads the lead\'s untied texts wherever they are filed', async () => {
      const w = await company();
      const all = { ...NO_CUSTOMERS, communication_scope: 'all' };
      const owner = await attachedPerson(w.org, 'SALES', all);
      const lead = await sharedLead(w, owner);
      const t = await textsAround(w, await otherCustomerWith(w.org, '5550105252'), '+15550105252');

      const ids = await listed(await fx.signedInAs(owner), 'lead', lead.id);
      expectShownOnly(ids, t);
      expect(ids).toEqual(expect.arrayContaining(lead.tied));

      await refusedLikeMissing(await fx.signedInAs(await attachedPerson(w.org, 'SALES', all)), 'lead', lead.id);
    });

    it("a text filed on a customer the lead's owner cannot open is named after the lead's own customer, never the other one", async () => {
      const w = await company();
      const owner = await attachedPerson(w.org, 'SALES');
      const lead = await sharedLead(w, owner);
      const t = await textsAround(w, await otherCustomerWith(w.org, '5550105252'), '+15550105252');
      const [onPat, onRiley] = t.shown;

      // The admin opens Riley Brooks, so the row filed on Riley is named after Riley.
      expect((await textRows(await fx.signedInAs(w.admin), 'lead', lead.id)).get(onRiley)).toBe('Riley Brooks');
      // The owner opens Pat Payer (the lead's customer) but not Riley.
      const rows = await textRows(await fx.signedInAs(owner), 'lead', lead.id);
      expect(rows.get(onPat)).toBe('Pat Payer');
      expect(rows.get(onRiley)).toBe('Pat Payer');
      expect([...rows.values()].filter((who) => who.includes('Riley'))).toEqual([]);
    });

    it('a text filed on a customer the person cannot open carries no name when they cannot open the job\'s customer either', async () => {
      const w = await company();
      const crew = await attachedPerson(w.org, 'TECHNICIAN', { ...NO_CUSTOMERS, communication_scope: 'all' });
      const job = await sharedJob(w, crew);
      const t = await textsAround(w, await otherCustomerWith(w.org, '5550103002'), '+15550103002');
      const onRiley = t.shown[1];

      const rows = await textRows(await fx.signedInAs(crew), 'job', job.id);
      expect(rows.get(onRiley)).toBe('');
      expect([...rows.values()].filter((who) => who.includes('Riley'))).toEqual([]);
    });

    // Ran, 2026-11-06: the customer phone the record replaced is one of its numbers, under the same reach and naming rules.
    for (const kind of ['lead', 'job'] as const) {
      it(`untied texts from the customer phone the ${kind} replaced reach whom its other numbers reach, and are named by the same rule`, async () => {
        const w = await company();
        const base: Role = kind === 'lead' ? 'SALES' : 'TECHNICIAN';
        const opensCustomer = await attachedPerson(w.org, base);
        const recordOnly = await attachedPerson(w.org, base, NO_CUSTOMERS);
        const allHolder = await attachedPerson(w.org, base, { ...NO_CUSTOMERS, communication_scope: 'all' });
        const people = [opensCustomer.id, recordOnly.id, allHolder.id];
        const id = kind === 'lead'
          ? (await fx.addLead(w.org, w.customer, { assignees: people, owner: opensCustomer.id })).id
          : (await fx.addJob(w.org, w.customer, { crew: people })).id;
        if (kind === 'lead') await db.lead.update({ where: { id }, data: { created_at: MADE } });
        else await db.job.update({ where: { id }, data: { created_at: MADE } });
        await changePhone(await fx.signedInAs(w.admin), kind, id, '(555) 010-5252');
        const riley = await otherCustomerWith(w.org, '5550103002');
        const elsewhere = await company();

        const tied = await text(w, '+15550103002', { at: day(1), direction: 'out', ...(kind === 'lead' ? { leadId: id } : { jobId: id }) });
        const [onPat, onRiley, onNobody] = [
          await text(w, '+15550103002', { at: day(1) }),
          await text(w, '+15550103002', { at: day(2), customer: riley }),
          await text(w, '+15550103002', { at: day(3), customer: null }),
        ];
        const hidden = {
          beforeOnPat: await text(w, '+15550103002', { at: day(-2) }),
          beforeOnRiley: await text(w, '+15550103002', { at: day(-2), customer: riley }),
          inAnotherCompany: await text(elsewhere, '+15550103002', { at: day(2), customer: null }),
        };
        const noRiley = (rows: Map<string, string>) => [...rows.values()].filter((who) => who.includes('Riley'));

        // The admin opens every customer: every untied text, the row on Riley named after Riley.
        const adminRows = await textRows(await fx.signedInAs(w.admin), kind, id);
        expect([...adminRows.keys()]).toEqual(expect.arrayContaining([tied, onPat, onRiley, onNobody]));
        expect(adminRows.get(onRiley)).toBe('Riley Brooks');

        // Opens the record and its customer (Pat Payer), not Riley: every untied text, the row on Riley named after Pat.
        const opener = await textRows(await fx.signedInAs(opensCustomer), kind, id);
        expect([...opener.keys()]).toEqual(expect.arrayContaining([tied, onPat, onRiley, onNobody]));
        for (const [what, hiddenId] of Object.entries(hidden)) expect([...opener.keys()], what).not.toContain(hiddenId);
        expect(opener.get(onRiley)).toBe('Pat Payer');
        expect(noRiley(opener)).toEqual([]);

        // Opens the record but no customer: only the text tied to it.
        expect([...(await textRows(await fx.signedInAs(recordOnly), kind, id)).keys()]).toEqual([tied]);

        // Communication "All" without View customers: every untied text, the row on Riley unnamed.
        const all = await textRows(await fx.signedInAs(allHolder), kind, id);
        expect([...all.keys()]).toEqual(expect.arrayContaining([tied, onPat, onRiley, onNobody]));
        for (const [what, hiddenId] of Object.entries(hidden)) expect([...all.keys()], what).not.toContain(hiddenId);
        expect(all.get(onRiley)).toBe('');
        expect(noRiley(all)).toEqual([]);

        // Someone not on the record still gets the answer for one that does not exist.
        await refusedLikeMissing(await fx.signedInAs(await attachedPerson(w.org, base)), kind, id);
      });
    }
  });

  describe('the journey through the app', () => {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const inbound = async (w: Company, at: Date, body: string) =>
      request(await fx.listener())
        .post(`/api/webhooks/ctm/inbound_text?token=${WEBHOOK_TOKEN}`)
        .send({
          message_id: `MSG-3022-${randomUUID()}`, account_id: w.account, caller_number: '5550105252', tracking_number: w.mainLine,
          direction: 'msg_inbound', message_body: body, unix_time: Math.floor(at.getTime() / 1000),
        });
    const previews = async (api: Api, lead: string) =>
      ((await api.get(`/api/leads/${lead}/communications`)).body.items as { channel: string; preview: string }[])
        .filter((i) => i.channel === 'sms')
        .map((i) => i.preview);

    it('a lead made in the app, changed to (555) 010-5252, lists the reply; once lost, a later reply is left out and a review request is listed', async () => {
      const w = await company();
      const admin = await fx.signedInAs(w.admin);
      // A text from (555) 010-5252 a year before the lead.
      expect((await inbound(w, new Date(Date.now() - 365 * DAY), 'Old question')).status).toBe(200);
      const made = await admin.post('/api/leads', { customer_id: w.customer, service_request: 'New garage door' });
      expect(made.status).toBe(201);
      const lead = made.body.id ?? made.body.lead?.id;
      await changePhone(admin, 'lead', lead, '(555) 010-5252');
      await pause(1100);
      expect((await inbound(w, new Date(), 'Tuesday works')).status).toBe(200);
      await pause(1100);

      const lost = await admin.post(`/api/leads/${lead}/mark-lost`, { lost_reason: 'PRICE' });
      expect(lost.status).toBe(200);
      await pause(1100);
      expect((await inbound(w, new Date(), 'Never mind')).status).toBe(200);
      const review = await admin.post('/api/communication/sms', { customerId: w.customer, leadId: lead, body: 'How did we do?' });
      expect(review.status).toBe(201);

      const shown = await previews(admin, lead);
      expect(shown).toEqual(expect.arrayContaining(['Tuesday works', 'How did we do?']));
      expect(shown).not.toContain('Old question');
      expect(shown).not.toContain('Never mind');
    });
  });
});
