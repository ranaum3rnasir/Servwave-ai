/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.10 - a customer's reply rings the record's people, through M6.

   Driven through the real inbound entry point (`processResendEvent`, the handler behind the delivery webhook) with fixture
   payloads and the real reply-token resolver; only the call that fetches the received message from the provider is replaced,
   so nothing is sent or received from this machine. The bell rows the alert wrote are read back from the database.

   A customer's reply in a RECORD conversation (the one a send opens about a job, lead, estimate or invoice) rings lane 1: the
   holder of the user mailbox it sits in, the person who sent the mail being answered by hand, the record's Owner or Sold By, its
   crew, its Dispatcher and the conversation's assignee, each only if active, holding Access Communication and able to read the
   conversation under their scope (and, for an estimate or an invoice, to open that estimate or invoice). Only when lane 1 finds
   nobody: the people linked to the main mailbox who can read it, else the holders of Manage roles and permissions, with the
   reason line. Holders of the matching "Alert me about every ..." switch get a copy. A reply in an ordinary conversation rings
   its assignee, else its mailbox's holder (the main mailbox's readers). Bell only. An empty chain is logged.

   People are on custom roles (never a built-in role name) holding exactly the switch values under test, plus the Admin box.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient, fetchReceived, emitSpy } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, fetchReceived: vi.fn(), emitSpy: vi.fn() };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The provider call that fetches a received message is the only thing replaced.
vi.mock('../lib/inbound-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inbound-email')>()),
  fetchReceivedEmail: fetchReceived,
}));

// The real bell, watched: every call is counted, none is stopped.
vi.mock('../services/notifications/notificationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/notifications/notificationService')>();
  emitSpy.mockImplementation(actual.emit);
  return { ...actual, emit: emitSpy };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;

