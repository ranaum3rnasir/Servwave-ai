/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.15 - mail to the company's MAIN address, and who it rings.

   Every case goes through the REAL delivery webhook route (POST /api/webhooks/resend) with a signed fixture event, and the
   reply cases through the REAL reply route (POST /api/communication/emails); only the call that fetches the received message
   from the provider is replaced (and the suite-wide stub of the outgoing dispatcher stays), so nothing is sent or received
   from this machine. The after-commit announce is real (the bell and the live-update ping are watched, never stopped).

   What is proved, each against the real tables:
     - a fresh message to the main address starts a NEW conversation in the main mailbox (origin "started", no assignee),
       listed to the people who read the main mailbox and to nobody else on a narrower scope;
     - it rings the people LINKED to the main mailbox, never everyone on Communication scope All, never a customer-level
       person (the job's Sold By, crew, Dispatcher); while nobody ACTIVE is linked it rings the holders of Manage roles and
       permissions, saying "Nobody is linked to the main mailbox";
     - a customer's reply to an email sent before the release without a reply address, and fresh mail from a known customer
       tied to no record, are both exactly that: a new main-mailbox conversation, never the customer's open conversation;
     - the first person to reply takes the conversation; the customer's answer to that reply then rings that person alone;
     - the Email plan feature off: stored, hidden, rings nobody; a redelivery rings nobody twice; a sender failing
       authentication is stored and rings nobody;
     - the whole route runs on a ONE-connection pool (the hosted database's), and the work does not grow with the number of
       people linked.

   People are on custom roles (never a built-in role name) holding exactly the switch values under test. The company's
   Admin box is always in the company: it holds every switch and so is both an Admin (the last fallback) and a
   person on Communication scope All, which is exactly the "not linked, not rung" person of the rule.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import { afterResponseDrained } from '../lib/after-response';
import type { PrismaClient, Role } from '@prisma/client';

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
import { clearTokenCache } from '../middleware/authenticate';
import { env } from '../config/env';
import { NOBODY_LINKED_REASON } from '../services/notifications/emailReplyAlerts';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { sendComposedEmail } from '../lib/email';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SECRET_BYTES = randomBytes(24);
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const MAILBOX_DOMAIN = 'mail.test.com';
const ARRIVED = new Date('2026-07-01T15:00:00.000Z');
const EVENT_PREFIX = 'rp-s10-15-';

suite('mail to the main address and who it rings (real database, real webhook and reply routes)', () => {
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
    // The suite-wide stub of the outgoing dispatcher answers with one fixed provider id; every send is its own message here.
    vi.mocked(sendComposedEmail).mockImplementation(async () => ({
      status: 'sent', providerMessageId: `re_${randomUUID()}`, fromAddress: 'someone@mail.test.com', fromName: null,
    }));
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;

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

  /** A person on a fresh custom role holding exactly these switch values, with the Email page open and a mailbox of their own. */
  async function personWith(org: string, values: Record<string, boolean | string> = {}, base: Role = 'DISPATCHER'): Promise<Who> {
    const key = `mm-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, view_invoices: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'attached',
        contact_customers: true,
        ...switchValues,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /**
   * A company with its main mailbox and main address, a customer who writes from a known address and has a conversation open
   * about an estimate on a job, and the job's customer-level people (Sold By, crew, Dispatcher). Nobody is linked yet.
   */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, tag, customer, admin } = made;

    const main = randomUUID();
    await db.mailbox.create({ data: { id: main, organization_id: org, kind: 'main', status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `main-${tag}`, organization_id: org, mailbox_id: main, is_primary: true } });

    const customerEmail = `pat-${tag}@example.com`;
    await db.customer.update({ where: { id: customer }, data: { email: customerEmail } });
    const seller = await personWith(org);
    const crew = await personWith(org);
    const dispatcher = await personWith(org);
    const job = await fx.addJob(org, customer, { soldBy: seller.id, crew: [crew.id], dispatcher: dispatcher.id });
    const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
    const openThread = randomUUID();
    await db.emailThread.create({
      data: { id: openThread, organization_id: org, mailbox_id: main, origin: 'record', record_type: 'estimate', record_id: estimate.id },
    });
    await db.email.create({
      data: {
        id: randomUUID(), organization_id: org, thread_id: openThread, customer_id: customer, job_id: job.id,
        account: 'system', direction: 'out', folder: 'sent', from: { name: null, email: 'office@example.com' }, to: customerEmail,
        subject: 'Your estimate', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now() - 86_400_000),
      },
      select: { id: true },
    });

    return {
      org, tag, customer, admin, main, mainAddress: `main-${tag}@${MAILBOX_DOMAIN}`, customerEmail, job, openThread,
      seller, crew, dispatcher,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** A person on the Sender Address page's "People who read the main mailbox", with a mailbox of their own to write from. */
  async function linkedPerson(w: World, values: Record<string, boolean | string> = {}): Promise<Who> {
    const person = await personWith(w.org, values);
    await fx.addUserMailbox(w.org, person);
    await db.mailboxReader.create({ data: { organization_id: w.org, mailbox_id: w.main, user_id: person.id } });
    return person;
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
    again?: { eventId: string; providerId: string };
    headers?: Record<string, string>;
  }

  /** One `email.received` event through the real route. The fetched message is what the provider would answer with. */
  async function receive(d: Delivery) {
    const providerId = d.again?.providerId ?? `${EVENT_PREFIX}rcv-${randomUUID()}`;
    const eventId = d.again?.eventId ?? `${EVENT_PREFIX}evt-${randomUUID()}`;
    const from = d.from ?? 'Pat Payer <pat@example.com>';
    const subject = d.subject ?? 'Quick question';
    fetchReceived.mockResolvedValue({
      providerId, from, receivedFor: d.to, to: d.to, subject,
      messageId: `<${providerId}@mail.example.com>`, receivedAt: ARRIVED, text: 'Are you open on Saturday?',
      html: '<div>Are you open on Saturday?</div>',
      headers: d.headers ?? { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' },
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

  /** The mail from the customer's known address to the company address. */
  const fromCustomer = (w: World, subject: string): Delivery => ({
    to: [w.mainAddress], from: `Pat Payer <${w.customerEmail}>`, subject,
  });

  const storedCopy = async (providerId: string) => {
    const [row, ...rest] = await db.email.findMany({ where: { provider_message_id: { startsWith: providerId } } });
    expect(rest).toEqual([]);
    return row!;
  };
  const threadOf = (row: { thread_id: string | null }) => db.emailThread.findUniqueOrThrow({ where: { id: row.thread_id! } });

  /** Who the mail rang: the plain alert, the alert with the reason line, and the line. */
  async function bells(providerId: string) {
    const key = `email_inbound:${providerId}`;
    const rows = await db.notification.findMany({
      where: { dedup_key: { in: [key, `${key}:why`] } },
      select: { dedup_key: true, data: true, recipients: { select: { recipient_id: true } } },
    });
    const idsOf = (dedup: string) => rows.filter((r) => r.dedup_key === dedup).flatMap((r) => r.recipients.map((x) => x.recipient_id)).sort();
    const why = rows.find((r) => r.dedup_key === `${key}:why`);
    return {
      plain: idsOf(key), why: idsOf(`${key}:why`), all: [...idsOf(key), ...idsOf(`${key}:why`)].sort(),
      reason: ((why?.data ?? {}) as { fallback_reason?: string }).fallback_reason ?? null,
    };
  }
  const ids = (...people: Person[]) => people.map((p) => p.id).sort();

  const listedIds = async (person: Person, query: string) => {
    const res = await (await fx.signedInAs(person)).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };

  describe('a fresh message to the main address', () => {
    it('starts a new conversation in the main mailbox, owned by nobody, and acknowledges the delivery', async () => {
      const w = await world();
      const { res, providerId } = await receive({ to: [w.mainAddress] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      const row = await storedCopy(providerId);
      expect(row).toMatchObject({
        organization_id: w.org, direction: 'in', folder: 'inbox', to: w.mainAddress, inbound_match: 'MATCHED', reply_token: null,
      });
      expect(await threadOf(row)).toMatchObject({
        organization_id: w.org, mailbox_id: w.main, origin: 'started', assigned_to_user_id: null, record_type: null, record_id: null,
      });
    });

    it('is listed to the people linked to the main mailbox and to a person on All, and to nobody on a narrower scope who is not linked', async () => {
      const w = await world();
      const linked = await linkedPerson(w);
      const { providerId } = await receive({ to: [w.mainAddress] });
      const row = await storedCopy(providerId);

      expect(await listedIds(linked, `?mailbox=${w.main}`)).toContain(row.id);
      expect(await listedIds(w.admin, `?mailbox=${w.main}`)).toContain(row.id);
      for (const outsider of [w.seller, w.crew, w.dispatcher]) {
        expect(await listedIds(outsider, `?mailbox=${w.main}`)).not.toContain(row.id);
      }
    });

    it('rings the people linked to the main mailbox, and not everyone on All, the job\'s people or the Admins', async () => {
      const w = await world();
      const linkedA = await linkedPerson(w);
      const linkedB = await linkedPerson(w);
      const onAll = await personWith(w.org, { communication_scope: 'all' });
      const manager = await personWith(w.org, { view_users: true, is_admin: true });
      const { providerId } = await receive({ to: [w.mainAddress] });

      const rung = await bells(providerId);
      expect(rung.plain).toEqual(ids(linkedA, linkedB));
      expect(rung.why).toEqual([]);
      expect(rung.reason).toBeNull();
      for (const left of [w.admin, onAll, manager, w.seller, w.crew, w.dispatcher]) expect(rung.all).not.toContain(left.id);
      // The person on All could read it, so leaving them out is the rule at work and not a lack of access.
      expect(await listedIds(onAll, `?mailbox=${w.main}`)).toContain((await storedCopy(providerId)).id);
      expect(publishEmailsSpy).toHaveBeenCalledTimes(1);
    });

    it('opens the conversation itself from the bell, in the main mailbox, whether it rings the linked people or the Admins', async () => {
      const w = await world();
      const linkOf = async (providerId: string) => {
        const key = `email_inbound:${providerId}`;
        const rows = await db.notification.findMany({ where: { dedup_key: { in: [key, `${key}:why`] } }, select: { data: true } });
        return rows.map((r) => (r.data as { link_path?: string }).link_path);
      };

      const covered = await receive({ to: [w.mainAddress] });
      const coveredThread = (await threadOf(await storedCopy(covered.providerId))).id;
      expect(await linkOf(covered.providerId)).toEqual([`/communication/inbox?mailbox=${w.main}&thread=${coveredThread}`]);

      await linkedPerson(w);
      const linked = await receive({ to: [w.mainAddress] });
      const linkedThread = (await threadOf(await storedCopy(linked.providerId))).id;
      expect(await linkOf(linked.providerId)).toEqual([`/communication/inbox?mailbox=${w.main}&thread=${linkedThread}`]);
    });

    it('rings the Admins, with the reason line, while nobody is linked, and still not a person on All who holds no such switch', async () => {
      const w = await world();
      const manager = await personWith(w.org, { view_users: true, is_admin: true });
      const onAll = await personWith(w.org, { communication_scope: 'all' });
      const { providerId } = await receive({ to: [w.mainAddress] });

      const rung = await bells(providerId);
      expect(rung.plain).toEqual([]);
      expect(rung.why).toEqual(ids(w.admin, manager));
      expect(rung.reason).toBe('Nobody is linked to the main mailbox');
      expect(rung.reason).toBe(NOBODY_LINKED_REASON);
      for (const left of [onAll, w.seller, w.crew, w.dispatcher]) expect(rung.all).not.toContain(left.id);
    });

    it('rings the holders with the reason line when the only person linked has been deactivated, and the linked person again when they return', async () => {
      const w = await world();
      const gone = await linkedPerson(w);
      const manager = await personWith(w.org, { view_users: true, is_admin: true });
      await db.user.update({ where: { id: gone.id }, data: { is_active: false }, select: { id: true } });
      clearTokenCache();

      const first = await receive({ to: [w.mainAddress] });
      const away = await bells(first.providerId);
      expect(away.why).toEqual(ids(w.admin, manager));
      expect(away.reason).toBe(NOBODY_LINKED_REASON);
      expect(away.all).not.toContain(gone.id);

      // Their link stayed, so the moment they are active again they are the ones rung.
      await db.user.update({ where: { id: gone.id }, data: { is_active: true }, select: { id: true } });
      clearTokenCache();
      const second = await receive({ to: [w.mainAddress] });
      expect((await bells(second.providerId)).plain).toEqual(ids(gone));
    });

    it('rings only the linked people who are still active when others are deactivated, without the fallback', async () => {
      const w = await world();
      const stays = await linkedPerson(w);
      const leaves = await linkedPerson(w);
      await db.user.update({ where: { id: leaves.id }, data: { is_active: false }, select: { id: true } });
      clearTokenCache();

      const rung = await bells((await receive({ to: [w.mainAddress] })).providerId);
      expect(rung.plain).toEqual(ids(stays));
      expect(rung.why).toEqual([]);
    });

    it('does not ring a linked person without Access Communication, nor one with Show Email off: the bell opens the Email page, which both close', async () => {
      const w = await world();
      const shut = await linkedPerson(w, withDependantsOff(['access_communication']));
      const displayOff = await linkedPerson(w, { show_email: false });
      const open = await linkedPerson(w);
      const rung = await bells((await receive({ to: [w.mainAddress] })).providerId);
      expect(rung.all).not.toContain(shut.id);
      // Show Email off closes the Email page on the server (M7, ticket 36), so the bell that opens it is not rung.
      expect(rung.all).not.toContain(displayOff.id);
      expect(rung.plain).toEqual(ids(open));
    });
  });

  describe('a customer who writes to the company address', () => {
    it('answering an email sent before the release without a reply address starts a new main-mailbox conversation, never the open one, and rings the linked people', async () => {
      const w = await world();
      const linked = await linkedPerson(w);
      const before = await db.email.count({ where: { thread_id: w.openThread } });

      const { providerId } = await receive(fromCustomer(w, 'Re: Your estimate'));

      const row = await storedCopy(providerId);
      expect(row.thread_id).not.toBe(w.openThread);
      expect(await db.email.count({ where: { thread_id: w.openThread } })).toBe(before);
      expect(await threadOf(row)).toMatchObject({ mailbox_id: w.main, origin: 'started', assigned_to_user_id: null, record_type: null });
      const rung = await bells(providerId);
      expect(rung.plain).toEqual(ids(linked));
      for (const left of [w.admin, w.seller, w.crew, w.dispatcher]) expect(rung.all).not.toContain(left.id);
    });

    it('rings the Admins, with the reason line, when nobody is linked', async () => {
      const w = await world();
      const manager = await personWith(w.org, { view_users: true, is_admin: true });

      const { providerId } = await receive(fromCustomer(w, 'Re: Your estimate'));

      const rung = await bells(providerId);
      expect(rung.why).toEqual(ids(w.admin, manager));
      expect(rung.reason).toBe(NOBODY_LINKED_REASON);
      for (const left of [w.seller, w.crew, w.dispatcher]) expect(rung.all).not.toContain(left.id);
    });

    it('fresh mail from a known customer tied to no record rings the linked people, never a customer-level person', async () => {
      const w = await world();
      const linked = await linkedPerson(w);
      const { providerId } = await receive(fromCustomer(w, 'Do you do gutters?'));

      const row = await storedCopy(providerId);
      expect(await threadOf(row)).toMatchObject({ mailbox_id: w.main, origin: 'started', record_type: null, record_id: null });
      expect(row).toMatchObject({ job_id: null, lead_id: null });
      const rung = await bells(providerId);
      expect(rung.plain).toEqual(ids(linked));
      // Not the job's Sold By, crew or Dispatcher, nor anyone who owns one of the customer's jobs.
      for (const left of [w.seller, w.crew, w.dispatcher]) expect(rung.all).not.toContain(left.id);
    });

    it('fresh mail from a known customer, with nobody linked, rings the Admins and never a customer-level person', async () => {
      const w = await world();
      const { providerId } = await receive(fromCustomer(w, 'Do you do gutters?'));

      const rung = await bells(providerId);
      expect(rung.reason).toBe(NOBODY_LINKED_REASON);
      expect(rung.why).toEqual(ids(w.admin));
      for (const left of [w.seller, w.crew, w.dispatcher]) expect(rung.all).not.toContain(left.id);
    });
  });

  describe('the first person to reply takes the conversation', () => {
    const replyFrom = async (person: Who, thread: string, to: string) =>
      (await person.api()).post('/api/communication/emails', { to, subject: 'Re: Quick question', body: ['Yes, we are.'], thread_id: thread });

    it('is the replier, who is then the only one rung when the customer answers; a later replier does not take it', async () => {
      const w = await world();
      const first = await linkedPerson(w);
      const second = await linkedPerson(w);
      const { providerId } = await receive(fromCustomer(w, 'Quick question'));
      const thread = (await storedCopy(providerId)).thread_id!;
      expect((await bells(providerId)).plain).toEqual(ids(first, second));

      const answered = await replyFrom(first, thread, w.customerEmail);
      expect(answered.status).toBe(201);
      expect((await db.emailThread.findUniqueOrThrow({ where: { id: thread } })).assigned_to_user_id).toBe(first.id);

      // A colleague answering afterwards sends, and does not take it.
      expect((await replyFrom(second, thread, w.customerEmail)).status).toBe(201);
      expect((await db.emailThread.findUniqueOrThrow({ where: { id: thread } })).assigned_to_user_id).toBe(first.id);
      // It stays listed to the other reader, marked with the assignee.
      const list = await (await second.api()).get(`/api/communication/emails?mailbox=${w.main}`);
      const rows = list.body.emails as { id: string; threadAssignedToUserId: string | null }[];
      const mainCopy = await storedCopy(providerId);
      expect(rows.find((e) => e.id === mainCopy.id)?.threadAssignedToUserId).toBe(first.id);

      // The customer answers on the reply address the answer went out with: it joins the conversation and rings the assignee alone.
      const token = await db.replyToken.findFirstOrThrow({ where: { thread_id: thread, revoked_at: null }, select: { token: true } });
      emitSpy.mockClear();
      const customerAnswer = await receive({
        to: [`${token.token}@reply.test.com`], from: `Pat Payer <${w.customerEmail}>`, subject: 'Re: Re: Quick question',
      });
      expect((await storedCopy(customerAnswer.providerId)).thread_id).toBe(thread);
      const rung = await bells(customerAnswer.providerId);
      expect(rung.all).toEqual(ids(first));
      expect(rung.reason).toBeNull();
    });

    it('is a single winner when two linked people reply at the same moment', async () => {
      const w = await world();
      const a = await linkedPerson(w);
      const b = await linkedPerson(w);
      const { providerId } = await receive(fromCustomer(w, 'Quick question'));
      const thread = (await storedCopy(providerId)).thread_id!;

      const [one, two] = await Promise.all([replyFrom(a, thread, w.customerEmail), replyFrom(b, thread, w.customerEmail)]);

      expect([one.status, two.status]).toEqual([201, 201]);
      expect([a.id, b.id]).toContain((await db.emailThread.findUniqueOrThrow({ where: { id: thread } })).assigned_to_user_id);
      expect(await db.email.count({ where: { thread_id: thread, direction: 'out' } })).toBe(2);
    });
  });

  describe('with the Email plan feature off', () => {
    it('keeps the mail in the main mailbox, hides it, rings nobody, and still rings nobody when the feature returns', async () => {
      const w = await world();
      const linked = await linkedPerson(w);
      await db.organization.update({ where: { id: w.org }, data: { feature_overrides: { email: false } } });
      clearTokenCache();

      const { providerId } = await receive({ to: [w.mainAddress] });

      const row = await storedCopy(providerId);
      expect(await threadOf(row)).toMatchObject({ mailbox_id: w.main, origin: 'started' });
      expect(emitSpy).not.toHaveBeenCalled();
      expect(publishEmailsSpy).not.toHaveBeenCalled();
      expect(await db.notification.count({ where: { organization_id: w.org } })).toBe(0);
      const hidden = await (await fx.signedInAs(linked)).get(`/api/communication/emails?mailbox=${w.main}`);
      expect(hidden.status).toBe(402);
      expect(JSON.stringify(hidden.body)).not.toMatch(/Saturday|pat@/);

      await db.organization.update({ where: { id: w.org }, data: { feature_overrides: {} } });
      clearTokenCache();
      expect(await listedIds(linked, `?mailbox=${w.main}`)).toContain(row.id);
      expect(await db.notification.count({ where: { organization_id: w.org } })).toBe(0);
    });
  });

  describe('a redelivered event', () => {
    it('rings the linked people once, and the holders once when nobody is linked', async () => {
      const w = await world();
      const linked = await linkedPerson(w);
      const first = await receive({ to: [w.mainAddress] });
      emitSpy.mockClear();
      const again = await receive({ to: [w.mainAddress], again: first });

      expect(again.res.body).toEqual({ received: true, duplicate: true });
      expect(emitSpy).not.toHaveBeenCalled();
      expect(await bells(first.providerId)).toMatchObject({ plain: ids(linked) });
      expect(await db.email.count({ where: { provider_message_id: { startsWith: first.providerId } } })).toBe(1);

      // The same with the fallback: unlink, redeliver a second message twice.
      await db.mailboxReader.deleteMany({ where: { organization_id: w.org } });
      const next = await receive({ to: [w.mainAddress] });
      const ringsBefore = await db.notificationRecipient.count({ where: { notification: { organization_id: w.org } } });
      emitSpy.mockClear();
      await receive({ to: [w.mainAddress], again: next });
      expect(emitSpy).not.toHaveBeenCalled();
      expect(await db.notificationRecipient.count({ where: { notification: { organization_id: w.org } } })).toBe(ringsBefore);
      expect((await bells(next.providerId)).why).toEqual(ids(w.admin));
    });
  });

  describe('a sender who fails authentication', () => {
    it('is held in the main mailbox\'s Needs review list (S10.18), linked to no customer, and rings nobody', async () => {
      const w = await world();
      await linkedPerson(w);
      const { providerId } = await receive({
        ...fromCustomer(w, 'Wire the deposit'), headers: { 'Authentication-Results': 'amazonses.com; dmarc=fail header.from=example.com' },
      });

      const row = await storedCopy(providerId);
      expect(row).toMatchObject({
        inbound_auth: 'FAIL', customer_id: null, thread_id: null, review_reason: 'failed_authentication', review_mailbox_id: w.main,
      });
      expect(emitSpy).not.toHaveBeenCalled();
      expect(await db.notification.count({ where: { organization_id: w.org } })).toBe(0);
    });
  });

  describe('cost, on the hosted database\'s one-connection pool', () => {
    /** Every statement a delivery made on the tables of the company's people and bells, from the request to the end of the announce. */
    async function statementsFor(d: Delivery) {
      await settle();
      queries.length = 0;
      await receive(d);
      return [...queries];
    }

    it('answers the same number of statements whether two people are linked or twenty, and rings after the commit', async () => {
      const small = await world();
      await linkedPerson(small);
      await linkedPerson(small);
      const few = await statementsFor({ to: [small.mainAddress] });

      const big = await world();
      for (let i = 0; i < 20; i++) await linkedPerson(big);
      const many = await statementsFor({ to: [big.mainAddress] });

      expect(many).toHaveLength(few.length);
      // The bell is written after the transaction closed: no notification is written between BEGIN and COMMIT.
      const begin = few.findIndex((q) => /^BEGIN/.test(q));
      const commit = few.findIndex((q, i) => i > begin && /^COMMIT/.test(q));
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThan(begin);
      expect(few.slice(begin, commit).filter((q) => /"public"\."notifications?"/.test(q))).toEqual([]);
      expect(few.slice(commit).some((q) => /INSERT INTO "public"\."notifications"/.test(q))).toBe(true);
    });
  });
});
