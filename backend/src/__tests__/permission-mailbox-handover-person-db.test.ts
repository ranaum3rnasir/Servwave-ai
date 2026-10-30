/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.22 - hand a mailbox to a person, and move it later.

   Every case goes through the REAL routes: the deactivate action (DELETE /api/users/:id), the later move
   (PUT /api/users/:id/mailbox-handover), the Email page's reads, the real dispatcher (only the mail provider's client is
   replaced, so the headers that "went out" are read back) and the REAL signed delivery webhook for mail that arrives (only
   the call that fetches the received message from the provider is replaced). Nothing is sent or received from this machine.
   The people are on custom roles holding exactly the switch values under test, never a built-in role name.

   What is proved, each against the real tables:
     - handed to a person: listed under the owner's name, read in full, a reply goes from the HOLDER'S own address and display
       name (never the leaver's), the reply token keeps the conversation, the customer's answer through the signed webhook
       lands back in it and rings the holder; mail to the leaver's address lands in the holder's view and rings them; a record
       conversation still follows its record (Invoices View off cannot open it through the held mailbox);
     - a later move person -> person, person -> main and main -> person carries the conversations and the addresses, restores
       what the merge changed, and the previous holder loses it on the very next request;
     - a person who leaves while holding someone else's mailbox hands that one on too, with their own;
     - a later move is refused to a non-Admin, for an active owner, for a target that is no active person, and across
       companies; the Users list says where a leaver's mailbox went;
     - the whole move runs on a ONE-connection pool (the hosted database's) and costs the same statements for 0 or 1,000
       conversations.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import type { PrismaClient, Role } from '@prisma/client';

const { clientPromise, fetchReceived, resendSend, queries } = vi.hoisted(() => {
  const queries: string[] = [];
  const clientPromise = (async () => {
    const dbUrl = process.env.TEST_DATABASE_URL;
    if (!dbUrl) return undefined;
    const { PrismaClient } = await import('@prisma/client');
    // The hosted database's pool: ONE connection and a short wait, so a query on the global client made inside a move's
    // transaction fails here in seconds instead of on the hosted database.
    const pooled = new URL(dbUrl);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '4');
    const client = new PrismaClient({ datasources: { db: { url: pooled.toString() } }, log: [{ emit: 'event', level: 'query' }] });
    (client as unknown as { $on(e: 'query', cb: (q: { query: string }) => void): void }).$on('query', (q) => queries.push(q.query));
    return client;
  })();
  return { clientPromise, fetchReceived: vi.fn(), resendSend: vi.fn(), queries };
});

// The suite-wide setup mocks the app's client; here it is the real one, on the hosted pool.
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));

// The provider call that fetches a received message is the only inbound thing replaced.
vi.mock('../lib/inbound-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inbound-email')>()),
  fetchReceivedEmail: fetchReceived,
}));