suite('a customer\'s reply rings the record\'s people through M6 (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM resend_events WHERE (payload->'data'->>'email_id') LIKE 'rp-s10-10-${org.slice(0, 8)}%'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_readers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  beforeEach(() => {
    emitSpy.mockClear();
    fetchReceived.mockReset();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;
  const token = () => randomBytes(16).toString('base64url');
  const ARRIVED = new Date('2026-07-01T15:00:00.000Z');

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

  /** A company with its main mailbox, which nobody is linked to. */
  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const main = await db.mailbox.create({ data: { organization_id: made.org, kind: 'main', status: 'active' }, select: { id: true } });
    return { ...made, main: main.id };
  }
  type World = Awaited<ReturnType<typeof newOrg>>;

  /** A person on a fresh custom role of this base holding exactly these switch values, with the Email page open. */
  async function personWith(org: string, values: Record<string, boolean | string> = {}, base: Role = 'DISPATCHER'): Promise<Who> {
    const key = `rpb-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, estimates_scope: 'attached', view_invoices: true, invoices_scope: 'attached',
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'linked_to_me',
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The user mailbox a person holds (what the user-mailbox migration gives every active user). */
  async function userMailbox(org: string, person: Person, holder: Person = person) {
    const id = randomUUID();
    await db.mailbox.create({ data: { id, organization_id: org, kind: 'user', status: 'active', user_id: person.id, holder_user_id: holder.id } });
    return id;
  }

  /** Link a person to the company's main mailbox, as a holder of Company settings does on the Sender Address page. */
  const linkToMain = (w: World, person: Person) =>
    db.mailboxReader.create({ data: { organization_id: w.org, mailbox_id: w.main, user_id: person.id } });

  interface Convo { thread: string; token: string; sent: string; org: string }

  /**
   * The conversation a send to a customer opened (or a started one): its thread, the mail that went out (`sentBy` is the person
   * who pressed Send by hand, empty for an automated send) and the reply token the customer was given.
   */
  async function conversation(
    w: World,
    opts: {
      record?: { type: string; id: string }; mailbox?: string; assignee?: string | null; sentBy?: string | null;
      origin?: 'record' | 'started' | 'migrated'; job?: string; lead?: string;
    } = {},
  ): Promise<Convo> {
    const thread = randomUUID();
    await db.emailThread.create({
      data: {
        id: thread, organization_id: w.org, mailbox_id: opts.mailbox ?? w.main, assigned_to_user_id: opts.assignee ?? null,
        origin: opts.origin ?? (opts.record ? 'record' : 'started'),
        record_type: opts.record?.type ?? null, record_id: opts.record?.id ?? null,
      },
    });
    const sent = randomUUID();
    await db.email.create({
      data: {
        id: sent, organization_id: w.org, thread_id: thread, customer_id: w.customer, job_id: opts.job ?? null, lead_id: opts.lead ?? null,
        account: opts.sentBy ? 'user' : 'system', direction: 'out', folder: 'sent', sent_by_user_id: opts.sentBy ?? null,
        from: { name: null, email: 'office@example.com' }, to: 'angel@example.com',
        subject: 'Your visit', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now() - 86_400_000),
      },
      select: { id: true },
    });
    const tok = token();
    await db.replyToken.create({
      data: {
        token: tok, organization_id: w.org, thread_id: thread, entity_type: opts.record?.type ?? null, entity_id: opts.record?.id ?? null,
        customer_id: w.customer, expected_from: 'angel@example.com', created_by_user_id: opts.sentBy ?? null,
      },
    });
    return { thread, token: tok, sent, org: w.org };
  }

  /** A customer's reply arriving through the delivery webhook's handler, once or again (`providerId` repeats a delivery). */
  async function receive(c: Convo, opts: { from?: string; providerId?: string } = {}) {
    const providerId = opts.providerId ?? `rp-s10-10-${c.org.slice(0, 8)}-${++sequence}`;
    fetchReceived.mockResolvedValueOnce({
      providerId,
      from: opts.from ?? 'Angel <angel@example.com>',
      receivedFor: [`${c.token}@reply.test.com`],
      to: [`${c.token}@reply.test.com`],
      subject: 'Re: Your visit',
      messageId: `<${providerId}@mail.example.com>`,
      receivedAt: ARRIVED,
      text: 'Sounds good, thank you.',
      html: '<div>Sounds good.</div>',
      headers: { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' },
    });
    const { processResendEvent } = await import('../controllers/resend-webhook.controller.js');
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await processResendEvent(
      `svix-${providerId}-${++sequence}`,
      { type: 'email.received', created_at: ARRIVED.toISOString(), data: { email_id: providerId } } as never,
      res as never,
    );
    expect(res.status).not.toHaveBeenCalled();
    const row = await db.email.findUniqueOrThrow({ where: { provider_message_id: providerId } });
    return { providerId, row };
  }

  /**
   * What the reply rang: who got the plain alert, who got the one with the reason line, and the line. The Admin box holds every
   * switch, so it is always a copy holder ("Alert me about every ...") and is told apart (`admin`) rather than mixed into the lists.
   */
  async function bells(providerId: string, w: World) {
    const key = `email_inbound:${providerId}`;
    const rows = await db.notification.findMany({
      where: { dedup_key: { in: [key, `${key}:why`] } },
      select: { dedup_key: true, title: true, body: true, data: true, object_type: true, object_id: true, recipients: { select: { recipient_id: true, priority: true } } },
    });
    const plain = rows.find((r) => r.dedup_key === key);
    const why = rows.find((r) => r.dedup_key === `${key}:why`);
    const ids = (r: typeof plain) => (r?.recipients ?? []).map((x) => x.recipient_id).filter((id) => id !== w.admin.id).sort();
    const adminIn = (r: typeof plain) => (r?.recipients ?? []).some((x) => x.recipient_id === w.admin.id);
    return {
      plain: ids(plain), why: ids(why),
      reason: ((why?.data ?? {}) as { fallback_reason?: string }).fallback_reason ?? null,
      all: [...ids(plain), ...ids(why)].sort(), admin: adminIn(plain) || adminIn(why), rows,
    };
  }
  const sorted = (...people: Person[]) => people.map((p) => p.id).sort();

  const listedIds = async (person: Who, query: string) => {
    const res = await (await person.api()).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };

  describe('a reply to an automated notice about a job', () => {
    it('rings the job\'s Sold By, crew and Dispatcher, not the main mailbox\'s linked people, who do not list it under "Linked to me"', async () => {
      const w = await newOrg();
      const soldBy = await personWith(w.org);
      const crew = await personWith(w.org);
      const dispatcher = await personWith(w.org);
      const linked = await personWith(w.org);
      const stranger = await personWith(w.org);
      await linkToMain(w, linked);
      const job = await fx.addJob(w.org, w.customer, { soldBy: soldBy.id, crew: [crew.id], dispatcher: dispatcher.id });
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });

      const reply = await receive(convo);

      const rung = await bells(reply.providerId, w);
      expect(rung.all).toEqual(sorted(soldBy, crew, dispatcher));
      expect(rung.why).toEqual([]);
      expect(rung.admin, 'the Admin box holds Alert me about every job: a copy').toBe(true);
      for (const person of [linked, stranger]) {
        expect(rung.all).not.toContain(person.id);
        expect(await listedIds(person, '?folder=inbox'), 'Linked to me').not.toContain(reply.row.id);
        expect(await listedIds(person, `?mailbox=${w.main}`), 'the main mailbox').not.toContain(reply.row.id);
      }
      // The bell is the conversation's: it opens the thread on the Email page, and says who wrote.
      expect(rung.rows[0]).toMatchObject({ object_type: 'EMAIL_THREAD', object_id: convo.thread });
    });
  });

  // ─── Lane 1, member by member ──────────────────────────────────────────────────────────────────────────────────────────

  /** A person who may read any job's conversations, for the people who are on a conversation without being on the job. */
  const allJobs = { jobs_scope: 'all' };
  const priorityOf = (rung: Awaited<ReturnType<typeof bells>>) =>
    new Map(rung.rows.flatMap((r) => r.recipients.map((x) => [x.recipient_id, x.priority] as const)));

  describe('lane 1 of a record conversation', () => {
    it('rings the holder of the mailbox it sits in, whoever took it over, the hand sender, the Sold By, the crew, the Dispatcher and the assignee, and nobody else', async () => {
      const w = await newOrg();
      const [soldBy, crew, dispatcher] = [await personWith(w.org), await personWith(w.org), await personWith(w.org)];
      const [leaver, taker, sender, assignee] = [
        await personWith(w.org, allJobs), await personWith(w.org, allJobs), await personWith(w.org, allJobs), await personWith(w.org, allJobs),
      ];
      const linked = await personWith(w.org, allJobs);
      await linkToMain(w, linked);
      const job = await fx.addJob(w.org, w.customer, { soldBy: soldBy.id, crew: [crew.id], dispatcher: dispatcher.id });
      // Sits in the leaver's mailbox, which the taker holds now.
      const box = await userMailbox(w.org, leaver, taker);
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id, mailbox: box, sentBy: sender.id, assignee: assignee.id });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.all).toEqual(sorted(soldBy, crew, dispatcher, taker, sender, assignee));
      expect(rung.all).not.toContain(leaver.id);
      expect(rung.all).not.toContain(linked.id);
      expect(rung.why).toEqual([]);
      // The people it is theirs to answer interrupt; the rest of the record's people are told on the feed.
      const priority = priorityOf(rung);
      for (const own of [taker, sender, assignee]) expect(priority.get(own.id), own.id).toBe('INTERRUPT');
      for (const other of [soldBy, crew, dispatcher]) expect(priority.get(other.id), other.id).toBe('FEED');
    });

    it('drops a member who is inactive, has no Access Communication or View communication, cannot open the job, or has a scope that reaches nothing', async () => {
      const w = await newOrg();
      const control = await personWith(w.org);
      const variants: Record<string, Who> = {
        inactive: await personWith(w.org),
        'no Access Communication': await personWith(w.org, withDependantsOff(['access_communication'])),
        'no View communication': await personWith(w.org, withDependantsOff(['view_communication'])),
        'cannot open jobs': await personWith(w.org, withDependantsOff(['view_jobs'])),
        'Team scope with no team': await personWith(w.org, { jobs_scope: 'team' }),
      };
      await db.user.update({ where: { id: variants.inactive!.id }, data: { is_active: false }, select: { id: true } });
      const job = await fx.addJob(w.org, w.customer, { crew: [control.id, ...Object.values(variants).map((v) => v.id)] });
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.all).toEqual(sorted(control));
      for (const [what, person] of Object.entries(variants)) expect(rung.all, what).not.toContain(person.id);
    });

    it('does not ring the hand sender once taken off the job, or one who cannot read the conversation, and rings the one who still can', async () => {
      const w = await newOrg();
      const still = await personWith(w.org, allJobs);
      const takenOff = await personWith(w.org);
      const cannot = await personWith(w.org, { ...allJobs, ...withDependantsOff(['access_communication']) });
      const job = await fx.addJob(w.org, w.customer, {});

      for (const [sender, rings] of [[still, true], [takenOff, false], [cannot, false]] as const) {
        const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id, sentBy: sender.id });
        const rung = await bells((await receive(convo)).providerId, w);
        // Nobody else is on the job, so when the sender cannot take it the fallback is the one that rings (the Admin box covers it).
        expect(rung.plain.includes(sender.id), sender.id).toBe(rings);
      }
    });

    it('rings a crew member who sent the mail being answered once, as the sender; and a crew member who did not send it, as crew', async () => {
      const w = await newOrg();
      const sender = await personWith(w.org);
      const other = await personWith(w.org);
      const job = await fx.addJob(w.org, w.customer, { crew: [sender.id, other.id] });
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id, sentBy: sender.id });

      const reply = await receive(convo);
      const rung = await bells(reply.providerId, w);

      expect(rung.all).toEqual(sorted(sender, other));
      expect(priorityOf(rung).get(sender.id)).toBe('INTERRUPT');
      expect(priorityOf(rung).get(other.id)).toBe('FEED');
      expect(await db.notificationRecipient.count({ where: { recipient_id: sender.id, notification: { dedup_key: { startsWith: `email_inbound:${reply.providerId}` } } } })).toBe(1);
    });

    it('takes the sender from the latest mail that went out, so a reply to an automated reminder after a hand-sent mail has no hand sender', async () => {
      const w = await newOrg();
      const sender = await personWith(w.org, allJobs);
      const crew = await personWith(w.org);
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id, sentBy: sender.id });
      // An automated mail went out after the hand-sent one: the reply answers that one.
      await db.email.create({
        data: {
          id: randomUUID(), organization_id: w.org, thread_id: convo.thread, customer_id: w.customer, account: 'system', direction: 'out',
          folder: 'sent', from: { name: null, email: 'office@example.com' }, to: 'angel@example.com', subject: 'Reminder', snippet: 's',
          body: ['b'], at: '2:00 PM', ts: BigInt(Date.now()),
        },
        select: { id: true },
      });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.all).toEqual(sorted(crew));
    });
  });

  // ─── The kind of record ────────────────────────────────────────────────────────────────────────────────────────────────

  describe('a conversation about each kind of record', () => {
    it('a lead\'s: rings its Owner, the crew of its walkthroughs and its Dispatcher, not an assignee of the lead', async () => {
      const w = await newOrg();
      const [owner, crew, dispatcher, assigned] = [await personWith(w.org), await personWith(w.org), await personWith(w.org), await personWith(w.org)];
      const lead = await fx.addLead(w.org, w.customer, { owner: owner.id, dispatcher: dispatcher.id, walkthroughCrew: [crew.id], assignees: [assigned.id] });
      const convo = await conversation(w, { record: { type: 'lead', id: lead.id }, lead: lead.id });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.all).toEqual(sorted(owner, crew, dispatcher));
    });

    it('an estimate\'s: rings the people of its job and the Owner of its lead, and never a person who cannot open the estimate', async () => {
      const w = await newOrg();
      const [soldBy, crew, creator, blind] = [await personWith(w.org), await personWith(w.org), await personWith(w.org), await personWith(w.org)];
      const [leadOwner, noView, creatorNoView] = [
        await personWith(w.org),
        await personWith(w.org, withDependantsOff(['view_estimates'])),
        await personWith(w.org, withDependantsOff(['view_estimates'])),
      ];
      const lead = await fx.addLead(w.org, w.customer, { owner: leadOwner.id });
      const job = await fx.addJob(w.org, w.customer, { soldBy: soldBy.id, crew: [crew.id, creator.id, blind.id, noView.id, creatorNoView.id] });
      const estimate = await fx.addEstimate(w.org, w.customer, creatorNoView.id, { jobId: job.id, leadId: lead.id });
      const convo = await conversation(w, { record: { type: 'estimate', id: estimate.id }, job: job.id });

      const rung = await bells((await receive(convo)).providerId, w);

      // View estimates off: not rung, except for the estimate's own creator while attached (the creator rule).
      expect(rung.all).toEqual(sorted(soldBy, crew, creator, blind, leadOwner, creatorNoView));
      expect(rung.all).not.toContain(noView.id);
    });

    it('an invoice\'s: rings the people of its job, and never a person who cannot open the invoice, except its attached creator', async () => {
      const w = await newOrg();
      const [soldBy, crew] = [await personWith(w.org), await personWith(w.org)];
      const [noView, creatorNoView] = [
        await personWith(w.org, withDependantsOff(['view_invoices'])),
        await personWith(w.org, withDependantsOff(['view_invoices'])),
      ];
      const job = await fx.addJob(w.org, w.customer, { soldBy: soldBy.id, crew: [crew.id, noView.id, creatorNoView.id] });
      const invoice = await fx.addInvoice(w.org, w.customer, { jobId: job.id, createdBy: creatorNoView.id });
      const convo = await conversation(w, { record: { type: 'invoice', id: invoice.id }, job: job.id });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.all).toEqual(sorted(soldBy, crew, creatorNoView));
      expect(rung.all).not.toContain(noView.id);
    });

    it('a deposit invoice with no job: rings the people of its estimate\'s job', async () => {
      const w = await newOrg();
      const crew = await personWith(w.org);
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: job.id });
      const invoice = await fx.addInvoice(w.org, w.customer, { estimateId: estimate.id });
      const convo = await conversation(w, { record: { type: 'invoice', id: invoice.id } });

      expect((await bells((await receive(convo)).providerId, w)).all).toEqual(sorted(crew));
    });
  });

  // ─── When lane 1 finds nobody ──────────────────────────────────────────────────────────────────────────────────────────

  describe('when lane 1 finds nobody', () => {
    const JOB_REASON = 'This job has no Dispatcher or Sold By who can take this reply';

    it('rings the people linked to the main mailbox who can read it, with the reason line, and nobody else it did not name', async () => {
      const w = await newOrg();
      const linked = await personWith(w.org, allJobs);
      const linkedBlind = await personWith(w.org);
      const manager = await personWith(w.org, { ...allJobs, view_users: true, manage_roles_and_permissions: true });
      await linkToMain(w, linked);
      await linkToMain(w, linkedBlind);
      const job = await fx.addJob(w.org, w.customer, {});
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.why).toEqual(sorted(linked));
      expect(rung.reason).toBe(JOB_REASON);
      expect(rung.all).not.toContain(linkedBlind.id);
      expect(rung.all, 'the Manage roles holders are only for when no linked person can take it').not.toContain(manager.id);
      // The Admin box holds Alert me about every job, so it has a copy, without the line.
      expect(rung.admin).toBe(true);
    });

    it('rings the holders of Manage roles and permissions who can read it, with the reason line, when nobody is linked', async () => {
      const w = await newOrg();
      const manager = await personWith(w.org, { ...allJobs, view_users: true, manage_roles_and_permissions: true });
      const managerBlind = await personWith(w.org, { view_users: true, manage_roles_and_permissions: true });
      const job = await fx.addJob(w.org, w.customer, {});
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.why).toEqual(sorted(manager));
      expect(rung.reason).toBe(JOB_REASON);
      // A holder who cannot read the conversation is told nothing about it: no alert without details.
      expect(rung.all).not.toContain(managerBlind.id);
      expect(await db.notificationRecipient.count({ where: { recipient_id: managerBlind.id } })).toBe(0);
    });

    it('says the same for a lead, and for a record with no job or lead', async () => {
      const w = await newOrg();
      const manager = await personWith(w.org, { leads_scope: 'all', invoices_scope: 'all', ...allJobs, view_users: true, manage_roles_and_permissions: true });
      const lead = await fx.addLead(w.org, w.customer, {});
      const customerOnly = await fx.addInvoice(w.org, w.customer, {});

      const onLead = await bells((await receive(await conversation(w, { record: { type: 'lead', id: lead.id }, lead: lead.id }))).providerId, w);
      expect(onLead.reason).toBe('This lead has no Dispatcher or Owner who can take this reply');
      expect(onLead.why).toEqual(sorted(manager));

      // The Admin box is a copy holder for an invoice, and a person who is covering and has a copy is told once, without the line.
      await db.user.update({ where: { id: w.admin.id }, data: { is_active: false }, select: { id: true } });
      const onInvoice = await bells((await receive(await conversation(w, { record: { type: 'invoice', id: customerOnly.id } }))).providerId, w);
      expect(onInvoice.reason).toBe('Nobody on this conversation\'s record can take this reply');
    });

    it('is logged when the chain ends with nobody, with the kind of alert, the conversation and the company, and nothing of the customer', async () => {
      const w = await newOrg();
      // The Admin box holds every switch and so is always a last resort; out of the way, nobody is left.
      await db.user.update({ where: { id: w.admin.id }, data: { is_active: false }, select: { id: true } });
      const job = await fx.addJob(w.org, w.customer, {});
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });
      const warn = vi.spyOn(logger, 'warn');
      try {
        const reply = await receive(convo);

        const lines = warn.mock.calls.filter(([line]) => String(line).includes('nobody to tell'));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toEqual([
          '[alertChain] customer email reply alert: nobody to tell',
          { alert: 'customer email reply alert', organizationId: w.org, recordType: 'EMAIL_THREAD', recordId: convo.thread },
        ]);
        expect(JSON.stringify(lines)).not.toMatch(/angel@|Sounds good|Your visit|Re: /);
        expect((await bells(reply.providerId, w)).rows).toEqual([]);
        expect(await db.notification.count({ where: { organization_id: w.org } })).toBe(0);
      } finally {
        warn.mockRestore();
      }
    });
  });

  // ─── Copies ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('copies to the holders of "Alert me about every ..."', () => {
    const kinds = [
      { kind: 'job', switch: 'alert_every_job' },
      { kind: 'lead', switch: 'alert_every_lead' },
      { kind: 'estimate', switch: 'alert_every_estimate' },
      { kind: 'invoice', switch: 'alert_every_invoice' },
    ] as const;

    it.each(kinds)('a reply on a $kind\'s conversation copies the holders of $switch who can read it, and no other kind\'s', async ({ kind }) => {
      const w = await newOrg();
      const everyScope = { jobs_scope: 'all', leads_scope: 'all', estimates_scope: 'all', invoices_scope: 'all' };
      const holders: Record<string, Who> = {};
      for (const k of kinds) holders[k.kind] = await personWith(w.org, { ...everyScope, [k.switch]: true });
      // Holds the matching switch, but a scope that reaches none of it: not copied.
      const cannotRead = await personWith(w.org, { [kinds.find((k) => k.kind === kind)!.switch]: true });
      const crew = await personWith(w.org);
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const lead = await fx.addLead(w.org, w.customer, { owner: crew.id });
      const estimate = await fx.addEstimate(w.org, w.customer, w.admin.id, { jobId: job.id });
      const invoice = await fx.addInvoice(w.org, w.customer, { jobId: job.id });
      const record = { job: job.id, lead: lead.id, estimate: estimate.id, invoice: invoice.id }[kind];
      const convo = await conversation(w, { record: { type: kind, id: record } });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.all).toEqual(sorted(crew, holders[kind]!));
      expect(rung.all).not.toContain(cannotRead.id);
    });

    it('copies even when lane 1 found nobody, and tells a person found both ways once, without the reason line', async () => {
      const w = await newOrg();
      const copy = await personWith(w.org, { ...allJobs, alert_every_job: true });
      const both = await personWith(w.org, { ...allJobs, alert_every_job: true, view_users: true, manage_roles_and_permissions: true });
      const job = await fx.addJob(w.org, w.customer, {});
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.plain).toEqual(sorted(copy, both));
      expect(rung.why).toEqual([]);
    });
  });

  // ─── A reply in an ordinary conversation ───────────────────────────────────────────────────────────────────────────────

  describe('a reply in an ordinary conversation', () => {
    it('rings its assignee, interrupting, and nobody else', async () => {
      const w = await newOrg();
      const assignee = await personWith(w.org);
      const holder = await personWith(w.org);
      const colleague = await personWith(w.org, { communication_scope: 'all' });
      const box = await userMailbox(w.org, holder);
      const convo = await conversation(w, { mailbox: box, assignee: assignee.id });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.all).toEqual(sorted(assignee));
      expect(rung.all).not.toContain(colleague.id);
      expect(priorityOf(rung).get(assignee.id)).toBe('INTERRUPT');
      // No record, so no "Alert me about every": the Admin box gets nothing either.
      expect(rung.admin).toBe(false);
    });

    it('opens the conversation itself from the bell: the mailbox it sits in and its thread, for the plain alert and the one with the reason line', async () => {
      const w = await newOrg();
      const holder = await personWith(w.org);
      const box = await userMailbox(w.org, holder);
      const convo = await conversation(w, { mailbox: box, assignee: holder.id });
      const nobodyLinked = await conversation(w, { mailbox: w.main });

      const rung = await bells((await receive(convo)).providerId, w);
      const linkOf = (r: Awaited<ReturnType<typeof bells>>) => r.rows.map((x) => (x.data as { link_path?: string }).link_path);
      expect(linkOf(rung)).toEqual([`/communication/inbox?mailbox=${box}&thread=${convo.thread}`]);

      // The holders of Manage roles and permissions told because nobody is linked are sent to the main mailbox's conversation.
      const covering = await bells((await receive(nobodyLinked)).providerId, w);
      expect(linkOf(covering)).toEqual([`/communication/inbox?mailbox=${w.main}&thread=${nobodyLinked.thread}`]);
    });

    it('rings its mailbox\'s holder when it has no assignee, or the assignee cannot take it', async () => {
      const w = await newOrg();
      const holder = await personWith(w.org);
      const leaver = await personWith(w.org);
      const gone = await personWith(w.org);
      await db.user.update({ where: { id: gone.id }, data: { is_active: false }, select: { id: true } });
      const box = await userMailbox(w.org, leaver, holder);

      const unassigned = await bells((await receive(await conversation(w, { mailbox: box }))).providerId, w);
      const assigneeGone = await bells((await receive(await conversation(w, { mailbox: box, assignee: gone.id }))).providerId, w);

      expect(unassigned.all).toEqual(sorted(holder));
      expect(assigneeGone.all).toEqual(sorted(holder));
    });

    it('in the main mailbox rings the people linked to it who can read it, and not the others', async () => {
      const w = await newOrg();
      const linked = await personWith(w.org);
      const linkedAway = await personWith(w.org);
      const manager = await personWith(w.org, { view_users: true, manage_roles_and_permissions: true });
      await linkToMain(w, linked);
      await linkToMain(w, linkedAway);
      await db.user.update({ where: { id: linkedAway.id }, data: { is_active: false }, select: { id: true } });
      // An ordinary conversation started in the main mailbox is listed to the people linked to it.
      const convo = await conversation(w, {});

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.plain).toEqual(sorted(linked));
      expect(rung.all).not.toContain(manager.id);
      expect(rung.reason).toBeNull();

      // With an assignee who can take it, the assignee is rung and the linked people are not.
      const assignee = await personWith(w.org);
      const assigned = await bells((await receive(await conversation(w, { assignee: assignee.id }))).providerId, w);
      expect(assigned.all).toEqual(sorted(assignee));
    });

    it('in the main mailbox rings the holders of Manage roles and permissions while nobody is linked, saying so', async () => {
      const w = await newOrg();
      const manager = await personWith(w.org, { view_users: true, manage_roles_and_permissions: true });
      const bystander = await personWith(w.org);

      const rung = await bells((await receive(await conversation(w, {}))).providerId, w);

      expect(rung.why).toEqual(sorted(manager));
      expect(rung.reason).toBe('Nobody is linked to the main mailbox');
      expect(rung.all).not.toContain(bystander.id);
    });

    it('is logged when the conversation is in a user mailbox nobody can take it from', async () => {
      const w = await newOrg();
      const holder = await personWith(w.org);
      await db.user.update({ where: { id: holder.id }, data: { is_active: false }, select: { id: true } });
      const box = await userMailbox(w.org, holder);
      const warn = vi.spyOn(logger, 'warn');
      try {
        const reply = await receive(await conversation(w, { mailbox: box }));
        expect(warn.mock.calls.filter(([line]) => String(line).includes('nobody to tell'))).toHaveLength(1);
        expect((await bells(reply.providerId, w)).rows).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  });

  // ─── Company, retries, plan feature ────────────────────────────────────────────────────────────────────────────────────

  describe('around the chain', () => {
    it('never rings a person of another company, even one named on the record', async () => {
      const mine = await newOrg();
      const theirs = await newOrg();
      const foreign = await personWith(theirs.org, allJobs);
      const crew = await personWith(mine.org);
      const job = await fx.addJob(mine.org, mine.customer, { soldBy: foreign.id, crew: [crew.id] });
      const convo = await conversation(mine, { record: { type: 'job', id: job.id }, job: job.id });

      const rung = await bells((await receive(convo)).providerId, mine);

      expect(rung.all).toEqual(sorted(crew));
      expect(await db.notificationRecipient.count({ where: { recipient_id: foreign.id } })).toBe(0);
    });

    it('rings nobody twice for a retried delivery: the same alerts, plain and with the reason line, are written once', async () => {
      const { alertEmailReply } = await import('../services/notifications/emailReplyAlerts.js');
      const w = await newOrg();
      const crew = await personWith(w.org);
      const manager = await personWith(w.org, { ...allJobs, view_users: true, manage_roles_and_permissions: true });
      const withCrew = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const withNobody = await fx.addJob(w.org, w.customer, {});

      for (const job of [withCrew, withNobody]) {
        const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });
        const reply = await receive(convo);
        const before = await db.notification.count({ where: { organization_id: w.org } });
        emitSpy.mockClear();
        const again = await alertEmailReply({
          organizationId: w.org, threadId: convo.thread, providerMessageId: reply.providerId, senderLabel: 'Angel', subject: 'Re: Your visit',
        });
        expect(again).toEqual([]);
        // Nothing was worked out for it: the alert is not even handed to the bell.
        expect(emitSpy).not.toHaveBeenCalled();
        expect(await db.notification.count({ where: { organization_id: w.org } })).toBe(before);
      }
      expect(await db.notificationRecipient.count({ where: { recipient_id: crew.id } })).toBe(1);
      expect(await db.notificationRecipient.count({ where: { recipient_id: manager.id } })).toBe(1);
      const keys = (await db.notification.findMany({ where: { organization_id: w.org }, select: { dedup_key: true } })).map((n) => n.dedup_key!);
      expect(keys.filter((k) => k.endsWith(':why'))).toHaveLength(1);
    });

    it('does nothing for a delivery the webhook already took (the same event twice)', async () => {
      const w = await newOrg();
      const crew = await personWith(w.org);
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });
      const reply = await receive(convo);
      const { processResendEvent } = await import('../controllers/resend-webhook.controller.js');
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      emitSpy.mockClear();

      await processResendEvent(
        `svix-${reply.providerId}-1`, { type: 'email.received', created_at: ARRIVED.toISOString(), data: { email_id: reply.providerId } } as never, res as never,
      );

      expect(emitSpy).not.toHaveBeenCalled();
      expect(await db.notificationRecipient.count({ where: { recipient_id: crew.id } })).toBe(1);
    });

    it('rings nobody and runs no chain, so logs nothing, while the Email plan feature is off', async () => {
      const { alertEmailReply } = await import('../services/notifications/emailReplyAlerts.js');
      const w = await newOrg();
      const crew = await personWith(w.org);
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });
      await db.organization.update({ where: { id: w.org }, data: { feature_overrides: { email: false } } });
      const warn = vi.spyOn(logger, 'warn');
      try {
        const reply = await receive(convo);
        const direct = await alertEmailReply({
          organizationId: w.org, threadId: convo.thread, providerMessageId: reply.providerId, senderLabel: 'Angel', subject: 'Re: Your visit',
        });

        expect(direct).toEqual([]);
        expect(emitSpy).not.toHaveBeenCalled();
        expect(await db.notification.count({ where: { organization_id: w.org } })).toBe(0);
        expect(warn.mock.calls.filter(([line]) => String(line).includes('nobody to tell'))).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });

    it('is a bell and nothing else: the alert carries no email, and names no outside service', async () => {
      const w = await newOrg();
      const crew = await personWith(w.org);
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });
      const outBefore = await db.email.count({ where: { organization_id: w.org, direction: 'out' } });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(await db.email.count({ where: { organization_id: w.org, direction: 'out' } })).toBe(outBefore);
      expect(JSON.stringify(rung.rows)).not.toMatch(/resend|supabase|render|ctm|stripe/i);
      expect(rung.rows[0]).toMatchObject({ title: 'New email — Angel <angel@example.com>', body: 'Re: Your visit' });
    });
  });
});
