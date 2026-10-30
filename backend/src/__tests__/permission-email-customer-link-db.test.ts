/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.20 - the customer link by address, the "Unverified sender" mark and attaching by hand.

   Mail on a mailbox address links to a CUSTOMER by the sender's address, never to a conversation, job or lead:
     - exactly one customer has the address: linked (verified on PASS; linked and marked "Unverified sender" on NO_POLICY or
       UNAVAILABLE);
     - several customers have it: linked to none, and the person is offered the matches and picks one (the pick needs the attach
       switch);
     - a sender whose check FAILED is held for review and never linked (S10.18 holds it; this proves the link never happens);
     - mail a person sends from their own mailbox links on its RECIPIENT's address, with no linking by hand;
     - the customer's Communication tab lists every email to or from the customer, from any mailbox, under the per-row reach rule;
     - a person attaches a mailbox conversation to a job or lead with the attach switch and record reach, and it then shows on
       that record's tab.

   Every case goes through the REAL signed delivery webhook (POST /api/webhooks/resend; only the provider's body fetch is
   replaced) and the real routes. People are on custom roles holding exactly the switch values under test, never a built-in role
   name. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';

const { clientPromise, fetchReceived } = vi.hoisted(() => {
  const clientPromise = (async () => {
    const dbUrl = process.env.TEST_DATABASE_URL;
    if (!dbUrl) return undefined;
    const { PrismaClient } = await import('@prisma/client');
    // The hosted database's pool: ONE connection and a short wait, so a query on the global client made inside the webhook's
    // transaction fails here in seconds instead of on the hosted database.
    const pooled = new URL(dbUrl);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '4');
    return new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
  })();
  return { clientPromise, fetchReceived: vi.fn() };
});

// The suite-wide setup mocks the app's client; here it is the real one, on the hosted pool.
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));

// The provider call that fetches a received message is the only thing replaced on the way in.
vi.mock('../lib/inbound-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inbound-email')>()),
  fetchReceivedEmail: fetchReceived,
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { env } from '../config/env';
import { sendComposedEmail } from '../lib/email';
import { replyAddressFor } from '../lib/reply-token';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SECRET_BYTES = randomBytes(24);
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const MAILBOX_DOMAIN = 'mail.test.com';
const ARRIVED = new Date('2026-07-01T15:00:00.000Z');
const EVENT_PREFIX = 'rp-s10-20-';

