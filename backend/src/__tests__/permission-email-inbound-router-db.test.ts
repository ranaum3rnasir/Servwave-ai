/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.14 - the inbound mail router: fresh mail to an issued mailbox address.

   Every case goes through the REAL delivery webhook route (POST /api/webhooks/resend) with a signed fixture event; only the
   call that fetches the received message from the provider is replaced, so nothing is sent or received from this machine.
   The signature is checked for real (the standard HMAC the provider signs with), the acknowledgement is real, and the
   after-commit announce is real (the bell and the live-update ping are watched, never stopped).

   What is proved, each against the real tables:
     - fresh mail to a user's address starts a NEW conversation in that mailbox (origin "started", assigned to nobody) and rings
       its holder; it shows on the holder's Email page; it is linked to no job or lead, even when the sender is a customer of the
       company with a conversation open (it is linked to that customer by the sender's address: S10.20 proves the link);
     - mail to a reserved address, an address never issued, or another environment's mailbox domain is dropped: the body is NOT
       fetched, nothing is stored, nobody is rung, and the ledger row holds only the event id, the type and the time (no sender,
       recipient or subject anywhere in it, the stored payload included); a redelivery is deduped, for dropped and kept mail;
     - one message to several of a company's addresses is stored once per mailbox; never under two companies; forwarding rules
       are not consulted;
     - with the company's Email plan feature off the mail is kept, shown nowhere and rings nobody;
     - the whole route runs on a ONE-connection pool (the hosted database's), and costs the same number of statements whether the
       message names one recipient or fifty.

   People are on custom roles (never a built-in role name) holding exactly the switch values under test.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
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
import { clearTokenCache } from '../middleware/authenticate';
import { env } from '../config/env';
import { logger } from '../lib/logger';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SECRET_BYTES = randomBytes(24);
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const MAILBOX_DOMAIN = 'mail.test.com';
const ARRIVED = new Date('2026-07-01T15:00:00.000Z');
const EVENT_PREFIX = 'rp-s10-14-';

suite('the inbound mail router: fresh mail to an issued mailbox address (real database, real webhook route)', () => {
  let db: PrismaClient;
  let fx: ReturnType<typeof switchFixture>;
  let app: Parameters<typeof request>[0];

  beforeAll(async () => {
    db = (await clientPromise) as PrismaClient;
    app = (await import('../app.js')).default as never;
    fx = switchFixture(db, async () => app);
    // The webhook reads its secret from the environment object at request time.
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_forward_rules WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
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

  /**
   * A company with its main mailbox (and main address), two people who each hold a mailbox of their own (and so a user address),
   * and a customer with an estimate conversation already open: the case "fresh mail from a customer never joins it".
   */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, tag, customer, admin } = made;
    const seq = ++sequence;

    const roleOf = async (key: string, values: Record<string, boolean | string>) => {
      const role = await fx.addCustomRole(org, `${key}-${seq}`, 'DISPATCHER');
      await setRoleSwitchValues({
        organizationId: org, roleKey: `${key}-${seq}`,
        values: {
          view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
          access_communication: true, show_email: true, view_communication: true, communication_scope: 'linked_to_me', ...values,
        },
        actorId: null, reason: 'manual',
      });
      return fx.addUser(org, `${key}${seq}`, 'DISPATCHER', { customRoleId: role.id });
    };
    const holderA: Person = await roleOf('holdera', {});
    const holderB: Person = await roleOf('holderb', {});
    const mailboxA = await fx.addUserMailbox(org, holderA);
    const mailboxB = await fx.addUserMailbox(org, holderB);
    const addressOf = (p: Person) => `${p.email.split('@')[0]!.toLowerCase()}@${MAILBOX_DOMAIN}`;

    const main = randomUUID();
    await db.mailbox.create({ data: { id: main, organization_id: org, kind: 'main', status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `main-${tag}`, organization_id: org, mailbox_id: main, is_primary: true } });

    // The customer writes from this address, and has a conversation open with the company about an estimate.
    await db.customer.update({ where: { id: customer }, data: { email: `pat-${tag}@example.com` } });
    const job = await fx.addJob(org, customer, { crew: [holderA.id] });
    const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
    const openThread = randomUUID();
    await db.emailThread.create({
      data: { id: openThread, organization_id: org, mailbox_id: main, origin: 'record', record_type: 'estimate', record_id: estimate.id },
    });
    await db.email.create({
      data: {
        id: randomUUID(), organization_id: org, thread_id: openThread, customer_id: customer, job_id: job.id,
        account: 'system', direction: 'out', folder: 'sent', from: { name: null, email: 'office@example.com' }, to: `pat-${tag}@example.com`,
        subject: 'Your estimate', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now() - 86_400_000),
      },
      select: { id: true },
    });

    return {
      org, tag, customer, admin, job, holderA, holderB, mailboxA, mailboxB, main, openThread,
      addressA: addressOf(holderA), addressB: addressOf(holderB), mainAddress: `main-${tag}@${MAILBOX_DOMAIN}`,
      customerEmail: `pat-${tag}@example.com`,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** The standard signature a delivery webhook carries: HMAC-SHA256 of `id.timestamp.body` under the shared secret. */
  const signed = (svixId: string, body: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET_BYTES).update(`${svixId}.${timestamp}.${body}`).digest('base64');
    return { 'svix-id': svixId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
  };

  interface Delivery {
    to: string[];
    cc?: string[];
    from?: string;
    subject?: string;
    text?: string;
    /** Repeat a delivery: the same provider event id (and so the same received message). */
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
      messageId: `<${providerId}@mail.example.com>`, receivedAt: ARRIVED, text: d.text ?? 'Are you open on Saturday?',
      html: '<div>Are you open on Saturday?</div>',
      headers: d.headers ?? { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' },
    });
    const body = JSON.stringify({
      type: 'email.received', created_at: ARRIVED.toISOString(),
      data: {
        email_id: providerId, created_at: ARRIVED.toISOString(), from, to: d.to, cc: d.cc ?? [], bcc: [], received_for: d.to,
        message_id: `<${providerId}@mail.example.com>`, subject, attachments: [],
      },
    });
    const res = await request(app).post('/api/webhooks/resend').set('Content-Type', 'application/json').set(signed(eventId, body)).send(body);
    await settle();
    return { res, eventId, providerId };
  }

  /**
   * The webhook answers first and announces after (the acknowledge-then-announce order), so a case reads the bells only once the
   * announce has finished: the database has been quiet for a moment.
   */
  async function settle() {
    let seen = -1;
    for (let waited = 0; waited < 10_000 && seen !== queries.length; waited += 250) {
      seen = queries.length;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const stored = (providerId: string) => db.email.findMany({ where: { provider_message_id: { startsWith: providerId } }, orderBy: { provider_message_id: 'asc' } });
  const ledger = (eventId: string) => db.resendEvent.findMany({ where: { resend_event_id: eventId } });
  const ringsOf = (org: string) => db.notification.count({ where: { organization_id: org } });
  const rungFor = (person: Person) => db.notificationRecipient.count({ where: { recipient_id: person.id, notification: { verb: 'communication.email_inbound' } } });
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  describe('fresh mail to a user\'s address', () => {
    it('starts a new conversation in that mailbox, owned by nobody, and acknowledges the delivery', async () => {
      const w = await world();
      const { res, providerId } = await receive({ to: [w.addressA] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      const [row, ...rest] = await stored(providerId);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        organization_id: w.org, direction: 'in', folder: 'inbox', unread: true, to: w.addressA, subject: 'Quick question',
        inbound_match: 'MATCHED', inbound_auth: 'PASS', reply_token: null,
      });
      expect(Number(row!.ts)).toBe(ARRIVED.getTime());
      const thread = await db.emailThread.findUniqueOrThrow({ where: { id: row!.thread_id! } });
      expect(thread).toMatchObject({
        organization_id: w.org, mailbox_id: w.mailboxA, origin: 'started', assigned_to_user_id: null, record_type: null, record_id: null,
      });
    });

    it('rings its holder and nobody else, and the holder finds it on the Email page', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.addressA] });

      expect(await rungFor(w.holderA)).toBe(1);
      expect(await rungFor(w.holderB)).toBe(0);
      expect(await rungFor(w.admin)).toBe(0);
      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy.mock.calls[0]![0]).toMatchObject({ verb: 'communication.email_inbound', dedupKey: `email_inbound:${providerId}` });
      expect(publishEmailsSpy).toHaveBeenCalledTimes(1);

      const [row] = await stored(providerId);
      const holder: Api = await fx.signedInAs(w.holderA);
      const list = await holder.get(`/api/communication/emails?mailbox=${w.mailboxA}`);
      expect(list.status).toBe(200);
      expect((list.body.emails as { id: string }[]).map((e) => e.id)).toContain(row!.id);
      // A colleague with the same role does not see it in the holder's mailbox.
      const colleague: Api = await fx.signedInAs(w.holderB);
      const theirs = await colleague.get('/api/communication/emails?mailbox=mine');
      expect((theirs.body.emails as { id: string }[]).map((e) => e.id)).not.toContain(row!.id);
    });

    it('matches the address without regard to its case or a display name', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [`Holder A <${w.addressA.toUpperCase()}>`] });
      const [row] = await stored(providerId);
      expect(row).toBeTruthy();
      expect((await db.emailThread.findUniqueOrThrow({ where: { id: row!.thread_id! } })).mailbox_id).toBe(w.mailboxA);
    });

    it('starts a new conversation even when the sender is a customer of the company with a conversation open, and links it to that customer by address but to no job or lead', async () => {
      const w = await world();
      const before = await db.email.count({ where: { thread_id: w.openThread } });
      const { providerId } = await receive({ to: [w.addressA], from: `Pat Payer <${w.customerEmail}>` });

      const [row] = await stored(providerId);
      expect(row!.thread_id).not.toBe(w.openThread);
      // The customer is linked by the sender's address (S10.20: exactly one customer has it); a job or a lead never is.
      expect(row).toMatchObject({ customer_id: w.customer, job_id: null, lead_id: null });
      const thread = await db.emailThread.findUniqueOrThrow({ where: { id: row!.thread_id! } });
      expect(thread).toMatchObject({ origin: 'started', mailbox_id: w.mailboxA, record_type: null, record_id: null });
      // The open conversation did not gain the message, and is still the same one.
      expect(await db.email.count({ where: { thread_id: w.openThread } })).toBe(before);
    });

    it('rings nobody when the sender fails authentication, yet keeps the mail (held for review: S10.18 proves the rest)', async () => {
      const w = await world();
      const { providerId } = await receive({
        to: [w.addressA], headers: { 'Authentication-Results': 'amazonses.com; dmarc=fail header.from=example.com' },
      });
      expect((await stored(providerId))[0]).toMatchObject({ inbound_auth: 'FAIL', customer_id: null });
      expect(emitSpy).not.toHaveBeenCalled();
      expect(await ringsOf(w.org)).toBe(0);
    });
  });

  describe('mail nobody here is expecting is dropped', () => {
    const dropped: Array<[string, (w: World) => string]> = [
      ['a reserved address', () => `no-reply@${MAILBOX_DOMAIN}`],
      ['a reserved address in capitals', () => `Postmaster@${MAILBOX_DOMAIN}`],
      ['an address never issued', (w) => `never.issued.${w.tag}@${MAILBOX_DOMAIN}`],
      ['an address on another environment\'s mailbox domain', (w) => `${w.addressA.split('@')[0]}@staging.${MAILBOX_DOMAIN}`],
      ['an address on the production mailbox domain', (w) => `${w.addressA.split('@')[0]}@mail.servwave.com`],
    ];
    it.each(dropped)('%s: the body is not fetched, nothing is stored, nobody is rung, and the ledger row is content-free', async (_what, addressOf) => {
      const w = await world();
      const address = addressOf(w);
      const logged = vi.spyOn(logger, 'info');
      try {
        const { res, eventId, providerId } = await receive({ to: [address], from: 'Spy Sender <spy.sender@example.org>', subject: 'Confidential subject' });

        expect(res.status).toBe(200);
        expect(fetchReceived).not.toHaveBeenCalled();
        expect(await stored(providerId)).toEqual([]);
        expect(await db.emailThread.count({ where: { organization_id: w.org } })).toBe(1);
        expect(emitSpy).not.toHaveBeenCalled();

        const rows = await ledger(eventId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ resend_event_id: eventId, event_type: 'email.received', payload: null });
        expect(rows[0]!.created_at).toBeInstanceOf(Date);
        // Nothing of the message anywhere in the row, wherever it is kept.
        const everything = JSON.stringify(rows);
        for (const secret of ['spy.sender', 'Spy Sender', 'Confidential', address, providerId]) expect(everything).not.toContain(secret);
        // The log line names the event and nothing else.
        const lines = logged.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(eventId));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) for (const secret of ['spy.sender', 'Confidential', address]) expect(line).not.toContain(secret);
      } finally {
        logged.mockRestore();
      }
    });

    it('keeps a redelivery of a dropped event deduped: still one ledger row, still no fetch', async () => {
      const w = await world();
      const first = await receive({ to: [`never.issued.${w.tag}@${MAILBOX_DOMAIN}`] });
      const again = await receive({ to: [`never.issued.${w.tag}@${MAILBOX_DOMAIN}`], again: first });

      expect(again.res.status).toBe(200);
      expect(again.res.body).toEqual({ received: true, duplicate: true });
      expect(await ledger(first.eventId)).toHaveLength(1);
      expect(fetchReceived).not.toHaveBeenCalled();
    });

    it('drops a message addressed to nothing but reserved and unissued addresses', async () => {
      const w = await world();
      const { eventId } = await receive({ to: [`no-reply@${MAILBOX_DOMAIN}`, `ghost.${w.tag}@${MAILBOX_DOMAIN}`] });
      expect((await ledger(eventId))[0]!.payload).toBeNull();
    });

    it('rejects an unsigned or wrongly signed event before anything is read', async () => {
      const body = JSON.stringify({ type: 'email.received', data: { email_id: 'x', to: ['a@b.c'] } });
      const bad = await request(app).post('/api/webhooks/resend').set('Content-Type', 'application/json')
        .set({ 'svix-id': `${EVENT_PREFIX}bad`, 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,AAAA' }).send(body);
      expect(bad.status).toBe(401);
      expect(await ledger(`${EVENT_PREFIX}bad`)).toEqual([]);
      expect(fetchReceived).not.toHaveBeenCalled();
    });
  });

  describe('a redelivered event', () => {
    it('stores nothing new and rings nobody twice', async () => {
      const w = await world();
      const first = await receive({ to: [w.addressA] });
      emitSpy.mockClear();
      fetchReceived.mockClear();

      const again = await receive({ to: [w.addressA], again: first });

      expect(again.res.body).toEqual({ received: true, duplicate: true });
      expect(await stored(first.providerId)).toHaveLength(1);
      expect(await db.emailThread.count({ where: { organization_id: w.org, mailbox_id: w.mailboxA } })).toBe(1);
      expect(await ledger(first.eventId)).toHaveLength(1);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(await rungFor(w.holderA)).toBe(1);
    });

    it('keeps the whole event in the ledger for mail it stores', async () => {
      const w = await world();
      const { eventId } = await receive({ to: [w.addressA], subject: 'Kept subject' });
      const [row] = await ledger(eventId);
      expect(row!.payload).toMatchObject({ type: 'email.received', data: { subject: 'Kept subject', to: [w.addressA] } });
    });
  });

  describe('one message to several of the company\'s addresses', () => {
    it('is stored once per mailbox, each in its own conversation, and rings each holder', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.addressA], cc: [w.addressB, w.mainAddress] });

      const rows = await stored(providerId);
      expect(rows).toHaveLength(3);
      const threads = await db.emailThread.findMany({ where: { id: { in: rows.map((r) => r.thread_id!) } } });
      expect(threads.map((t) => t.mailbox_id).sort()).toEqual([w.mailboxA, w.mailboxB, w.main].sort());
      expect(new Set(threads.map((t) => t.id)).size).toBe(3);
      for (const t of threads) expect(t).toMatchObject({ origin: 'started', assigned_to_user_id: null });
      expect(new Set(rows.map((r) => r.provider_message_id)).size).toBe(3);
      // Each copy says which address it reached.
      expect(rows.map((r) => r.to).sort()).toEqual([w.addressA, w.addressB, w.mainAddress].sort());
      expect(await rungFor(w.holderA)).toBe(1);
      expect(await rungFor(w.holderB)).toBe(1);
    });

    it('is stored once for a mailbox named twice', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.addressA, w.addressA.toUpperCase()] });
      expect(await stored(providerId)).toHaveLength(1);
    });

    it('is redelivered without a third or fourth copy', async () => {
      const w = await world();
      const first = await receive({ to: [w.addressA, w.addressB] });
      await receive({ to: [w.addressA, w.addressB], again: first });
      expect(await stored(first.providerId)).toHaveLength(2);
    });

    it('is never stored under two companies: the first recipient\'s company takes it, the other holds nothing', async () => {
      const one = await world();
      const two = await world();
      const { providerId } = await receive({ to: [one.addressA, two.addressA] });

      const rows = await stored(providerId);
      expect(rows.map((r) => r.organization_id)).toEqual([one.org]);
      expect(await db.email.count({ where: { organization_id: two.org, direction: 'in' } })).toBe(0);
      expect(await db.emailThread.count({ where: { organization_id: two.org, origin: 'started' } })).toBe(0);
      expect(await rungFor(two.holderA)).toBe(0);
    });

    it('does not consult forwarding rules: a rule from the address to a colleague changes nothing', async () => {
      const w = await world();
      await db.emailForwardRule.create({ data: { organization_id: w.org, from: w.addressA, to_member_id: w.holderB.id, enabled: true } });
      const { providerId } = await receive({ to: [w.addressA] });

      const [row] = await stored(providerId);
      expect((await db.emailThread.findUniqueOrThrow({ where: { id: row!.thread_id! } })).mailbox_id).toBe(w.mailboxA);
      expect(await db.email.count({ where: { organization_id: w.org, direction: 'in' } })).toBe(1);
      expect(await rungFor(w.holderB)).toBe(0);
    });
  });

  describe('the order of the recipients', () => {
    it('lets a reply token win over a mailbox address in the same message: the customer\'s answer joins its conversation', async () => {
      const w = await world();
      const token = randomBytes(16).toString('base64url');
      await db.replyToken.create({
        data: {
          token, organization_id: w.org, thread_id: w.openThread, entity_type: 'estimate', entity_id: (await db.emailThread.findUniqueOrThrow({ where: { id: w.openThread } })).record_id,
          customer_id: w.customer, expected_from: w.customerEmail,
        },
      });
      const { providerId } = await receive({ to: [`${token}@reply.test.com`], cc: [w.addressA], from: `Pat Payer <${w.customerEmail}>` });

      const rows = await stored(providerId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ thread_id: w.openThread, inbound_match: 'MATCHED', reply_token: token });
    });

    it('falls to the mailbox address when the token has been revoked', async () => {
      const w = await world();
      const token = randomBytes(16).toString('base64url');
      await db.replyToken.create({
        data: { token, organization_id: w.org, thread_id: w.openThread, expected_from: w.customerEmail, revoked_at: new Date() },
      });
      const { providerId } = await receive({ to: [`${token}@reply.test.com`, w.addressA] });
      const [row] = await stored(providerId);
      expect((await db.emailThread.findUniqueOrThrow({ where: { id: row!.thread_id! } })).mailbox_id).toBe(w.mailboxA);
    });

    it('drops a token that does not resolve when nothing else takes the message', async () => {
      await world();
      const { eventId } = await receive({ to: [`${randomBytes(16).toString('base64url')}@reply.test.com`] });
      expect(fetchReceived).not.toHaveBeenCalled();
      expect((await ledger(eventId))[0]!.payload).toBeNull();
    });

    it('judges an event that names no recipients on the fetched message, so a payload change cannot lose mail', async () => {
      const w = await world();
      const providerId = `${EVENT_PREFIX}rcv-${randomUUID()}`;
      const eventId = `${EVENT_PREFIX}evt-${randomUUID()}`;
      fetchReceived.mockResolvedValue({
        providerId, from: 'Pat <pat@example.com>', receivedFor: [w.addressA], to: [w.addressA], subject: 'No recipients in the event',
        messageId: '<x@y>', receivedAt: ARRIVED, text: 'hi', html: null, headers: null,
      });
      const body = JSON.stringify({ type: 'email.received', created_at: ARRIVED.toISOString(), data: { email_id: providerId } });
      const res = await request(app).post('/api/webhooks/resend').set('Content-Type', 'application/json').set(signed(eventId, body)).send(body);
      await settle();
      expect(res.status).toBe(200);
      expect(await stored(providerId)).toHaveLength(1);
    });
  });

  describe('with the Email plan feature off', () => {
    it('keeps the mail in the right mailbox, rings nobody and shows it nowhere; when the feature returns it appears unread and still rings nobody', async () => {
      const w = await world();
      await db.organization.update({ where: { id: w.org }, data: { feature_overrides: { email: false } } });
      clearTokenCache();

      const { providerId } = await receive({ to: [w.addressA] });

      const [row] = await stored(providerId);
      expect(row).toMatchObject({ unread: true, organization_id: w.org });
      expect((await db.emailThread.findUniqueOrThrow({ where: { id: row!.thread_id! } })).mailbox_id).toBe(w.mailboxA);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(publishEmailsSpy).not.toHaveBeenCalled();
      expect(await ringsOf(w.org)).toBe(0);
      const holder: Api = await fx.signedInAs(w.holderA);
      const hidden = await holder.get(`/api/communication/emails?mailbox=${w.mailboxA}`);
      expect(hidden.status).toBe(402);
      expect(JSON.stringify(hidden.body)).not.toMatch(/Saturday|pat@/);

      await db.organization.update({ where: { id: w.org }, data: { feature_overrides: {} } });
      clearTokenCache();
      const shown = await (await fx.signedInAs(w.holderA)).get(`/api/communication/emails?mailbox=${w.mailboxA}`);
      expect(shown.status).toBe(200);
      expect((shown.body.emails as { id: string }[]).map((e) => e.id)).toContain(row!.id);
      expect(await ringsOf(w.org)).toBe(0);
    });

    it('still drops mail to an address never issued', async () => {
      const w = await world();
      await db.organization.update({ where: { id: w.org }, data: { feature_overrides: { email: false } } });
      clearTokenCache();
      const { eventId } = await receive({ to: [`never.issued.${w.tag}@${MAILBOX_DOMAIN}`] });
      expect(fetchReceived).not.toHaveBeenCalled();
      expect((await ledger(eventId))[0]!.payload).toBeNull();
    });

    it('is not touched by the company\'s sending switch: with sending off and the feature on, mail is received and rings as normal', async () => {
      const w = await world();
      await db.organization.update({ where: { id: w.org }, data: { email_sending_enabled: false } });
      await receive({ to: [w.addressA] });
      expect(await rungFor(w.holderA)).toBe(1);
    });
  });

  describe('cost, on the hosted database\'s one-connection pool', () => {
    /** The router's and the store's statements a delivery made, from the moment before the request to the moment after the announce. */
    async function statementsFor(d: Delivery) {
      await settle(); // anything an earlier case left running is over before the count starts
      queries.length = 0;
      await receive(d); // returns once the announce after the acknowledgement has finished too
      // Only the statements on the tables the router and the store touch, so a stray read of something else cannot move a count.
      return queries.filter((q) => /(?:FROM|INTO|UPDATE) "public"\."(resend_events|mailbox_addresses|reply_tokens|email_threads|emails)"/.test(q));
    }

    it('answers on one connection for fresh mail, and a dropped message makes only the dedupe read, the router\'s reads and the ledger write', async () => {
      const w = await world();
      const kept = await statementsFor({ to: [w.addressA] });
      // dedupe read, ONE register read (the address row names company and mailbox), ledger write, the conversation, the message.
      const tables = kept.map((q) => q.match(/(?:FROM|INTO) "public"\."(resend_events|mailbox_addresses|email_threads|emails)"/)?.[1]).filter(Boolean);
      expect(tables.slice(0, 5)).toEqual(['resend_events', 'mailbox_addresses', 'resend_events', 'email_threads', 'emails']);
      expect(kept.filter((q) => /FROM "public"\."mailbox_addresses"/.test(q))).toHaveLength(1);

      const unknown = await statementsFor({ to: [`never.issued.${w.tag}@${MAILBOX_DOMAIN}`] });
      // dedupe read, one register read, one ledger write.
      expect(unknown).toHaveLength(3);
      expect(unknown.filter((q) => /mailbox_addresses/.test(q))).toHaveLength(1);
      expect(unknown.filter((q) => /INSERT INTO "public"."resend_events"/.test(q))).toHaveLength(1);
      expect(unknown.filter((q) => /"public"."emails"/.test(q))).toHaveLength(0);
    });

    it('asks the register once however many addresses the message names', async () => {
      const w = await world();
      const one = await statementsFor({ to: [`ghost0.${w.tag}@${MAILBOX_DOMAIN}`] });
      const fifty = await statementsFor({ to: Array.from({ length: 50 }, (_, i) => `ghost${i}.${w.tag}@${MAILBOX_DOMAIN}`) });
      expect(fifty).toHaveLength(one.length);
      // Beyond the cap the extra recipients are not even looked up.
      const many = await statementsFor({ to: Array.from({ length: 200 }, (_, i) => `ghost${i}.${w.tag}@${MAILBOX_DOMAIN}`) });
      expect(many).toHaveLength(one.length);
    });

    it('stores two mailbox copies with a bounded number of statements and no per-recipient scan', async () => {
      const w = await world();
      const two = await statementsFor({ to: [w.addressA, w.addressB] });
      const registerReads = two.filter((q) => /mailbox_addresses/.test(q));
      expect(registerReads).toHaveLength(1);
      expect(two.filter((q) => /INSERT INTO "public"."emails"/.test(q))).toHaveLength(2);
      expect(two.filter((q) => /INSERT INTO "public"."email_threads"/.test(q))).toHaveLength(2);
    });
  });
});
