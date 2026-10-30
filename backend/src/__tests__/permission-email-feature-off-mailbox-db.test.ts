/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.16 - while the company's Email plan feature is off, MAILBOX mail is kept, hidden and
   silent.

   S10.6 proved it for a reply on a reply token; this proves it for mail to the company's issued addresses, a user's and the
   main one, side by side with a token reply. Every case goes through the REAL delivery webhook route (POST
   /api/webhooks/resend) with a signed fixture event, and reads the REAL routes afterwards; only the call that fetches the
   received message from the provider is replaced, so nothing is sent or received from this machine. The bell and the live-update
   ping are watched, never stopped.

   What is proved, each against the real tables:
     - with the feature off, mail to a user address and to the main address is stored in the right mailbox, in a conversation of
       its own, unread and with its arrival date; its ledger row is kept; it rings nobody (no bell, no ping, no alert chain, so
       no "nobody to tell" line); and it shows in no list, folder, mailbox list, Needs review list, single read, attachment link,
       record tab or customer tab, and in no count (the badge says 0);
     - mail to an address that was never issued is still dropped, with a ledger row that holds no content;
     - when the feature returns the same rows appear in their mailboxes unread with their original dates, count again, and still
       ring nobody (nothing runs at switch-on, and a redelivery of an event kept meanwhile rings nobody either);
     - a NEW message after the feature returns is delivered and rings as normal;
     - the company's "Send emails to customers and staff" switch is a sending rule: with only that off, mail is received and rings.

   People are on custom roles (never a built-in role name) holding exactly the switch values under test. The company's Admin
   box is always in the company. Real migrated database (TEST_DATABASE_URL), on the hosted database's ONE-connection pool; the
   suite skips when it is unset. Every org it creates is removed.
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
const EVENT_PREFIX = 'rp-s10-16-';