const PASS = { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' };
const NO_POLICY = { 'Authentication-Results': 'amazonses.com; dmarc=none header.from=example.com' };
const UNAVAILABLE = {};
const FAIL = { 'Authentication-Results': 'amazonses.com; dmarc=fail header.from=example.com' };

suite('the customer link by address (real database, real webhook route)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_readers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM customer_emails WHERE customer_id IN (SELECT id FROM customers WHERE organization_id = '${org}')`));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM resend_events WHERE resend_event_id LIKE '${EVENT_PREFIX}%'`));
    await fx.cleanup();
  });

  beforeEach(() => {
    fetchReceived.mockReset();
    // The suite-wide stub of the outgoing dispatcher answers with one fixed provider id; every send is its own message here.
    vi.mocked(sendComposedEmail).mockImplementation(async () => ({
      status: 'sent', providerMessageId: `re_${randomUUID()}`, fromAddress: 'someone@mail.test.com', fromName: null,
    }));
  });

  let sequence = 0;

  /** Every switch that needs one of these goes off with it, so the set stays storable. */
  const withDependantsOff = (off: string[]): Record<string, boolean> => {
    const out: Record<string, boolean> = Object.fromEntries(off.map((k) => [k, false]));
    for (let grew = true; grew; ) {
      grew = false;
      for (const sw of SWITCH_CATALOG) {
        if (!(sw.key in out) && sw.requires.some((r) => out[r] === false)) { out[sw.key] = false; grew = true; }
      }
    }
    return out;
  };

  /** A role holding exactly these switch values on top of an ordinary office worker's. */
  async function person(org: string, key: string, values: Record<string, boolean | string> = {}): Promise<Person> {
    const seq = ++sequence;
    const role = await fx.addCustomRole(org, `${key}-${seq}`, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: `${key}-${seq}`,
      values: {
        view_jobs: true, jobs_scope: 'all', view_leads: true, leads_scope: 'all', view_customers: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'linked_to_me',
        contact_customers: true, attach_conversations: true, ...values,
      },
      actorId: null, reason: 'manual',
    });
    return fx.addUser(org, `${key}${seq}`, 'DISPATCHER', { customRoleId: role.id });
  }

  /**
   * A company with its main mailbox and a person who holds a mailbox of their own, and four customers: one with a lone address,
   * one with its address among extras, and two that share an address. A job and a lead of the lone customer sit ready to attach to.
   */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, tag, admin } = made;

    const holder = await person(org, 'holder');
    const mailbox = await fx.addUserMailbox(org, holder);
    const address = `${holder.email.split('@')[0]!.toLowerCase()}@${MAILBOX_DOMAIN}`;
    const main = randomUUID();
    await db.mailbox.create({ data: { id: main, organization_id: org, kind: 'main', status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `main-${tag}`, organization_id: org, mailbox_id: main, is_primary: true } });

    const customerOf = async (name: string, email: string | null) => {
      const id = randomUUID();
      await db.customer.create({
        data: { id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: name, last_name: tag, email },
        select: { id: true },
      });
      return id;
    };
    const loneEmail = `Lone.${tag}@Example.com`;
    const lone = await customerOf('Lone', loneEmail);
    const extra = await customerOf('Extra', `extra.main.${tag}@example.com`);
    await db.customerEmail.create({ data: { customer_id: extra, email: `Extra.Second.${tag}@example.com` } });
    const sharedEmail = `office.${tag}@example.com`;
    const sharedA = await customerOf('SharedA', sharedEmail);
    const sharedB = await customerOf('SharedB', sharedEmail);
    const job = await fx.addJob(org, lone, { crew: [holder.id] });
    const lead = await fx.addLead(org, lone, { assignees: [holder.id] });

    return {
      org, tag, admin, holder, mailbox, address, main, mainAddress: `main-${tag}@${MAILBOX_DOMAIN}`,
      lone, extra, sharedA, sharedB, job, lead,
      loneAddress: loneEmail.toLowerCase(), extraAddress: `extra.second.${tag}@example.com`, sharedEmail,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /**
   * Two customers whose addresses differ only by an apostrophe in the local part (an apostrophe is valid in an address): the
   * lookup must take the whole address, never the part after it, which is what the other customer owns.
   */
  async function apostropheWorld(w: World, shared = false) {
    const make = async (name: string, email: string) => {
      const id = randomUUID();
      await db.customer.create({
        data: { id, organization_id: w.org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: name, last_name: w.tag, email },
        select: { id: true },
      });
      return id;
    };
    const address = `o'brien.${w.tag}@example.com`;
    const owner = await make('Apostrophe', address);
    const second = shared ? await make('ApostropheTwin', address) : null;
    const decoy = await make('Decoy', `brien.${w.tag}@example.com`);
    return { address, owner, second, decoy };
  }

  /** The standard signature a delivery webhook carries: HMAC-SHA256 of `id.timestamp.body` under the shared secret. */
  const signed = (svixId: string, body: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET_BYTES).update(`${svixId}.${timestamp}.${body}`).digest('base64');
    return { 'svix-id': svixId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
  };

  interface Delivery {
    to: string[];
    from: string;
    headers?: Record<string, string>;
    subject?: string;
  }

  /** One `email.received` event through the real route. The fetched message is what the provider would answer with. */
  async function receive(d: Delivery) {
    const providerId = `${EVENT_PREFIX}rcv-${randomUUID()}`;
    const eventId = `${EVENT_PREFIX}evt-${randomUUID()}`;
    const subject = d.subject ?? 'Quick question';
    fetchReceived.mockResolvedValue({
      providerId, from: d.from, receivedFor: d.to, to: d.to, subject,
      messageId: `<${providerId}@mail.example.com>`, receivedAt: ARRIVED, text: 'Are you open on Saturday?',
      html: '<div>Are you open on Saturday?</div>', headers: d.headers ?? PASS,
    });
    const body = JSON.stringify({
      type: 'email.received', created_at: ARRIVED.toISOString(),
      data: {
        email_id: providerId, created_at: ARRIVED.toISOString(), from: d.from, to: d.to, cc: [], bcc: [], received_for: d.to,
        message_id: `<${providerId}@mail.example.com>`, subject, attachments: [],
      },
    });
    const res = await request(app).post('/api/webhooks/resend').set('Content-Type', 'application/json').set(signed(eventId, body)).send(body);
    // The webhook answers first and announces after: let the announce finish before the case reads or the suite cleans up.
    await new Promise((r) => setTimeout(r, 500));
    return { res, providerId };
  }

  const stored = (providerId: string) => db.email.findMany({ where: { provider_message_id: { startsWith: providerId } }, orderBy: { provider_message_id: 'asc' } });
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  const asPerson = (p: Person): Promise<Api> => fx.signedInAs(p);

  describe('mail on a mailbox address: the sender\'s address', () => {
    it('links to the one customer that has it, case aside, and starts its own conversation, linked to no job or lead', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: `Lone Customer <${w.loneAddress.toUpperCase()}>` });

      const [row, ...rest] = await stored(providerId);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({ customer_id: w.lone, job_id: null, lead_id: null, inbound_auth: 'PASS', inbound_match: 'MATCHED' });
      const thread = await db.emailThread.findUniqueOrThrow({ where: { id: row!.thread_id! } });
      expect(thread).toMatchObject({ mailbox_id: w.mailbox, origin: 'started', record_type: null, record_id: null });
    });

    it('finds a customer by an extra address too', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: `Extra <${w.extraAddress}>` });
      expect((await stored(providerId))[0]).toMatchObject({ customer_id: w.extra, job_id: null, lead_id: null });
    });

    it.each([
      ['NO_POLICY', NO_POLICY],
      ['UNAVAILABLE', UNAVAILABLE],
    ])('links on %s too, and records the verdict so the screens can mark it unverified', async (verdict, headers) => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: w.loneAddress, headers });
      expect((await stored(providerId))[0]).toMatchObject({ customer_id: w.lone, inbound_auth: verdict, reply_token: null });
    });

    it('links the same customer in every mailbox the message reached, from one read of the customers', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address, w.mainAddress], from: w.loneAddress });
      const rows = await stored(providerId);
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row).toMatchObject({ customer_id: w.lone, job_id: null, lead_id: null });
    });

    it('links to none when several customers have the address, and keeps the mail in its mailbox', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: w.sharedEmail });
      const [row] = await stored(providerId);
      expect(row).toMatchObject({ customer_id: null, job_id: null, lead_id: null, inbound_match: 'MATCHED', review_reason: null });
      expect((await db.emailThread.findUniqueOrThrow({ where: { id: row!.thread_id! } })).mailbox_id).toBe(w.mailbox);
    });

    it('links a sender whose address has an apostrophe to the customer that owns it, not to the one that owns the part after it', async () => {
      const w = await world();
      const a = await apostropheWorld(w);
      const { providerId } = await receive({ to: [w.address], from: `Pat O'Brien <${a.address}>` });
      const [row] = await stored(providerId);
      expect(row).toMatchObject({ customer_id: a.owner, job_id: null, lead_id: null });
    });

    it('links to none when no customer has the address', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: `stranger.${w.tag}@example.org` });
      expect((await stored(providerId))[0]).toMatchObject({ customer_id: null });
    });

    it('never links mail whose sender check failed, which is held for review', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: w.loneAddress, headers: FAIL });
      expect((await stored(providerId))[0]).toMatchObject({ customer_id: null, thread_id: null, inbound_auth: 'FAIL', review_reason: 'failed_authentication' });
    });

    it('never links automatic mail, which is held for review', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: w.loneAddress, headers: { ...PASS, 'Auto-Submitted': 'auto-replied' } });
      expect((await stored(providerId))[0]).toMatchObject({ customer_id: null, review_reason: 'automatic' });
    });

    it('does not link a customer of another company that has the same address', async () => {
      const w = await world();
      const other = await world();
      await db.customer.update({ where: { id: other.lone }, data: { email: w.loneAddress } });
      await db.customer.update({ where: { id: w.lone }, data: { email: `moved.${w.tag}@example.com` } });
      const { providerId } = await receive({ to: [w.address], from: w.loneAddress });
      expect((await stored(providerId))[0]).toMatchObject({ customer_id: null });
    });
  });

  /** The mailbox page's own list, as the holder reads it. */
  async function listOf(p: Person, mailbox: string) {
    const api = await asPerson(p);
    const res = await api.get(`/api/communication/emails?mailbox=${mailbox}`);
    expect(res.status).toBe(200);
    return res.body.emails as Array<Record<string, unknown> & { id: string }>;
  }

  describe('the marks on the Email page', () => {
    it.each([
      ['NO_POLICY', NO_POLICY],
      ['UNAVAILABLE', UNAVAILABLE],
    ])('marks a customer-linked message from an unverified sender (%s) and names its customer', async (_verdict, headers) => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: w.loneAddress, headers });
      const [row] = await stored(providerId);
      const listed = (await listOf(w.holder, w.mailbox)).find((e) => e.id === row!.id);
      expect(listed).toMatchObject({ unverifiedSender: true, customerId: w.lone, inboundAuth: _verdict });
      expect(listed!.linkedCustomer).toMatchObject({ id: w.lone });
      expect(listed).not.toHaveProperty('matchesSeveralCustomers');
    });

    it('does not mark a verified sender', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: w.loneAddress, headers: PASS });
      const [row] = await stored(providerId);
      const listed = (await listOf(w.holder, w.mailbox)).find((e) => e.id === row!.id);
      expect(listed).toMatchObject({ customerId: w.lone });
      expect(listed).not.toHaveProperty('unverifiedSender');
    });

    it('does not mark an unverified sender that no customer has, since nothing was linked', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: `stranger.${w.tag}@example.org`, headers: NO_POLICY });
      const [row] = await stored(providerId);
      const listed = (await listOf(w.holder, w.mailbox)).find((e) => e.id === row!.id);
      expect(listed).not.toHaveProperty('unverifiedSender');
      expect(listed).not.toHaveProperty('matchesSeveralCustomers');
    });

    it('says a message matches several customers, and only then', async () => {
      const w = await world();
      const shared = await receive({ to: [w.address], from: w.sharedEmail });
      const lone = await receive({ to: [w.address], from: w.loneAddress });
      const rows = await listOf(w.holder, w.mailbox);
      const [sharedRow] = await stored(shared.providerId);
      const [loneRow] = await stored(lone.providerId);
      expect(rows.find((e) => e.id === sharedRow!.id)).toMatchObject({ matchesSeveralCustomers: true });
      expect(rows.find((e) => e.id === loneRow!.id)).not.toHaveProperty('matchesSeveralCustomers');
    });
  });

  describe('picking one of several customers', () => {
    it('flags, offers and links an apostrophe address that several customers share, by the whole address', async () => {
      const w = await world();
      const a = await apostropheWorld(w, true);
      const { providerId } = await receive({ to: [w.address], from: a.address });
      const [email] = await stored(providerId);
      expect(email).toMatchObject({ customer_id: null });
      const rows = await listOf(w.holder, w.mailbox);
      expect(rows.find((e) => e.id === email!.id)).toMatchObject({ matchesSeveralCustomers: true });
      const offered = await (await asPerson(w.holder)).get(`/api/communication/emails/${email!.id}/customer-candidates`);
      expect(offered.status).toBe(200);
      expect((offered.body.customers as { id: string }[]).map((c) => c.id).sort()).toEqual([a.owner, a.second!].sort());
      const picked = await (await asPerson(w.holder)).patch(`/api/communication/emails/${email!.id}/customer`, { customer_id: a.owner });
      expect(picked.status).toBe(200);
      expect(await db.email.findUniqueOrThrow({ where: { id: email!.id } })).toMatchObject({ customer_id: a.owner });
      const wrong = await (await asPerson(w.holder)).patch(`/api/communication/emails/${email!.id}/customer`, { customer_id: a.decoy });
      expect(wrong.status).not.toBe(200);
    });

    /** A message from the shared address, and the people who may and may not pick. */
    async function pickingWorld() {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: w.sharedEmail });
      const [email] = await stored(providerId);
      const outsider = await person(w.org, 'outsider');
      return { ...w, email: email!, outsider };
    }
    type Picking = Awaited<ReturnType<typeof pickingWorld>>;
    const candidates = async (w: Picking, as: Person, query = '') => (await asPerson(as)).get(`/api/communication/emails/${w.email.id}/customer-candidates${query}`);
    const pick = async (w: Picking, as: Person, customerId: string) => (await asPerson(as)).patch(`/api/communication/emails/${w.email.id}/customer`, { customer_id: customerId });

    it('offers exactly the customers that have the address, to a person with the attach switch', async () => {
      const w = await pickingWorld();
      const res = await candidates(w, w.holder);
      expect(res.status).toBe(200);
      expect((res.body.customers as { id: string }[]).map((c) => c.id).sort()).toEqual([w.sharedA, w.sharedB].sort());
      expect(res.body.total).toBe(2);
      expect(res.body.customers[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.stringContaining(w.tag), number: expect.any(String) }));
    });

    it('searches within the matches', async () => {
      const w = await pickingWorld();
      const res = await candidates(w, w.holder, '?search=SharedB');
      expect((res.body.customers as { id: string }[]).map((c) => c.id)).toEqual([w.sharedB]);
      expect(res.body.total).toBe(1);
    });

    it('scales: a hundred and twenty customers share an address, a page comes back with the total, and search narrows it', async () => {
      const w = await pickingWorld();
      await db.customer.createMany({
        data: Array.from({ length: 120 }, (_, i) => ({
          id: randomUUID(), organization_id: w.org, customer_number: `BULK-${w.tag}-${i}`, kind: 'PERSON' as const, segment: 'RESIDENTIAL' as const,
          first_name: `Bulk${i}`, last_name: w.tag, email: w.sharedEmail,
        })),
      });
      const page = await candidates(w, w.holder);
      expect(page.status).toBe(200);
      expect(page.body.total).toBe(122);
      expect((page.body.customers as unknown[]).length).toBe(50);
      const small = await candidates(w, w.holder, '?limit=10');
      expect((small.body.customers as unknown[]).length).toBe(10);
      const narrowed = await candidates(w, w.holder, '?search=Bulk77');
      expect((narrowed.body.customers as { name: string }[]).map((c) => c.name)).toEqual([`Bulk77 ${w.tag}`]);
      expect(narrowed.body.total).toBe(1);
    });

    it('offers only the customers the person can open', async () => {
      const w = await pickingWorld();
      // The reader is attached to a job of one of the two customers only.
      const reader = await person(w.org, 'reader', { jobs_scope: 'attached', leads_scope: 'attached' });
      await fx.addJob(w.org, w.sharedB, { crew: [reader.id] });
      await db.mailbox.update({ where: { id: w.mailbox }, data: { holder_user_id: reader.id } });
      const res = await candidates(w, reader);
      expect(res.status).toBe(200);
      expect((res.body.customers as { id: string }[]).map((c) => c.id)).toEqual([w.sharedB]);
      // ...and cannot pick the one they cannot open.
      expect((await pick(w, reader, w.sharedA)).status).toBe(404);
      expect((await pick(w, reader, w.sharedB)).status).toBe(200);
    });

    it('is refused without the attach switch, even with Edit communication records and mailbox access', async () => {
      const w = await pickingWorld();
      const editor = await person(w.org, 'editor', { attach_conversations: false, edit_communication_records: true });
      await db.mailbox.update({ where: { id: w.mailbox }, data: { holder_user_id: editor.id } });
      expect((await candidates(w, editor)).status).toBe(403);
      expect((await pick(w, editor, w.sharedA)).status).toBe(403);
      expect(await db.email.findUniqueOrThrow({ where: { id: w.email.id } })).toMatchObject({ customer_id: null });
    });

    it('is refused without Access Communication', async () => {
      const w = await pickingWorld();
      const noSection = await person(w.org, 'nosection', withDependantsOff(['access_communication']));
      expect((await candidates(w, noSection)).status).toBe(403);
      expect((await pick(w, noSection, w.sharedA)).status).toBe(403);
    });

    it('answers 404 to a person who cannot read the message', async () => {
      const w = await pickingWorld();
      expect((await candidates(w, w.outsider)).status).toBe(404);
      expect((await pick(w, w.outsider, w.sharedA)).status).toBe(404);
      expect(await db.email.findUniqueOrThrow({ where: { id: w.email.id } })).toMatchObject({ customer_id: null });
    });

    it('links the message and the conversation\'s own replies to the picked customer, and the customer\'s tab lists them', async () => {
      const w = await pickingWorld();
      // The holder replied in the conversation before picking.
      const reply = await (await asPerson(w.holder)).post('/api/communication/emails', {
        to: w.sharedEmail, subject: 'Re: Quick question', body: ['Yes, we are open.'], thread_id: w.email.thread_id,
      });
      expect(reply.status).toBe(201);
      expect(await db.email.findUniqueOrThrow({ where: { id: reply.body.email.id } })).toMatchObject({ customer_id: null });

      const picked = await pick(w, w.holder, w.sharedA);
      expect(picked.status).toBe(200);
      expect(picked.body.email).toMatchObject({ id: w.email.id, customerId: w.sharedA });
      expect(picked.body.email).not.toHaveProperty('matchesSeveralCustomers');
      const rows = await db.email.findMany({ where: { thread_id: w.email.thread_id! } });
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row).toMatchObject({ customer_id: w.sharedA, job_id: null, lead_id: null });

      const tab = await (await asPerson(w.admin)).get(`/api/customers/${w.sharedA}/communications`);
      expect(tab.status).toBe(200);
      expect((tab.body.items as { id: string }[]).map((i) => i.id).sort()).toEqual(rows.map((r) => r.id).sort());
      const other = await (await asPerson(w.admin)).get(`/api/customers/${w.sharedB}/communications`);
      expect(other.body.items).toEqual([]);
    });

    /** The customer answers a reply the holder sent, through the reply address it carried: the real webhook route. */
    async function customerAnswers(w: Picking) {
      const token = await db.replyToken.findFirstOrThrow({ where: { thread_id: w.email.thread_id!, revoked_at: null } });
      const { providerId } = await receive({ to: [replyAddressFor(token.token)], from: w.sharedEmail });
      return (await stored(providerId))[0]!;
    }

    it('keeps the conversation on the picked customer\'s tab as it goes on: a reply sent after the pick, and the customer\'s answer to it', async () => {
      const w = await pickingWorld();
      expect((await pick(w, w.holder, w.sharedA)).status).toBe(200);

      const reply = await (await asPerson(w.holder)).post('/api/communication/emails', {
        to: w.sharedEmail, subject: 'Re: Quick question', body: ['Yes, we are open.'], thread_id: w.email.thread_id,
      });
      expect(reply.status).toBe(201);
      expect(await db.email.findUniqueOrThrow({ where: { id: reply.body.email.id } })).toMatchObject({ customer_id: w.sharedA, job_id: null, lead_id: null });
      expect(await db.replyToken.findFirstOrThrow({ where: { thread_id: w.email.thread_id! } })).toMatchObject({ customer_id: w.sharedA });

      const answer = await customerAnswers(w);
      expect(answer).toMatchObject({ customer_id: w.sharedA, thread_id: w.email.thread_id, direction: 'in' });

      const tab = await (await asPerson(w.admin)).get(`/api/customers/${w.sharedA}/communications`);
      const rows = await db.email.findMany({ where: { thread_id: w.email.thread_id! } });
      expect(rows).toHaveLength(3);
      expect((tab.body.items as { id: string }[]).map((i) => i.id).sort()).toEqual(rows.map((r) => r.id).sort());
    });

    it('keeps the customer\'s answer on the tab when the holder replied before the pick and the reply address was made then', async () => {
      const w = await pickingWorld();
      const reply = await (await asPerson(w.holder)).post('/api/communication/emails', {
        to: w.sharedEmail, subject: 'Re: Quick question', body: ['Yes, we are open.'], thread_id: w.email.thread_id,
      });
      expect(reply.status).toBe(201);
      expect((await pick(w, w.holder, w.sharedA)).status).toBe(200);

      const answer = await customerAnswers(w);
      expect(answer).toMatchObject({ customer_id: w.sharedA, thread_id: w.email.thread_id });
      const tab = await (await asPerson(w.admin)).get(`/api/customers/${w.sharedA}/communications`);
      expect((tab.body.items as { id: string }[]).map((i) => i.id)).toContain(answer.id);
    });

    it('lets the recipient decide over the conversation\'s customer when the reply goes to a different customer\'s address', async () => {
      const w = await pickingWorld();
      expect((await pick(w, w.holder, w.sharedA)).status).toBe(200);
      const reply = await (await asPerson(w.holder)).post('/api/communication/emails', {
        to: w.loneAddress, subject: 'Re: Quick question', body: ['Copying you in.'], thread_id: w.email.thread_id,
      });
      expect(await db.email.findUniqueOrThrow({ where: { id: reply.body.email.id } })).toMatchObject({ customer_id: w.lone });
    });

    it('refuses a customer that does not have the address, and a message that already has a customer', async () => {
      const w = await pickingWorld();
      expect((await pick(w, w.holder, w.lone)).status).toBe(404);
      expect((await pick(w, w.holder, randomUUID())).status).toBe(404);
      expect((await pick(w, w.holder, w.sharedA)).status).toBe(200);
      const again = await pick(w, w.holder, w.sharedB);
      expect(again.status).toBe(409);
      expect(await db.email.findUniqueOrThrow({ where: { id: w.email.id } })).toMatchObject({ customer_id: w.sharedA });
      const candidatesAfter = await candidates(w, w.holder);
      expect(candidatesAfter.status).toBe(409);
    });
  });

  describe('mail a person sends from their own mailbox: the recipient\'s address', () => {
    const send = async (w: World, as: Person, body: Record<string, unknown>) => (await asPerson(as)).post('/api/communication/emails', { subject: 'Hello', body: ['Hi there'], ...body });
    const rowOf = (res: { body: { email: { id: string } } }) => db.email.findUniqueOrThrow({ where: { id: res.body.email.id } });

    it('links to the one customer that has the recipient\'s address, with no linking by hand', async () => {
      const w = await world();
      const res = await send(w, w.holder, { to: w.loneAddress });
      expect(res.status).toBe(201);
      expect(await rowOf(res)).toMatchObject({ customer_id: w.lone, job_id: null, lead_id: null, direction: 'out', sent_by_user_id: w.holder.id });
    });

    it('links mail to an apostrophe address to the customer that owns it, not to the one that owns the part after it', async () => {
      const w = await world();
      const a = await apostropheWorld(w);
      const res = await send(w, w.holder, { to: `Pat O'Brien <${a.address}>` });
      expect(res.status).toBe(201);
      expect(await rowOf(res)).toMatchObject({ customer_id: a.owner });
    });

    it('reads the address out of a name and brackets, and finds an extra address', async () => {
      const w = await world();
      const res = await send(w, w.holder, { to: `"Extra, Person" <${w.extraAddress.toUpperCase()}>` });
      expect(await rowOf(res)).toMatchObject({ customer_id: w.extra });
    });

    it('links a reply in a received conversation, so the conversation is on the tab from both sides', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: w.loneAddress });
      const [received] = await stored(providerId);
      const res = await send(w, w.holder, { to: w.loneAddress, thread_id: received!.thread_id });
      expect(await rowOf(res)).toMatchObject({ customer_id: w.lone, thread_id: received!.thread_id });
    });

    it('links to none when several customers have the address, when the recipients are different customers, or when nobody has it', async () => {
      const w = await world();
      for (const to of [w.sharedEmail, `${w.loneAddress}, ${w.extraAddress}`, `${w.loneAddress}, ${w.sharedEmail}`, `stranger.${w.tag}@example.org`]) {
        const res = await send(w, w.holder, { to });
        expect(res.status, to).toBe(201);
        expect(await rowOf(res), to).toMatchObject({ customer_id: null });
      }
    });

    it('links one customer named twice by two of their addresses', async () => {
      const w = await world();
      await db.customerEmail.create({ data: { customer_id: w.lone, email: `Lone.Second.${w.tag}@example.com` } });
      const res = await send(w, w.holder, { to: `${w.loneAddress}; lone.second.${w.tag}@example.com` });
      expect(await rowOf(res)).toMatchObject({ customer_id: w.lone });
    });

    it('lets the customer the person writes from win over the address', async () => {
      const w = await world();
      const res = await send(w, w.holder, { to: w.loneAddress, customer_id: w.extra });
      expect(await rowOf(res)).toMatchObject({ customer_id: w.extra });
    });

    it('lets the record the person writes on decide the customer, as before', async () => {
      const w = await world();
      const res = await send(w, w.holder, { to: w.extraAddress, job_id: w.job.id });
      expect(await rowOf(res)).toMatchObject({ customer_id: w.lone, job_id: w.job.id });
    });
  });

  describe('the customer\'s Communication tab', () => {
    const tabOf = async (as: Person, customer: string) => {
      const res = await (await asPerson(as)).get(`/api/customers/${customer}/communications`);
      return res;
    };
    const idsOf = (res: { body: { items: { id: string }[] } }) => res.body.items.map((i) => i.id).sort();

    it('lists every email between any of the company\'s mailboxes and the customer, received and sent, with no linking by hand', async () => {
      const w = await world();
      // A second person with a mailbox of their own, and the main mailbox, each hear from the customer; the first writes to them.
      const colleague = await person(w.org, 'colleague');
      await fx.addUserMailbox(w.org, colleague);
      const colleagueAddress = `${colleague.email.split('@')[0]!.toLowerCase()}@${MAILBOX_DOMAIN}`;
      const toHolder = await receive({ to: [w.address], from: w.loneAddress });
      const toColleague = await receive({ to: [colleagueAddress], from: w.loneAddress });
      const toMain = await receive({ to: [w.mainAddress], from: w.loneAddress });
      const sent = await (await asPerson(w.holder)).post('/api/communication/emails', { to: w.loneAddress, subject: 'Hello', body: ['Hi'] });
      const someoneElse = await receive({ to: [w.address], from: `stranger.${w.tag}@example.org` });

      const ids = [toHolder, toColleague, toMain].map(async (r) => (await stored(r.providerId))[0]!.id);
      const expected = [...(await Promise.all(ids)), sent.body.email.id].sort();
      const viewer = await person(w.org, 'viewer');
      const tab = await tabOf(viewer, w.lone);
      expect(tab.status).toBe(200);
      expect(idsOf(tab)).toEqual(expected);
      expect(idsOf(tab)).not.toContain((await stored(someoneElse.providerId))[0]!.id);
      const directions = (tab.body.items as { direction: string }[]).map((i) => i.direction);
      expect(directions.filter((d) => d === 'in')).toHaveLength(3);
      expect(directions.filter((d) => d === 'out')).toHaveLength(1);
    });

    it('lists one message once when it reached two of the company\'s addresses, as the copy the person can open', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address, w.mainAddress], from: w.loneAddress });
      const copies = await stored(providerId);
      expect(copies).toHaveLength(2);
      const mailboxOf = async (emailId: string) => {
        const row = await db.email.findUniqueOrThrow({ where: { id: emailId }, select: { thread: { select: { mailbox_id: true } } } });
        return row.thread!.mailbox_id;
      };
      const mailboxes = await Promise.all(copies.map((c) => mailboxOf(c.id)));
      const inMain = copies[mailboxes.indexOf(w.main)]!.id;
      const inHolders = copies[mailboxes.indexOf(w.mailbox)]!.id;

      // Someone who holds neither mailbox still sees the message once.
      const viewer = await person(w.org, 'viewer');
      expect((await tabOf(viewer, w.lone)).body.items).toHaveLength(1);
      // The holder is shown the copy in their own mailbox; a person linked to the main mailbox, the one in that.
      expect(idsOf(await tabOf(w.holder, w.lone))).toEqual([inHolders]);
      const reader = await person(w.org, 'mainreader');
      await db.mailboxReader.create({ data: { organization_id: w.org, mailbox_id: w.main, user_id: reader.id } });
      expect(idsOf(await tabOf(reader, w.lone))).toEqual([inMain]);
    });

    it('marks a received message from an unverified sender, and no other', async () => {
      const w = await world();
      const unverified = await receive({ to: [w.address], from: w.loneAddress, headers: NO_POLICY });
      const unavailable = await receive({ to: [w.address], from: w.loneAddress, headers: UNAVAILABLE });
      const verified = await receive({ to: [w.address], from: w.loneAddress, headers: PASS });
      const sent = await (await asPerson(w.holder)).post('/api/communication/emails', { to: w.loneAddress, subject: 'Hello', body: ['Hi'] });
      const tab = await tabOf(w.admin, w.lone);
      const items = tab.body.items as { id: string; unverifiedSender?: boolean }[];
      const itemOf = async (providerId: string) => {
        const [row] = await stored(providerId);
        return items.find((i) => i.id === row!.id);
      };
      expect(await itemOf(unverified.providerId)).toMatchObject({ unverifiedSender: true });
      expect(await itemOf(unavailable.providerId)).toMatchObject({ unverifiedSender: true });
      expect(await itemOf(verified.providerId)).not.toHaveProperty('unverifiedSender');
      expect(items.find((i) => i.id === sent.body.email.id)).not.toHaveProperty('unverifiedSender');
    });

    it('applies the per-row reach rule: a row also attached to a job the person cannot open is not theirs to see', async () => {
      const w = await world();
      const attached = await receive({ to: [w.address], from: w.loneAddress });
      const plain = await receive({ to: [w.address], from: w.loneAddress });
      const [attachedRow] = await stored(attached.providerId);
      const [plainRow] = await stored(plain.providerId);
      // The holder files one of the two on the customer's job, which the viewer is not on.
      const filed = await (await asPerson(w.holder)).patch(`/api/communication/emails/${attachedRow!.id}/job`, { job_id: w.job.id });
      expect(filed.status).toBe(200);
      // The viewer opens the customer through a job of their own, and not the first job.
      const viewer = await person(w.org, 'viewer', { jobs_scope: 'attached', leads_scope: 'attached' });
      await fx.addJob(w.org, w.lone, { crew: [viewer.id] });

      const theirs = await tabOf(viewer, w.lone);
      expect(theirs.status).toBe(200);
      expect(idsOf(theirs)).toEqual([plainRow!.id]);
      // Someone who can open every job sees both rows.
      const all = await tabOf(w.admin, w.lone);
      expect(idsOf(all)).toEqual([attachedRow!.id, plainRow!.id].sort());
    });

    it('is not opened by a person who cannot open the customer', async () => {
      const w = await world();
      await receive({ to: [w.address], from: w.loneAddress });
      const stranger = await person(w.org, 'strangerviewer', { jobs_scope: 'attached', leads_scope: 'attached' });
      expect((await tabOf(stranger, w.lone)).status).toBe(404);
    });
  });

  describe('attaching mailbox mail to a job or a lead by hand', () => {
    const attachJob = async (as: Person, emailId: string, jobId: string | null) => (await asPerson(as)).patch(`/api/communication/emails/${emailId}/job`, { job_id: jobId });
    const attachLead = async (as: Person, emailId: string, leadId: string | null) => (await asPerson(as)).patch(`/api/communication/emails/${emailId}/lead`, { lead_id: leadId });
    const tabIds = async (as: Person, path: string) => {
      const res = await (await asPerson(as)).get(path);
      expect(res.status, path).toBe(200);
      return (res.body.items as { id: string }[]).map((i) => i.id);
    };

    async function mailWorld(from = 'lone') {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: from === 'lone' ? w.loneAddress : `stranger.${w.tag}@example.org` });
      const [email] = await stored(providerId);
      return { ...w, email: email! };
    }

    it('files the mail on a job the person can open, with the attach switch alone, and the job\'s tab then lists it', async () => {
      const w = await mailWorld();
      const attacher = await person(w.org, 'attacher', { edit_communication_records: false });
      await db.mailbox.update({ where: { id: w.mailbox }, data: { holder_user_id: attacher.id } });
      expect(await tabIds(w.admin, `/api/jobs/${w.job.id}/communications`)).not.toContain(w.email.id);

      const res = await attachJob(attacher, w.email.id, w.job.id);
      expect(res.status).toBe(200);
      expect(await db.email.findUniqueOrThrow({ where: { id: w.email.id } })).toMatchObject({ job_id: w.job.id, customer_id: w.lone });
      expect(await tabIds(w.admin, `/api/jobs/${w.job.id}/communications`)).toContain(w.email.id);
      // It stays on the customer's tab too.
      expect(await tabIds(w.admin, `/api/customers/${w.lone}/communications`)).toContain(w.email.id);
    });

    it('files the mail on a lead the person can open, and the lead\'s tab then lists it', async () => {
      const w = await mailWorld();
      const res = await attachLead(w.holder, w.email.id, w.lead.id);
      expect(res.status).toBe(200);
      expect(await tabIds(w.admin, `/api/leads/${w.lead.id}/communications`)).toContain(w.email.id);
      expect(await db.email.findUniqueOrThrow({ where: { id: w.email.id } })).toMatchObject({ lead_id: w.lead.id, job_id: null });
    });

    it('files mail from an address no customer has on a job, which shows on the job\'s tab and on no customer\'s', async () => {
      const w = await mailWorld('stranger');
      expect((await attachJob(w.holder, w.email.id, w.job.id)).status).toBe(200);
      expect(await tabIds(w.admin, `/api/jobs/${w.job.id}/communications`)).toContain(w.email.id);
      expect(await tabIds(w.admin, `/api/customers/${w.lone}/communications`)).not.toContain(w.email.id);
    });

    it('no longer calls it a match of several customers once it is filed on a record', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.address], from: w.sharedEmail });
      const [email] = await stored(providerId);
      const sharedJob = await fx.addJob(w.org, w.sharedA, { crew: [w.holder.id] });
      expect((await attachJob(w.holder, email!.id, sharedJob.id)).status).toBe(200);
      const listed = (await listOf(w.holder, w.mailbox)).find((e) => e.id === email!.id);
      expect(listed).toMatchObject({ jobId: sharedJob.id });
      expect(listed).not.toHaveProperty('matchesSeveralCustomers');
      // ...and the picker no longer offers it.
      const offer = await (await asPerson(w.holder)).get(`/api/communication/emails/${email!.id}/customer-candidates`);
      expect(offer.status).toBe(409);
    });

    it('is refused with the attach switch off, even with Edit communication records on', async () => {
      const w = await mailWorld();
      const editor = await person(w.org, 'editor', { attach_conversations: false, edit_communication_records: true });
      await db.mailbox.update({ where: { id: w.mailbox }, data: { holder_user_id: editor.id } });
      expect((await attachJob(editor, w.email.id, w.job.id)).status).toBe(403);
      expect((await attachLead(editor, w.email.id, w.lead.id)).status).toBe(403);
      expect(await db.email.findUniqueOrThrow({ where: { id: w.email.id } })).toMatchObject({ job_id: null, lead_id: null });
    });

    it('is refused for a job or a lead the person cannot open', async () => {
      const w = await mailWorld();
      const narrow = await person(w.org, 'narrow', { jobs_scope: 'attached', leads_scope: 'attached' });
      await db.mailbox.update({ where: { id: w.mailbox }, data: { holder_user_id: narrow.id } });
      expect((await attachJob(narrow, w.email.id, w.job.id)).status).toBe(404);
      expect((await attachLead(narrow, w.email.id, w.lead.id)).status).toBe(404);
      expect(await db.email.findUniqueOrThrow({ where: { id: w.email.id } })).toMatchObject({ job_id: null, lead_id: null });
    });

    it('is refused for a conversation the person cannot read', async () => {
      const w = await mailWorld('stranger');
      const outsider = await person(w.org, 'outsider');
      expect((await attachJob(outsider, w.email.id, w.job.id)).status).toBe(404);
      expect((await attachLead(outsider, w.email.id, w.lead.id)).status).toBe(404);
      expect(await db.email.findUniqueOrThrow({ where: { id: w.email.id } })).toMatchObject({ job_id: null, lead_id: null });
    });

    it('is refused for a job of another customer than the one the mail is linked to', async () => {
      const w = await mailWorld();
      const otherJob = await fx.addJob(w.org, w.extra, { crew: [w.holder.id] });
      expect((await attachJob(w.holder, w.email.id, otherJob.id)).status).toBe(404);
    });

    it('detaches again, and the job\'s tab lets it go', async () => {
      const w = await mailWorld();
      await attachJob(w.holder, w.email.id, w.job.id);
      expect((await attachJob(w.holder, w.email.id, null)).status).toBe(200);
      expect(await tabIds(w.admin, `/api/jobs/${w.job.id}/communications`)).not.toContain(w.email.id);
    });
  });
});
