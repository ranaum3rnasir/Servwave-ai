/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.18 - the Needs review folder: automatic mail, failed authentication, unmatched replies.

   Every case that stores mail goes through the REAL delivery webhook route (POST /api/webhooks/resend) with a signed fixture
   event; only the call that fetches the received message from the provider is replaced, so nothing is sent or received from this
   machine. The list, the counts and the link action are the real routes, called as real people.

   What is proved, each against the real tables:
     - intake: a message that fails sender authentication, and automatic mail (auto-submitted, bulk / junk / list / auto-reply
       precedence, a null-sender bounce), on a mailbox address is HELD under that mailbox: no conversation, no bell, no live-update
       ping, not in the inbox list and not in any unread count, linked to no customer; any other verdict is delivered with the
       verdict recorded;
     - a token reply whose sender does not match is held under the mailbox its token's conversation belongs to, with that
       conversation as its record; a token that no longer resolves is held under the MAIN mailbox; an unknown token is dropped;
     - the list follows mailbox visibility, a held reply to a record follows who can reach that record, the counts follow the
       same filter, and a person without Access Communication cannot open any list;
     - linking keeps the filing rule (Edit communication records) and needs reach to the target conversation;
     - the whole route and the list run on a ONE-connection pool (the hosted database's).

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
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { env } from '../config/env';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SECRET_BYTES = randomBytes(24);
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const MAILBOX_DOMAIN = 'mail.test.com';
const REPLY_DOMAIN = 'reply.test.com';
const ARRIVED = new Date('2026-07-01T15:00:00.000Z');
const EVENT_PREFIX = 'rp-s10-18-';
const FAILED = { 'Authentication-Results': 'amazonses.com; dmarc=fail header.from=example.com' };
const PASSED = { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' };

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

suite('the Needs review folder (real database, real webhook route, real list and link routes)', () => {
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

  /**
   * A company with its main mailbox, three people who each hold a mailbox of their own, two people linked to read the main
   * mailbox, a reader of every mailbox, a person with no Access Communication, and five conversations a customer has been
   * mailed a reply address for: an invoice sent by the main mailbox (an automated send), an invoice sent by hand from one
   * person's mailbox, an ordinary conversation in another's, and one the customer's reply address was revoked on.
   */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, tag, customer, admin } = made;
    const seq = ++sequence;

    const personWith = async (key: string, values: Record<string, boolean | string>): Promise<Member> => {
      const role = await fx.addCustomRole(org, `${key}-${seq}`, 'DISPATCHER');
      await setRoleSwitchValues({
        organizationId: org, roleKey: `${key}-${seq}`,
        values: {
          view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
          view_estimates: true, estimates_scope: 'attached', view_invoices: true, invoices_scope: 'attached',
          access_communication: true, show_email: true, view_communication: true, communication_scope: 'linked_to_me', ...values,
        },
        actorId: null, reason: 'manual',
      });
      const person = await fx.addUser(org, `${key}${seq}`, 'DISPATCHER', { customRoleId: role.id });
      return Object.assign(person, { api: () => fx.signedInAs(person) });
    };
    const mailboxOf = async (person: Person) => {
      const id = await fx.addUserMailbox(org, person);
      const row = await db.mailboxAddress.findFirst({ where: { mailbox_id: id, is_primary: true }, select: { local_part: true } });
      return { id, address: `${row!.local_part}@${MAILBOX_DOMAIN}` };
    };

    const holderA = await personWith('holdera', {});
    const holderB = await personWith('holderb', {});
    // Holds a mailbox but cannot open an invoice: a hand-sent invoice in this mailbox is not theirs to read.
    const holderC = await personWith('holderc', withDependantsOff(['view_invoices']));
    const reader = await personWith('reader', {});
    const readerNoInvoice = await personWith('readerni', withDependantsOff(['view_invoices']));
    const wide = await personWith('wide', { communication_scope: 'all' });
    const noAccess = await personWith('noaccess', withDependantsOff(['access_communication']));
    const boxA = await mailboxOf(holderA);
    const boxB = await mailboxOf(holderB);
    const boxC = await mailboxOf(holderC);

    const main = randomUUID();
    await db.mailbox.create({ data: { id: main, organization_id: org, kind: 'main', status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `main-${tag}`, organization_id: org, mailbox_id: main, is_primary: true } });
    for (const p of [reader, readerNoInvoice]) await db.mailboxReader.create({ data: { organization_id: org, mailbox_id: main, user_id: p.id } });

    const job = await fx.addJob(org, customer, { crew: [holderA.id, holderC.id, reader.id, readerNoInvoice.id] });
    const invoiceRow = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });

    /** A conversation a send opened, with its sent email and the reply address the customer was given (expecting angel@). */
    const conversation = async (mailboxId: string, record: { type: string; id: string } | null) => {
      const thread = randomUUID();
      await db.emailThread.create({
        data: {
          id: thread, organization_id: org, mailbox_id: mailboxId, origin: record ? 'record' : 'started',
          record_type: record?.type ?? null, record_id: record?.id ?? null,
        },
      });
      await db.email.create({
        data: {
          id: randomUUID(), organization_id: org, thread_id: thread, customer_id: customer, job_id: job.id,
          account: 'system', direction: 'out', folder: 'sent', from: { name: null, email: 'office@example.com' }, to: 'angel@example.com',
          subject: 'Your invoice', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now() - 86_400_000),
        },
        select: { id: true },
      });
      const token = newToken();
      await db.replyToken.create({
        data: {
          token, organization_id: org, thread_id: thread, entity_type: record?.type ?? null, entity_id: record?.id ?? null,
          customer_id: customer, expected_from: 'angel@example.com',
        },
      });
      return { thread, token, address: `${token}@${REPLY_DOMAIN}` };
    };
    const invoice = { type: 'invoice', id: invoiceRow.id };
    const automatedInvoice = await conversation(main, invoice);
    const handInvoiceA = await conversation(boxA.id, invoice);
    const handInvoiceC = await conversation(boxC.id, invoice);
    const ordinaryA = await conversation(boxA.id, null);
    const ordinaryB = await conversation(boxB.id, null);
    // A reply address that was revoked: it no longer resolves, though its conversation (an invoice's, in the main mailbox) does.
    const revoked = await conversation(main, invoice);
    await db.replyToken.update({ where: { token: revoked.token }, data: { revoked_at: new Date() } });

    return {
      personWith, org, tag, customer, admin, job, invoice: invoiceRow, holderA, holderB, holderC, reader, readerNoInvoice, wide, noAccess,
      boxA, boxB, boxC, main, mainAddress: `main-${tag}@${MAILBOX_DOMAIN}`,
      automatedInvoice, handInvoiceA, handInvoiceC, ordinaryA, ordinaryB, revoked,
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
    from?: string;
    subject?: string;
    text?: string;
    headers?: Record<string, string>;
    /** Repeat a delivery: the same provider event id (and so the same received message). */
    again?: { eventId: string; providerId: string };
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
      html: '<div>Are you open on Saturday?</div>', headers: d.headers ?? PASSED,
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

  /** The webhook answers first and announces after, so a case reads the bells only once the database has been quiet a moment. */
  async function settle() {
    let seen = -1;
    for (let waited = 0; waited < 10_000 && seen !== queries.length; waited += 250) {
      seen = queries.length;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const stored = (providerId: string) => db.email.findMany({ where: { provider_message_id: { startsWith: providerId } }, orderBy: { provider_message_id: 'asc' } });
  const ringsOf = (org: string) => db.notification.count({ where: { organization_id: org } });
  const unreadBadge = async (person: Member) => ((await (await person.api()).get('/api/communication/unread-counts')).body as { email: number }).email;
  const inboxIds = async (person: Member, mailbox: string) => {
    const res = await (await person.api()).get(`/api/communication/emails?mailbox=${mailbox}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };

  /** Mail held for review, read with no reading rule: what the intake stored. */
  async function held(providerId: string) {
    const rows = await stored(providerId);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  describe('intake: mail on a mailbox address', () => {
    it('holds a message that fails sender authentication under that mailbox: no conversation, no bell, never linked to a customer', async () => {
      const w = await world();
      const { res, providerId } = await receive({ to: [w.boxA.address], from: `Pat Payer <pat@example.com>`, headers: FAILED });

      expect(res.status).toBe(200);
      const row = await held(providerId);
      expect(row).toMatchObject({
        organization_id: w.org, thread_id: null, customer_id: null, job_id: null, lead_id: null, direction: 'in',
        folder: 'needs_review', unread: true, inbound_auth: 'FAIL', review_reason: 'failed_authentication',
        review_mailbox_id: w.boxA.id, review_thread_id: null, to: w.boxA.address,
      });
      // It opened no conversation: the only ones in the company are the six the world made.
      expect(await db.emailThread.count({ where: { organization_id: w.org } })).toBe(6);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(publishEmailsSpy).not.toHaveBeenCalled();
      expect(await ringsOf(w.org)).toBe(0);
    });

    it('delivers any other verdict with the verdict recorded', async () => {
      const w = await world();
      for (const [verdict, headers] of [
        ['PASS', PASSED],
        ['NO_POLICY', { 'Authentication-Results': 'amazonses.com; dmarc=none header.from=example.com' }],
        ['UNAVAILABLE', {}],
      ] as const) {
        const { providerId } = await receive({ to: [w.boxA.address], headers });
        const row = await held(providerId);
        expect(row, verdict).toMatchObject({ inbound_auth: verdict, folder: 'inbox', inbound_match: 'MATCHED', review_reason: null, review_mailbox_id: null });
        expect(row.thread_id, verdict).not.toBeNull();
      }
    });

    it('keeps a held message out of every inbox list and unread count, on "Linked to me" and on All alike', async () => {
      const w = await world();
      const before = { holder: await unreadBadge(w.holderA), wide: await unreadBadge(w.wide) };
      const { providerId } = await receive({ to: [w.boxA.address], headers: FAILED });
      const row = await held(providerId);

      expect(await inboxIds(w.holderA, w.boxA.id)).not.toContain(row.id);
      expect(await inboxIds(w.holderA, 'mine')).not.toContain(row.id);
      expect(await inboxIds(w.wide, 'all')).not.toContain(row.id);
      expect(await inboxIds(w.wide, w.boxA.id)).not.toContain(row.id);
      expect(await unreadBadge(w.holderA)).toBe(before.holder);
      expect(await unreadBadge(w.wide)).toBe(before.wide);
      const list = (await (await w.holderA.api()).get(`/api/communication/mailboxes?selected=${w.boxA.id}`)).body as { selected_unread: number; total_unread: number };
      expect(list.selected_unread).toBe(0);
      expect(list.total_unread).toBe(0);
    });

    it('holds one copy under each mailbox a failed message reached, and rings neither holder', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.boxA.address, w.boxB.address, w.mainAddress], headers: FAILED });
      const rows = await stored(providerId);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.review_mailbox_id).sort()).toEqual([w.boxA.id, w.boxB.id, w.main].sort());
      for (const r of rows) expect(r).toMatchObject({ thread_id: null, review_reason: 'failed_authentication', folder: 'needs_review' });
      expect(new Set(rows.map((r) => r.provider_message_id)).size).toBe(3);
      expect(await ringsOf(w.org)).toBe(0);
    });

    it('holds a failed message even when its sender is a customer of the company, and links it to nobody', async () => {
      const w = await world();
      await db.customer.update({ where: { id: w.customer }, data: { email: `pat-${w.tag}@example.com` } });
      const { providerId } = await receive({ to: [w.boxA.address], from: `Pat Payer <pat-${w.tag}@example.com>`, headers: FAILED });
      expect(await held(providerId)).toMatchObject({ customer_id: null, job_id: null, lead_id: null, thread_id: null, review_reason: 'failed_authentication' });
    });
  });

  describe('intake: automatic mail on a mailbox address', () => {
    const automatic: Array<[string, Partial<Delivery>]> = [
      ['an Auto-Submitted header', { headers: { ...PASSED, 'Auto-Submitted': 'auto-replied' } }],
      ['an auto-generated Auto-Submitted header in other letters', { headers: { ...PASSED, 'auto-submitted': 'Auto-Generated' } }],
      ['bulk precedence', { headers: { ...PASSED, Precedence: 'bulk' } }],
      ['junk precedence', { headers: { ...PASSED, Precedence: 'junk' } }],
      ['list precedence', { headers: { ...PASSED, Precedence: 'list' } }],
      ['auto-reply precedence', { headers: { ...PASSED, Precedence: 'auto_reply' } }],
      ['an empty sender (a bounce)', { from: 'Mail Delivery System <>' }],
      ['an empty return path', { headers: { ...PASSED, 'Return-Path': '<>' } }],
    ];
    it.each(automatic)('holds mail with %s as automatic mail: no bell, no conversation, no unread count', async (_what, delivery) => {
      const w = await world();
      const before = await unreadBadge(w.holderA);
      const listed = await inboxIds(w.holderA, w.boxA.id);
      const { providerId } = await receive({ to: [w.boxA.address], ...delivery });

      expect(await held(providerId)).toMatchObject({
        thread_id: null, folder: 'needs_review', review_reason: 'automatic', review_mailbox_id: w.boxA.id, customer_id: null,
      });
      expect(emitSpy).not.toHaveBeenCalled();
      expect(publishEmailsSpy).not.toHaveBeenCalled();
      expect(await ringsOf(w.org)).toBe(0);
      expect(await unreadBadge(w.holderA)).toBe(before);
      expect(await inboxIds(w.holderA, w.boxA.id)).toEqual(listed);
      expect(await db.emailThread.count({ where: { organization_id: w.org } })).toBe(6);
    });

    it.each([
      ['Auto-Submitted: no', { 'Auto-Submitted': 'no' }],
      ['a first-class precedence', { Precedence: 'first-class' }],
    ])('delivers mail with %s: it is a person\'s', async (_what, extra) => {
      const w = await world();
      const { providerId } = await receive({ to: [w.boxA.address], headers: { ...PASSED, ...extra } });
      expect(await held(providerId)).toMatchObject({ folder: 'inbox', review_reason: null });
      expect(await ringsOf(w.org)).toBe(1);
    });

    it('names a failed authentication before automatic mail', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.boxA.address], headers: { ...FAILED, Precedence: 'bulk' } });
      expect(await held(providerId)).toMatchObject({ review_reason: 'failed_authentication' });
    });
  });

  describe('intake: a reply on a reply address', () => {
    const FROM_SPOUSE = 'Their Spouse <spouse@example.com>';

    it('holds a sender-mismatched reply to an invoice sent by hand under the mailbox the invoice\'s conversation sits in, with that conversation as its record', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.handInvoiceA.address], from: FROM_SPOUSE });
      expect(await held(providerId)).toMatchObject({
        thread_id: null, customer_id: null, folder: 'needs_review', inbound_match: 'UNMATCHED_SENDER', reply_token: w.handInvoiceA.token,
        review_reason: 'sender_mismatch', review_mailbox_id: w.boxA.id, review_thread_id: w.handInvoiceA.thread,
      });
      // The bell for it (who it rings, and the item it opens) is S10.19's: permission-email-unmatched-reply-bells-db.test.ts.
    });

    it('files a sender-mismatched reply to an automated invoice under the main mailbox, and to an ordinary conversation under its own mailbox', async () => {
      const w = await world();
      const a = await receive({ to: [w.automatedInvoice.address], from: FROM_SPOUSE });
      const b = await receive({ to: [w.ordinaryB.address], from: FROM_SPOUSE });
      expect(await held(a.providerId)).toMatchObject({ review_reason: 'sender_mismatch', review_mailbox_id: w.main, review_thread_id: w.automatedInvoice.thread });
      expect(await held(b.providerId)).toMatchObject({ review_reason: 'sender_mismatch', review_mailbox_id: w.boxB.id, review_thread_id: w.ordinaryB.thread });
    });

    it('delivers a reply from the address we wrote to as ever, onto its conversation', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.handInvoiceA.address], from: 'Angel <angel@example.com>' });
      expect(await held(providerId)).toMatchObject({ thread_id: w.handInvoiceA.thread, folder: 'inbox', inbound_match: 'MATCHED', review_reason: null });
    });

    it('holds a reply that fails authentication even from the address we wrote to, and rings nobody', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.handInvoiceA.address], from: 'Angel <angel@example.com>', headers: FAILED });
      expect(await held(providerId)).toMatchObject({ thread_id: null, review_reason: 'failed_authentication', review_mailbox_id: w.boxA.id, review_thread_id: w.handInvoiceA.thread });
      expect(await ringsOf(w.org)).toBe(0);
    });

    it('holds an out-of-office reply from the address we wrote to as automatic mail under the conversation\'s mailbox', async () => {
      const w = await world();
      const { providerId } = await receive({
        to: [w.handInvoiceA.address], from: 'Angel <angel@example.com>', headers: { ...PASSED, 'Auto-Submitted': 'auto-replied' },
      });
      expect(await held(providerId)).toMatchObject({ thread_id: null, review_reason: 'automatic', review_mailbox_id: w.boxA.id, review_thread_id: w.handInvoiceA.thread });
      expect(await ringsOf(w.org)).toBe(0);
    });

    it('files a reply on a reply address that no longer resolves under the MAIN mailbox, whichever mailbox its conversation sits in', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.revoked.address], from: 'Angel <angel@example.com>' });
      expect(await held(providerId)).toMatchObject({
        thread_id: null, customer_id: null, folder: 'needs_review', review_reason: 'unknown_reply', review_mailbox_id: w.main,
        review_thread_id: w.revoked.thread, reply_token: w.revoked.token,
      });
      expect(await ringsOf(w.org)).toBe(0);
    });

    it('drops a reply address the table never held: nothing names a company to file it under', async () => {
      const w = await world();
      const { providerId, eventId } = await receive({ to: [`${newToken()}@${REPLY_DOMAIN}`] });
      expect(fetchReceived).not.toHaveBeenCalled();
      expect(await stored(providerId)).toEqual([]);
      expect((await db.resendEvent.findMany({ where: { resend_event_id: eventId } }))[0]!.payload).toBeNull();
      expect(w.org).toBeTruthy();
    });

    it('files a reply on an address anchored to a record with no conversation yet under the main mailbox, in that record\'s conversation', async () => {
      const w = await world();
      const token = newToken();
      await db.replyToken.create({
        data: { token, organization_id: w.org, thread_id: null, entity_type: 'invoice', entity_id: w.invoice.id, customer_id: w.customer, expected_from: 'angel@example.com' },
      });
      const first = await receive({ to: [`${token}@${REPLY_DOMAIN}`], from: FROM_SPOUSE });
      const second = await receive({ to: [`${token}@${REPLY_DOMAIN}`], from: FROM_SPOUSE });
      const [a, b] = [await held(first.providerId), await held(second.providerId)];
      expect(a).toMatchObject({ review_reason: 'sender_mismatch', review_mailbox_id: w.main });
      expect(a.review_thread_id).not.toBeNull();
      // The record's conversation is opened once and reused.
      expect(b.review_thread_id).toBe(a.review_thread_id);
      expect(await db.emailThread.findUniqueOrThrow({ where: { id: a.review_thread_id! } })).toMatchObject({
        origin: 'record', record_type: 'invoice', record_id: w.invoice.id, mailbox_id: w.main,
      });
    });

    it('prefers a mailbox address over a reply address that no longer resolves, as the router always has', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.revoked.address, w.boxA.address] });
      expect(await held(providerId)).toMatchObject({ folder: 'inbox', review_reason: null, thread_id: expect.any(String) });
    });

    it('keeps a redelivery from holding the message twice', async () => {
      const w = await world();
      const first = await receive({ to: [w.handInvoiceA.address], from: FROM_SPOUSE });
      const again = await receive({ to: [w.handInvoiceA.address], from: FROM_SPOUSE, again: first });
      expect(again.res.body).toEqual({ received: true, duplicate: true });
      expect(await stored(first.providerId)).toHaveLength(1);
    });
  });

  /** A held message stored directly: for the cases about who sees it, where the intake is not what is being proved. */
  async function holdDirect(w: World, h: {
    mailbox: string; reason?: string; thread?: string | null; ts?: number; from?: string; subject?: string; auth?: 'PASS' | 'FAIL'; token?: string | null;
  }) {
    const id = randomUUID();
    await db.email.create({
      data: {
        id, organization_id: w.org, account: 'user', direction: 'in', folder: 'needs_review', unread: true,
        from: { name: 'Held Sender', email: h.from ?? 'held@example.com' }, to: 'x@mail.test.com', subject: h.subject ?? 'Held message',
        snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(h.ts ?? Date.now()),
        provider_message_id: `${EVENT_PREFIX}direct-${id}`, inbound_match: 'UNMATCHED_SENDER', inbound_auth: h.auth ?? 'PASS',
        reply_token: h.token ?? null, review_reason: h.reason ?? 'automatic', review_mailbox_id: h.mailbox, review_thread_id: h.thread ?? null,
      },
      select: { id: true },
    });
    return id;
  }

  const LIST = '/api/communication/emails/unmatched';
  const idsOf = (body: { emails: { id: string }[] }) => body.emails.map((e) => e.id);
  const listFor = async (person: Member, query = '') => (await person.api()).get(`${LIST}${query}`);
  const countsFor = async (person: Member, selected = 'mine') =>
    ((await (await person.api()).get(`/api/communication/mailboxes?selected=${selected}`)).body as { needs_review: { selected: number; total: number } }).needs_review;

  describe('the list, its visibility and its counts', () => {
    let w: World;
    const item: Record<string, string> = {};

    beforeAll(async () => {
      w = await world();
      const FROM_SPOUSE = 'Their Spouse <spouse@example.com>';
      // The seven kinds of held message, each through the real webhook route.
      item.failedA = (await held((await receive({ to: [w.boxA.address], headers: FAILED, subject: 'failed A' })).providerId)).id;
      item.autoMain = (await held((await receive({ to: [w.mainAddress], headers: { ...PASSED, Precedence: 'bulk' }, subject: 'auto main' })).providerId)).id;
      item.mismatchAutomated = (await held((await receive({ to: [w.automatedInvoice.address], from: FROM_SPOUSE })).providerId)).id;
      item.mismatchHandA = (await held((await receive({ to: [w.handInvoiceA.address], from: FROM_SPOUSE })).providerId)).id;
      item.mismatchHandC = (await held((await receive({ to: [w.handInvoiceC.address], from: FROM_SPOUSE })).providerId)).id;
      item.mismatchOrdinaryB = (await held((await receive({ to: [w.ordinaryB.address], from: FROM_SPOUSE })).providerId)).id;
      item.unknown = (await held((await receive({ to: [w.revoked.address] })).providerId)).id;
    }, 120_000);

    it('lists a person\'s own mailbox\'s items with each one\'s reason, sender, subject and the conversation it replied to', async () => {
      const res = await listFor(w.holderA, '?mailbox=mine');
      expect(res.status).toBe(200);
      expect(idsOf(res.body).sort()).toEqual([item.failedA, item.mismatchHandA].sort());
      const byId = new Map((res.body.emails as { id: string }[]).map((e) => [e.id, e as Record<string, unknown>]));
      expect(byId.get(item.failedA)).toMatchObject({
        reviewReason: 'failed_authentication', subject: 'failed A', from: { email: 'pat@example.com' }, folder: 'needs_review', linkTo: null,
      });
      expect(byId.get(item.mismatchHandA)).toMatchObject({
        reviewReason: 'sender_mismatch', from: { email: 'spouse@example.com' }, linkTo: { threadId: w.handInvoiceA.thread, subject: 'Your invoice' },
      });
      expect(res.body).toMatchObject({ total: 2, selected: 'mine', offset: 0 });
    });

    it('shows each person only the mailboxes they can see', async () => {
      expect(idsOf((await listFor(w.holderB, '?mailbox=mine')).body)).toEqual([item.mismatchOrdinaryB]);
      // Asking for a colleague\'s mailbox, or the main mailbox they do not read, answers their own list instead.
      const other = await listFor(w.holderB, `?mailbox=${w.boxA.id}`);
      expect(other.body.selected).toBe('mine');
      expect(idsOf(other.body)).toEqual([item.mismatchOrdinaryB]);
      expect(idsOf((await listFor(w.holderB, `?mailbox=${w.main}`)).body)).toEqual([item.mismatchOrdinaryB]);
    });

    it('lists the main mailbox\'s items, the unresolved ones included, to the people linked to read it', async () => {
      const res = await listFor(w.reader, `?mailbox=${w.main}`);
      expect(res.status).toBe(200);
      expect(idsOf(res.body).sort()).toEqual([item.autoMain, item.mismatchAutomated, item.unknown].sort());
      expect(res.body.selected).toBe(w.main);
      // Their own mailbox is a different list.
      expect(idsOf((await listFor(w.reader, '?mailbox=mine')).body)).toEqual([]);
      // Asked for no mailbox, it is every mailbox they can see.
      const everything = await listFor(w.reader);
      expect(idsOf(everything.body).sort()).toEqual([item.autoMain, item.mismatchAutomated, item.unknown].sort());
      expect(everything.body.selected).toBe('all');
    });

    it('shows a held reply to an invoice only to people who can open that invoice, whichever mailbox it is filed under', async () => {
      // In the main mailbox: a reader who cannot open the invoice sees the automatic mail and nothing about the invoice.
      expect(idsOf((await listFor(w.readerNoInvoice, `?mailbox=${w.main}`)).body)).toEqual([item.autoMain]);
      // In a hand-sender\'s own mailbox: the holder cannot open the invoice, so it is not theirs to read, in their own mailbox.
      expect(idsOf((await listFor(w.holderC, '?mailbox=mine')).body)).toEqual([]);
      expect(idsOf((await listFor(w.holderC)).body)).toEqual([]);
    });

    it('lists every mailbox\'s items to a reader of every mailbox, one mailbox at a time or all together', async () => {
      const all = await listFor(w.wide, '?mailbox=all');
      expect(all.status).toBe(200);
      expect(idsOf(all.body).sort()).toEqual(Object.values(item).sort());
      expect(all.body).toMatchObject({ total: 7, selected: 'all' });
      expect(idsOf((await listFor(w.wide, `?mailbox=${w.boxC.id}`)).body)).toEqual([item.mismatchHandC]);
      expect(idsOf((await listFor(w.wide, `?mailbox=${w.main}`)).body).sort()).toEqual([item.autoMain, item.mismatchAutomated, item.unknown].sort());
    });

    it('counts exactly what the list shows, for the selection and for every mailbox the person can see', async () => {
      expect(await countsFor(w.holderA)).toEqual({ selected: 2, total: 2 });
      expect(await countsFor(w.holderB)).toEqual({ selected: 1, total: 1 });
      expect(await countsFor(w.holderC)).toEqual({ selected: 0, total: 0 });
      expect(await countsFor(w.reader, w.main)).toEqual({ selected: 3, total: 3 });
      expect(await countsFor(w.reader, 'mine')).toEqual({ selected: 0, total: 3 });
      expect(await countsFor(w.readerNoInvoice, w.main)).toEqual({ selected: 1, total: 1 });
      expect(await countsFor(w.wide, 'all')).toEqual({ selected: 7, total: 7 });
      expect(await countsFor(w.wide, w.boxA.id)).toEqual({ selected: 2, total: 7 });
    });

    it('refuses the list, and every count of it, to a person without Access Communication', async () => {
      const res = await listFor(w.noAccess);
      expect(res.status).toBe(403);
      expect(res.body.emails).toBeUndefined();
      expect((await listFor(w.noAccess, `?mailbox=${w.boxA.id}`)).status).toBe(403);
      expect((await listFor(w.noAccess, '?mailbox=all')).status).toBe(403);
      expect((await (await w.noAccess.api()).get('/api/communication/mailboxes')).status).toBe(403);
    });

    it('shows nothing of another company\'s held mail to anyone', async () => {
      const other = await world();
      const stranger = await listFor(other.wide, '?mailbox=all');
      expect(stranger.status).toBe(200);
      expect(idsOf(stranger.body)).toEqual([]);
      expect(Object.values(item).some((id) => idsOf(stranger.body).includes(id))).toBe(false);
    });

    it('keeps held mail and hides it while the company\'s Email plan feature is off, then shows it again', async () => {
      const own = await world();
      const mine = await holdDirect(own, { mailbox: own.boxA.id });
      expect(idsOf((await listFor(own.holderA, '?mailbox=mine')).body)).toEqual([mine]);

      await db.organization.update({ where: { id: own.org }, data: { feature_overrides: { email: false } } });
      (await import('../middleware/authenticate.js')).clearTokenCache();
      for (const person of [own.holderA, own.wide]) {
        expect((await listFor(person)).status).toBe(402);
        expect((await (await person.api()).patch(`/api/communication/emails/${mine}/link`, {})).status).toBe(402);
      }
      expect(await db.email.count({ where: { id: mine, review_reason: { not: null } } })).toBe(1);

      await db.organization.update({ where: { id: own.org }, data: { feature_overrides: {} } });
      (await import('../middleware/authenticate.js')).clearTokenCache();
      expect(idsOf((await listFor(own.holderA)).body)).toEqual([mine]);
    });
  });

  describe('the list at scale', () => {
    it('pages 230 items newest first, each exactly once, in a constant number of statements', async () => {
      const w = await world();
      const rows = Array.from({ length: 230 }, (_, n) => ({
        id: randomUUID(), organization_id: w.org, account: 'user', direction: 'in', folder: 'needs_review', unread: true,
        from: { name: 'Bulk', email: `bulk${n}@example.com` }, to: 'x@mail.test.com', subject: `Bulk ${n}`, snippet: 's', body: ['b'], at: '1:00 PM',
        ts: BigInt(1_800_000_000_000 + n), provider_message_id: `${EVENT_PREFIX}bulk-${randomUUID()}`, inbound_match: 'UNMATCHED_NO_TOKEN' as const,
        inbound_auth: 'PASS' as const, review_reason: 'automatic', review_mailbox_id: w.boxA.id,
      }));
      await db.email.createMany({ data: rows });
      const small = await world();
      await holdDirect(small, { mailbox: small.boxA.id });

      const statementsFor = async (person: Member, query: string) => {
        const before = queries.length;
        const res = await listFor(person, query);
        expect(res.status).toBe(200);
        return { res, statements: queries.length - before };
      };
      const first = await statementsFor(w.holderA, '');
      const lone = await statementsFor(small.holderA, '');

      expect(first.res.body).toMatchObject({ total: 230, limit: 50, offset: 0 });
      expect(first.res.body.emails).toHaveLength(50);
      expect(first.statements).toBe(lone.statements);

      const seen: string[] = [];
      let last = Number.POSITIVE_INFINITY;
      for (let offset = 0; offset < 230; offset += 100) {
        const page = await listFor(w.holderA, `?limit=100&offset=${offset}`);
        expect(page.body.emails.length).toBe(Math.min(100, 230 - offset));
        for (const e of page.body.emails as { id: string; ts: number }[]) {
          expect(e.ts).toBeLessThanOrEqual(last);
          last = e.ts;
          seen.push(e.id);
        }
      }
      expect(new Set(seen).size).toBe(230);
      // The page size is capped, and a nonsense page falls back to the first.
      expect((await listFor(w.holderA, '?limit=100000')).body.emails).toHaveLength(100);
      expect((await listFor(w.holderA, '?limit=abc&offset=-5')).body).toMatchObject({ limit: 50, offset: 0 });
      expect((await countsFor(w.holderA))).toEqual({ selected: 230, total: 230 });
    });
  });

  describe('linking a held message to a conversation', () => {
    const link = async (person: Member, id: string, body: object = {}) => (await person.api()).patch(`/api/communication/emails/${id}/link`, body);

    it('files it in the conversation, with the filing rule: it joins the conversation, leaves the list and every count, and keeps its verdict', async () => {
      const w = await world();
      const id = await holdDirect(w, { mailbox: w.boxA.id, reason: 'failed_authentication', auth: 'FAIL', subject: 'Forged hello' });
      expect(await countsFor(w.holderA)).toEqual({ selected: 1, total: 1 });

      const res = await link(w.holderA, id, { thread_id: w.ordinaryA.thread });

      expect(res.status).toBe(200);
      expect(res.body.email).toMatchObject({ id, threadId: w.ordinaryA.thread, folder: 'inbox', inboundMatch: 'MATCHED', inboundAuth: 'FAIL' });
      expect(res.body.email.reviewReason).toBeUndefined();
      expect(await db.email.findUniqueOrThrow({ where: { id } })).toMatchObject({
        thread_id: w.ordinaryA.thread, folder: 'inbox', inbound_match: 'MATCHED', inbound_auth: 'FAIL',
        review_reason: null, review_mailbox_id: null, review_thread_id: null, customer_id: null,
      });
      expect(idsOf((await listFor(w.holderA)).body)).toEqual([]);
      expect(await countsFor(w.holderA)).toEqual({ selected: 0, total: 0 });
      // It now shows in the conversation, in the mailbox that holds it.
      expect(await inboxIds(w.holderA, w.boxA.id)).toContain(id);
      expect(await ringsOf(w.org)).toBe(0);
    });

    it('links a reply to the conversation it was a reply to with no choice to make', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.handInvoiceA.address], from: 'Their Spouse <spouse@example.com>' });
      const id = (await held(providerId)).id;

      const res = await link(w.holderA, id);

      expect(res.status).toBe(200);
      expect(await db.email.findUniqueOrThrow({ where: { id } })).toMatchObject({ thread_id: w.handInvoiceA.thread, review_reason: null });
      // The reply token is kept on the message, and the sender the token expects is not widened.
      expect((await db.replyToken.findUniqueOrThrow({ where: { token: w.handInvoiceA.token } })).expected_from).toBe('angel@example.com');
    });

    it('answers 400 for a message with no conversation of its own to go to and none chosen', async () => {
      const w = await world();
      const id = await holdDirect(w, { mailbox: w.boxA.id });
      const res = await link(w.holderA, id);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NO_REPLY_TOKEN');
      expect(await db.email.count({ where: { id, review_reason: { not: null } } })).toBe(1);
    });

    it('refuses a conversation the person cannot reach, and leaves the message held', async () => {
      const w = await world();
      const id = await holdDirect(w, { mailbox: w.boxA.id });
      // An ordinary conversation in the main mailbox, which they do not read.
      const inMain = randomUUID();
      await db.emailThread.create({ data: { id: inMain, organization_id: w.org, mailbox_id: w.main, origin: 'started' } });
      const unreachable = [
        w.ordinaryB.thread, // a colleague's mailbox
        inMain,
      ];
      for (const thread of unreachable) {
        const res = await link(w.holderA, id, { thread_id: thread });
        expect(res.status, thread).toBe(404);
      }
      expect(await db.email.findUniqueOrThrow({ where: { id } })).toMatchObject({ thread_id: null, review_reason: 'automatic', folder: 'needs_review' });
    });

    it('refuses a record conversation whose record the person cannot open, even in a mailbox they hold', async () => {
      const w = await world();
      const id = await holdDirect(w, { mailbox: w.boxC.id });
      expect((await link(w.holderC, id, { thread_id: w.handInvoiceC.thread })).status).toBe(404);
      // A reader of every mailbox reaches it.
      expect((await link(w.wide, id, { thread_id: w.handInvoiceC.thread })).status).toBe(200);
    });

    it('links into a record conversation whose record the person can open, in a mailbox they do not hold', async () => {
      const w = await world();
      const id = await holdDirect(w, { mailbox: w.boxA.id });
      // The automated invoice\'s conversation is in the main mailbox; holderA is on the job and can open the invoice.
      const res = await link(w.holderA, id, { thread_id: w.automatedInvoice.thread });
      expect(res.status).toBe(200);
      expect(await db.email.findUniqueOrThrow({ where: { id } })).toMatchObject({ thread_id: w.automatedInvoice.thread });
    });

    it('refuses a message the person cannot see: a colleague\'s, the main mailbox\'s for someone who does not read it, or another company\'s', async () => {
      const w = await world();
      const theirs = await holdDirect(w, { mailbox: w.boxB.id });
      const main = await holdDirect(w, { mailbox: w.main });
      const other = await world();
      const strangers = await holdDirect(other, { mailbox: other.boxA.id });
      expect((await link(w.holderA, theirs, { thread_id: w.ordinaryA.thread })).status).toBe(404);
      expect((await link(w.holderA, main, { thread_id: w.ordinaryA.thread })).status).toBe(404);
      expect((await link(w.holderA, strangers, { thread_id: w.ordinaryA.thread })).status).toBe(404);
      expect((await link(w.wide, strangers, { thread_id: w.ordinaryA.thread })).status).toBe(404);
      expect(await db.email.count({ where: { id: { in: [theirs, main, strangers] }, review_reason: { not: null } } })).toBe(3);
    });

    it('refuses a conversation of another company, and a made-up one', async () => {
      const w = await world();
      const other = await world();
      const id = await holdDirect(w, { mailbox: w.boxA.id });
      expect((await link(w.holderA, id, { thread_id: other.ordinaryA.thread })).status).toBe(404);
      expect((await link(w.wide, id, { thread_id: other.ordinaryA.thread })).status).toBe(404);
      expect((await link(w.holderA, id, { thread_id: randomUUID() })).status).toBe(404);
      expect((await link(w.holderA, id, { thread_id: 'not-an-id' })).status).toBe(400);
    });

    it('is refused to a person without Edit communication records, and without Access Communication', async () => {
      const w = await world();
      const id = await holdDirect(w, { mailbox: w.boxA.id });
      const readOnly = await (async () => {
        const key = `readonly-${++sequence}`;
        const role = await fx.addCustomRole(w.org, key, 'DISPATCHER');
        await setRoleSwitchValues({
          organizationId: w.org, roleKey: key,
          values: {
            view_jobs: true, jobs_scope: 'attached', view_customers: true, access_communication: true, show_email: true,
            view_communication: true, communication_scope: 'all', ...withDependantsOff(['edit_communication_records']),
          },
          actorId: null, reason: 'manual',
        });
        const person = await fx.addUser(w.org, key, 'DISPATCHER', { customRoleId: role.id });
        return Object.assign(person, { api: () => fx.signedInAs(person) }) as Member;
      })();
      expect((await link(readOnly, id, { thread_id: w.ordinaryA.thread })).status).toBe(403);
      // They can still open the list.
      expect((await listFor(readOnly, '?mailbox=all')).status).toBe(200);
      expect((await link(w.noAccess, id, { thread_id: w.ordinaryA.thread })).status).toBe(403);
      expect(await db.email.count({ where: { id, review_reason: { not: null } } })).toBe(1);
    });

    it('answers 404 for a message somebody else linked first', async () => {
      const w = await world();
      const id = await holdDirect(w, { mailbox: w.boxA.id });
      expect((await link(w.wide, id, { thread_id: w.ordinaryA.thread })).status).toBe(200);
      expect((await link(w.holderA, id, { thread_id: w.ordinaryA.thread })).status).toBe(404);
    });

    it('lets a reader of the main mailbox link what is filed there, and lets the people on All link in any mailbox', async () => {
      const w = await world();
      const inMain = await holdDirect(w, { mailbox: w.main });
      const inB = await holdDirect(w, { mailbox: w.boxB.id });
      expect((await link(w.reader, inMain, { thread_id: w.automatedInvoice.thread })).status).toBe(200);
      expect((await link(w.wide, inB, { thread_id: w.ordinaryB.thread })).status).toBe(200);
    });
  });

  describe('when the mailbox\'s owner leaves', () => {
    const deactivate = async (editor: Member, id: string, handoverTo?: string) =>
      (await editor.api()).patch(`/api/users/${id}`, { is_active: false, ...(handoverTo ? { handover_to: handoverTo } : {}) });

    it('moves what the mailbox held to the main mailbox\'s list, where its readers find it, with no one left holding it', async () => {
      const w = await world();
      const editor = await w.personWith('editor', { view_users: true, edit_users: true, delete_users: false });
      const id = await holdDirect(w, { mailbox: w.boxA.id, subject: 'Held for the leaver' });
      expect(idsOf((await listFor(w.reader, `?mailbox=${w.main}`)).body)).not.toContain(id);

      expect((await deactivate(editor, w.holderA.id)).status).toBe(200);

      expect(await db.email.findUniqueOrThrow({ where: { id } })).toMatchObject({ review_mailbox_id: w.main, review_reason: 'automatic' });
      expect(idsOf((await listFor(w.reader, `?mailbox=${w.main}`)).body)).toContain(id);
      expect(await countsFor(w.reader, w.main)).toEqual({ selected: 1, total: 1 });
    });

    it('leaves it where it is when the mailbox is handed to a person, who now holds it and sees it', async () => {
      const w = await world();
      const editor = await w.personWith('editor', { view_users: true, edit_users: true, delete_users: false });
      const id = await holdDirect(w, { mailbox: w.boxA.id });

      expect((await deactivate(editor, w.holderA.id, w.holderB.id)).status).toBe(200);

      expect(await db.email.findUniqueOrThrow({ where: { id } })).toMatchObject({ review_mailbox_id: w.boxA.id });
      expect(idsOf((await listFor(w.holderB, `?mailbox=${w.boxA.id}`)).body)).toContain(id);
    });
  });
});