suite('mailbox mail while the Email plan feature is off: kept, hidden and silent (real database, real webhook route)', () => {
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

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values, with the Email page open. */
  async function personWith(org: string, scope: 'all' | 'attached'): Promise<Who> {
    const key = `ff-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, view_invoices: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: scope,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /**
   * A company with its main mailbox and main address; a holder with a mailbox and address of their own; a person linked to the
   * main mailbox; a person who reads every mailbox; and a customer with an estimate conversation open on a job (a reply token
   * the customer can answer on), so the record tabs and the customer tab have mail of their own to show.
   */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, tag, customer, admin } = made;

    const main = randomUUID();
    await db.mailbox.create({ data: { id: main, organization_id: org, kind: 'main', status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `main-${tag}`, organization_id: org, mailbox_id: main, is_primary: true } });
    const holder = await personWith(org, 'attached');
    const holderBox = await fx.addUserMailbox(org, holder);
    const linked = await personWith(org, 'attached');
    await fx.addUserMailbox(org, linked);
    await db.mailboxReader.create({ data: { organization_id: org, mailbox_id: main, user_id: linked.id } });
    const wide = await personWith(org, 'all');

    const customerEmail = `pat-${tag}@example.com`;
    await db.customer.update({ where: { id: customer }, data: { email: customerEmail } });
    const job = await fx.addJob(org, customer, { crew: [holder.id] });
    const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
    const openThread = randomUUID();
    await db.emailThread.create({
      data: { id: openThread, organization_id: org, mailbox_id: main, origin: 'record', record_type: 'estimate', record_id: estimate.id },
    });
    const sent = randomUUID();
    await db.email.create({
      data: {
        id: sent, organization_id: org, thread_id: openThread, customer_id: customer, job_id: job.id,
        account: 'system', direction: 'out', folder: 'sent', from: { name: null, email: 'office@example.com' }, to: customerEmail,
        subject: 'Your estimate', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now() - 86_400_000),
      },
      select: { id: true },
    });
    const replyToken = randomBytes(16).toString('base64url');
    await db.replyToken.create({
      data: {
        token: replyToken, organization_id: org, thread_id: openThread, entity_type: 'estimate', entity_id: estimate.id,
        customer_id: customer, expected_from: customerEmail,
      },
    });

    return {
      org, tag, customer, admin: Object.assign(admin, { api: () => fx.signedInAs(admin) }) as Who, job, holder, holderBox, linked, wide,
      main, openThread, sent, replyToken, customerEmail,
      userAddress: `${holder.email.split('@')[0]!.toLowerCase()}@${MAILBOX_DOMAIN}`,
      mainAddress: `main-${tag}@${MAILBOX_DOMAIN}`,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** The company's Email plan feature, the way ServWave turns it off for one company. */
  const setEmailFeature = async (org: string, on: boolean) => {
    await db.organization.update({ where: { id: org }, data: { feature_overrides: on ? {} : { email: false } } });
    clearTokenCache();
  };

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
    /** Repeat a delivery: the same provider event id (and so the same received message). */
    again?: { eventId: string; providerId: string };
  }

  /** One `email.received` event through the real route. */
  async function receive(d: Delivery) {
    const providerId = d.again?.providerId ?? `${EVENT_PREFIX}rcv-${randomUUID()}`;
    const eventId = d.again?.eventId ?? `${EVENT_PREFIX}evt-${randomUUID()}`;
    const from = d.from ?? 'Pat Payer <pat@example.com>';
    const subject = d.subject ?? 'Quick question';
    fetchReceived.mockResolvedValue({
      providerId, from, receivedFor: d.to, to: d.to, subject,
      messageId: `<${providerId}@mail.example.com>`, receivedAt: ARRIVED, text: 'Are you open on Saturday?',
      html: '<div>Are you open on Saturday?</div>',
      headers: { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' },
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

  const storedCopy = async (providerId: string) => {
    const [row, ...rest] = await db.email.findMany({ where: { provider_message_id: { startsWith: providerId } } });
    expect(rest).toEqual([]);
    return row!;
  };
  const threadOf = (row: { thread_id: string | null }) => db.emailThread.findUniqueOrThrow({ where: { id: row.thread_id! } });
  const ringsOf = (org: string) => db.notification.count({ where: { organization_id: org } });
  const rungFor = (person: Person) => db.notificationRecipient.count({ where: { recipient_id: person.id, notification: { verb: 'communication.email_inbound' } } });
  const tabIds = (body: { items: { id: string; channel: string }[] }) => body.items.filter((i) => i.channel === 'email').map((i) => i.id);

  /** One of each kind of mail a company gets: to a user address, to the main address, and a customer's answer on a reply token. */
  async function receiveAll(w: World) {
    const user = await receive({ to: [w.userAddress], subject: 'For the holder' });
    const mainMail = await receive({ to: [w.mainAddress], subject: 'For the office' });
    const reply = await receive({ to: [`${w.replyToken}@reply.test.com`], from: `Pat Payer <${w.customerEmail}>`, subject: 'Re: Your estimate' });
    return { user, mainMail, reply };
  }

  describe('with the feature off', () => {
    it('stores mail to a user address and to the main address in the right mailbox and a conversation of its own, unread, with its arrival date and its ledger row', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);

      const { user, mainMail, reply } = await receiveAll(w);

      for (const sent of [user, mainMail, reply]) expect(sent.res.status).toBe(200);
      const userRow = await storedCopy(user.providerId);
      const mainRow = await storedCopy(mainMail.providerId);
      expect(userRow).toMatchObject({ unread: true, direction: 'in', folder: 'inbox', organization_id: w.org, customer_id: null });
      expect(mainRow).toMatchObject({ unread: true, direction: 'in', folder: 'inbox', organization_id: w.org, customer_id: null });
      expect(await threadOf(userRow)).toMatchObject({ mailbox_id: w.holderBox, origin: 'started', assigned_to_user_id: null });
      expect(await threadOf(mainRow)).toMatchObject({ mailbox_id: w.main, origin: 'started', assigned_to_user_id: null });
      expect(userRow.thread_id).not.toBe(mainRow.thread_id);
      // The customer's answer joined the conversation it answers.
      expect(await storedCopy(reply.providerId)).toMatchObject({ thread_id: w.openThread, inbound_match: 'MATCHED', unread: true });
      for (const row of [userRow, mainRow, await storedCopy(reply.providerId)]) expect(Number(row.ts)).toBe(ARRIVED.getTime());
      // The kept mail keeps its whole ledger row.
      for (const sent of [user, mainMail, reply]) {
        const [ledger] = await db.resendEvent.findMany({ where: { resend_event_id: sent.eventId } });
        expect(ledger?.payload, sent.eventId).not.toBeNull();
      }
    });

    it('rings nobody: no bell, no copy, no live-update ping, no alert chain and so no "nobody to tell" line', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);
      const warn = vi.spyOn(logger, 'warn');
      const info = vi.spyOn(logger, 'info');
      try {
        const sent = await receiveAll(w);

        expect(emitSpy).not.toHaveBeenCalled();
        expect(publishEmailsSpy).not.toHaveBeenCalled();
        expect(await ringsOf(w.org)).toBe(0);
        expect(await db.notificationRecipient.count({ where: { organization_id: w.org } })).toBe(0);
        const lines = [...warn.mock.calls, ...info.mock.calls].map(([line]) => String(line));
        expect(lines.filter((line) => /nobody/i.test(line))).toEqual([]);
        // The webhook says why it did not ring, naming no sender, recipient or subject.
        for (const { providerId } of [sent.user, sent.mainMail, sent.reply]) {
          const kept = lines.filter((line) => line.includes(providerId));
          expect(kept, providerId).toHaveLength(1);
          expect(kept[0]).toContain('kept without an alert');
          expect(kept[0]).not.toMatch(/pat@|Saturday|holder|For the/);
        }
      } finally {
        warn.mockRestore();
        info.mockRestore();
      }
    });

    it('shows it nowhere, to the Admin box or to anyone: no list, folder, mailbox list, Needs review list, single read or attachment link', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);
      const { user, mainMail, reply } = await receiveAll(w);
      const kept = [await storedCopy(user.providerId), await storedCopy(mainMail.providerId), await storedCopy(reply.providerId)].map((r) => r.id);

      for (const person of [w.admin, w.wide, w.holder, w.linked]) {
        const api = await person.api();
        const paths = [
          '/api/communication/emails', '/api/communication/emails?mailbox=all', '/api/communication/emails?mailbox=mine',
          `/api/communication/emails?mailbox=${w.main}`, `/api/communication/emails?mailbox=${w.holderBox}`,
          '/api/communication/emails?folder=inbox', '/api/communication/emails?folder=sent', '/api/communication/emails?folder=starred',
          '/api/communication/emails?assignment=unassigned', '/api/communication/emails/unmatched', '/api/communication/mailboxes',
          '/api/communication/my-mailbox',
          ...kept.flatMap((id) => [`/api/communication/emails/${id}`, `/api/communication/emails/${id}/attachments/0`]),
        ];
        for (const path of paths) {
          const res = await api.get(path);
          expect(res.status, path).toBe(402);
          expect(res.body.error, path).toBe('FEATURE_NOT_IN_PLAN');
          expect(JSON.stringify(res.body), path).not.toMatch(/Saturday|pat@|For the holder|For the office/);
        }
      }
    });

    it('shows it in no record tab or customer tab and in no count: the badge says 0 for everybody', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);
      await receiveAll(w);

      for (const person of [w.admin, w.wide, w.holder, w.linked]) {
        const api = await person.api();
        const badge = await api.get('/api/communication/unread-counts');
        expect(badge.status).toBe(200);
        expect(badge.body.email).toBe(0);
        for (const path of [`/api/jobs/${w.job.id}/communications`, `/api/customers/${w.customer}/communications`]) {
          const tab = await api.get(path);
          // A person who may not open the record is refused; one who may sees no email on it, sent or received.
          if (tab.status === 200) expect(tabIds(tab.body), path).toEqual([]);
          else expect([403, 404], path).toContain(tab.status);
        }
      }
      // The Admin box, who can open every record, is the proof that the tabs open and merely hold no email.
      const admin = await w.admin.api();
      for (const path of [`/api/jobs/${w.job.id}/communications`, `/api/customers/${w.customer}/communications`]) {
        const tab = await admin.get(path);
        expect(tab.status, path).toBe(200);
        expect(tabIds(tab.body), path).toEqual([]);
      }
    });

    it('still drops mail to an address that was never issued: the body is not fetched and the ledger row holds no content', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);

      const { res, eventId } = await receive({ to: [`never.issued.${w.tag}@${MAILBOX_DOMAIN}`], subject: 'Secret subject' });

      expect(res.status).toBe(200);
      expect(fetchReceived).not.toHaveBeenCalled();
      const [ledger] = await db.resendEvent.findMany({ where: { resend_event_id: eventId } });
      expect(ledger).toBeDefined();
      expect(ledger!.payload).toBeNull();
      expect(await db.email.count({ where: { organization_id: w.org, direction: 'in' } })).toBe(0);
    });
  });

  describe('cost, on the hosted database\'s one-connection pool', () => {
    it('asks for the company\'s plan once for a delivery, however many of its mailboxes the message names, and not at all for a dropped one', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);
      const planReads = async (d: Delivery) => {
        await settle();
        queries.length = 0;
        await receive(d);
        return queries.filter((q) => /FROM "public"\."organizations"/.test(q) && /"trial_ends_at"/.test(q)).length;
      };

      const one = await planReads({ to: [w.userAddress] });
      const two = await planReads({ to: [w.userAddress, w.mainAddress] });
      const dropped = await planReads({ to: [`never.issued.${w.tag}@${MAILBOX_DOMAIN}`] });

      expect(one).toBe(1);
      expect(two).toBe(one);
      expect(dropped).toBe(0);
    });
  });

  describe('when the feature is turned back on', () => {
    it('shows the kept mail unread with its original arrival dates, in its own mailbox and counted, and rings nobody for it', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);
      const { user, mainMail, reply } = await receiveAll(w);
      const ids = {
        user: (await storedCopy(user.providerId)).id,
        main: (await storedCopy(mainMail.providerId)).id,
        reply: (await storedCopy(reply.providerId)).id,
      };
      expect(await ringsOf(w.org)).toBe(0);

      await setEmailFeature(w.org, true);

      const listed = async (person: Who, query: string) => {
        const res = await (await person.api()).get(`/api/communication/emails${query}`);
        expect(res.status, query).toBe(200);
        return new Map((res.body.emails as { id: string; unread: boolean; folder: string; ts: number | string }[]).map((e) => [e.id, e]));
      };
      // The holder finds the user-address mail in their mailbox, unread and with its original date.
      const holderSees = await listed(w.holder, `?mailbox=${w.holderBox}`);
      expect(holderSees.get(ids.user)).toMatchObject({ unread: true });
      expect(Number(holderSees.get(ids.user)!.ts)).toBe(ARRIVED.getTime());
      expect(holderSees.has(ids.main)).toBe(false);
      // The person linked to the main mailbox finds the main-address mail in it.
      const linkedSees = await listed(w.linked, `?mailbox=${w.main}`);
      expect(linkedSees.get(ids.main)).toMatchObject({ unread: true });
      expect(Number(linkedSees.get(ids.main)!.ts)).toBe(ARRIVED.getTime());
      expect(linkedSees.has(ids.user)).toBe(false);
      // A reader of every mailbox finds all of it, and the folders list it.
      const wideSees = await listed(w.wide, '?mailbox=all');
      for (const id of Object.values(ids)) expect(wideSees.get(id), id).toMatchObject({ unread: true });
      const inbox = await listed(w.wide, '?mailbox=all&folder=inbox');
      for (const id of Object.values(ids)) expect(inbox.has(id), id).toBe(true);
      const single = await (await w.holder.api()).get(`/api/communication/emails/${ids.user}`);
      expect(single.status).toBe(200);

      // The badge counts it again, for each reader, as many as they may read.
      const badge = async (person: Who) => (await (await person.api()).get('/api/communication/unread-counts')).body.email as number;
      // Each reader's badge is the unread conversations their own list holds, whichever mailbox they are asking about.
      for (const [person, sees] of [[w.holder, holderSees], [w.linked, linkedSees]] as const) {
        const own = await listed(person, '');
        expect(await badge(person)).toBe([...own.values()].filter((e) => e.unread && e.folder === 'inbox').length);
      }
      expect(await badge(w.holder)).toBeGreaterThanOrEqual(1);
      expect(await badge(w.linked)).toBeGreaterThanOrEqual(1);
      expect(await badge(w.wide)).toBe(3);
      const boxes = await (await w.wide.api()).get('/api/communication/mailboxes');
      expect(boxes.status).toBe(200);
      expect(boxes.body.total_unread).toBe(3);

      // The customer's answer is back on the job's tab and the customer's tab; the mailbox mail is linked to no record or customer.
      const admin = await w.admin.api();
      const jobTab = tabIds((await admin.get(`/api/jobs/${w.job.id}/communications`)).body);
      expect(jobTab).toEqual(expect.arrayContaining([w.sent, ids.reply]));
      expect(jobTab).not.toContain(ids.user);
      expect(jobTab).not.toContain(ids.main);
      const customerTab = tabIds((await admin.get(`/api/customers/${w.customer}/communications`)).body);
      expect(customerTab).toContain(ids.reply);
      expect(customerTab).not.toContain(ids.user);
      expect(customerTab).not.toContain(ids.main);

      // Nothing rang when the feature came back, and the dates are the ones the mail came with.
      expect(emitSpy).not.toHaveBeenCalled();
      expect(publishEmailsSpy).not.toHaveBeenCalled();
      expect(await ringsOf(w.org)).toBe(0);
      for (const id of Object.values(ids)) expect(Number((await db.email.findUniqueOrThrow({ where: { id } })).ts)).toBe(ARRIVED.getTime());
    });

    it('rings nobody when the provider redelivers an event that was kept while the feature was off', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);
      const first = await receive({ to: [w.mainAddress] });
      await setEmailFeature(w.org, true);

      const again = await receive({ to: [w.mainAddress], again: { eventId: first.eventId, providerId: first.providerId } });

      expect(again.res.body).toMatchObject({ received: true, duplicate: true });
      expect(await db.email.count({ where: { provider_message_id: { startsWith: first.providerId } } })).toBe(1);
      expect(emitSpy).not.toHaveBeenCalled();
      expect(await ringsOf(w.org)).toBe(0);
    });

    it('delivers and rings a NEW message as normal, while the one kept before it still has no bell', async () => {
      const w = await world();
      await setEmailFeature(w.org, false);
      const kept = await receive({ to: [w.userAddress], subject: 'Sent while off' });
      const keptMain = await receive({ to: [w.mainAddress], subject: 'Sent to the office while off' });
      await setEmailFeature(w.org, true);

      const fresh = await receive({ to: [w.userAddress], subject: 'Sent after' });
      const freshMain = await receive({ to: [w.mainAddress], subject: 'Sent to the office after' });

      expect(await db.notification.count({ where: { organization_id: w.org, dedup_key: `email_inbound:${fresh.providerId}` } })).toBe(1);
      expect(await db.notification.count({ where: { organization_id: w.org, dedup_key: `email_inbound:${freshMain.providerId}` } })).toBe(1);
      expect(await rungFor(w.holder)).toBe(1);
      expect(await rungFor(w.linked)).toBe(1);
      // Only the new mail rang.
      for (const old of [kept, keptMain]) {
        expect(await db.notification.count({ where: { organization_id: w.org, dedup_key: { startsWith: `email_inbound:${old.providerId}` } } })).toBe(0);
      }
      expect(await ringsOf(w.org)).toBe(2);
      expect(publishEmailsSpy).toHaveBeenCalledTimes(2);
      // All four are in the holder's and the main mailbox, the new ones with the same standing as the kept ones.
      const holderList = await (await w.holder.api()).get(`/api/communication/emails?mailbox=${w.holderBox}`);
      expect((holderList.body.emails as { id: string }[]).map((e) => e.id)).toEqual(expect.arrayContaining([
        (await storedCopy(kept.providerId)).id, (await storedCopy(fresh.providerId)).id,
      ]));
    });
  });

  describe('the company switch "Send emails to customers and staff"', () => {
    it('is a sending rule: with only it off, mail to a user address and to the main address is received, listed and rings as normal', async () => {
      const w = await world();
      await db.organization.update({ where: { id: w.org }, data: { email_sending_enabled: false } });
      await setEmailFeature(w.org, true);

      const user = await receive({ to: [w.userAddress] });
      const mainMail = await receive({ to: [w.mainAddress] });

      expect(await rungFor(w.holder)).toBe(1);
      expect(await rungFor(w.linked)).toBe(1);
      expect(await ringsOf(w.org)).toBe(2);
      const holderList = await (await w.holder.api()).get(`/api/communication/emails?mailbox=${w.holderBox}`);
      expect(holderList.status).toBe(200);
      expect((holderList.body.emails as { id: string }[]).map((e) => e.id)).toContain((await storedCopy(user.providerId)).id);
      const linkedList = await (await w.linked.api()).get(`/api/communication/emails?mailbox=${w.main}`);
      expect((linkedList.body.emails as { id: string }[]).map((e) => e.id)).toContain((await storedCopy(mainMail.providerId)).id);
    });
  });
});
