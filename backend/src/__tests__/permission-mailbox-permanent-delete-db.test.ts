/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.24 - permanent delete keeps working with mailboxes, and the address stays
   reserved.

   Every case goes through the REAL routes: the invite (a mailbox is issued with the user), the deactivate action, the
   permanent delete and the two-step login reset, the Email page's reads, the send route, the address-setting route and the
   REAL signed delivery webhook for mail that arrives (only the call that fetches the received message from the provider is
   replaced; nothing is sent or received from this machine). The people are on custom roles holding exactly the switch values
   under test, never a built-in role name. The app runs on a client holding ONE connection, as the hosted pool does.

   What is proved, each against the real tables:
     - a mistaken invite (deactivated, mailbox issued at invite) is removed; the mailbox's link to the user is cleared, its
       address row stays and still delivers (to the main mailbox, or to the person it was handed to), and the address is
       never issued again: a namesake lands in "address needed", the register says it is not free, and setting it by hand is
       refused;
     - a mailbox nobody holds (the user was switched off without a handover, or held someone else's) is merged into the main
       mailbox in the SAME transaction as the delete, its conversations with it, and nothing is left unheld;
     - a user with real history, an active user, and the missing Delete users switch are refused as before, and a refused
       delete changes nothing in the mailbox world;
     - no foreign key from the mailbox tables to users blocks a delete (read from the database itself);
     - a message the user sent keeps its recorded From.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import type { PrismaClient, Role } from '@prisma/client';

const { clientPromise, fetchReceived, resendSend } = vi.hoisted(() => {
  const clientPromise = (async () => {
    const { oneConnectionClient } = await import('./one-connection-client.js');
    return oneConnectionClient(process.env.TEST_DATABASE_URL);
  })();
  return { clientPromise, fetchReceived: vi.fn(), resendSend: vi.fn() };
});

// The suite-wide setup mocks the app's client; here it is the real one, on the hosted pool.
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));

// The provider call that fetches a received message is the only inbound thing replaced.
vi.mock('../lib/inbound-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inbound-email')>()),
  fetchReceivedEmail: fetchReceived,
}));

// Only the mail provider's client is faked; the real dispatcher runs, with its key set BEFORE it loads (it builds its client at load).
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
  // No invitation leaves the machine: the set-password email is a stub that reports it was sent.
  return { ...(await importOriginal<Record<string, unknown>>()), sendUserInviteEmail: vi.fn().mockResolvedValue(true) };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { env } from '../config/env';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SECRET_BYTES = randomBytes(24);
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const MAILBOX_DOMAIN = 'mail.test.com';
const ARRIVED = new Date('2026-07-01T15:00:00.000Z');
const EVENT_PREFIX = 'rp-s10-24-';

