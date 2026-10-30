/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.23 - a reactivated user gets their mailbox back.

   Every case goes through the REAL routes: the deactivate action (DELETE /api/users/:id), the user update that sets a
   person active again (PATCH /api/users/:id), the later move (PUT /api/users/:id/mailbox-handover), the Email page's reads
   and the REAL signed delivery webhook for mail that arrives (only the call that fetches the received message from the
   provider is replaced). Nothing is sent or received from this machine. The people are on custom roles holding exactly the
   switch values under test, never a built-in role name.

   What is proved, each against the real tables:
     - a mailbox that was HANDED to a person comes back to its owner as "My mailbox"; the interim holder loses it on the very
       next request; its conversations and address are where they were;
     - a mailbox that was MERGED into the main one comes back as a FRESH mailbox carrying the old address as its primary;
       new mail to that address lands in it and rings the person; the merged conversations stay in the main mailbox and the
       merged mailbox keeps its lineage;
     - NO ADDRESS goes to a second person at any step: after every step each address row is still on a mailbox of the person
       it was first issued to, a namesake who arrived meanwhile has none, and the register refuses a second row for one address;
     - a person with several old mailboxes (deactivated and reactivated more than once), a mailbox handed on again by a later
       move, a person who still has a live mailbox, and a person with no mailbox history;
     - the route is the Admin flag's alone (AL-18);
     - the whole reactivation runs on a ONE-connection pool (the hosted database's) and costs the same statements for 0 or
       1,000 conversations.

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
const EVENT_PREFIX = 'rp-s10-23-';

suite('a reactivated user gets their mailbox back (real database, real routes and webhook)', () => {
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
   * A company with its main mailbox; the person who reactivates (an Admin); a reader of the main
   * mailbox; a leaver who can sign in, with a mailbox and the address first.last.company, who holds a started conversation
   * and an invoice conversation; two people who could take the mailbox over; and a stranger.
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

    const leaver = await personWith(org, {}, { name: 'Jane', mailbox: false });
    const leaverBox = randomUUID();
    const leaverLocal = `jane.tester.co${tag}`;
    await db.mailbox.create({ data: { id: leaverBox, organization_id: org, kind: 'user', user_id: leaver.id, holder_user_id: leaver.id, status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: leaverLocal, organization_id: org, mailbox_id: leaverBox, is_primary: true } });
    const leaverAddress = `${leaverLocal}@${MAILBOX_DOMAIN}`;

    const job = await fx.addJob(org, customer, { crew: [heir.id, second.id, stranger.id] });
    const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
    const started = await addConversation(org, leaverBox, customer, { messages: [{ direction: 'in' }, { direction: 'out' }] });
    const invoiceMail = await addConversation(org, leaverBox, customer, {
      record: { type: 'invoice', id: invoice.id }, messages: [{ direction: 'out', jobId: job.id }, { direction: 'in' }],
    });
    const untied = await addConversation(org, leaverBox, customer, { untied: true });
    const inMain = await addConversation(org, main, customer);

    // Who each address was first issued to, taken now: every later step is checked against it.
    const issuedTo = new Map<string, string | null>();
    for (const row of await db.mailboxAddress.findMany({ where: { organization_id: org }, select: { local_part: true, mailbox: { select: { user_id: true } } } })) {
      issuedTo.set(row.local_part, row.mailbox?.user_id ?? null);
    }

    return {
      org, tag, customer, admin, main, company: `switches-${tag}`, editor, reader, heir, second, stranger,
      leaver, leaverBox, leaverLocal, leaverAddress, job, invoice, started, invoiceMail, untied, inMain, issuedTo,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const mailboxRow = (id: string) => db.mailbox.findUniqueOrThrow({ where: { id } });
  const threadRow = (id: string) => db.emailThread.findUniqueOrThrow({ where: { id } });

  const deactivate = async (w: World, who: Person, handoverTo?: string) =>
    (await w.editor.api()).delete(`/api/users/${who.id}`, handoverTo === undefined ? undefined : { handover_to: handoverTo });
  /**
   * Reactivate, then give the person their sign-in back. Deactivating removed their login, and reactivating does not restore it:
   * they sign in again from a new invite. A person with no login holds no session (H2, ticket 22), so the cases that read mail as
   * them stand for "re-invited and set up again", which this suite is not about.
   */
  const reactivate = async (by: Who, who: Person) => {
    const res = await (await by.api()).patch(`/api/users/${who.id}`, { is_active: true });
    if (res.status === 200) await db.user.update({ where: { id: who.id }, data: { has_login: true } });
    return res;
  };
  const move = async (by: Who, ownerId: string, handoverTo: unknown) =>
    (await by.api()).put(`/api/users/${ownerId}/mailbox-handover`, { handover_to: handoverTo });

  const listedIds = async (person: Person, query: string) => {
    const res = await (await fx.signedInAs(person)).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };
  const opens = async (person: Person, id: string) =>
    (await (await fx.signedInAs(person)).get(`/api/communication/emails/${id}`)).status === 200;
  const mailboxList = async (person: Person) => {
    const res = await (await fx.signedInAs(person)).get('/api/communication/mailboxes');
    expect(res.status).toBe(200);
    return res.body as { mine: { id: string | null }; held: { id: string; name: string }[] };
  };
  const heldIds = async (person: Person) => (await mailboxList(person)).held.map((m) => m.id);

  /** The user mailboxes issued to a person, newest first, with their addresses. */
  const boxesOf = (userId: string) =>
    db.mailbox.findMany({ where: { kind: 'user', user_id: userId }, orderBy: { created_at: 'desc' }, include: { addresses: true } });

  /**
   * The register is sound after a step: every address is held once (the unique index makes a second row impossible, and the
   * router resolves it to exactly one mailbox), and every address is still on a mailbox issued to the person it was first
   * issued to, never to anybody else; a person has at most one live mailbox.
   */
  async function expectRegisterSound(w: World, step: string) {
    const rows = await db.mailboxAddress.findMany({
      where: { organization_id: w.org }, select: { local_part: true, mailbox: { select: { user_id: true, kind: true } } },
    });
    expect(new Set(rows.map((r) => r.local_part)).size, `${step}: an address is held twice`).toBe(rows.length);
    for (const row of rows) {
      if (w.issuedTo.has(row.local_part)) expect(row.mailbox?.user_id ?? null, `${step}: ${row.local_part}`).toBe(w.issuedTo.get(row.local_part));
    }
    const live = await db.mailbox.groupBy({
      by: ['user_id'], where: { organization_id: w.org, kind: 'user', status: { in: ['active', 'address_needed'] }, user_id: { not: null } }, _count: true,
    });
    for (const g of live) expect(g._count, `${step}: more than one live mailbox for ${g.user_id}`).toBe(1);
    const resolved = await db.$queryRaw<{ local_part: string; n: number }[]>`
      SELECT a.local_part, COUNT(DISTINCT COALESCE(m.merged_into_mailbox_id, m.id))::int AS n
        FROM mailbox_addresses a JOIN mailboxes m ON m.id = a.mailbox_id
       WHERE a.organization_id = ${w.org}::uuid GROUP BY a.local_part`;
    for (const r of resolved) expect(r.n, `${step}: ${r.local_part} resolves to ${r.n} mailboxes`).toBe(1);
  }

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
      providerId, from, receivedFor: [to], to: [to], subject: 'Quick question', messageId: `<${providerId}@mail.example.com>`,
      receivedAt: ARRIVED, text: 'Are you open on Saturday?', html: '<div>Are you open on Saturday?</div>',
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

  describe('a mailbox that was handed to a person', () => {
    it('comes back to its owner as "My mailbox", and the interim holder loses it on the very next request', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);
      expect(await heldIds(w.heir)).toEqual([w.leaverBox]);
      expect(await opens(w.heir, w.untied.first)).toBe(true);
      await expectRegisterSound(w, 'handed');

      const res = await reactivate(w.editor, w.leaver);

      expect(res.status).toBe(200);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'active', holder_user_id: w.leaver.id, user_id: w.leaver.id, merged_into_mailbox_id: null });
      // The owner sees it as theirs; the interim holder has lost it, conversations and all.
      const mine = await mailboxList(w.leaver);
      expect(mine.mine.id).toBe(w.leaverBox);
      expect(mine.held).toEqual([]);
      expect(await heldIds(w.heir)).toEqual([]);
      expect(await opens(w.heir, w.untied.first)).toBe(false);
      expect(await listedIds(w.heir, `?mailbox=${w.leaverBox}`)).not.toContain(w.untied.first);
      for (const id of [...w.started.ids, ...w.untied.ids]) expect(await opens(w.leaver, id), id).toBe(true);
      expect(await listedIds(w.leaver, '?mailbox=mine')).toEqual(expect.arrayContaining(w.started.ids));
      await expectRegisterSound(w, 'handed, reactivated');
    });

    it('delivers mail to the address to the owner again, ringing the owner and not the interim holder', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);
      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);

      const { providerId, stored } = await receive(w.leaverAddress);

      expect(await threadRow(stored.thread_id!)).toMatchObject({ mailbox_id: w.leaverBox, origin: 'started' });
      expect(await ringed(providerId)).toEqual([w.leaver.id]);
      await expectRegisterSound(w, 'handed, reactivated, mail');
    });

    it('comes back from a person it was handed on to by a later move, too', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      expect((await move(w.editor, w.leaver.id, w.heir.id)).status).toBe(200);
      expect((await move(w.editor, w.leaver.id, w.second.id)).status).toBe(200);
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.leaverBox, origin: 'started' });

      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);

      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'active', holder_user_id: w.leaver.id });
      expect(await heldIds(w.second)).toEqual([]);
      expect(await heldIds(w.heir)).toEqual([]);
      expect((await mailboxList(w.leaver)).mine.id).toBe(w.leaverBox);
      await expectRegisterSound(w, 'moved on, reactivated');
    });

    it('comes back with the mailbox it was in "address needed" when it never had an address', async () => {
      const w = await world();
      await db.mailboxAddress.deleteMany({ where: { mailbox_id: w.leaverBox } });
      await db.mailbox.update({ where: { id: w.leaverBox }, data: { status: 'address_needed' }, select: { id: true } });
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);

      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);

      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'address_needed', holder_user_id: w.leaver.id });
    });
  });

  describe('a mailbox that was merged into the main one', () => {
    it('comes back as a FRESH mailbox with the old address as its primary; the merged conversations stay in main', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'merged', merged_into_mailbox_id: w.main });
      const between = await receive(w.leaverAddress);
      await expectRegisterSound(w, 'merged');

      const res = await reactivate(w.editor, w.leaver);

      expect(res.status).toBe(200);
      const [fresh, ...older] = await boxesOf(w.leaver.id);
      expect(older.map((b) => b.id)).toEqual([w.leaverBox]);
      expect(fresh!.id).not.toBe(w.leaverBox);
      expect(fresh).toMatchObject({ status: 'active', holder_user_id: w.leaver.id, merged_into_mailbox_id: null, organization_id: w.org });
      expect(fresh!.addresses.map((a) => [a.local_part, a.is_primary])).toEqual([[w.leaverLocal, true]]);
      // The merged mailbox keeps its lineage and its content; it is still merged and nobody holds it.
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'merged', merged_into_mailbox_id: w.main, holder_user_id: null, user_id: w.leaver.id });
      expect(await db.mailboxAddress.count({ where: { mailbox_id: w.leaverBox } })).toBe(0);
      // The merge is NOT reversed: what moved into main stays there, for the readers of main.
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.main, origin: 'moved', moved_from_mailbox_id: w.leaverBox });
      expect(await threadRow(w.invoiceMail.thread)).toMatchObject({ mailbox_id: w.main, origin: 'record', moved_from_mailbox_id: w.leaverBox });
      expect(await threadRow(between.stored.thread_id!)).toMatchObject({ mailbox_id: w.main });
      for (const id of [...w.started.ids, ...w.untied.ids]) expect(await opens(w.leaver, id), `owner ${id}`).toBe(false);
      // The owner sees the fresh mailbox as "My mailbox", empty.
      expect((await mailboxList(w.leaver)).mine.id).toBe(fresh!.id);
      expect(await listedIds(w.leaver, '?mailbox=mine')).toEqual([]);
      await expectRegisterSound(w, 'merged, reactivated');
    });

    it('lands new mail to the old address in the fresh mailbox and rings the owner, not the readers of main', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);
      const fresh = (await boxesOf(w.leaver.id))[0]!;

      const { providerId, stored } = await receive(w.leaverAddress);

      expect(await threadRow(stored.thread_id!)).toMatchObject({ mailbox_id: fresh.id, origin: 'started' });
      expect(await ringed(providerId)).toEqual([w.leaver.id]);
      expect(await listedIds(w.leaver, '?mailbox=mine')).toContain(stored.id);
      expect(await listedIds(w.reader, `?mailbox=${w.main}`)).not.toContain(stored.id);
      await expectRegisterSound(w, 'merged, reactivated, mail');
    });

    it('lets the owner reply from the old address, and keeps the customer\'s answer in the fresh mailbox', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);
      const fresh = (await boxesOf(w.leaver.id))[0]!;
      const first = await receive(w.leaverAddress);

      const res = await (await w.leaver.api()).post('/api/communication/emails', {
        to: 'pat@example.com', subject: 'Re: Quick question', body: ['Yes, we are.'], thread_id: first.stored.thread_id!,
      });

      expect(res.status).toBe(201);
      const from = (resendSend.mock.calls.at(-1)![0] as { from: string }).from;
      expect(from).toContain(`<${w.leaverAddress}>`);
      const answer = await receive((resendSend.mock.calls.at(-1)![0] as { replyTo: string }).replyTo);
      expect(await threadRow(answer.stored.thread_id!)).toMatchObject({ mailbox_id: fresh.id });
      expect(await ringed(answer.providerId)).toEqual([w.leaver.id]);
    });

    it('moves every address of the old mailbox, an older (replaced) one included, and keeps the primary primary', async () => {
      const w = await world();
      const older = `jane.old.co${w.tag}`;
      await db.mailboxAddress.update({ where: { local_part: w.leaverLocal }, data: { is_primary: false }, select: { id: true } });
      await db.mailboxAddress.create({ data: { local_part: older, organization_id: w.org, mailbox_id: w.leaverBox, is_primary: false } });
      await db.mailboxAddress.update({ where: { local_part: w.leaverLocal }, data: { is_primary: true }, select: { id: true } });
      w.issuedTo.set(older, w.leaver.id);
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      await expectRegisterSound(w, 'merged with two addresses');

      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);

      const fresh = (await boxesOf(w.leaver.id))[0]!;
      expect(fresh.addresses.map((a) => [a.local_part, a.is_primary]).sort()).toEqual([[older, false], [w.leaverLocal, true]].sort());
      const { stored } = await receive(`${older}@${MAILBOX_DOMAIN}`);
      expect(await threadRow(stored.thread_id!)).toMatchObject({ mailbox_id: fresh.id });
      await expectRegisterSound(w, 'merged with two addresses, reactivated');
    });
  });

  describe('no address is ever issued to a second person', () => {
    it('gives a namesake who arrived while the owner was away no address, and the owner their old one back', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      // A new hire named like the leaver: the name part is taken, so the register issues nothing and says "address needed".
      const namesake: Person = { id: randomUUID(), email: `jane-too-${w.tag}@example.test` };
      await db.user.create({ data: { id: namesake.id, organization_id: w.org, email: namesake.email, first_name: 'Jane', last_name: 'Tester', role: 'SALES' }, select: { id: true } });
      const { issueUserMailbox } = await import('../lib/mailbox/register.js');
      const issued = await db.$transaction((tx) => issueUserMailbox(tx, { id: namesake.id, organization_id: w.org, first_name: 'Jane', last_name: 'Tester' }));
      expect(issued).toMatchObject({ status: 'address_needed', localPart: null });
      await expectRegisterSound(w, 'namesake');

      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);

      const fresh = (await boxesOf(w.leaver.id))[0]!;
      expect(fresh.addresses.map((a) => a.local_part)).toEqual([w.leaverLocal]);
      expect(await boxesOf(namesake.id)).toEqual([expect.objectContaining({ status: 'address_needed', addresses: [] })]);
      const { stored } = await receive(w.leaverAddress);
      expect(await threadRow(stored.thread_id!)).toMatchObject({ mailbox_id: fresh.id });
      await expectRegisterSound(w, 'namesake, reactivated');
    });

    it('is held by the unique index: the address cannot be written a second time, to the owner\'s fresh mailbox or anybody\'s', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);
      const fresh = (await boxesOf(w.leaver.id))[0]!;
      for (const mailbox_id of [fresh.id, w.leaverBox, w.main]) {
        await expect(db.mailboxAddress.create({ data: { local_part: w.leaverLocal, organization_id: w.org, mailbox_id }, select: { id: true } }), mailbox_id).rejects.toMatchObject({ code: 'P2002' });
      }
      expect(await db.mailboxAddress.count({ where: { local_part: w.leaverLocal } })).toBe(1);
    });
  });

  describe('a person with several old mailboxes', () => {
    it('deactivated and reactivated twice over (merged each time) ends with one live mailbox holding the address, and every old one still merged', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);
      const second = (await boxesOf(w.leaver.id))[0]!;
      const mid = await addConversation(w.org, second.id, w.customer);
      await expectRegisterSound(w, 'first return');

      expect((await deactivate(w, w.leaver)).status).toBe(200);
      expect(await mailboxRow(second.id)).toMatchObject({ status: 'merged', merged_into_mailbox_id: w.main });
      expect(await threadRow(mid.thread)).toMatchObject({ mailbox_id: w.main, moved_from_mailbox_id: second.id });
      await expectRegisterSound(w, 'second leave');
      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);

      const boxes = await boxesOf(w.leaver.id);
      expect(boxes).toHaveLength(3);
      const live = boxes.filter((b) => b.status !== 'merged');
      expect(live).toHaveLength(1);
      expect(live[0]!.addresses.map((a) => [a.local_part, a.is_primary])).toEqual([[w.leaverLocal, true]]);
      expect(boxes.filter((b) => b.status === 'merged').map((b) => b.id).sort()).toEqual([w.leaverBox, second.id].sort());
      expect(await threadRow(mid.thread)).toMatchObject({ mailbox_id: w.main });
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.main });
      await expectRegisterSound(w, 'second return');
    });

    it('with an old merged mailbox and a newer one handed to a person, takes the newer one back and leaves the merged one merged', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);
      const newer = (await boxesOf(w.leaver.id))[0]!;
      const conv = await addConversation(w.org, newer.id, w.customer);
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);
      expect(await heldIds(w.heir)).toEqual([newer.id]);

      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);

      expect(await mailboxRow(newer.id)).toMatchObject({ status: 'active', holder_user_id: w.leaver.id });
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'merged', holder_user_id: null });
      expect(await threadRow(conv.thread)).toMatchObject({ mailbox_id: newer.id });
      expect(await threadRow(w.started.thread)).toMatchObject({ mailbox_id: w.main });
      expect(await heldIds(w.heir)).toEqual([]);
      expect((await mailboxList(w.leaver)).mine.id).toBe(newer.id);
      await expectRegisterSound(w, 'handed after merged, reactivated');
    });
  });

  describe('a person whose mailbox was handed on again after the merge', () => {
    it('gets it back from the third person who took it, conversations and address with it', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver)).status).toBe(200);
      expect((await move(w.editor, w.leaver.id, w.heir.id)).status).toBe(200);
      expect(await heldIds(w.heir)).toEqual([w.leaverBox]);

      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);

      expect(await boxesOf(w.leaver.id)).toHaveLength(1);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'active', holder_user_id: w.leaver.id });
      expect(await heldIds(w.heir)).toEqual([]);
      expect(await opens(w.heir, w.untied.first)).toBe(false);
      expect(await opens(w.leaver, w.untied.first)).toBe(true);
    });
  });

  describe('a person with nothing to hand back', () => {
    it('who holds a live mailbox already is left exactly as they are', async () => {
      const w = await world();
      // Deactivated by hand, as before the hand-over existed: the mailbox was never handed on.
      await db.user.update({ where: { id: w.leaver.id }, data: { is_active: false }, select: { id: true } });
      const before = await mailboxRow(w.leaverBox);

      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);

      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'active', holder_user_id: w.leaver.id, updated_at: before.updated_at });
      expect(await boxesOf(w.leaver.id)).toHaveLength(1);
    });

    it('who is already active changes nothing when the update says active again', async () => {
      const w = await world();
      const before = await mailboxRow(w.leaverBox);
      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ updated_at: before.updated_at });
      expect(await boxesOf(w.leaver.id)).toHaveLength(1);
    });

    it('who has no mailbox history at all gets the mailbox every new user gets (PRD 10: "Inactive users get none until reactivated")', async () => {
      const w = await world();
      const never = await personWith(w.org, {}, { name: 'Ned', mailbox: false });
      await db.user.update({ where: { id: never.id }, data: { is_active: false }, select: { id: true } });
      expect(await boxesOf(never.id)).toEqual([]);
      const mailboxesBefore = await db.mailbox.count({ where: { organization_id: w.org } });

      expect((await reactivate(w.editor, never)).status).toBe(200);

      const [box, ...rest] = await boxesOf(never.id);
      expect(rest).toEqual([]);
      expect(box).toMatchObject({ status: 'active', holder_user_id: never.id });
      expect(box!.addresses.map((a) => [a.local_part, a.is_primary])).toEqual([[`ned.tester.co${w.tag}`, true]]);
      expect(await db.mailbox.count({ where: { organization_id: w.org } })).toBe(mailboxesBefore + 1);
      // Nobody else's mailbox or address was touched.
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'active', holder_user_id: w.leaver.id });
    });
  });

  describe('who may reactivate', () => {
    it('an Admin does it; a non-Admin is refused and nothing changes', async () => {
      const w = await world();
      expect((await deactivate(w, w.leaver, w.heir.id)).status).toBe(200);
      const without = await personWith(w.org, { view_users: true });
      const deleter = await personWith(w.org, { view_users: true });

      for (const who of [without, deleter]) {
        const res = await reactivate(who, w.leaver);
        expect(res.status).toBe(403);
        expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: w.heir.id });
        expect((await db.user.findUniqueOrThrow({ where: { id: w.leaver.id } })).is_active).toBe(false);
      }
      expect((await reactivate(w.editor, w.leaver)).status).toBe(200);
      expect(await mailboxRow(w.leaverBox)).toMatchObject({ status: 'active', holder_user_id: w.leaver.id });
    });

    it('does not reach a person of another company', async () => {
      const w = await world();
      const other = await world();
      expect((await deactivate(other, other.leaver, other.heir.id)).status).toBe(200);
      const res = await reactivate(w.editor, other.leaver);
      expect(res.status).toBe(404);
      expect(await mailboxRow(other.leaverBox)).toMatchObject({ status: 'handed', holder_user_id: other.heir.id });
    });
  });

  describe('what a reactivation costs, on the hosted database\'s one connection', () => {
    /** The statements of one reactivation of a person whose mailbox holds `conversations` conversations. */
    async function statements(conversations: number, how: 'merged' | 'handed') {
      const w = await world();
      if (conversations > 0) {
        await db.emailThread.createMany({
          data: Array.from({ length: conversations }, () => ({ organization_id: w.org, mailbox_id: w.leaverBox, origin: 'started' })),
        });
      }
      expect((await deactivate(w, w.leaver, how === 'handed' ? w.heir.id : undefined)).status).toBe(200);
      const start = queries.length;
      const res = await reactivate(w.editor, w.leaver);
      expect(res.status).toBe(200);
      const ran = queries.slice(start);
      await expectRegisterSound(w, `${how} ${conversations}`);
      return ran;
    }

    it.each(['merged', 'handed'] as const)('takes the same statements for 0 or 1,000 conversations, and never touches a conversation (%s)', async (how) => {
      const empty = await statements(0, how);
      const big = await statements(1000, how);
      expect(big.length).toBe(empty.length);
      expect(big.filter((q) => /email_threads/i.test(q))).toEqual([]);
      expect(big.filter((q) => /^\s*UPDATE/i.test(q)).length).toBe(empty.filter((q) => /^\s*UPDATE/i.test(q)).length);
    }, 90_000);
  });
});
