/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.21 - deactivating a person hands their mailbox on.

   Every case goes through the REAL routes: the deactivate action (DELETE /api/users/:id), the user update that sets a user
   inactive (PATCH /api/users/:id), the reactivation, the Email page's reads, and the REAL signed delivery webhook for mail to
   a leaver's address (only the call that fetches the received message from the provider is replaced, so nothing is sent or
   received from this machine). The person who deactivates is an Admin (the flag; managing people is theirs alone, AL-18) on a custom role (never a
   built-in role name).

   What is proved, each against the real tables:
     - both paths hand the mailbox over, and with no target the target is the main mailbox;
     - handed to main: the conversations move into it (one set-based write), a started one reads "moved" and says from where,
       a record conversation keeps following its record, the mailbox reads "merged", its owner and addresses stay for the
       reactivation slice, and nobody holds it;
     - the moved conversations are NOT listed to the main mailbox's readers under "Linked to me" (they still list under the
       main mailbox for a person on All), and a person with Invoices View off cannot open a moved invoice conversation
       through any mailbox while a person with it on still can;
     - a message to the leaver's address is new main-mailbox mail and rings the people who read the main mailbox;
     - handed to a person: they hold the mailbox, its mail stays where it is, its address keeps delivering into it;
     - mail is kept: no message or conversation is ever deleted;
     - a target that is not an active person of the company is refused before anything changes, on both paths;
     - the whole handover runs on a ONE-connection pool (the hosted database's), and its cost does not grow with the mail.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import { afterResponseDrained } from '../lib/after-response';
import type { PrismaClient, Role } from '@prisma/client';

const { clientPromise, fetchReceived, queries } = vi.hoisted(() => {
  const queries: string[] = [];
  const clientPromise = (async () => {
    const dbUrl = process.env.TEST_DATABASE_URL;
    if (!dbUrl) return undefined;
    const { PrismaClient } = await import('@prisma/client');
    // The hosted database's pool: ONE connection and a short wait, so a query on the global client made inside the
    // handover's transaction fails here in seconds instead of on the hosted database.
    const pooled = new URL(dbUrl);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '4');
    const client = new PrismaClient({ datasources: { db: { url: pooled.toString() } }, log: [{ emit: 'event', level: 'query' }] });
    (client as unknown as { $on(e: 'query', cb: (q: { query: string }) => void): void }).$on('query', (q) => queries.push(q.query));
    return client;
  })();
  return { clientPromise, fetchReceived: vi.fn(), queries };
});

// The suite-wide setup mocks the app's client; here it is the real one, on the hosted pool.
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));

// The provider call that fetches a received message is the only thing replaced.
vi.mock('../lib/inbound-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inbound-email')>()),
  fetchReceivedEmail: fetchReceived,
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { env } from '../config/env';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SECRET_BYTES = randomBytes(24);
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const MAILBOX_DOMAIN = 'mail.test.com';
const ARRIVED = new Date('2026-07-01T15:00:00.000Z');
const EVENT_PREFIX = 'rp-s10-21-';