suite('permanent delete keeps working with mailboxes (real database, real routes and webhook, one connection)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM notes WHERE organization_id = '${org}'`));
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

  /** A person on a fresh custom role holding exactly the switch values under test, with the Email page open. */
  async function personWith(org: string, values: Record<string, boolean | string> = {}, opts: { name?: string; mailbox?: boolean } = {}): Promise<Who> {
    const key = `pd-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER' as Role);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, estimates_scope: 'attached', view_invoices: true, invoices_scope: 'attached',
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'linked_to_me',
        contact_customers: true,
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const first = opts.name ?? `P${sequence}`;
    const person = await fx.addUser(org, first, 'DISPATCHER', { customRoleId: role.id });
    if (opts.mailbox !== false) await fx.addUserMailbox(org, person);
    return Object.assign(person, { first, api: () => fx.signedInAs(person) });
  }

  const tagOf = () => randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 8);

  /**
   * A company with a frozen company part and its main mailbox; a holder of Edit users (no Delete users); a holder of Delete
   * users (no Edit users); a reader of the main mailbox; and a person who could take a mailbox over.
   */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, tag, customer, admin } = made;
    const part = `co${tagOf()}`;
    await db.organization.update({ where: { id: org }, data: { email_sending_enabled: true, email_sender_local_part: part } });

    const main = randomUUID();
    await db.mailbox.create({ data: { id: main, organization_id: org, kind: 'main', status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: part, organization_id: org, mailbox_id: main, is_primary: true } });

    const editor = await personWith(org, { view_users: true, edit_users: true, delete_users: false });
    const deleter = await personWith(org, { view_users: true, edit_users: false, delete_users: true });
    const reader = await personWith(org);
    await db.mailboxReader.create({ data: { organization_id: org, mailbox_id: main, user_id: reader.id } });
    const heir = await personWith(org, {}, { name: 'Hank' });
    return { org, tag, part, customer, admin, main, editor, deleter, reader, heir };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** A person with a mailbox, built straight in the tables (what an invite leaves behind), so a case can put it in any state. */
  async function leaverWith(w: World, name: string, opts: { status?: string; holder?: string | null } = {}) {
    const leaver = await personWith(w.org, {}, { name, mailbox: false });
    const box = randomUUID();
    const local = `${name.toLowerCase()}.tester.${w.part}`;
    await db.mailbox.create({
      data: {
        id: box, organization_id: w.org, kind: 'user', user_id: leaver.id,
        holder_user_id: opts.holder === undefined ? leaver.id : opts.holder, status: opts.status ?? 'active',
      },
    });
    await db.mailboxAddress.create({ data: { local_part: local, organization_id: w.org, mailbox_id: box, is_primary: true } });
    return { leaver, box, local, address: `${local}@${MAILBOX_DOMAIN}` };
  }

  /** A conversation in `mailboxId` holding one message, with a reply token for it. */
  async function addConversation(w: World, mailboxId: string) {
    const thread = randomUUID();
    await db.emailThread.create({ data: { id: thread, organization_id: w.org, mailbox_id: mailboxId, origin: 'started' } });
    const email = randomUUID();
    await db.email.create({
      data: {
        id: email, organization_id: w.org, thread_id: thread, customer_id: w.customer,
        account: 'user', direction: 'in', folder: 'inbox',
        from: { name: null, email: 'customer@example.com' }, to: 'office@example.com',
        subject: 'run-permanent-delete', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
      },
      select: { id: true },
    });
    return { thread, email };
  }

  const mailboxRow = (id: string) => db.mailbox.findUniqueOrThrow({ where: { id } });
  const threadRow = (id: string) => db.emailThread.findUniqueOrThrow({ where: { id } });
  const userRow = (id: string) => db.user.findUnique({ where: { id } });

  const deactivate = async (by: Who, who: Person, handoverTo?: string) =>
    (await by.api()).delete(`/api/users/${who.id}`, handoverTo === undefined ? undefined : { handover_to: handoverTo });
  const permanentDelete = async (by: Who, who: Person) => (await by.api()).delete(`/api/users/${who.id}/permanent`);

  const signed = (svixId: string, body: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET_BYTES).update(`${svixId}.${timestamp}.${body}`).digest('base64');
    return { 'svix-id': svixId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
  };

  /** One `email.received` event through the real route, from a known customer's address, to `to`; the stored message. */
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
    let stored: Awaited<ReturnType<typeof db.email.findMany>> = [];
    for (let waited = 0; waited < 10_000 && stored.length === 0; waited += 250) {
      stored = await db.email.findMany({ where: { provider_message_id: { startsWith: providerId } } });
      if (stored.length === 0) await new Promise((r) => setTimeout(r, 250));
    }
    expect(stored).toHaveLength(1);
    return stored[0]!;
  }

  const listedIds = async (person: Person, query: string) => {
    const res = await (await fx.signedInAs(person)).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };

  /** Whether a mistaken invite (a user with a mailbox and an address, never signed in) can be removed, step by step. */
  const invite = async (w: World, first: string, last: string) => {
    const res = await (await fx.signedInAs(w.admin)).post('/api/users/invite', {
      first_name: first, last_name: last, email: `${tagOf()}@example.test`, role: 'TECHNICIAN',
    });
    expect(res.status).toBe(201);
    const id = res.body.user.id as string;
    const mailbox = await db.mailbox.findFirstOrThrow({ where: { user_id: id, kind: 'user' }, include: { addresses: true } });
    return { id, mailbox, person: { id, email: res.body.user.email as string } as Person };
  };

  describe('a mistaken invite that was given a mailbox', () => {
    it('is removed after a default deactivation, its address stays and still delivers to the main mailbox', async () => {
      const w = await world();
      const { id, mailbox, person } = await invite(w, 'Ivy', 'Mistake');
      const local = `ivy.mistake.${w.part}`;
      expect(mailbox.addresses.map((a) => a.local_part)).toEqual([local]);
      expect((await deactivate(w.editor, person)).status).toBe(200);
      const merged = await mailboxRow(mailbox.id);
      expect(merged).toMatchObject({ status: 'merged', merged_into_mailbox_id: w.main, holder_user_id: null });

      const res = await permanentDelete(w.deleter, person);

      expect(res.status).toBe(200);
      expect(await userRow(id)).toBeNull();
      // The link to the user is cleared; the mailbox, its lineage and its address row are all still there.
      expect(await mailboxRow(mailbox.id)).toMatchObject({ user_id: null, holder_user_id: null, status: 'merged', merged_into_mailbox_id: w.main });
      expect(await db.mailboxAddress.findUnique({ where: { local_part: local } })).toMatchObject({ mailbox_id: mailbox.id, organization_id: w.org, kind: 'issued', is_primary: true });

      // The address still delivers: into the main mailbox, where the people who read it find the message.
      const stored = await receive(`${local}@${MAILBOX_DOMAIN}`);
      expect(await threadRow(stored.thread_id!)).toMatchObject({ mailbox_id: w.main, origin: 'started' });
      expect(await listedIds(w.reader, `?mailbox=${w.main}`)).toContain(stored.id);
    });

    it('can never be issued again, to anyone: a namesake has no address, the register says it is taken, setting it by hand is refused', async () => {
      const w = await world();
      const { person, mailbox } = await invite(w, 'Ivy', 'Mistake');
      const local = `ivy.mistake.${w.part}`;
      expect((await deactivate(w.editor, person)).status).toBe(200);
      expect((await permanentDelete(w.deleter, person)).status).toBe(200);

      const namesake = await invite(w, 'Ivy', 'Mistake');
      expect(namesake.mailbox).toMatchObject({ status: 'address_needed', holder_user_id: namesake.id });
      expect(namesake.mailbox.addresses).toEqual([]);

      const { isAddressFree } = await import('../lib/mailbox/register.js');
      expect(await isAddressFree(db, `${local}@${MAILBOX_DOMAIN}`)).toBe(false);

      const set = await (await w.editor.api()).put(`/api/users/${namesake.id}/mailbox-address`, { name_part: 'ivy.mistake' });
      expect(set.status).toBe(409);
      expect(set.body.error).toBe('This address is already in use. Choose a different one.');
      expect(await db.mailboxAddress.findMany({ where: { local_part: local } })).toEqual([
        expect.objectContaining({ mailbox_id: mailbox.id }),
      ]);
      expect(await db.mailbox.findUniqueOrThrow({ where: { id: namesake.mailbox.id } })).toMatchObject({ status: 'address_needed' });
    });

    it('with the mailbox handed to a person: the address keeps delivering into that mailbox, held by that person, with no owner', async () => {
      const w = await world();
      const { person, mailbox } = await invite(w, 'Ivy', 'Mistake');
      const local = `ivy.mistake.${w.part}`;
      const kept = await addConversation(w, mailbox.id);
      expect((await deactivate(w.editor, person, w.heir.id)).status).toBe(200);

      expect((await permanentDelete(w.deleter, person)).status).toBe(200);

      expect(await mailboxRow(mailbox.id)).toMatchObject({ user_id: null, holder_user_id: w.heir.id, status: 'handed', merged_into_mailbox_id: null });
      expect((await threadRow(kept.thread)).mailbox_id).toBe(mailbox.id);
      const stored = await receive(`${local}@${MAILBOX_DOMAIN}`);
      expect(await threadRow(stored.thread_id!)).toMatchObject({ mailbox_id: mailbox.id });
      expect(await listedIds(w.heir, `?mailbox=${mailbox.id}`)).toEqual(expect.arrayContaining([stored.id, kept.email]));
      // The Email page still names it, without the person.
      const list = await (await w.heir.api()).get('/api/communication/mailboxes');
      expect(list.status).toBe(200);
      expect(list.body.held).toEqual([expect.objectContaining({ id: mailbox.id, name: 'Former team member' })]);
    });
  });

  describe('a mailbox nobody holds', () => {
    it('is merged into the main mailbox in the same write as the delete, conversations and Needs review included, and keeps delivering', async () => {
      const w = await world();
      const { leaver, box, address } = await leaverWith(w, 'Una');
      const kept = await addConversation(w, box);
      const held = randomUUID();
      await db.email.create({
        data: {
          id: held, organization_id: w.org, review_mailbox_id: box, account: 'user', direction: 'in', folder: 'inbox',
          from: { name: null, email: 'x@example.com' }, to: 'office@example.com', subject: 'run-permanent-delete', snippet: 's', body: ['b'],
          at: '1:00 PM', ts: BigInt(Date.now()),
        },
        select: { id: true },
      });
      // Switched off with no handover (an older path, or a direct change): still held by the person, not merged.
      await db.user.update({ where: { id: leaver.id }, data: { is_active: false }, select: { id: true } });

      const res = await permanentDelete(w.deleter, leaver);

      expect(res.status).toBe(200);
      expect(await userRow(leaver.id)).toBeNull();
      expect(await mailboxRow(box)).toMatchObject({ user_id: null, holder_user_id: null, status: 'merged', merged_into_mailbox_id: w.main });
      expect(await threadRow(kept.thread)).toMatchObject({ mailbox_id: w.main, moved_from_mailbox_id: box, origin: 'moved' });
      expect((await db.email.findUniqueOrThrow({ where: { id: held } })).review_mailbox_id).toBe(w.main);
      const stored = await receive(address);
      expect(await threadRow(stored.thread_id!)).toMatchObject({ mailbox_id: w.main });
      // New mail on the leaver's address is listed to the main mailbox's readers; the conversations moved in are not ("Linked to me").
      const listed = await listedIds(w.reader, `?mailbox=${w.main}`);
      expect(listed).toContain(stored.id);
      expect(listed).not.toContain(kept.email);
    });

    it('is also what happens to a mailbox the person held for somebody else: it goes to main, its owner keeps their link', async () => {
      const w = await world();
      const owner = await leaverWith(w, 'Olga', { status: 'handed', holder: null });
      const { leaver } = await leaverWith(w, 'Hugh');
      await db.mailbox.update({ where: { id: owner.box }, data: { holder_user_id: leaver.id }, select: { id: true } });
      await db.mailbox.updateMany({ where: { user_id: leaver.id }, data: { status: 'merged', holder_user_id: null, merged_into_mailbox_id: w.main } });
      await db.user.update({ where: { id: leaver.id }, data: { is_active: false }, select: { id: true } });

      expect((await permanentDelete(w.deleter, leaver)).status).toBe(200);

      expect(await mailboxRow(owner.box)).toMatchObject({ user_id: owner.leaver.id, holder_user_id: null, status: 'merged', merged_into_mailbox_id: w.main });
    });

    it('leaves a mailbox that is still held by somebody else exactly as it is', async () => {
      const w = await world();
      const { leaver, box } = await leaverWith(w, 'Una', { status: 'handed', holder: w.heir.id });
      await db.user.update({ where: { id: leaver.id }, data: { is_active: false }, select: { id: true } });

      expect((await permanentDelete(w.deleter, leaver)).status).toBe(200);

      expect(await mailboxRow(box)).toMatchObject({ user_id: null, holder_user_id: w.heir.id, status: 'handed', merged_into_mailbox_id: null });
    });

    it('does not merge anything when the company has no main mailbox, and still deletes (the mail stays where it is)', async () => {
      const w = await world();
      const { leaver, box } = await leaverWith(w, 'Una');
      await db.user.update({ where: { id: leaver.id }, data: { is_active: false }, select: { id: true } });
      await db.mailboxReader.deleteMany({ where: { organization_id: w.org } });
      await db.mailbox.update({ where: { id: w.main }, data: { kind: 'user' }, select: { id: true } });

      expect((await permanentDelete(w.deleter, leaver)).status).toBe(200);

      expect(await mailboxRow(box)).toMatchObject({ user_id: null, holder_user_id: null });
      expect(await db.mailboxAddress.count({ where: { mailbox_id: box } })).toBe(1);
    });
  });

  describe('refusals are as before, and change nothing', () => {
    it('refuses a user with real history, and leaves their mailbox, its conversations and address untouched', async () => {
      const w = await world();
      const { leaver, box, local } = await leaverWith(w, 'Una');
      const kept = await addConversation(w, box);
      await db.note.create({ data: { id: randomUUID(), organization_id: w.org, entity_type: 'CUSTOMER', entity_id: w.customer, content: 'history', created_by: leaver.id } });
      await db.user.update({ where: { id: leaver.id }, data: { is_active: false }, select: { id: true } });

      const res = await permanentDelete(w.deleter, leaver);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/notes/);
      expect(await userRow(leaver.id)).not.toBeNull();
      expect(await mailboxRow(box)).toMatchObject({ user_id: leaver.id, holder_user_id: leaver.id, status: 'active', merged_into_mailbox_id: null });
      expect((await threadRow(kept.thread)).mailbox_id).toBe(box);
      expect(await db.mailboxAddress.findUnique({ where: { local_part: local } })).toMatchObject({ mailbox_id: box });
    });

    it('rolls the merge back when the delete itself is refused by other records, so the mailbox is not moved for nothing', async () => {
      const w = await world();
      const { leaver, box } = await leaverWith(w, 'Una');
      const kept = await addConversation(w, box);
      // A task the person created is not on the history list, but its foreign key still stops the row from going.
      await db.$executeRaw`
        INSERT INTO tasks (id, task_number, title, created_by, organization_id, updated_at)
        VALUES (${randomUUID()}::uuid, ${`T-${tagOf()}`}, 'run-permanent-delete', ${leaver.id}::uuid, ${w.org}::uuid, now())`;
      await db.user.update({ where: { id: leaver.id }, data: { is_active: false }, select: { id: true } });

      const res = await permanentDelete(w.deleter, leaver);

      expect(res.status).toBe(409);
      expect(await userRow(leaver.id)).not.toBeNull();
      expect(await mailboxRow(box)).toMatchObject({ user_id: leaver.id, holder_user_id: leaver.id, status: 'active', merged_into_mailbox_id: null });
      expect(await threadRow(kept.thread)).toMatchObject({ mailbox_id: box, origin: 'started', moved_from_mailbox_id: null });
    });

    it('refuses an active user', async () => {
      const w = await world();
      const { leaver, box } = await leaverWith(w, 'Una');

      const res = await permanentDelete(w.deleter, leaver);

      expect(res.status).toBe(409);
      expect(await userRow(leaver.id)).not.toBeNull();
      expect(await mailboxRow(box)).toMatchObject({ user_id: leaver.id, status: 'active' });
    });

    it('refuses permanent delete and the two-step login reset without Delete users, even with Edit users, and changes nothing', async () => {
      const w = await world();
      const { leaver, box } = await leaverWith(w, 'Una');
      await db.user.update({ where: { id: leaver.id }, data: { is_active: false, mfa_email_enrolled: true }, select: { id: true } });
      const editorOnly = await w.editor.api();

      expect((await editorOnly.delete(`/api/users/${leaver.id}/permanent`)).status).toBe(403);
      expect((await editorOnly.post(`/api/users/${leaver.id}/mfa/reset`)).status).toBe(403);

      expect(await userRow(leaver.id)).toMatchObject({ mfa_email_enrolled: true });
      expect(await mailboxRow(box)).toMatchObject({ user_id: leaver.id, holder_user_id: leaver.id, status: 'active' });

      // Delete users alone does the delete and the reset, and does not stand in for Edit users.
      expect((await (await w.deleter.api()).post(`/api/users/${leaver.id}/mfa/reset`)).status).toBe(200);
      expect((await deactivate(w.deleter, leaver)).status).toBe(403);
    });

    it('lets a holder of Edit users alone deactivate and hand over, and not delete', async () => {
      const w = await world();
      const { person, mailbox } = await invite(w, 'Ivy', 'Mistake');

      expect((await deactivate(w.editor, person, w.heir.id)).status).toBe(200);
      expect((await permanentDelete(w.editor, person)).status).toBe(403);

      expect(await userRow(person.id)).not.toBeNull();
      expect(await mailboxRow(mailbox.id)).toMatchObject({ user_id: person.id, holder_user_id: w.heir.id, status: 'handed' });
    });
  });

  describe('what a delete keeps', () => {
    it('keeps the From of a message the user sent, and the message in its conversation', async () => {
      const w = await world();
      const sender = await personWith(w.org, {}, { name: 'Sid', mailbox: false });
      const box = randomUUID();
      const local = `sid.tester.${w.part}`;
      await db.mailbox.create({ data: { id: box, organization_id: w.org, kind: 'user', user_id: sender.id, holder_user_id: sender.id, status: 'active' } });
      await db.mailboxAddress.create({ data: { local_part: local, organization_id: w.org, mailbox_id: box, is_primary: true } });
      const first = await receive(`${local}@${MAILBOX_DOMAIN}`);
      const res = await (await sender.api()).post('/api/communication/emails', {
        to: 'pat@example.com', subject: 'Re: Quick question', body: ['Yes, we are.'], thread_id: first.thread_id!,
      });
      expect(res.status).toBe(201);
      const before = await db.email.findUniqueOrThrow({ where: { id: res.body.email.id } });
      expect(before.sent_by_user_id).toBe(sender.id);
      expect(JSON.stringify(before.from)).toContain(local);

      expect((await deactivate(w.editor, sender)).status).toBe(200);
      expect((await permanentDelete(w.deleter, sender)).status).toBe(200);

      const after = await db.email.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.from).toEqual(before.from);
      expect(after).toMatchObject({ sent_by_user_id: null, thread_id: first.thread_id, folder: before.folder, subject: before.subject });
      expect((await threadRow(first.thread_id!)).mailbox_id).toBe(w.main);
    });
  });

  describe('no foreign key from the mailbox tables blocks a delete', () => {
    it('gives every foreign key to users from the mailbox, address, conversation, message, reply and read tables a rule that clears or removes the row', async () => {
      const rows = await db.$queryRaw<{ tbl: string; col: string; rule: string }[]>`
        SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype::text AS rule
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
         WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass
           AND c.conrelid::regclass::text ~ '^(mailboxes|mailbox_addresses|mailbox_readers|emails|email_threads|email_read_states|email_forward_rules|reply_tokens)$'
         ORDER BY 1, 2`;
      // 'n' = SET NULL (the link is cleared, the row stays), 'c' = CASCADE (a row that only says what the person read or linked).
      const blocking = rows.filter((r) => r.rule !== 'n' && r.rule !== 'c').map((r) => `${r.tbl}.${r.col}`);
      expect(blocking).toEqual([]);
      // The links that matter to this slice are among them, and are SET NULL (the rows are kept).
      const cleared = new Set(rows.filter((r) => r.rule === 'n').map((r) => `${r.tbl}.${r.col}`));
      for (const link of ['mailboxes.user_id', 'mailboxes.holder_user_id', 'emails.sent_by_user_id', 'email_threads.assigned_to_user_id']) {
        expect(cleared.has(link), link).toBe(true);
      }
    });

    it('does not count the mailbox tables as blocking history', async () => {
      const { DELETE_BLOCKING_RELATIONS } = await import('../controllers/user.controller.js');
      const { Prisma } = await import('@prisma/client');
      const user = Prisma.dmmf.datamodel.models.find((m) => m.name === 'User')!;
      const mailboxWorld = user.fields
        .filter((f) => f.kind === 'object' && /^(Mailbox|MailboxReader|MailboxAddress|Email|EmailThread|EmailReadState|ReplyToken)$/.test(f.type))
        .map((f) => f.name);
      expect(mailboxWorld.length).toBeGreaterThan(0);
      expect(Object.keys(DELETE_BLOCKING_RELATIONS).filter((k) => mailboxWorld.includes(k))).toEqual([]);
    });
  });
});
