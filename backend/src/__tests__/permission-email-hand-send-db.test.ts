/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.11 - hand-written email goes from the sender's own mailbox.

   Every new email and reply written by hand (the Email page; a job's, lead's or customer's tab) goes out from the
   sender's OWN address with "<name> at <company>" as the display name, in any conversation they can reach. There is no
   From choice: the server refuses any other mailbox, for a person on Communication scope All too. The first reply in an
   unassigned main-mailbox conversation takes it. A person with no address is refused, and the company's switches and
   the plan still block every mailbox.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding exactly the
   switch values under test, against a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   The real dispatcher runs; only the mail provider's client is faked, so the headers that "went out" are read back and
   compared with the stored email. No email leaves the machine. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient, resendSend } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, resendSend: vi.fn() };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// Only the mail provider's client is faked.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    domains = { create: vi.fn(), get: vi.fn(), verify: vi.fn(), remove: vi.fn() };
  },
}));
// The suite-wide setup replaces the dispatcher with a stub; here the real one runs, with the provider key and the
// mailbox domain set BEFORE it loads (it builds its client at load).
vi.mock('../lib/email', async (importOriginal) => {
  const { env } = await import('../config/env.js');
  Object.assign(env, { RESEND_API_KEY: 're_test_key', MAILBOX_DOMAIN: 'staging.mail.test.com', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com' });
  return importOriginal();
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('hand-written email goes from the sender\'s own mailbox (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_readers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  beforeEach(() => {
    resendSend.mockReset();
    resendSend.mockImplementation(async () => ({ data: { id: `re_${randomUUID()}` }, error: null }));
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api>; first: string; last: string };
  let sequence = 0;

  /** A company that sends mail, with its main mailbox and address. */
  async function newOrg(opts: { sending?: boolean; featureOverrides?: Record<string, boolean> } = {}) {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const part = `co${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: {
        email_sending_enabled: opts.sending ?? true, email_sender_local_part: part,
        ...(opts.featureOverrides ? { feature_overrides: opts.featureOverrides } : {}),
      },
    });
    const main = await db.mailbox.create({ data: { organization_id: made.org, kind: 'main', status: 'active' }, select: { id: true } });
    await db.mailboxAddress.create({ data: { local_part: part, organization_id: made.org, mailbox_id: main.id, is_primary: true } });
    return { ...made, main: main.id, part };
  }
  type World = Awaited<ReturnType<typeof newOrg>>;

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

  /** A person on a fresh custom role of this base holding exactly these switch values, with the Email page open. */
  async function personWith(
    w: World,
    values: Record<string, boolean | string>,
    opts: { address?: boolean | string } = {},
    base: Role = 'DISPATCHER',
  ): Promise<Who> {
    const key = `hs-role-${++sequence}`;
    const role = await fx.addCustomRole(w.org, key, base);
    await setRoleSwitchValues({
      organizationId: w.org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, view_invoices: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'attached',
        contact_customers: true,
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(w.org, `p${sequence}`, base, { customRoleId: role.id });
    const mailbox = await userMailbox(w, person, opts.address ?? true);
    void mailbox;
    return Object.assign(person, { api: () => fx.signedInAs(person), first: `p${sequence}`, last: 'Tester' });
  }

  /** A user's own mailbox: with its primary address (the default), or in "address needed" with none. */
  async function userMailbox(w: World, owner: Person, address: boolean | string = true, holder: Person | null = owner) {
    const id = randomUUID();
    await db.mailbox.create({
      data: {
        id, organization_id: w.org, kind: 'user', user_id: owner.id, holder_user_id: holder?.id ?? null,
        status: address ? 'active' : 'address_needed',
      },
    });
    if (address) {
      const local = typeof address === 'string' ? address : `${owner.email.split('@')[0]}.${w.part}`.toLowerCase();
      await db.mailboxAddress.create({ data: { local_part: local, organization_id: w.org, mailbox_id: id, is_primary: true } });
    }
    return id;
  }
  /** A leaver's mailbox handed to someone: it stays the leaver's, and the new holder sees it. */
  async function handOver(leaver: Person, to: Person) {
    const box = await mailboxOf(leaver);
    await db.mailbox.update({ where: { id: box.id }, data: { holder_user_id: to.id } });
    return box.id;
  }
  const mailboxOf = async (person: Person) => db.mailbox.findFirstOrThrow({
    where: { user_id: person.id, kind: 'user' }, include: { addresses: { where: { is_primary: true } } },
  });
  const addressOf = async (person: Person) => `${(await mailboxOf(person)).addresses[0]!.local_part}@staging.mail.test.com`;
  const nameOf = (w: World, person: Who) => `${person.first} ${person.last} at switches-${w.tag}`;

  type Conversation = { origin?: string; assignedTo?: string; messages?: { direction?: 'out' | 'in'; jobId?: string }[] };
  /** A conversation in `mailboxId`, holding the messages given (one inbound message when none are). */
  async function addConversation(w: World, mailboxId: string, conv: Conversation = {}) {
    const thread = randomUUID();
    await db.emailThread.create({
      data: { id: thread, organization_id: w.org, mailbox_id: mailboxId, origin: conv.origin ?? 'started', assigned_to_user_id: conv.assignedTo ?? null },
    });
    const ids: string[] = [];
    for (const m of conv.messages ?? [{}]) {
      const id = randomUUID();
      const out = m.direction === 'out';
      await db.email.create({
        data: {
          id, organization_id: w.org, thread_id: thread, customer_id: w.customer, job_id: m.jobId ?? null,
          account: 'user', direction: out ? 'out' : 'in', folder: out ? 'sent' : 'inbox',
          from: { name: null, email: out ? 'office@example.com' : 'customer@example.com' },
          to: out ? 'customer@example.com' : 'office@example.com',
          subject: 'run-hand-send', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
        select: { id: true },
      });
      ids.push(id);
    }
    return { thread, first: ids[0]! };
  }

  const send = async (person: Who, body: Record<string, unknown> = {}) =>
    (await person.api()).post('/api/communication/emails', { to: 'customer@example.com', subject: 'Hello', body: ['Hi'], ...body });

  /** The message the mocked provider was last given. */
  const lastSent = () => resendSend.mock.calls.at(-1)![0] as { from: string; replyTo: string; to: string };

  /** The header a send went out with, as address and name. */
  const headerOf = (header: string) => {
    const m = /^"(.*)" <(.*)>$/.exec(header)!;
    return { name: m[1]!, address: m[2]! };
  };

  describe('a new email goes from the sender\'s own mailbox', () => {
    it('on the Email page: their address and "<name> at <company>", the stored email says exactly what went out, and the conversation starts in their mailbox', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      const res = await send(jane);
      expect(res.status).toBe(201);

      const header = headerOf(lastSent().from);
      expect(header).toEqual({ name: nameOf(w, jane), address: await addressOf(jane) });
      const stored = await db.email.findUniqueOrThrow({ where: { id: res.body.email.id } });
      expect(stored.from).toEqual({ name: header.name, email: header.address });
      expect(stored.sent_by_user_id).toBe(jane.id);

      const thread = await db.emailThread.findUniqueOrThrow({ where: { id: stored.thread_id! } });
      expect(thread).toMatchObject({ mailbox_id: (await mailboxOf(jane)).id, origin: 'started', assigned_to_user_id: jane.id });
    });

    it.each(['job', 'customer', 'lead'] as const)('from a %s\'s tab: the same, stamped with the record', async (kind) => {
      const w = await newOrg();
      const jane = await personWith(w, { view_jobs: true });
      const record =
        kind === 'job' ? { job_id: (await fx.addJob(w.org, w.customer, { crew: [jane.id] })).id }
        : kind === 'lead' ? { lead_id: (await fx.addLead(w.org, w.customer, { assignees: [jane.id] })).id }
        : { customer_id: w.customer };
      // Emailing a customer needs the customer to be one the person reaches: Jane is on a lead of theirs (M2).
      await fx.addLead(w.org, w.customer, { assignees: [jane.id] });
      const res = await send(jane, record);
      expect(res.status).toBe(201);

      const header = headerOf(lastSent().from);
      expect(header).toEqual({ name: nameOf(w, jane), address: await addressOf(jane) });
      const stored = await db.email.findUniqueOrThrow({ where: { id: res.body.email.id } });
      expect(stored.from).toEqual({ name: header.name, email: header.address });
      expect(stored).toMatchObject({ job_id: (record as { job_id?: string }).job_id ?? null });
    });

    it('carries the hidden reply address, which the existing resolver maps back to the new conversation', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      const res = await send(jane);
      const { parseReplyAddress, resolveReplyToken } = await import('../lib/reply-token.js');

      const token = parseReplyAddress(lastSent().replyTo)!;
      expect(token).toBeTruthy();
      const stored = await db.email.findUniqueOrThrow({ where: { id: res.body.email.id } });
      expect((await resolveReplyToken(db, token))?.thread_id).toBe(stored.thread_id);
    });

    it('sends to any recipient', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      for (const to of ['someone@example.org', 'colleague@elsewhere.example.net']) {
        expect((await send(jane, { to })).status).toBe(201);
        expect(lastSent().to).toBe(to);
      }
    });
  });

  describe('an email written on a job\'s or lead\'s tab belongs to that record\'s customer', () => {
    const customerTab = async (person: Who, customer: string) =>
      (await person.api()).get(`/api/customers/${customer}/communications`);
    const tabIds = (res: { body: { items?: { id: string }[] } }) => (res.body.items ?? []).map((i) => i.id);

    it('stamps the job\'s customer on a job-tab send, so it shows on that customer\'s tab for someone who can open the customer and the job', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      const job = await fx.addJob(w.org, w.customer, { crew: [jane.id] });
      const res = await send(jane, { job_id: job.id });
      expect(res.status).toBe(201);

      const stored = await db.email.findUniqueOrThrow({ where: { id: res.body.email.id } });
      expect(stored).toMatchObject({ job_id: job.id, customer_id: w.customer });
      const tab = await customerTab(jane, w.customer);
      expect(tab.status).toBe(200);
      expect(tabIds(tab)).toContain(res.body.email.id);
    });

    it('stamps the lead\'s customer on a lead-tab send', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      const lead = await fx.addLead(w.org, w.customer, { assignees: [jane.id] });
      const res = await send(jane, { lead_id: lead.id });
      expect(res.status).toBe(201);

      const stored = await db.email.findUniqueOrThrow({ where: { id: res.body.email.id } });
      expect(stored).toMatchObject({ lead_id: lead.id, customer_id: w.customer });
      expect(tabIds(await customerTab(jane, w.customer))).toContain(res.body.email.id);
    });

    it('keeps the job\'s reach on the customer\'s tab: a person who can open the customer through another job does not get it, and one who cannot open the customer gets a 404', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      const onOtherJob = await personWith(w, {});
      const stranger = await personWith(w, {});
      const job = await fx.addJob(w.org, w.customer, { crew: [jane.id] });
      await fx.addJob(w.org, w.customer, { crew: [onOtherJob.id] });
      const res = await send(jane, { job_id: job.id });
      expect(res.status).toBe(201);

      const sees = await customerTab(onOtherJob, w.customer);
      expect(sees.status).toBe(200);
      expect(tabIds(sees)).not.toContain(res.body.email.id);
      expect((await customerTab(stranger, w.customer)).status).toBe(404);
    });

    it('stamps the customer on the reply address too, so the customer\'s answer carries it', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      const job = await fx.addJob(w.org, w.customer, { crew: [jane.id] });
      await send(jane, { job_id: job.id });
      const { parseReplyAddress, resolveReplyToken } = await import('../lib/reply-token.js');
      expect((await resolveReplyToken(db, parseReplyAddress(lastSent().replyTo)!))?.customer_id).toBe(w.customer);
    });
  });

  describe('a reply goes from the sender\'s own mailbox, in any conversation they can reach', () => {
    /** Sends a reply and proves it left from the sender's own address, was stored as such, and keeps the conversation. */
    async function expectOwnReply(w: World, person: Who, thread: string, mailboxOfThread: string) {
      const res = await send(person, { thread_id: thread });
      expect(res.status).toBe(201);
      const header = headerOf(lastSent().from);
      expect(header).toEqual({ name: nameOf(w, person), address: await addressOf(person) });
      const stored = await db.email.findUniqueOrThrow({ where: { id: res.body.email.id } });
      expect(stored.from).toEqual({ name: header.name, email: header.address });
      expect(stored.thread_id).toBe(thread);
      expect((await db.emailThread.findUniqueOrThrow({ where: { id: thread } })).mailbox_id).toBe(mailboxOfThread);

      // The customer's answer to the reply address lands in the same conversation (the inbound path is unchanged).
      const { parseReplyAddress, resolveReplyToken } = await import('../lib/reply-token.js');
      const row = await resolveReplyToken(db, parseReplyAddress(lastSent().replyTo)!);
      expect(row?.thread_id).toBe(thread);
      expect(row?.expected_from).toBe('customer@example.com');
      return stored;
    }

    it('in their own mailbox', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      const mine = (await mailboxOf(jane)).id;
      const conv = await addConversation(w, mine);
      await expectOwnReply(w, jane, conv.thread, mine);
    });

    it('in a conversation of the main mailbox, as one of its readers', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      await db.mailboxReader.create({ data: { organization_id: w.org, mailbox_id: w.main, user_id: jane.id } });
      const conv = await addConversation(w, w.main);
      await expectOwnReply(w, jane, conv.thread, w.main);
    });

    it('in a mailbox handed over to them, under their own address and name and never the leaver\'s', async () => {
      const w = await newOrg();
      const leaver = await personWith(w, {});
      const jane = await personWith(w, {});
      const handed = await handOver(leaver, jane);
      const conv = await addConversation(w, handed);
      await expectOwnReply(w, jane, conv.thread, handed);
      expect(lastSent().from).not.toContain(leaver.first);
    });

    it('in a colleague\'s mailbox, for a person on Communication scope All', async () => {
      const w = await newOrg();
      const wide = await personWith(w, { communication_scope: 'all' });
      const colleague = await personWith(w, {});
      const theirs = (await mailboxOf(colleague)).id;
      const conv = await addConversation(w, theirs);
      await expectOwnReply(w, wide, conv.thread, theirs);
    });
  });

  describe('there is no From choice', () => {
    const SCOPES = ['attached', 'all'] as const;

    it.each(SCOPES)('refuses a send that names the main mailbox, a colleague\'s, a handed-over one or another company\'s, on scope %s', async (scope) => {
      const w = await newOrg();
      const other = await newOrg();
      const jane = await personWith(w, { communication_scope: scope });
      const colleague = await personWith(w, {});
      const leaver = await personWith(w, {});
      const handedOver = await handOver(leaver, jane);
      const strangers = await personWith(other, {});
      const conv = await addConversation(w, (await mailboxOf(jane)).id);

      const named = [w.main, (await mailboxOf(colleague)).id, handedOver, (await mailboxOf(strangers)).id, randomUUID(), 'not-an-id'];
      for (const from_mailbox_id of named) {
        for (const extra of [{}, { thread_id: conv.thread }]) {
          const res = await send(jane, { from_mailbox_id, ...extra });
          expect(res.status, `${from_mailbox_id}`).toBe(403);
          expect(res.body.error).toBe('You can only send email from your own address.');
        }
      }
      expect(resendSend).not.toHaveBeenCalled();
      expect(await db.email.count({ where: { organization_id: w.org, direction: 'out' } })).toBe(0);
    });

    it('lets a request name the sender\'s own mailbox, and still sends from it', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      const res = await send(jane, { from_mailbox_id: (await mailboxOf(jane)).id });
      expect(res.status).toBe(201);
      expect(headerOf(lastSent().from).address).toBe(await addressOf(jane));
    });

    it('ignores an address or a name in the body: the header is the register\'s, not the caller\'s', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      const res = await send(jane, { from: { name: 'The CEO', email: 'ceo@example.com' }, from_name: 'The CEO', from_address: 'ceo@example.com' });
      expect(res.status).toBe(201);
      expect(headerOf(lastSent().from)).toEqual({ name: nameOf(w, jane), address: await addressOf(jane) });
    });

    it('keeps a hostile name from splitting the header, and the stored email matches it', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      await db.user.update({ where: { id: jane.id }, data: { first_name: 'Eve\r\nBcc: spy@example.com "<x>,', last_name: 'Hacker' } });
      const { clearSwitchCacheForUser } = await import('../lib/permissions/switches/cache.js');
      clearSwitchCacheForUser(jane.id);
      const res = await send(jane);
      expect(res.status).toBe(201);
      const header = lastSent().from;
      expect(header).not.toMatch(/[\r\n]/);
      expect(header).toMatch(/^"[^"<>,\\]*" <[^<>\s,"]+>$/);
      const stored = await db.email.findUniqueOrThrow({ where: { id: res.body.email.id } });
      expect(stored.from).toEqual({ name: headerOf(header).name, email: headerOf(header).address });
    });
  });

  describe('a person with no address of their own cannot send by hand', () => {
    const MESSAGE = "You don't have an email address yet. An admin needs to set one before you can send email.";

    it.each([
      ['in "address needed"', false],
      ['with no mailbox at all', null],
    ] as const)('is refused on every hand send, %s, and nothing is sent or stored', async (_label, address) => {
      const w = await newOrg();
      const jane = await personWith(w, {}, { address: address === null ? false : address });
      if (address === null) await db.mailbox.deleteMany({ where: { user_id: jane.id } });
      const job = await fx.addJob(w.org, w.customer, { crew: [jane.id] });
      const mine = await userMailbox(w, await fx.addUser(w.org, 'owner', 'DISPATCHER'), true);
      const conv = await addConversation(w, mine);

      for (const body of [{}, { thread_id: conv.thread }, { job_id: job.id }, { customer_id: w.customer }]) {
        const res = await send(jane, body);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ error: MESSAGE, code: 'ADDRESS_NEEDED' });
      }
      expect(resendSend).not.toHaveBeenCalled();
      expect(await db.email.count({ where: { organization_id: w.org, direction: 'out' } })).toBe(0);
    });

    it('still has automated sends about their records go out, from the company\'s main address', async () => {
      const w = await newOrg();
      await personWith(w, {}, { address: false });
      const { __dispatchEmailForTest } = await import('../lib/email.js');
      const result = await __dispatchEmailForTest(w.org, { to: 'customer@example.com', subject: 'Your visit', text: 'See you' } as never);
      expect(result.status).toBe('sent');
      expect(headerOf(lastSent().from)).toMatchObject({ address: `${w.part}@staging.mail.test.com` });
    });
  });

  describe('the existing blocks stand for every mailbox', () => {
    it('refuses a send without Contact customers, for the new email and the reply', async () => {
      const w = await newOrg();
      const jane = await personWith(w, { ...withDependantsOff(['contact_customers']), communication_scope: 'all' });
      const conv = await addConversation(w, (await mailboxOf(jane)).id);
      expect((await send(jane)).status).toBe(403);
      expect((await send(jane, { thread_id: conv.thread })).status).toBe(403);
      expect(resendSend).not.toHaveBeenCalled();
    });

    it('stops every send while the company has email sending off, and stores nothing', async () => {
      const w = await newOrg({ sending: false });
      const jane = await personWith(w, {});
      await db.mailboxReader.create({ data: { organization_id: w.org, mailbox_id: w.main, user_id: jane.id } });
      const inMain = await addConversation(w, w.main);
      for (const body of [{}, { thread_id: inMain.thread }]) {
        const res = await send(jane, body);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('EMAIL_SENDING_DISABLED');
      }
      expect(resendSend).not.toHaveBeenCalled();
      expect(await db.email.count({ where: { organization_id: w.org, direction: 'out' } })).toBe(0);
    });

    it('stops a send to an address on the suppression list', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      const bounced = `bounced-${w.tag}@example.com`;
      await db.emailSuppression.create({ data: { address: bounced, category: 'TRANSACTIONAL', kind: 'HARD_BOUNCE' } });
      try {
        const res = await send(jane, { to: bounced });
        expect(res.status).toBe(409);
        expect(resendSend).not.toHaveBeenCalled();
      } finally {
        await db.emailSuppression.deleteMany({ where: { address: bounced } });
      }
    });

    it('closes the whole thing while ServWave has the Email plan feature off for the company', async () => {
      const w = await newOrg({ featureOverrides: { email: false } });
      const jane = await personWith(w, {});
      const res = await send(jane);
      expect(res.status).toBe(402);
      expect(resendSend).not.toHaveBeenCalled();
    });
  });

  describe('the first reply takes a main-mailbox conversation that has no assignee', () => {
    async function twoReaders(w: World) {
      const a = await personWith(w, {});
      const b = await personWith(w, {});
      for (const reader of [a, b]) await db.mailboxReader.create({ data: { organization_id: w.org, mailbox_id: w.main, user_id: reader.id } });
      return { a, b };
    }
    const assigneeOf = async (thread: string) => (await db.emailThread.findUniqueOrThrow({ where: { id: thread } })).assigned_to_user_id;

    it('assigns it to the replier, and it stays listed for the other reader marked with that assignee', async () => {
      const w = await newOrg();
      const { a, b } = await twoReaders(w);
      const conv = await addConversation(w, w.main);

      expect((await send(a, { thread_id: conv.thread })).status).toBe(201);

      expect(await assigneeOf(conv.thread)).toBe(a.id);
      const list = await (await b.api()).get('/api/communication/emails');
      const row = (list.body.emails as { id: string; threadAssignedToUserId: string | null }[]).find((e) => e.id === conv.first);
      expect(row?.threadAssignedToUserId).toBe(a.id);
    });

    it('keeps the first replier when a second person replies later, and still sends and stores the second reply', async () => {
      const w = await newOrg();
      const { a, b } = await twoReaders(w);
      const conv = await addConversation(w, w.main);
      await send(a, { thread_id: conv.thread });
      expect((await send(b, { thread_id: conv.thread })).status).toBe(201);
      expect(await assigneeOf(conv.thread)).toBe(a.id);
      expect(await db.email.count({ where: { thread_id: conv.thread, direction: 'out' } })).toBe(2);
    });

    it('lets exactly one of two people replying at the same moment take it, and sends and stores both replies', async () => {
      for (let round = 0; round < 3; round++) {
        const w = await newOrg();
        const { a, b } = await twoReaders(w);
        const conv = await addConversation(w, w.main);

        const [first, second] = await Promise.all([send(a, { thread_id: conv.thread }), send(b, { thread_id: conv.thread })]);

        expect([first.status, second.status]).toEqual([201, 201]);
        expect([a.id, b.id]).toContain(await assigneeOf(conv.thread));
        expect(await db.email.count({ where: { thread_id: conv.thread, direction: 'out' } })).toBe(2);
        expect(resendSend).toHaveBeenCalledTimes(2);
        resendSend.mockClear();
      }
    });

    it('takes it when the assignee has left (the inbox reads that as no assignee)', async () => {
      const w = await newOrg();
      const { a } = await twoReaders(w);
      const leaver = await fx.addUser(w.org, 'leaver', 'DISPATCHER');
      await db.user.update({ where: { id: leaver.id }, data: { is_active: false } });
      const conv = await addConversation(w, w.main, { assignedTo: leaver.id });
      await send(a, { thread_id: conv.thread });
      expect(await assigneeOf(conv.thread)).toBe(a.id);
    });

    it('leaves a conversation that already has an assignee, and one in anyone\'s own mailbox, alone', async () => {
      const w = await newOrg();
      const { a } = await twoReaders(w);
      const owner = await fx.addUser(w.org, 'owner', 'DISPATCHER');
      const assigned = await addConversation(w, w.main, { assignedTo: owner.id });
      await send(a, { thread_id: assigned.thread });
      expect(await assigneeOf(assigned.thread)).toBe(owner.id);

      const wide = await personWith(w, { communication_scope: 'all' });
      const colleague = await personWith(w, {});
      const theirs = await addConversation(w, (await mailboxOf(colleague)).id);
      await send(wide, { thread_id: theirs.thread });
      expect(await assigneeOf(theirs.thread)).toBeNull();
    });

    it('can still be reassigned afterwards', async () => {
      const w = await newOrg();
      const { a, b } = await twoReaders(w);
      const conv = await addConversation(w, w.main);
      await send(a, { thread_id: conv.thread });

      const res = await (await a.api()).patch(`/api/communication/emails/threads/${conv.thread}/assign`, { user_id: b.id });
      expect(res.status).toBe(200);
      expect(await assigneeOf(conv.thread)).toBe(b.id);
      expect((await (await a.api()).patch(`/api/communication/emails/threads/${conv.thread}/assign`, { user_id: null })).status).toBe(200);
      expect(await assigneeOf(conv.thread)).toBeNull();
    });
  });

  describe('a person whose address was changed', () => {
    it('sends from the new primary address, and a reply in an old conversation still threads on the same reply address', async () => {
      const { setUserNamePart } = await import('../lib/mailbox/register.js');
      const { parseReplyAddress, resolveReplyToken } = await import('../lib/reply-token.js');
      const w = await newOrg();
      const jane = await personWith(w, {});
      const first = await send(jane);
      const thread = (await db.email.findUniqueOrThrow({ where: { id: first.body.email.id } })).thread_id!;
      const oldAddress = headerOf(lastSent().from).address;
      const oldReplyTo = lastSent().replyTo;

      const changed = await setUserNamePart(db, { organizationId: w.org, userId: jane.id, namePart: `janet${w.tag.replace(/\d/g, 'x')}` });
      expect(changed.ok).toBe(true);
      const { clearSwitchCacheForUser } = await import('../lib/permissions/switches/cache.js');
      clearSwitchCacheForUser(jane.id);

      const reply = await send(jane, { thread_id: thread });
      expect(reply.status).toBe(201);
      const newAddress = headerOf(lastSent().from).address;
      expect(newAddress).not.toBe(oldAddress);
      expect(newAddress).toBe(await addressOf(jane));
      expect(lastSent().replyTo).toBe(oldReplyTo);
      expect((await resolveReplyToken(db, parseReplyAddress(lastSent().replyTo)!))?.thread_id).toBe(thread);
      const stored = await db.email.findUniqueOrThrow({ where: { id: reply.body.email.id } });
      expect((stored.from as { email: string }).email).toBe(newAddress);
    });
  });

  describe('the "Sending as" read says what the send does', () => {
    const identity = async (person: Who) => (await (await person.api()).get('/api/communication/sending-identity')).body;

    it('gives the address and display name the send then uses, to a person without the Email page too', async () => {
      const w = await newOrg();
      const jane = await personWith(w, {});
      const noPage = await personWith(w, { ...withDependantsOff(['access_communication']) });

      for (const person of [jane, noPage]) {
        // Emailing a customer needs the customer to be one the person reaches: each is on a lead of theirs (M2).
        await fx.addLead(w.org, w.customer, { assignees: [person.id] });
        const shown = await identity(person);
        // From the customer's page: the one place a person without the Email page can write from.
        expect((await send(person, { customer_id: w.customer })).status).toBe(201);
        expect(headerOf(lastSent().from)).toEqual({ name: shown.name, address: shown.address });
        expect(shown).toMatchObject({ status: 'active', sendingEnabled: true });
      }
    });

    it('says "address needed" for a person with none, and that sending is off while the company has it off', async () => {
      const w = await newOrg({ sending: false });
      const needy = await personWith(w, {}, { address: false });
      const jane = await personWith(w, {});

      expect(await identity(needy)).toEqual({ status: 'address_needed', address: null, name: null, sendingEnabled: false });
      expect(await identity(jane)).toMatchObject({ status: 'active', sendingEnabled: false });
    });
  });
});
