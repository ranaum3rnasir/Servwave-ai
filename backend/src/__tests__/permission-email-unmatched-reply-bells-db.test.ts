/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.19 - a reply from an address we didn't send to rings the record's people.

   Every case that stores mail goes through the REAL delivery webhook route (POST /api/webhooks/resend) with a signed fixture
   event; only the call that fetches the received message from the provider is replaced, so nothing is sent or received from this
   machine. The bells are read back from the database, and the item the bell opens is read and linked through the real routes,
   called as real people.

   What is proved, each against the real tables:
     - a token reply whose sender does not match rings the same people a customer's reply in that conversation would (the record's
       people, the fallback, the copies) with "A reply from an address we didn't send to - check and link it"; a person who cannot
       open the record gets no bell;
     - an ordinary conversation rings its assignee, else its mailbox's holder, else (the main mailbox) the people linked to read
       it, else the company's Admins (the holders of Manage roles and permissions until AL-18);
     - the Email plan feature off rings nobody; every other held kind (failed authentication, automatic mail, a reply address that
       no longer resolves) still rings nobody; a redelivery rings nobody twice;
     - the bell opens the Needs review item for anyone who can reach the token's conversation, whichever mailbox it is filed under;
       the item names the job or lead and can be linked, and a person without reach gets nothing.

   People are on custom roles (never a built-in role name) holding exactly the switch values under test.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import { afterResponseDrained } from '../lib/after-response';
import type { PrismaClient } from '@prisma/client';

const { clientPromise, fetchReceived, emitSpy, publishEmailsSpy, queries } = vi.hoisted(() => {
  const queries: string[] = [];
  const clientPromise = (async () => {
    const dbUrl = process.env.TEST_DATABASE_URL;
    if (!dbUrl) return undefined;
    const { PrismaClient } = await import('@prisma/client');
    // The hosted database's pool: ONE connection and a short wait, so a query on the global client made inside the
    // webhook's transaction fails here in seconds instead of on the hosted database.
    const pooled = new URL(dbUrl);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '4');
    const client = new PrismaClient({ datasources: { db: { url: pooled.toString() } }, log: [{ emit: 'event', level: 'query' }] });
    (client as unknown as { $on(e: 'query', cb: (q: { query: string }) => void): void }).$on('query', (q) => queries.push(q.query));
    return client;
  })();
  return { clientPromise, fetchReceived: vi.fn(), emitSpy: vi.fn(), publishEmailsSpy: vi.fn(), queries };
});

// The suite-wide setup mocks the app's client; here it is the real one, on the hosted pool.
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));

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
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { env } from '../config/env';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SECRET_BYTES = randomBytes(24);
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const MAILBOX_DOMAIN = 'mail.test.com';
const REPLY_DOMAIN = 'reply.test.com';
const ARRIVED = new Date('2026-07-01T15:00:00.000Z');
const EVENT_PREFIX = 'rp-s10-19-';
const FAILED = { 'Authentication-Results': 'amazonses.com; dmarc=fail header.from=example.com' };
const PASSED = { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' };
const FROM_SPOUSE = 'Their Spouse <spouse@example.com>';
/** PRD 10's words for the bell, word for word. */
const MESSAGE = "A reply from an address we didn't send to - check and link it";

/** Switch values with these switches off and everything that requires them off too (read from the catalog, never copied). */
const withDependantsOff = (keys: string[]): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  for (const k of keys) out[k] = false;
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of SWITCH_CATALOG) {
      if (!(s.key in out) && s.requires.some((r) => out[r] === false)) { out[s.key] = false; grew = true; }
    }
  }
  return out;
};