// Only the mail provider's client is faked; the real dispatcher runs, with its key set BEFORE it loads (it builds its client at load).
// The webhook's signature check is the SDK's own, so only the send is replaced on the real class.
vi.mock('resend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('resend')>();
  return {
    ...actual,
    Resend: class extends actual.Resend {
      emails = { send: resendSend } as never;
    },
  };
});
vi.mock('../lib/email', async (importOriginal) => {
  const { env } = await import('../config/env.js');
  Object.assign(env, { RESEND_API_KEY: 're_test_key', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com' });
  return importOriginal();
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { env } from '../config/env';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SECRET_BYTES = randomBytes(24);
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const MAILBOX_DOMAIN = 'mail.test.com';
const ARRIVED = new Date('2026-07-01T15:00:00.000Z');
const EVENT_PREFIX = 'rp-s10-22-';

suite('handing a mailbox to a person, and moving it later (real database, real routes and webhook)', () => {
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
    fetchReceived.mockReset();
    resendSend.mockReset();
    resendSend.mockImplementation(async () => ({ data: { id: `re_${randomUUID()}` }, error: null }));
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api>; first: string };
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

  /** A person on a fresh custom role holding exactly the switch values under test, with the Email page open and a mailbox of their own. */
  async function personWith(org: string, values: Record<string, boolean | string> = {}, opts: { name?: string; mailbox?: boolean } = {}): Promise<Who> {
    const key = `ph-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER' as Role);
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
    const first = opts.name ?? `P${sequence}`;
    const person = await fx.addUser(org, first, 'DISPATCHER', { customRoleId: role.id, isAdmin: asAdmin === true });
    if (opts.mailbox !== false) await fx.addUserMailbox(org, person);
    return Object.assign(person, { first, api: () => fx.signedInAs(person) });
  }

  /** A conversation in `mailboxId` with the messages given (one unread inbound message when none are), and a reply token for it. */
  async function addConversation(
    org: string, mailboxId: string, customer: string,
    conv: { origin?: string; record?: { type: string; id: string }; untied?: boolean; messages?: { direction?: 'in' | 'out'; jobId?: string }[] } = {},
  ) {
    const thread = randomUUID();
    await db.emailThread.create({
      data: {
        id: thread, organization_id: org, mailbox_id: mailboxId, origin: conv.origin ?? (conv.record ? 'record' : 'started'),
        record_type: conv.record?.type ?? null, record_id: conv.record?.id ?? null,
      },
    });
    const ids: string[] = [];
    for (const m of conv.messages ?? [{}]) {
      const id = randomUUID();
      const out = m.direction === 'out';
      await db.email.create({
        data: {
          id, organization_id: org, thread_id: thread, customer_id: conv.untied ? null : customer, job_id: m.jobId ?? null,
          account: 'user', direction: out ? 'out' : 'in', folder: out ? 'sent' : 'inbox',
          from: { name: null, email: out ? 'office@example.com' : 'customer@example.com' },
          to: out ? 'customer@example.com' : 'office@example.com',
          subject: 'run-person-handover', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
        select: { id: true },
      });
      ids.push(id);
    }
    return { thread, ids, first: ids[0]! };
  }

  /**
   * A company with its main mailbox; the person who moves mailboxes (an Admin); a reader of the main
   * mailbox; a leaver with a mailbox and an address who holds a started conversation and an invoice conversation; two people
   * who could take the mailbox over (each with an address of their own); and a stranger.
   */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, tag, customer, admin } = made;
    await db.organization.update({ where: { id: org }, data: { email_sending_enabled: true, email_sender_local_part: `co${tag}` }, select: { id: true } });

    const main = randomUUID();
    await db.mailbox.create({ data: { id: main, organization_id: org, kind: 'main', status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `co${tag}`, organization_id: org, mailbox_id: main, is_primary: true } });

    const editor = await personWith(org, { view_users: true, is_admin: true });
    const reader = await personWith(org);
    await db.mailboxReader.create({ data: { organization_id: org, mailbox_id: main, user_id: reader.id } });
    const heir = await personWith(org, {}, { name: 'Hank' });
    const second = await personWith(org, {}, { name: 'Sam' });
    const stranger = await personWith(org);

    const leaver = await fx.addUser(org, 'Jane', 'SALES');
    const leaverBox = await fx.addUserMailbox(org, leaver);
    const leaverAddress = `${leaver.email.split('@')[0]!.toLowerCase()}@${MAILBOX_DOMAIN}`;

    const job = await fx.addJob(org, customer, { crew: [heir.id, second.id, stranger.id] });
    const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
    const started = await addConversation(org, leaverBox, customer, { messages: [{ direction: 'in' }, { direction: 'out' }] });
    const invoiceMail = await addConversation(org, leaverBox, customer, {
      record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }],
    });
    // Mail from an address that is no customer's: no record to reach it through, so only the mailbox decides who reads it.
    const untied = await addConversation(org, leaverBox, customer, { untied: true });
    const inMain = await addConversation(org, main, customer);

    return {
      org, tag, customer, admin, main, company: `switches-${tag}`, editor, reader, heir, second, stranger,
      leaver, leaverBox, leaverAddress, job, invoice, started, invoiceMail, untied, inMain,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const mailboxRow = (id: string) => db.mailbox.findUniqueOrThrow({ where: { id } });
  const threadRow = (id: string) => db.emailThread.findUniqueOrThrow({ where: { id } });
  const userRow = (id: string) => db.user.findUniqueOrThrow({ where: { id } });

  const deactivate = async (w: World, who: Person, handoverTo?: string) =>
    (await w.editor.api()).delete(`/api/users/${who.id}`, handoverTo === undefined ? undefined : { handover_to: handoverTo });
  const move = async (by: Who, ownerId: string, handoverTo: unknown) =>
    (await by.api()).put(`/api/users/${ownerId}/mailbox-handover`, { handover_to: handoverTo });

  const listedIds = async (person: Person, query: string) => {
    const res = await (await fx.signedInAs(person)).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };
  const opens = async (person: Person, id: string) =>
    (await (await fx.signedInAs(person)).get(`/api/communication/emails/${id}`)).status === 200;
  const heldIds = async (person: Person) => {
    const res = await (await fx.signedInAs(person)).get('/api/communication/mailboxes');
    expect(res.status).toBe(200);
    return (res.body.held as { id: string }[]).map((m) => m.id);
  };

  const signed = (svixId: string, body: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET_BYTES).update(`${svixId}.${timestamp}.${body}`).digest('base64');
    return { 'svix-id': svixId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
  };

  /** One `email.received` event through the real route, from a known customer's address, to `to`. */
  async function receive(to: string, from = 'Pat Payer <pat@example.com>') {
    const providerId = `${EVENT_PREFIX}rcv-${randomUUID()}`;
    const eventId = `${EVENT_PREFIX}evt-${randomUUID()}`;
    fetchReceived.mockResolvedValue({
      providerId, from, receivedFor: [to], to: [to], subject: 'Quick question',
      messageId: `<${providerId}@mail.example.com>`, receivedAt: ARRIVED, text: 'Are you open on Saturday?',
      html: '<div>Are you open on Saturday?</div>',
      headers: { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' },
    });
    const body = JSON.stringify({
      type: 'email.received', created_at: ARRIVED.toISOString(),
      data: {
        email_id: providerId, created_at: ARRIVED.toISOString(), from, to: [to], cc: [], bcc: [], received_for: [to],
        message_id: `<${providerId}@mail.example.com>`, subject: 'Quick question', attachments: [],
      },
    });
    const res = await request(app).post('/api/webhooks/resend').set('Content-Type', 'application/json').set(signed(eventId, body)).send(body);
    expect(res.status).toBe(200);
    // The webhook answers first and announces after: read the bells once the database has been quiet for a moment.
    let seen = -1;
    for (let waited = 0; waited < 10_000 && seen !== queries.length; waited += 250) {
      seen = queries.length;
      await new Promise((r) => setTimeout(r, 250));
    }
    const [stored, ...rest] = await db.email.findMany({ where: { provider_message_id: { startsWith: providerId } } });
    expect(rest).toEqual([]);
    return { providerId, stored: stored! };
  }

  async function ringed(providerId: string) {
    const rows = await db.notification.findMany({
      where: { dedup_key: { in: [`email_inbound:${providerId}`, `email_inbound:${providerId}:why`] } },
      select: { recipients: { select: { recipient_id: true } } },
    });
    return rows.flatMap((r) => r.recipients.map((x) => x.recipient_id)).sort();
  }

  /** The message the mocked provider was last given. */
  const lastSent = () => resendSend.mock.calls.at(-1)![0] as { from: string; replyTo: string; to: string };
  const headerOf = (header: string) => {
    const m = /^"(.*)" <(.*)>$/.exec(header)!;
    return { name: m[1]!, address: m[2]! };
  };

  describe('handed to a person on deactivation', () => {
    it('lists the mailbox under the owner\'s name for the holder, and for nobody else', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);

      const res = await (await w.heir.api()).get('/api/communication/mailboxes');
      expect(res.status).toBe(200);
      expect(res.body.held).toEqual([expect.objectContaining({ id: w.leaverBox, name: 'Jane Tester' })]);
      expect(res.body.mine.id).not.toBe(w.leaverBox);
      const asked = await (await w.heir.api()).get(`/api/communication/mailboxes?selected=${w.leaverBox}`);
      expect(asked.body).toMatchObject({ selected: w.leaverBox, selected_label: "Jane Tester's mailbox" });
      for (const other of [w.stranger, w.second, w.reader]) expect(await heldIds(other)).toEqual([]);
    });

    it('lets the holder read all of it, and no one else', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);

      const listed = await listedIds(w.heir, `?mailbox=${w.leaverBox}`);
      expect(listed).toEqual(expect.arrayContaining([...w.started.ids, ...w.invoiceMail.ids]));
      expect(listed).not.toContain(w.inMain.first);
      for (const id of [...w.started.ids, ...w.invoiceMail.ids, ...w.untied.ids]) expect(await opens(w.heir, id), `holder ${id}`).toBe(true);
      for (const other of [w.stranger, w.second, w.reader]) {
        expect(await opens(other, w.untied.first), `${other.first} opens`).toBe(false);
        expect(await listedIds(other, '')).not.toContain(w.untied.first);
      }
    });

    it('keeps a record conversation behind its record: a holder with Invoices View off cannot open the invoice mail through the held mailbox', async () => {
      const w = await world();
      const noInvoices = await personWith(w.org, withDependantsOff(['view_invoices']));
      expect((await deactivate(w, w.leaver, noInvoices.id)).status).toBe(200);

      for (const id of w.started.ids) expect(await opens(noInvoices, id), `ordinary ${id}`).toBe(true);
      for (const id of w.invoiceMail.ids) expect(await opens(noInvoices, id), `invoice ${id}`).toBe(false);
      expect(await listedIds(noInvoices, `?mailbox=${w.leaverBox}`)).not.toEqual(expect.arrayContaining(w.invoiceMail.ids));
    });

    it('sends a reply from the HOLDER\'S own address and display name, never the leaver\'s, and keeps it in the conversation', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);

      const res = await (await w.heir.api()).post('/api/communication/emails', {
        to: 'customer@example.com', subject: 'Re: Quick question', body: ['Yes, we are.'], thread_id: w.started.thread,
      });
      expect(res.status).toBe(201);

      const header = headerOf(lastSent().from);
      const heirAddress = `${w.heir.email.split('@')[0]!.toLowerCase()}@${MAILBOX_DOMAIN}`;
      expect(header).toEqual({ name: `Hank Tester at ${w.company}`, address: heirAddress });
      expect(lastSent().from).not.toMatch(/jane/i);
      const stored = await db.email.findUniqueOrThrow({ where: { id: res.body.email.id } });
      expect(stored.from).toEqual({ name: header.name, email: header.address });
      expect(stored.thread_id).toBe(w.started.thread);
      expect((await threadRow(w.started.thread)).mailbox_id).toBe(w.leaverBox);
    });

    it('brings the customer\'s answer to that reply back into the held conversation, and rings the holder', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);
      expect((await (await w.heir.api()).post('/api/communication/emails', {
        to: 'pat@example.com', subject: 'Re: Quick question', body: ['Yes, we are.'], thread_id: w.started.thread,
      })).status).toBe(201);

      const { providerId, stored } = await receive(lastSent().replyTo, 'Pat Payer <pat@example.com>');

      expect(stored.thread_id).toBe(w.started.thread);
      expect((await threadRow(w.started.thread)).mailbox_id).toBe(w.leaverBox);
      expect(await ringed(providerId)).toEqual([w.heir.id]);
      expect(await listedIds(w.heir, `?mailbox=${w.leaverBox}`)).toContain(stored.id);
    });

    it('lands mail to the leaver\'s address in the holder\'s view, and rings the holder and nobody else', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);

      const { providerId, stored } = await receive(w.leaverAddress);

      expect(await threadRow(stored.thread_id!)).toMatchObject({ mailbox_id: w.leaverBox, origin: 'started' });
      expect(await ringed(providerId)).toEqual([w.heir.id]);
      expect(await listedIds(w.heir, `?mailbox=${w.leaverBox}`)).toContain(stored.id);
      expect(await listedIds(w.reader, `?mailbox=${w.main}`)).not.toContain(stored.id);
    });
  });

  describe('a later move', () => {
    it('hands a mailbox from one person to another: conversations and address come along, and the first holder loses it on the next request', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);
      expect(await heldIds(w.heir)).toEqual([w.leaverBox]);
      expect(await opens(w.heir, w.untied.first)).toBe(true);

      const res = await move(w.editor, w.leaver.id, w.second.id);

      expect(res.status).toBe(200);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: w.second.id, user_id: w.leaver.id, merged_into_mailbox_id: null });
      // The very next request: the first holder has lost it, the second holds it.
      expect(await heldIds(w.heir)).toEqual([]);
      expect(await opens(w.heir, w.untied.first)).toBe(false);
      expect(await listedIds(w.heir, `?mailbox=${w.leaverBox}`)).not.toContain(w.untied.first);
      expect(await heldIds(w.second)).toEqual([w.leaverBox]);
      expect(await listedIds(w.second, `?mailbox=${w.leaverBox}`)).toEqual(expect.arrayContaining([...w.started.ids, ...w.invoiceMail.ids]));

      // The address followed: mail to it now rings the new holder only.
      const { providerId, stored } = await receive(w.leaverAddress);
      expect(await threadRow(stored.thread_id!)).toMatchObject({ mailbox_id: w.leaverBox });
      expect(await ringed(providerId)).toEqual([w.second.id]);
    });

    it('hands a mailbox merged into main to a person: the moved-in conversations come back, started ones read "started" again, record ones keep their record, and the address delivers to the holder', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.main, origin: 'moved', moved_from_mailbox_id: w.leaverBox });
      // Mail that arrived on the leaver's address meanwhile is new main-mailbox mail.
      const between = await receive(w.leaverAddress);

      const res = await move(w.editor, w.leaver.id, w.heir.id);

      expect(res.status).toBe(200);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: w.heir.id, user_id: w.leaver.id, merged_into_mailbox_id: null });
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.leaverBox, origin: 'started', moved_from_mailbox_id: null });
      expect(await threadRow(w.invoiceMail.thread)).toMatchObject({
        mailbox_id: w.leaverBox, origin: 'record', record_type: 'invoice', record_id: w.invoice.id, moved_from_mailbox_id: null,
      });
      // What was main's own stays in main, mail received while merged included.
      expect(await threadRow(w.inMain.thread)).toMatchObject({ mailbox_id: w.main, origin: 'started' });
      expect(await threadRow(between.stored.thread_id!)).toMatchObject({ mailbox_id: w.main });

      expect(await heldIds(w.heir)).toEqual([w.leaverBox]);
      expect(await listedIds(w.heir, `?mailbox=${w.leaverBox}`)).toEqual(expect.arrayContaining([...w.started.ids, ...w.invoiceMail.ids]));
      expect(await listedIds(w.reader, `?mailbox=${w.main}`)).toEqual(expect.arrayContaining([w.inMain.first, between.stored.id]));
      expect(await opens(w.reader, w.started.first)).toBe(false);

      const after = await receive(w.leaverAddress);
      expect(await threadRow(after.stored.thread_id!)).toMatchObject({ mailbox_id: w.leaverBox, origin: 'started' });
      expect(await ringed(after.providerId)).toEqual([w.heir.id]);
    });

    it('hands a mailbox held by a person to the main mailbox: conversations move in, the holder loses it at once, the address delivers to main', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);

      const res = await move(w.editor, w.leaver.id, 'main');

      expect(res.status).toBe(200);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'merged', holder_user_id: null, merged_into_mailbox_id: w.main });
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.main, origin: 'moved', moved_from_mailbox_id: w.leaverBox });
      expect(await threadRow(w.invoiceMail.thread)).toMatchObject({ mailbox_id: w.main, origin: 'record', moved_from_mailbox_id: w.leaverBox });
      expect(await heldIds(w.heir)).toEqual([]);
      expect(await opens(w.heir, w.untied.first)).toBe(false);

      const { providerId, stored } = await receive(w.leaverAddress);
      expect(await threadRow(stored.thread_id!)).toMatchObject({ mailbox_id: w.main, origin: 'started' });
      expect(await ringed(providerId)).toEqual([w.reader.id]);
    });

    it('can be done twice over - main to a person to another person to main - and every conversation ends up where the last move put it', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      for (const target of [w.heir.id, w.second.id, 'main', w.heir.id]) {
        expect((await move(w.editor, w.leaver.id, target)).status, String(target)).toBe(200);
      }
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: w.heir.id });
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.leaverBox, origin: 'started', moved_from_mailbox_id: null });
      expect(await db.email.count({ where: { thread_id: { in: [w.started.thread, w.invoiceMail.thread] } } })).toBe(w.started.ids.length + w.invoiceMail.ids.length);
    });

    it('changes nothing when the mailbox is already where it is asked to go', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);
      const before = await mailboxRow(w.leaverBox);
      expect((await move(w.editor, w.leaver.id, w.heir.id)).status).toBe(200);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: w.heir.id, updated_at: before.updated_at });

      const other = await world();
      expect((await deactivate(other, other.leaver)).status).toBe(200);
      const merged = await mailboxRow(other.leaverBox);
      expect((await move(other.editor, other.leaver.id, 'main')).status).toBe(200);
      expect(await mailboxRow(other.leaverBox)).toMatchObject({ status: 'merged', merged_into_mailbox_id: other.main, updated_at: merged.updated_at });
      expect(await threadRow(other.started.thread)).toMatchObject({ mailbox_id: other.main, origin: 'moved', moved_from_mailbox_id: other.leaverBox });
    });

    it('never deletes mail', async () => {
      const w = await world();
      const count = async () => ({
        emails: await db.email.count({ where: { organization_id: w.org } }),
        threads: await db.emailThread.count({ where: { organization_id: w.org } }),
        addresses: await db.mailboxAddress.count({ where: { organization_id: w.org } }),
      });
      const before = await count();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      for (const target of [w.heir.id, 'main', w.second.id]) expect((await move(w.editor, w.leaver.id, target)).status, String(target)).toBe(200);
      expect(await count()).toEqual(before);
    });
  });

  describe('a refused move', () => {
    it('is refused to a non-Admin, and changes nothing', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);
      const without = await personWith(w.org, { view_users: true });

      const res = await move(without, w.leaver.id, w.second.id);

      expect(res.status).toBe(403);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: w.heir.id });
      const deleter = await personWith(w.org, { view_users: true });
      expect((await move(deleter, w.leaver.id, 'main')).status).toBe(403);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: w.heir.id });
    });

    it('is refused for a person who is still active: only a leaver\'s mailbox moves', async () => {
      const w = await world();
      const res = await move(w.editor, w.leaver.id, w.heir.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toEqual(expect.any(String));
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'active', holder_user_id: w.leaver.id });
    });

    it('is refused for a target that is not an active person of the company, or is missing', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);
      const gone = await fx.addUser(w.org, 'gone', 'SALES');
      await db.user.update({ where: { id: gone.id }, data: { is_active: false }, select: { id: true } });
      const other = await fx.newOrg();
      orgs.push(other.org);
      const foreign = await fx.addUser(other.org, 'foreign', 'SALES');

      for (const target of [gone.id, foreign.id, randomUUID(), w.leaver.id, 'somebody', '', null, undefined]) {
        const res = await move(w.editor, w.leaver.id, target);
        expect(res.status, String(target)).toBe(400);
        expect(res.body.error).toEqual(expect.any(String));
        expect(res.body.error).not.toMatch(/resend|supabase|ctm|render|twilio|stripe/i);
        expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: w.heir.id });
      }
    });

    it('answers 404 for a person of another company or one that does not exist, and 409 for a person with no mailbox', async () => {
      const w = await world();
      const other = await world();
      expect((await deactivate(other, other.leaver)).status).toBe(200);
      expect((await move(w.editor, other.leaver.id, w.heir.id)).status).toBe(404);
      expect((await move(w.editor, randomUUID(), w.heir.id)).status).toBe(404);
      expect(await mailboxRow(other.leaverBox)).toMatchObject({ status: 'merged' });

      const nobody = await fx.addUser(w.org, 'nobox', 'SALES');
      expect((await deactivate(w, nobody)).status).toBe(200);
      const res = await move(w.editor, nobody.id, w.heir.id);
      expect(res.status).toBe(409);
      expect(res.body.error).toEqual(expect.any(String));
    });

    it('is refused while the company\'s plan has no Email feature', async () => {
      const w = await world();
      // Set before anything is asked of the app, which remembers a company's features for a while.
      await db.organization.update({ where: { id: w.org }, data: { feature_overrides: { email: false } }, select: { id: true } });
      await db.mailbox.update({ where: { id: w.leaverBox }, data: { status: 'handed', holder_user_id: w.heir.id }, select: { id: true } });
      await db.user.update({ where: { id: w.leaver.id }, data: { is_active: false }, select: { id: true } });
      const res = await move(w.editor, w.leaver.id, w.second.id);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: w.heir.id });
    });
  });

  describe('a person who leaves while holding someone else\'s mailbox', () => {
    it('hands that mailbox on with their own, to the main mailbox by default', async () => {
      const w = await world();
      const heirBox = (await db.mailbox.findFirstOrThrow({ where: { user_id: w.heir.id, kind: 'user' } })).id;
      const heirConv = await addConversation(w.org, heirBox, w.customer);
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);

      expect((await deactivate(w, w.heir)).status).toBe(200);

      expect(await mailboxRow(heirBox)).toMatchObject({ status: 'merged', merged_into_mailbox_id: w.main, holder_user_id: null });
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'merged', merged_into_mailbox_id: w.main, holder_user_id: null, user_id: w.leaver.id });
      expect(await threadRow(heirConv.thread)).toMatchObject({ mailbox_id: w.main, origin: 'moved', moved_from_mailbox_id: heirBox });
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.main, origin: 'moved', moved_from_mailbox_id: w.leaverBox });
      // And the leaver's mailbox can still be handed on from the leaver's row.
      expect((await move(w.editor, w.leaver.id, w.second.id)).status).toBe(200);
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.leaverBox, origin: 'started' });
    });

    it('hands it to the person chosen, with their own, on the user update path too', async () => {
      const w = await world();
      const heirBox = (await db.mailbox.findFirstOrThrow({ where: { user_id: w.heir.id, kind: 'user' } })).id;
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);

      const res = await (await w.editor.api()).patch(`/api/users/${w.heir.id}`, { is_active: false, handover_to: w.second.id });

      expect(res.status).toBe(200);
      for (const box of [heirBox, w.leaverBox]) expect(await mailboxRow(box), box).toMatchObject({ status: 'handed', holder_user_id: w.second.id });
      expect((await heldIds(w.second)).sort()).toEqual([heirBox, w.leaverBox].sort());
    });
  });

  describe('the Users list', () => {
    it('says where a leaver\'s mailbox went: with a person, or in the main mailbox, and nothing for an active person', async () => {
      const w = await world();
      const row = async (id: string) => {
        const res = await (await w.editor.api()).get('/api/users');
        expect(res.status).toBe(200);
        return (res.body.users as { id: string; mailbox_handover?: unknown }[]).find((u) => u.id === id)!;
      };
      expect((await row(w.leaver.id)).mailbox_handover ?? null).toBeNull();

      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);
      expect((await row(w.leaver.id)).mailbox_handover).toEqual({ to: 'person', user_id: w.heir.id, name: 'Hank Tester' });

      expect((await move(w.editor, w.leaver.id, 'main')).status).toBe(200);
      expect((await row(w.leaver.id)).mailbox_handover).toEqual({ to: 'main' });
      expect((await row(w.heir.id)).mailbox_handover ?? null).toBeNull();
    });
  });

  describe('what a move costs, on the hosted database\'s one connection', () => {
    /** The statements that touched conversations while one move ran. */
    async function conversationStatements(conversations: number, target: 'person' | 'main', from: 'main' | 'person') {
      const w = await world();
      if (conversations > 0) {
        await db.emailThread.createMany({
          data: Array.from({ length: conversations }, () => ({ organization_id: w.org, mailbox_id: w.leaverBox, origin: 'started' })),
        });
      }
      expect((await deactivate(w, w.leaver, from === 'person' ? w.heir.id : undefined)).status).toBe(200);
      const start = queries.length;
      const res = await move(w.editor, w.leaver.id, target === 'person' ? w.second.id : 'main');
      expect(res.status).toBe(200);
      const ran = queries.slice(start).filter((q) => /email_threads/i.test(q));
      const where = target === 'main' ? { mailbox_id: w.main, moved_from_mailbox_id: w.leaverBox } : { mailbox_id: w.leaverBox };
      const inPlace = await db.emailThread.count({ where });
      return { ran, inPlace, expected: conversations + 3 };
    }

    it.each([
      ['main', 'person'],
      ['person', 'main'],
      ['person', 'person'],
    ] as const)('moves the conversations from %s to %s in a fixed number of statements, however many there are', async (from, to) => {
      const empty = await conversationStatements(0, to, from);
      const big = await conversationStatements(1000, to, from);

      expect(empty.inPlace).toBe(empty.expected);
      expect(big.inPlace).toBe(big.expected);
      const updates = (list: string[]) => list.filter((q) => /^\s*UPDATE/i.test(q));
      expect(big.ran.length).toBe(empty.ran.length);
      expect(updates(big.ran).length).toBe(updates(empty.ran).length);
      expect(updates(big.ran).length).toBeLessThanOrEqual(1);
    }, 90_000);
  });
});