suite('deactivating hands the mailbox on (real database, real routes and webhook)', () => {
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
    fetchReceived.mockReset();
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

  /** A person on a fresh custom role holding exactly the switch values under test, with the Email page open. */
  async function personWith(org: string, values: Record<string, boolean | string> = {}, base: Role = 'DISPATCHER'): Promise<Who> {
    const key = `ho-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, view_invoices: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'attached',
        ...switchValues,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** A conversation in `mailboxId` with the messages given (one unread inbound message when none are). */
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
          subject: 'run-mailbox-handover', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
        select: { id: true },
      });
      ids.push(id);
    }
    return { thread, ids, first: ids[0]! };
  }

  /**
   * A company with its main mailbox and main address; the person who deactivates (an Admin); two people
   * who read the main mailbox (one with Invoices View on, one with it off, both on the job's crew); a leaver with a mailbox and
   * an address who holds a started conversation and an invoice conversation; and a control conversation started in main.
   */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, tag, customer, admin } = made;

    const main = randomUUID();
    await db.mailbox.create({ data: { id: main, organization_id: org, kind: 'main', status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `main-${tag}`, organization_id: org, mailbox_id: main, is_primary: true } });

    const editor = await personWith(org, { view_users: true, is_admin: true });
    const reader = await personWith(org);
    const noInvoices = await personWith(org, withDependantsOff(['view_invoices']));
    const wide = await personWith(org, { communication_scope: 'all' });
    for (const person of [reader, noInvoices]) {
      await db.mailboxReader.create({ data: { organization_id: org, mailbox_id: main, user_id: person.id } });
    }

    const leaver = await fx.addUser(org, 'jane', 'SALES');
    const leaverBox = await fx.addUserMailbox(org, leaver);
    const leaverLocal = leaver.email.split('@')[0]!.toLowerCase();

    const job = await fx.addJob(org, customer, { crew: [reader.id, noInvoices.id] });
    const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
    const started = await addConversation(org, leaverBox, customer, { messages: [{ direction: 'in' }, { direction: 'out' }] });
    const invoiceMail = await addConversation(org, leaverBox, customer, {
      record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }],
    });
    // Mail from an address that is no customer's: no record to reach it through.
    const untied = await addConversation(org, leaverBox, customer, { untied: true });
    const inMain = await addConversation(org, main, customer);

    return {
      org, tag, customer, admin, main, mainAddress: `main-${tag}@${MAILBOX_DOMAIN}`, editor, reader, noInvoices, wide,
      leaver, leaverBox, leaverAddress: `${leaverLocal}@${MAILBOX_DOMAIN}`, job, invoice, started, invoiceMail, untied, inMain,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const mailboxRow = (id: string) => db.mailbox.findUniqueOrThrow({ where: { id } });
  const threadRow = (id: string) => db.emailThread.findUniqueOrThrow({ where: { id } });
  const userRow = (id: string) => db.user.findUniqueOrThrow({ where: { id } });

  /** The two ways to deactivate a person, each with an optional handover target. */
  type Path = { name: string; call: (api: Api, id: string, body?: object) => ReturnType<Api['delete']> };
  const PATHS: Path[] = [
    { name: 'the deactivate action', call: (api, id, body) => api.delete(`/api/users/${id}`, body) },
    { name: 'the user update', call: (api, id, body) => api.patch(`/api/users/${id}`, { is_active: false, ...body }) as never },
  ];

  const listedIds = async (person: Person, query: string) => {
    const res = await (await fx.signedInAs(person)).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };
  const opens = async (person: Person, id: string) =>
    (await (await fx.signedInAs(person)).get(`/api/communication/emails/${id}`)).status === 200;

  const signed = (svixId: string, body: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET_BYTES).update(`${svixId}.${timestamp}.${body}`).digest('base64');
    return { 'svix-id': svixId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
  };

  /** One `email.received` event through the real route, from a known customer's address. */
  async function receive(w: World, to: string) {
    const providerId = `${EVENT_PREFIX}rcv-${randomUUID()}`;
    const eventId = `${EVENT_PREFIX}evt-${randomUUID()}`;
    const from = 'Pat Payer <pat@example.com>';
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
    // The webhook answers first and announces after: read the bells once all of that work is over (a drain that times out fails).
    await afterResponseDrained();
    void w;
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

  describe.each(PATHS)('$name', (path) => {
    it('with no target hands the mailbox to the main mailbox, for an Admin', async () => {
      const w = await world();
      const res = await path.call(await w.editor.api(), w.leaver.id);

      expect(res.status).toBe(200);
      expect((await userRow(w.leaver.id)).is_active).toBe(false);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({
        status: 'merged', merged_into_mailbox_id: w.main, holder_user_id: null, user_id: w.leaver.id,
      });
      // A started conversation reads "moved in from" the leaver's mailbox; a record conversation keeps following its record.
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.main, origin: 'moved', moved_from_mailbox_id: w.leaverBox });
      expect(await threadRow(w.invoiceMail.thread)).toMatchObject({
        mailbox_id: w.main, origin: 'record', record_type: 'invoice', record_id: w.invoice.id, moved_from_mailbox_id: w.leaverBox,
      });
      // The conversation that was already in main is not touched.
      expect(await threadRow(w.inMain.thread)).toMatchObject({ mailbox_id: w.main, origin: 'started', moved_from_mailbox_id: null });
    });

    it('treats "main" and an empty target the same as no target', async () => {
      for (const body of [{ handover_to: 'main' }, { handover_to: null }]) {
        const w = await world();
        expect((await path.call(await w.editor.api(), w.leaver.id, body)).status).toBe(200);
        expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'merged', merged_into_mailbox_id: w.main });
        expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.main, origin: 'moved' });
      }
    });

    it('keeps every message and conversation for good', async () => {
      const w = await world();
      const before = {
        emails: await db.email.count({ where: { organization_id: w.org } }),
        threads: await db.emailThread.count({ where: { organization_id: w.org } }),
        addresses: await db.mailboxAddress.count({ where: { organization_id: w.org } }),
      };
      expect((await path.call(await w.editor.api(), w.leaver.id)).status).toBe(200);

      expect(await db.email.count({ where: { organization_id: w.org } })).toBe(before.emails);
      expect(await db.emailThread.count({ where: { organization_id: w.org } })).toBe(before.threads);
      expect(await db.mailboxAddress.count({ where: { organization_id: w.org } })).toBe(before.addresses);
      for (const id of [...w.started.ids, ...w.invoiceMail.ids]) expect(await db.email.findUnique({ where: { id } })).not.toBeNull();
    });

    it('does not list the moved conversations to the main mailbox\'s readers, and lists them under the main mailbox to a person on All', async () => {
      const w = await world();
      expect((await path.call(await w.editor.api(), w.leaver.id)).status).toBe(200);

      // The control: what was started in main is listed to its readers.
      expect(await listedIds(w.reader, `?mailbox=${w.main}`)).toEqual([w.inMain.first]);
      const readerAll = await listedIds(w.reader, '');
      for (const id of [...w.started.ids, ...w.untied.ids]) expect(readerAll, id).not.toContain(id);
      // Not theirs by being in the main mailbox: with no record they can open, they cannot open it either.
      expect(await opens(w.reader, w.untied.first)).toBe(false);
      // A person on All reads every mailbox, so the moved mail is under the main mailbox for them.
      const wideMain = await listedIds(w.wide, `?mailbox=${w.main}`);
      expect(wideMain).toEqual(expect.arrayContaining([...w.started.ids, ...w.untied.ids, ...w.invoiceMail.ids, w.inMain.first]));
    });

    it('keeps an invoice conversation behind Invoices View, through any mailbox', async () => {
      const w = await world();
      expect((await path.call(await w.editor.api(), w.leaver.id)).status).toBe(200);

      for (const id of w.invoiceMail.ids) {
        // Both are on the job's crew and both read the main mailbox; only the one who can open invoices reaches this.
        expect(await opens(w.reader, id), `reader ${id}`).toBe(true);
        expect(await opens(w.noInvoices, id), `noInvoices ${id}`).toBe(false);
      }
      for (const query of ['', `?mailbox=${w.main}`, `?mailbox=${w.leaverBox}`]) {
        const ids = await listedIds(w.noInvoices, query);
        for (const id of w.invoiceMail.ids) expect(ids, `${query} ${id}`).not.toContain(id);
      }
    });

    it('sends a message to the leaver\'s address into the main mailbox as new mail, and rings the people who read it', async () => {
      const w = await world();
      expect((await path.call(await w.editor.api(), w.leaver.id)).status).toBe(200);

      const { providerId, stored } = await receive(w, w.leaverAddress);
      const thread = await threadRow(stored.thread_id!);
      expect(thread).toMatchObject({ organization_id: w.org, mailbox_id: w.main, origin: 'started', moved_from_mailbox_id: null });
      expect(await ringed(providerId)).toEqual([w.reader.id, w.noInvoices.id].sort());
      // It is listed like any new main-mailbox mail, and the leaver's old conversations stay unlisted.
      expect(await listedIds(w.reader, `?mailbox=${w.main}`)).toEqual(expect.arrayContaining([stored.id, w.inMain.first]));
      expect(await listedIds(w.reader, `?mailbox=${w.main}`)).not.toContain(w.started.first);
    });

    it('hands the mailbox to a person: they hold it, its mail stays in it and its address keeps delivering into it', async () => {
      const w = await world();
      const heir = await personWith(w.org);
      const res = await path.call(await w.editor.api(), w.leaver.id, { handover_to: heir.id });

      expect(res.status).toBe(200);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: heir.id, user_id: w.leaver.id, merged_into_mailbox_id: null });
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.leaverBox, origin: 'started', moved_from_mailbox_id: null });
      const list = await (await heir.api()).get('/api/communication/mailboxes');
      expect(list.status).toBe(200);
      expect((list.body.held as { id: string }[]).map((m) => m.id)).toContain(w.leaverBox);
      expect(await listedIds(heir, `?mailbox=${w.leaverBox}`)).toEqual(expect.arrayContaining(w.started.ids));

      const { stored } = await receive(w, w.leaverAddress);
      expect(await threadRow(stored.thread_id!)).toMatchObject({ mailbox_id: w.leaverBox, origin: 'started' });
    });

    it('refuses a target that is not an active person of the company, before anything changes', async () => {
      const w = await world();
      const gone = await fx.addUser(w.org, 'gone', 'SALES');
      await db.user.update({ where: { id: gone.id }, data: { is_active: false }, select: { id: true } });
      const other = await fx.newOrg();
      orgs.push(other.org);
      const stranger = await fx.addUser(other.org, 'stranger', 'SALES');

      for (const target of [gone.id, stranger.id, randomUUID(), w.leaver.id, 'somebody', '']) {
        const res = await path.call(await w.editor.api(), w.leaver.id, { handover_to: target });
        expect(res.status, String(target)).toBe(400);
        expect(res.body.error).toEqual(expect.any(String));
        expect(res.body.error).not.toMatch(/resend|supabase|ctm|render/i);
        expect((await userRow(w.leaver.id)).is_active).toBe(true);
        expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'active', holder_user_id: w.leaver.id, merged_into_mailbox_id: null });
        expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.leaverBox, origin: 'started' });
      }
    });

    it('still deactivates a person who has no mailbox, and one whose mailbox is still waiting for an address', async () => {
      const w = await world();
      const none = await fx.addUser(w.org, 'nobox', 'SALES');
      expect((await path.call(await w.editor.api(), none.id)).status).toBe(200);
      expect((await userRow(none.id)).is_active).toBe(false);

      const waiting = await fx.addUser(w.org, 'waiting', 'SALES');
      const box = randomUUID();
      await db.mailbox.create({ data: { id: box, organization_id: w.org, kind: 'user', user_id: waiting.id, holder_user_id: waiting.id, status: 'address_needed' } });
      expect((await path.call(await w.editor.api(), waiting.id)).status).toBe(200);
      expect(await mailboxRow(box)).toMatchObject({ status: 'merged', merged_into_mailbox_id: w.main, holder_user_id: null });
    });

    it('does not hand a mailbox on twice: a second deactivation, with another target, changes nothing', async () => {
      const w = await world();
      const heir = await personWith(w.org);
      expect((await path.call(await w.editor.api(), w.leaver.id)).status).toBe(200);
      const after = await mailboxRow(w.leaverBox);

      expect((await path.call(await w.editor.api(), w.leaver.id, { handover_to: heir.id })).status).toBe(200);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'merged', merged_into_mailbox_id: w.main, holder_user_id: null, updated_at: after.updated_at });
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.main, origin: 'moved' });
    });
  });

  describe('a mailbox handed to a person', () => {
    it('stays handed when an Admin changes its address: only a mailbox waiting for an address becomes active', async () => {
      const w = await world();
      const heir = await personWith(w.org);
      await db.organization.update({ where: { id: w.org }, data: { email_sender_local_part: `co${w.tag.replace(/[0-9]/g, 'x')}` }, select: { id: true } });
      expect((await (await w.editor.api()).delete(`/api/users/${w.leaver.id}`, { handover_to: heir.id })).status).toBe(200);

      const { setUserNamePart } = await import('../lib/mailbox/register.js');
      const changed = await setUserNamePart(db, { organizationId: w.org, userId: w.leaver.id, namePart: 'jane.leaver' });

      expect(changed).toMatchObject({ ok: true, activated: false });
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: heir.id });
    });
  });

  describe('reactivating', () => {
    it('works for an Admin, and leaves the merged mailbox\'s lineage: whose mailbox was merged where (S10.23 gives the address to a fresh mailbox)', async () => {
      const w = await world();
      const api = await w.editor.api();
      expect((await api.delete(`/api/users/${w.leaver.id}`)).status).toBe(200);

      const res = await api.patch(`/api/users/${w.leaver.id}`, { is_active: true });
      expect(res.status).toBe(200);
      expect((await userRow(w.leaver.id)).is_active).toBe(true);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ user_id: w.leaver.id, status: 'merged', merged_into_mailbox_id: w.main });
      // The address went to the person's fresh mailbox; the merge itself is not reversed (S10.23).
      const fresh = await db.mailbox.findFirstOrThrow({ where: { user_id: w.leaver.id, kind: 'user', status: 'active' }, select: { id: true } });
      expect(fresh.id).not.toBe(w.leaverBox);
      expect(await db.mailboxAddress.count({ where: { mailbox_id: fresh.id, is_primary: true } })).toBe(1);
      expect(await db.mailboxAddress.count({ where: { mailbox_id: w.leaverBox } })).toBe(0);
      expect(await db.emailThread.count({ where: { moved_from_mailbox_id: w.leaverBox } })).toBe(3);
    });
  });

  describe('what it costs, on the hosted database\'s one connection', () => {
    /** The statements that touched conversations while one deactivation ran. */
    async function conversationStatements(conversations: number, path: Path) {
      const w = await world();
      if (conversations > 0) {
        await db.emailThread.createMany({
          data: Array.from({ length: conversations }, () => ({ organization_id: w.org, mailbox_id: w.leaverBox, origin: 'started' })),
        });
      }
      const from = queries.length;
      const res = await path.call(await w.editor.api(), w.leaver.id);
      expect(res.status).toBe(200);
      const ran = queries.slice(from).filter((q) => /email_threads/i.test(q));
      const moved = await db.emailThread.count({ where: { moved_from_mailbox_id: w.leaverBox } });
      return { ran, moved, expected: conversations + 3 };
    }

    it.each(PATHS)('moves the conversations in ONE statement however many there are ($name)', async (path) => {
      const empty = await conversationStatements(0, path);
      const big = await conversationStatements(1000, path);

      expect(empty.moved).toBe(empty.expected);
      expect(big.moved).toBe(big.expected);
      const updates = (list: string[]) => list.filter((q) => /^\s*UPDATE/i.test(q));
      expect(updates(empty.ran)).toHaveLength(1);
      expect(updates(big.ran)).toHaveLength(1);
      expect(big.ran.length).toBe(empty.ran.length);
    }, 60_000);
  });
});