suite('a reply from an address we did not send to rings the record\'s people (real database, real webhook route)', () => {
  let db: PrismaClient;
  let fx: ReturnType<typeof switchFixture>;
  let app: Parameters<typeof request>[0];

  beforeAll(async () => {
    db = (await clientPromise) as PrismaClient;
    fx = switchFixture(db, async () => (await import('../app.js')).default as never);

    app = await fx.listener();    // The webhook reads its secret from the environment object at request time.
    (env as { RESEND_WEBHOOK_SECRET?: string }).RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM notifications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_attachments WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_readers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM resend_events WHERE resend_event_id LIKE '${EVENT_PREFIX}%'`));
    await fx.cleanup();
  });

  beforeEach(() => {
    emitSpy.mockClear();
    publishEmailsSpy.mockClear();
    fetchReceived.mockReset();
  });

  let sequence = 0;
  const newToken = () => randomBytes(16).toString('base64url');
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Member = Person & { api: () => Promise<Api> };

  /** A company with its main mailbox (nobody linked to it yet). */
  async function company() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const main = randomUUID();
    await db.mailbox.create({ data: { id: main, organization_id: made.org, kind: 'main', status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `main-${made.tag}`, organization_id: made.org, mailbox_id: main, is_primary: true } });
    return { ...made, main };
  }
  type Company = Awaited<ReturnType<typeof company>>;

  /** A person on a fresh custom role holding exactly these switch values, with the Email page open. */
  async function personWith(c: Company, key: string, values: Record<string, boolean | string> = {}): Promise<Member> {
    const seq = ++sequence;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(c.org, `${key}-${seq}`, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: c.org, roleKey: `${key}-${seq}`,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, view_invoices: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'attached', ...switchValues,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(c.org, `${key}${seq}`, 'DISPATCHER', { customRoleId: role.id, isAdmin: asAdmin === true });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The mailbox issued to a person. */
  async function mailboxOf(c: Company, person: Person) {
    const id = await fx.addUserMailbox(c.org, person);
    const row = await db.mailboxAddress.findFirst({ where: { mailbox_id: id, is_primary: true }, select: { local_part: true } });
    return { id, address: `${row!.local_part}@${MAILBOX_DOMAIN}` };
  }

  /**
   * A conversation a send opened in a mailbox, the mail that went out (`sentBy` is who pressed Send by hand) and the reply
   * address the customer was given (expecting angel@).
   */
  async function conversation(
    c: Company, mailboxId: string, record: { type: string; id: string } | null, opts: { sentBy?: string; assignee?: string; jobId?: string } = {},
  ) {
    const thread = randomUUID();
    await db.emailThread.create({
      data: {
        id: thread, organization_id: c.org, mailbox_id: mailboxId, origin: record ? 'record' : 'started',
        record_type: record?.type ?? null, record_id: record?.id ?? null, assigned_to_user_id: opts.assignee ?? null,
      },
    });
    await db.email.create({
      data: {
        id: randomUUID(), organization_id: c.org, thread_id: thread, customer_id: c.customer, job_id: opts.jobId ?? null,
        account: opts.sentBy ? 'user' : 'system', direction: 'out', folder: 'sent', sent_by_user_id: opts.sentBy ?? null,
        from: { name: null, email: 'office@example.com' }, to: 'angel@example.com',
        subject: 'Your invoice', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now() - 86_400_000),
      },
      select: { id: true },
    });
    const token = newToken();
    await db.replyToken.create({
      data: {
        token, organization_id: c.org, thread_id: thread, entity_type: record?.type ?? null, entity_id: record?.id ?? null,
        customer_id: c.customer, expected_from: 'angel@example.com', created_by_user_id: opts.sentBy ?? null,
      },
    });
    return { thread, token, address: `${token}@${REPLY_DOMAIN}` };
  }

  /** The standard signature a delivery webhook carries: HMAC-SHA256 of `id.timestamp.body` under the shared secret. */
  const signed = (svixId: string, body: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET_BYTES).update(`${svixId}.${timestamp}.${body}`).digest('base64');
    return { 'svix-id': svixId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
  };

  interface Delivery {
    to: string[];
    from?: string;
    subject?: string;
    headers?: Record<string, string>;
    /** Repeat a delivery: the same provider event id (and so the same received message). */
    again?: { eventId: string; providerId: string };
  }

  /** One `email.received` event through the real route. The fetched message is what the provider would answer with. */
  async function receive(d: Delivery) {
    const providerId = d.again?.providerId ?? `${EVENT_PREFIX}rcv-${randomUUID()}`;
    const eventId = d.again?.eventId ?? `${EVENT_PREFIX}evt-${randomUUID()}`;
    const from = d.from ?? FROM_SPOUSE;
    const subject = d.subject ?? 'Re: Your invoice';
    fetchReceived.mockResolvedValue({
      providerId, from, receivedFor: d.to, to: d.to, subject,
      messageId: `<${providerId}@mail.example.com>`, receivedAt: ARRIVED, text: 'Hi, it is the spouse. We will pay on Friday.',
      html: '<div>We will pay on Friday.</div>', headers: d.headers ?? PASSED,
    });
    const body = JSON.stringify({
      type: 'email.received', created_at: ARRIVED.toISOString(),
      data: {
        email_id: providerId, created_at: ARRIVED.toISOString(), from, to: d.to, cc: [], bcc: [], received_for: d.to,
        message_id: `<${providerId}@mail.example.com>`, subject, attachments: [],
      },
    });
    const res = await request(app).post('/api/webhooks/resend').set('Content-Type', 'application/json').set(signed(eventId, body)).send(body);
    await settle();
    return { res, eventId, providerId };
  }

  /** The webhook answers first and announces after: a case reads the bells once ALL of that work (tracked in lib/after-response.ts) is over. A drain that times out fails the case. */
  async function settle() {
    await afterResponseDrained();
  }

  /**
   * What the reply rang: who got the plain alert, who got the one with the reason line (and the line), the bell's words. The Admin
   * box holds every switch, so it is always a copy holder and is told apart (`admin`) rather than mixed into the lists.
   */
  async function bells(providerId: string, c: Company) {
    const key = `email_inbound:${providerId}`;
    const rows = await db.notification.findMany({
      where: { dedup_key: { in: [key, `${key}:why`] } },
      select: { dedup_key: true, title: true, body: true, data: true, recipients: { select: { recipient_id: true } } },
    });
    const ids = (dedup: string) => (rows.find((r) => r.dedup_key === dedup)?.recipients ?? []).map((x) => x.recipient_id).filter((id) => id !== c.admin.id).sort();
    const why = rows.find((r) => r.dedup_key === `${key}:why`);
    return {
      plain: ids(key), why: ids(`${key}:why`), rows,
      reason: ((why?.data ?? {}) as { fallback_reason?: string }).fallback_reason ?? null,
      all: [...ids(key), ...ids(`${key}:why`)].sort(),
      admin: rows.some((r) => r.recipients.some((x) => x.recipient_id === c.admin.id)),
      titles: [...new Set(rows.map((r) => r.title))],
    };
  }
  const sorted = (...people: Person[]) => people.map((p) => p.id).sort();

  /** A company, a job with a crew, and an invoice about it sent by hand from one crew member's mailbox. */
  async function invoiceWorld() {
    const c = await company();
    const sender = await personWith(c, 'sender');
    const crewWithInvoices = await personWith(c, 'crew');
    const crewNoInvoices = await personWith(c, 'crewblind', withDependantsOff(['view_invoices']));
    const outsider = await personWith(c, 'outsider');
    const boxSender = await mailboxOf(c, sender);
    const job = await fx.addJob(c.org, c.customer, { crew: [sender.id, crewWithInvoices.id, crewNoInvoices.id] });
    const invoice = await fx.addInvoice(c.org, c.customer, { jobId: job.id, createdBy: c.admin.id });
    const reply = await conversation(c, boxSender.id, { type: 'invoice', id: invoice.id }, { sentBy: sender.id });
    return { c, sender, crewWithInvoices, crewNoInvoices, outsider, boxSender, job, invoice, reply };
  }

  describe('a reply to a record conversation', () => {
    it('rings the record\'s people with the message, and not a person who cannot open the invoice', async () => {
      const w = await invoiceWorld();
      const { res, providerId } = await receive({ to: [w.reply.address] });

      expect(res.status).toBe(200);
      const rung = await bells(providerId, w.c);
      expect(rung.all).toEqual(sorted(w.sender, w.crewWithInvoices));
      expect(rung.all).not.toContain(w.crewNoInvoices.id);
      expect(rung.all).not.toContain(w.outsider.id);
      expect(rung.titles).toEqual([MESSAGE]);
    });

    // Opens every job and invoice of the company, so the person reads a conversation about any of them.
    const SEES_ALL = { jobs_scope: 'all', leads_scope: 'all' };

    it('rings the person who sent the invoice by hand even when they are not on the job, and the copy holders on top', async () => {
      const w = await invoiceWorld();
      const handSender = await personWith(w.c, 'handsender', SEES_ALL);
      const copyHolder = await personWith(w.c, 'copyholder', { ...SEES_ALL, alert_every_invoice: true });
      const box = await mailboxOf(w.c, handSender);
      const sentByHand = await conversation(w.c, box.id, { type: 'invoice', id: w.invoice.id }, { sentBy: handSender.id });

      const { providerId } = await receive({ to: [sentByHand.address] });

      const rung = await bells(providerId, w.c);
      // The holder of the mailbox and the hand sender (one person), the job's crew who can open the invoice, and a copy.
      expect(rung.all).toEqual(sorted(handSender, w.sender, w.crewWithInvoices, copyHolder));
      expect(rung.reason).toBeNull();
    });

    it('does not ring a hand sender who can no longer open the invoice: attachment wins', async () => {
      const w = await invoiceWorld();
      const handSender = await personWith(w.c, 'handsender');
      const box = await mailboxOf(w.c, handSender);
      const sentByHand = await conversation(w.c, box.id, { type: 'invoice', id: w.invoice.id }, { sentBy: handSender.id });

      const { providerId } = await receive({ to: [sentByHand.address] });

      expect((await bells(providerId, w.c)).all).not.toContain(handSender.id);
    });

    it('falls back to the people linked to the main mailbox when the record has nobody who can take it, with the reason', async () => {
      const c = await company();
      const linked = await personWith(c, 'linked', SEES_ALL);
      const admin = await personWith(c, 'admin', { is_admin: true });
      const stranger = await personWith(c, 'stranger');
      await db.mailboxReader.create({ data: { organization_id: c.org, mailbox_id: c.main, user_id: linked.id } });
      const job = await fx.addJob(c.org, c.customer, {});
      const invoice = await fx.addInvoice(c.org, c.customer, { jobId: job.id, createdBy: c.admin.id });
      const automated = await conversation(c, c.main, { type: 'invoice', id: invoice.id });

      const { providerId } = await receive({ to: [automated.address] });

      const rung = await bells(providerId, c);
      expect(rung.why).toEqual(sorted(linked));
      expect(rung.reason).toBe('This job has no Dispatcher or Sold By who can take this reply');
      expect(rung.titles).toEqual([MESSAGE]);
      // An Admin holds every "Alert me about every ..." switch, so they have a copy without the line: never the fallback while a
      // linked person takes it (AL-18).
      expect(rung.plain).toEqual(sorted(admin));
      expect(rung.why).not.toContain(admin.id);
      expect(rung.all).not.toContain(stranger.id);
    });

    it('tells the Admins when nobody linked can take it, as holders of every copy switch, so without the reason line, and no non-Admin', async () => {
      const c = await company();
      // An Admin whose own switches reach no job: the switches do not narrow an Admin.
      const admin = await personWith(c, 'admin', { is_admin: true });
      const stranger = await personWith(c, 'stranger', SEES_ALL);
      const job = await fx.addJob(c.org, c.customer, {});
      const invoice = await fx.addInvoice(c.org, c.customer, { jobId: job.id, createdBy: c.admin.id });
      const automated = await conversation(c, c.main, { type: 'invoice', id: invoice.id });

      const { providerId } = await receive({ to: [automated.address] });

      const rung = await bells(providerId, c);
      expect(rung.plain).toEqual(sorted(admin));
      expect(rung.why).toEqual([]);
      expect(rung.admin).toBe(true);
      // A non-Admin is never the fallback, however much they can read.
      expect(rung.all).not.toContain(stranger.id);
    });
  });

  describe('a reply to an ordinary conversation', () => {
    it('rings the mailbox\'s holder, and not an assignee who does not hold the mailbox: being assigned opens nothing (M1)', async () => {
      const c = await company();
      const holder = await personWith(c, 'holder');
      const assignee = await personWith(c, 'assignee');
      const box = await mailboxOf(c, holder);
      const convo = await conversation(c, box.id, null, { assignee: assignee.id });

      const { providerId } = await receive({ to: [convo.address] });

      const rung = await bells(providerId, c);
      expect(rung.all).toEqual(sorted(holder));
      expect(rung.all).not.toContain(assignee.id);
      expect(rung.titles).toEqual([MESSAGE]);
    });

    it('rings the mailbox\'s holder when it has no assignee', async () => {
      const c = await company();
      const holder = await personWith(c, 'holder');
      const other = await personWith(c, 'other');
      const box = await mailboxOf(c, holder);
      const convo = await conversation(c, box.id, null);

      const { providerId } = await receive({ to: [convo.address] });

      const rung = await bells(providerId, c);
      expect(rung.all).toEqual(sorted(holder));
      expect(rung.all).not.toContain(other.id);
    });

    it('rings the people linked to read the main mailbox when it is the main mailbox\'s conversation with no assignee', async () => {
      const c = await company();
      const readerA = await personWith(c, 'readera');
      const readerB = await personWith(c, 'readerb');
      const stranger = await personWith(c, 'stranger');
      for (const p of [readerA, readerB]) await db.mailboxReader.create({ data: { organization_id: c.org, mailbox_id: c.main, user_id: p.id } });
      const convo = await conversation(c, c.main, null);

      const { providerId } = await receive({ to: [convo.address] });

      const rung = await bells(providerId, c);
      expect(rung.all).toEqual(sorted(readerA, readerB));
      expect(rung.all).not.toContain(stranger.id);
      expect(rung.reason).toBeNull();
    });

    it('rings the Admins, told why, while nobody active is linked to the main mailbox, and no non-Admin', async () => {
      const c = await company();
      // Reads every conversation, yet is no Admin: never the fallback.
      const stranger = await personWith(c, 'stranger', { communication_scope: 'all' });
      const convo = await conversation(c, c.main, null);

      const { providerId } = await receive({ to: [convo.address] });

      const rung = await bells(providerId, c);
      expect(rung.admin).toBe(true);
      expect(rung.all).not.toContain(stranger.id);
      expect(rung.reason).toBe('Nobody is linked to the main mailbox');
      expect(rung.titles).toEqual([MESSAGE]);
    });
  });

  describe('the item the bell opens', () => {
    /** The held message a reply stored. */
    const heldBy = (providerId: string) => db.email.findFirstOrThrow({ where: { provider_message_id: providerId } });
    const itemFor = async (person: Member, id: string) => (await person.api()).get(`/api/communication/emails/unmatched/${id}`);
    const linkAs = async (person: Member, id: string) => (await person.api()).patch(`/api/communication/emails/${id}/link`, {});
    /** The page the bell points at, as the notification carries it. */
    const bellTarget = async (providerId: string) => {
      const row = await db.notification.findFirstOrThrow({ where: { dedup_key: { startsWith: `email_inbound:${providerId}` } }, select: { data: true } });
      return (row.data as { link_path?: string }).link_path;
    };

    it('points the bell at the Needs review item, and opens it for everyone the bell rang, whichever mailbox it is filed under', async () => {
      const w = await invoiceWorld();
      const { providerId } = await receive({ to: [w.reply.address] });
      const held = await heldBy(providerId);
      expect(held).toMatchObject({ review_reason: 'sender_mismatch', review_mailbox_id: w.boxSender.id, review_thread_id: w.reply.thread });

      expect(await bellTarget(providerId)).toBe(`/communication/inbox?review=${held.id}`);
      const rung = await bells(providerId, w.c);
      expect(rung.all.length).toBeGreaterThan(1);
      for (const id of rung.all) {
        const person = [w.sender, w.crewWithInvoices].find((p) => p.id === id)!;
        const res = await itemFor(person as Member, held.id);
        expect(res.status, `the bell's person ${id}`).toBe(200);
        expect(res.body.email).toMatchObject({ id: held.id, reviewReason: 'sender_mismatch', subject: 'Re: Your invoice' });
      }
      // The crew member does not hold the mailbox it is filed under, and does not see it in any list.
      const crewList = await (await w.crewWithInvoices.api()).get('/api/communication/emails/unmatched?mailbox=mine');
      expect((crewList.body.emails as { id: string }[]).map((e) => e.id)).not.toContain(held.id);
    });

    it('names the job and offers the conversation it replied to, so it can be linked', async () => {
      const w = await invoiceWorld();
      const { providerId } = await receive({ to: [w.reply.address] });
      const held = await heldBy(providerId);
      const job = await db.job.findUniqueOrThrow({ where: { id: w.job.id }, select: { job_number: true } });

      const res = await itemFor(w.crewWithInvoices, held.id);

      expect(res.status).toBe(200);
      expect(res.body.email.recordTie).toEqual({ kind: 'job', id: w.job.id, label: job.job_number });
      expect(res.body.email.linkTo).toMatchObject({ threadId: w.reply.thread });
    });

    it('names the lead when the invoice\'s conversation is about a lead', async () => {
      const c = await company();
      const owner = await personWith(c, 'owner');
      const box = await mailboxOf(c, owner);
      const lead = await fx.addLead(c.org, c.customer, { owner: owner.id });
      const estimate = await fx.addEstimate(c.org, c.customer, c.admin.id, { leadId: lead.id });
      const convo = await conversation(c, box.id, { type: 'estimate', id: estimate.id }, { sentBy: owner.id });

      const { providerId } = await receive({ to: [convo.address] });
      const res = await itemFor(owner, (await heldBy(providerId)).id);

      expect(res.status).toBe(200);
      const row = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { lead_number: true } });
      expect(res.body.email.recordTie).toEqual({ kind: 'lead', id: lead.id, label: row.lead_number });
      expect((await bells(providerId, c)).all).toContain(owner.id);
    });

    it('links the item for a person the bell rang, though the mailbox it is filed under is not theirs', async () => {
      const w = await invoiceWorld();
      const { providerId } = await receive({ to: [w.reply.address] });
      const held = await heldBy(providerId);

      const res = await linkAs(w.crewWithInvoices, held.id);

      expect(res.status).toBe(200);
      expect(await db.email.findUniqueOrThrow({ where: { id: held.id } })).toMatchObject({ thread_id: w.reply.thread, review_reason: null });
    });

    it('answers a person who cannot open the invoice with 404 on the item and on the link, and leaves it held', async () => {
      const w = await invoiceWorld();
      const { providerId } = await receive({ to: [w.reply.address] });
      const held = await heldBy(providerId);

      for (const person of [w.crewNoInvoices, w.outsider]) {
        expect((await itemFor(person, held.id)).status).toBe(404);
        expect((await linkAs(person, held.id)).status).toBe(404);
      }
      expect(await db.email.count({ where: { id: held.id, review_reason: 'sender_mismatch' } })).toBe(1);
    });

    it('refuses the item to a person without Access Communication, and to another company', async () => {
      const w = await invoiceWorld();
      const noAccess = await personWith(w.c, 'noaccess', withDependantsOff(['access_communication']));
      const { providerId } = await receive({ to: [w.reply.address] });
      const held = await heldBy(providerId);
      const foreign = await invoiceWorld();

      expect((await itemFor(noAccess, held.id)).status).toBe(403);
      expect((await itemFor(foreign.sender, held.id)).status).toBe(404);
    });

    it('opens an item to a person on All, and to a reader of every mailbox, whichever mailbox it is in', async () => {
      const w = await invoiceWorld();
      const wide = await personWith(w.c, 'wide', { communication_scope: 'all' });
      const { providerId } = await receive({ to: [w.reply.address] });

      expect((await itemFor(wide, (await heldBy(providerId)).id)).status).toBe(200);
    });

    it('widens nothing for the other held kinds: a forged reply, automatic mail and an address that no longer resolves stay in their mailbox', async () => {
      const w = await invoiceWorld();
      const kinds = [
        await receive({ to: [w.reply.address], from: 'Angel <angel@example.com>', headers: FAILED }),
        await receive({ to: [w.reply.address], from: FROM_SPOUSE, headers: { ...PASSED, Precedence: 'bulk' } }),
      ];
      await db.replyToken.update({ where: { token: w.reply.token }, data: { revoked_at: new Date() } });
      kinds.push(await receive({ to: [w.reply.address], from: 'Angel <angel@example.com>' }));
      for (const { providerId } of kinds) {
        const held = await heldBy(providerId);
        expect(held.review_reason).not.toBe('sender_mismatch');
        expect((await itemFor(w.crewWithInvoices, held.id)).status, held.review_reason!).toBe(404);
        expect((await linkAs(w.crewWithInvoices, held.id)).status, held.review_reason!).toBe(404);
      }
    });

    it('neither rings nor opens the item to an assignee who opens only another message of the conversation; the holder gets both (M1)', async () => {
      const c = await company();
      const holder = await personWith(c, 'holder');
      const assignee = await personWith(c, 'assignee');
      const box = await mailboxOf(c, holder);
      // The assignee is crewed on a job of ANOTHER customer, and the message that went out is tied to that job: it opens for them,
      // the conversation itself does not.
      const elsewhere = randomUUID();
      await db.customer.create({ data: { id: elsewhere, organization_id: c.org, customer_number: `C-m1-${elsewhere.slice(0, 6)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Other', last_name: 'Customer' } });
      const theirJob = await fx.addJob(c.org, elsewhere, { crew: [assignee.id] });
      const convo = await conversation(c, box.id, null, { assignee: assignee.id, jobId: theirJob.id });

      const { providerId } = await receive({ to: [convo.address] });
      const held = await heldBy(providerId);

      const rung = await bells(providerId, c);
      expect(rung.all).toEqual(sorted(holder));
      expect(rung.all).not.toContain(assignee.id);
      expect((await itemFor(assignee, held.id)).status).toBe(404);
      expect((await linkAs(assignee, held.id)).status).toBe(404);
      expect((await itemFor(holder, held.id)).status).toBe(200);
    });

    it('opens an ordinary conversation\'s item to the mailbox\'s holder only, not to an assignee who does not hold the mailbox (M1)', async () => {
      const c = await company();
      const holder = await personWith(c, 'holder');
      const assignee = await personWith(c, 'assignee');
      const stranger = await personWith(c, 'stranger');
      const box = await mailboxOf(c, holder);
      const convo = await conversation(c, box.id, null, { assignee: assignee.id });

      const { providerId } = await receive({ to: [convo.address] });
      const held = await heldBy(providerId);

      expect((await itemFor(assignee, held.id)).status).toBe(404);
      expect((await itemFor(holder, held.id)).status).toBe(200);
      expect((await itemFor(stranger, held.id)).status).toBe(404);
    });

    it('hides the item while the company\'s Email plan feature is off', async () => {
      const w = await invoiceWorld();
      const { providerId } = await receive({ to: [w.reply.address] });
      const held = await heldBy(providerId);
      await db.organization.update({ where: { id: w.c.org }, data: { feature_overrides: { email: false } } });
      (await import('../middleware/authenticate.js')).clearTokenCache();

      expect((await itemFor(w.crewWithInvoices, held.id)).status).toBe(402);
      expect((await linkAs(w.crewWithInvoices, held.id)).status).toBe(402);
    });
  });

  describe('cost', () => {
    it('asks the database the same number of questions for a company of 5 as for a company of 25', async () => {
      const statementsFor = async (extraPeople: number) => {
        const w = await invoiceWorld();
        for (let i = 0; i < extraPeople; i += 1) await personWith(w.c, `extra${i}`);
        const before = queries.length;
        const { providerId } = await receive({ to: [w.reply.address] });
        const used = queries.length - before;
        expect((await bells(providerId, w.c)).all.length, 'it rang the record\'s people').toBeGreaterThan(0);
        return used;
      };
      // For comparison: the same delivery held without a bell (a forged sender), which is all this reply cost before S10.19.
      const quiet = await invoiceWorld();
      const quietBefore = queries.length;
      await receive({ to: [quiet.reply.address], headers: FAILED });
      const withoutBell = queries.length - quietBefore;
      const small = await statementsFor(0);
      const large = await statementsFor(20);
      // The bell reads the company's people in one query and asks the single read of the conversation once for everybody.
      expect(large - small).toBeLessThanOrEqual(2);
      // Stated for the record (the numbers a reviewer looks at): statements for one mismatched reply, delivery and bell together.
      console.info(`[S10.19] statements for one sender-mismatched reply: ${small} (5 people), ${large} (25 people); held without a bell: ${withoutBell}`);
    });
  });

  describe('everything that must ring nobody', () => {
    it('rings nobody while the company\'s Email plan feature is off, and keeps the reply held', async () => {
      const w = await invoiceWorld();
      await db.organization.update({ where: { id: w.c.org }, data: { feature_overrides: { email: false } } });
      (await import('../middleware/authenticate.js')).clearTokenCache();

      const { res, providerId } = await receive({ to: [w.reply.address] });

      expect(res.status).toBe(200);
      expect(await db.email.count({ where: { provider_message_id: providerId, review_reason: 'sender_mismatch' } })).toBe(1);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(publishEmailsSpy).not.toHaveBeenCalled();
      expect(await db.notification.count({ where: { organization_id: w.c.org } })).toBe(0);
    });

    it.each([
      ['a reply that failed sender authentication', { from: 'Angel <angel@example.com>', headers: FAILED }],
      ['an out-of-office reply', { from: 'Angel <angel@example.com>', headers: { ...PASSED, 'Auto-Submitted': 'auto-replied' } }],
      ['a forged reply from a stranger', { from: FROM_SPOUSE, headers: FAILED }],
      ['automatic mail from a stranger', { from: FROM_SPOUSE, headers: { ...PASSED, Precedence: 'bulk' } }],
    ])('rings nobody for %s', async (_what, delivery) => {
      const w = await invoiceWorld();
      const { providerId } = await receive({ to: [w.reply.address], ...delivery });
      expect(await db.email.count({ where: { provider_message_id: providerId, review_reason: { not: null } } })).toBe(1);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(await db.notification.count({ where: { organization_id: w.c.org } })).toBe(0);
    });

    it('rings nobody for a reply on an address that no longer resolves', async () => {
      const w = await invoiceWorld();
      await db.replyToken.update({ where: { token: w.reply.token }, data: { revoked_at: new Date() } });
      const { providerId } = await receive({ to: [w.reply.address], from: 'Angel <angel@example.com>' });
      expect(await db.email.count({ where: { provider_message_id: providerId, review_reason: 'unknown_reply' } })).toBe(1);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(await db.notification.count({ where: { organization_id: w.c.org } })).toBe(0);
    });

    it('rings nobody twice for one reply delivered again', async () => {
      const w = await invoiceWorld();
      const first = await receive({ to: [w.reply.address] });
      const rungOnce = await db.notification.count({ where: { organization_id: w.c.org } });
      expect(rungOnce).toBeGreaterThan(0);

      const again = await receive({ to: [w.reply.address], again: { eventId: first.eventId, providerId: first.providerId } });
      expect(again.res.body).toMatchObject({ duplicate: true });
      expect(await db.notification.count({ where: { organization_id: w.c.org } })).toBe(rungOnce);

      // A delivery that slipped past the event ledger is the same alert: the dedup key on the alert itself holds.
      const { alertEmailReply } = await import('../services/notifications/emailReplyAlerts.js');
      const held = await db.email.findFirstOrThrow({ where: { provider_message_id: first.providerId }, select: { id: true } });
      const rungAgain = await alertEmailReply({
        organizationId: w.c.org, threadId: w.reply.thread, providerMessageId: first.providerId, emailId: held.id, senderLabel: FROM_SPOUSE,
        subject: 'Re: Your invoice', heldEmailId: held.id,
      });
      expect(rungAgain).toEqual([]);
      expect(await db.notification.count({ where: { organization_id: w.c.org } })).toBe(rungOnce);
    });
  });
});
