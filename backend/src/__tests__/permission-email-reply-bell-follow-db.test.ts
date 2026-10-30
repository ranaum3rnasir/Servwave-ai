/* =============================================================================
   Roles & Permissions security fixes, ticket 31 (finding M1): a reply's bell goes only to people who can follow it.

   One invariant, checked over a table of scenes: after a customer's reply arrives through the real delivery webhook handler,
   every person the bell rings
     - opens the reply itself by id (or, for a reply held for review, opens the held item the bell points at), AND
     - finds the reply in the list the bell's link opens (the Email list for the link's `mailbox`, which is what the page
       lists before it opens the link's `thread`),
   and the people expected to take it are the ones rung. Being assigned a conversation opens nothing (M1), so an assignee who
   does not reach the conversation itself is never the one told, even when the reply's own customer tie opens it for them: the
   holder of the mailbox, or the people linked to the main mailbox, are told instead. When nobody can follow it, nobody is rung
   and the empty chain is logged.

   People are on custom roles (never a built-in role name) holding exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient, fetchReceived } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, fetchReceived: vi.fn() };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The provider call that fetches a received message is the only thing replaced on the way in.
vi.mock('../lib/inbound-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inbound-email')>()),
  fetchReceivedEmail: fetchReceived,
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { sendComposedEmail } from '../lib/email';
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;

suite('M1: a reply\'s bell goes only to people who can follow it (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM notifications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM resend_events WHERE (payload->'data'->>'email_id') LIKE 'm1-follow-${org.slice(0, 8)}%'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_readers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  beforeEach(() => {
    fetchReceived.mockReset();
    vi.mocked(sendComposedEmail).mockImplementation(async () => ({
      status: 'sent', providerMessageId: `re_${randomUUID()}`, fromAddress: 'no-reply@mail.test.com', fromName: null,
    }) as never);
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;
  const ARRIVED = new Date('2026-07-01T15:00:00.000Z');

  /** Every switch that needs one of these goes off with it, so the set stays storable (read from the catalog, never copied). */
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

  /** A company with its main mailbox, which nobody is linked to. */
  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const main = await db.mailbox.create({ data: { organization_id: made.org, kind: 'main', status: 'active' }, select: { id: true } });
    return { ...made, main: main.id };
  }
  type World = Awaited<ReturnType<typeof newOrg>>;

  /** A person on a fresh custom role holding exactly these switch values, with the Email page open, under "Linked to me". */
  async function personWith(org: string, values: Record<string, boolean | string> = {}, base: Role = 'DISPATCHER'): Promise<Who> {
    const key = `m1f-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, view_invoices: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'attached',
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `m1f${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The user mailbox issued to and held by `person`, with an address (a person without one cannot send). */
  async function userMailbox(org: string, person: Person) {
    const id = randomUUID();
    await db.mailbox.create({ data: { id, organization_id: org, kind: 'user', status: 'active', user_id: person.id, holder_user_id: person.id } });
    await db.mailboxAddress.create({ data: { local_part: `m1f-${id}`, organization_id: org, mailbox_id: id, is_primary: true } });
    return id;
  }

  const linkToMain = (w: World, person: Person) =>
    db.mailboxReader.create({ data: { organization_id: w.org, mailbox_id: w.main, user_id: person.id } });

  async function otherCustomer(w: World) {
    const id = randomUUID();
    await db.customer.create({ data: { id, organization_id: w.org, customer_number: `C-m1f-${id.slice(0, 6)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Other', last_name: 'Customer' } });
    return id;
  }

  interface Convo { thread: string; token: string; sent: string; mailbox: string }

  /** An ordinary conversation: the mail that went out (tied to `job` when given) and the reply token the customer was given. */
  async function conversation(
    w: World,
    opts: { mailbox?: string; assignee?: string | null; job?: string; origin?: 'started' | 'migrated'; aboutJob?: string; sentBy?: string } = {},
  ): Promise<Convo> {
    const thread = randomUUID();
    const mailbox = opts.mailbox ?? w.main;
    await db.emailThread.create({
      data: {
        id: thread, organization_id: w.org, mailbox_id: mailbox, assigned_to_user_id: opts.assignee ?? null,
        origin: opts.aboutJob ? 'record' : opts.origin ?? 'started', record_type: opts.aboutJob ? 'job' : null, record_id: opts.aboutJob ?? null,
      },
    });
    const sent = randomUUID();
    await db.email.create({
      data: {
        id: sent, organization_id: w.org, thread_id: thread, customer_id: w.customer, job_id: opts.job ?? null,
        account: opts.sentBy ? 'user' : 'system', direction: 'out', folder: 'sent', sent_by_user_id: opts.sentBy ?? null,
        from: { name: null, email: 'office@example.com' }, to: 'angel@example.com',
        subject: 'Your visit', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now() - 86_400_000),
      },
      select: { id: true },
    });
    const token = randomBytes(16).toString('base64url');
    await db.replyToken.create({
      data: {
        token, organization_id: w.org, thread_id: thread, customer_id: w.customer, expected_from: 'angel@example.com',
        entity_type: opts.aboutJob ? 'job' : null, entity_id: opts.aboutJob ?? null,
      },
    });
    return { thread, token, sent, mailbox };
  }

  /** A customer's reply through the delivery webhook's handler. `from` someone the conversation was not sent to holds it for review. */
  async function receive(w: World, c: Convo, from = 'Angel <angel@example.com>') {
    const providerId = `m1-follow-${w.org.slice(0, 8)}-${++sequence}`;
    fetchReceived.mockResolvedValueOnce({
      providerId, from, receivedFor: [`${c.token}@reply.test.com`], to: [`${c.token}@reply.test.com`],
      subject: 'Re: Your visit', messageId: `<${providerId}@mail.example.com>`, receivedAt: ARRIVED,
      text: 'Sounds good, thank you.', html: '<div>Sounds good.</div>',
      headers: { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' },
    });
    const { processResendEvent } = await import('../controllers/resend-webhook.controller.js');
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await processResendEvent(
      `svix-${providerId}-${++sequence}`,
      { type: 'email.received', created_at: ARRIVED.toISOString(), data: { email_id: providerId } } as never,
      res as never,
    );
    expect(res.status).not.toHaveBeenCalled();
    return db.email.findUniqueOrThrow({ where: { provider_message_id: providerId } });
  }

  /**
   * Who the reply's bell rang (every recipient, the Admin box included), and the link THEIR bell carries: the stored notification
   * each one received, read back, never a link worked out here. Every alert of this reply has a dedup key that starts with it.
   */
  async function bellOf(providerId: string) {
    const rows = await db.notification.findMany({
      where: { dedup_key: { startsWith: `email_inbound:${providerId}` } },
      select: { data: true, recipients: { select: { recipient_id: true } } },
    });
    const linkOf = new Map<string, string[]>();
    for (const r of rows) {
      for (const x of r.recipients) linkOf.set(x.recipient_id, [...(linkOf.get(x.recipient_id) ?? []), (r.data as { link_path?: string }).link_path ?? '']);
    }
    return { rung: [...linkOf.keys()].sort(), linkOf };
  }

  /** Can this person follow the bell: open the reply (or the held item) and find it in the list the link opens? */
  async function follows(person: Who, reply: { id: string; review_reason: string | null }, link: string) {
    const api = async () => person.api();
    const params = new URLSearchParams(link.split('?')[1] ?? '');
    if (params.get('review')) {
      // A held reply: the bell opens it in the Needs review folder, by its id.
      const item = await (await api()).get(`/api/communication/emails/unmatched/${params.get('review')}`);
      return { opens: item.status === 200, listed: item.status === 200 };
    }
    const opened = await (await api()).get(`/api/communication/emails/${reply.id}`);
    // The Email page reads a link with no `mailbox` as "My mailbox" and asks the list for exactly that (InboxPage, `MINE`).
    const mailbox = params.get('mailbox') ?? 'mine';
    const list = await (await api()).get(`/api/communication/emails?mailbox=${mailbox}`);
    const ids = ((list.body.emails ?? []) as { id: string }[]).map((e) => e.id);
    return { opens: opened.status === 200, listed: ids.includes(reply.id) };
  }

  type Scene = {
    name: string;
    /** Builds the scene, lets the reply arrive, and says who must be rung (empty: nobody, and the empty chain is logged). */
    run: (w: World) => Promise<{
      reply: { id: string; review_reason: string | null; provider_message_id: string | null };
      /** Who among the scene's people is told. */
      expected: Who[];
      everyone: Who[];
      /** Whether the Admin box (on All, holding every switch) is told too; left out where the scene does not say. */
      adminTold?: boolean;
      /** The list a person's bell must open: the main mailbox, "My mailbox", or a mailbox by id (the `mailbox` the link carries). */
      linkTo?: Array<[Who, 'main' | 'mine' | string]>;
    }>;
  };

  const SCENES: Scene[] = [
    {
      name: '1. an assignee on a job of the SAME customer, the conversation in a colleague\'s mailbox: the holder is told',
      run: async (w) => {
        const holder = await personWith(w.org);
        const assignee = await personWith(w.org);
        const box = await userMailbox(w.org, holder);
        const job = await fx.addJob(w.org, w.customer, { crew: [assignee.id] });
        const reply = await receive(w, await conversation(w, { mailbox: box, assignee: assignee.id, job: job.id }));
        return { reply, expected: [holder], everyone: [holder, assignee] };
      },
    },
    {
      name: '2. the main mailbox, a technician who replied through the customer tie took it: the linked reader is told',
      run: async (w) => {
        const reader = await personWith(w.org);
        await linkToMain(w, reader);
        const tech = await personWith(w.org, { contact_customers: true });
        await userMailbox(w.org, tech);
        const job = await fx.addJob(w.org, w.customer, { crew: [tech.id] });
        const convo = await conversation(w, { job: job.id });
        const sent = await (await tech.api()).post('/api/communication/emails', { to: 'angel@example.com', subject: 'Re', body: ['On my way'], thread_id: convo.thread });
        expect(sent.status).toBe(201);
        // The first replier in a main mailbox conversation takes it (S10.11): the technician is now its assignee.
        expect((await db.emailThread.findUniqueOrThrow({ where: { id: convo.thread }, select: { assigned_to_user_id: true } })).assigned_to_user_id).toBe(tech.id);
        const reply = await receive(w, convo);
        return { reply, expected: [reader], everyone: [reader, tech] };
      },
    },
    {
      name: '3. an assignee on another customer\'s job: the holder is told',
      run: async (w) => {
        const holder = await personWith(w.org);
        const assignee = await personWith(w.org);
        const box = await userMailbox(w.org, holder);
        const job = await fx.addJob(w.org, await otherCustomer(w), { crew: [assignee.id] });
        const reply = await receive(w, await conversation(w, { mailbox: box, assignee: assignee.id, job: job.id }));
        return { reply, expected: [holder], everyone: [holder, assignee] };
      },
    },
    {
      name: '4. an assignee who reaches nothing of it: the holder is told',
      run: async (w) => {
        const holder = await personWith(w.org);
        const assignee = await personWith(w.org);
        const box = await userMailbox(w.org, holder);
        const reply = await receive(w, await conversation(w, { mailbox: box, assignee: assignee.id }));
        return { reply, expected: [holder], everyone: [holder, assignee] };
      },
    },
    {
      name: '5. the holder is the assignee: the holder is told',
      run: async (w) => {
        const holder = await personWith(w.org);
        const box = await userMailbox(w.org, holder);
        const reply = await receive(w, await conversation(w, { mailbox: box, assignee: holder.id }));
        return { reply, expected: [holder], everyone: [holder] };
      },
    },
    {
      name: '6. no assignee: the holder is told',
      run: async (w) => {
        const holder = await personWith(w.org);
        const bystander = await personWith(w.org);
        const box = await userMailbox(w.org, holder);
        const reply = await receive(w, await conversation(w, { mailbox: box }));
        return { reply, expected: [holder], everyone: [holder, bystander] };
      },
    },
    {
      name: '7. a reply held for review (from an address it was not sent to), an assignee on the same customer\'s job: the holder is told',
      run: async (w) => {
        const holder = await personWith(w.org);
        const assignee = await personWith(w.org);
        const box = await userMailbox(w.org, holder);
        const job = await fx.addJob(w.org, w.customer, { crew: [assignee.id] });
        const reply = await receive(w, await conversation(w, { mailbox: box, assignee: assignee.id, job: job.id }), 'Their Spouse <spouse@example.com>');
        expect(reply.review_reason).toBe('sender_mismatch');
        return { reply, expected: [holder], everyone: [holder, assignee] };
      },
    },
    {
      name: '8. the main mailbox with linked readers and no assignee: every linked reader is told',
      run: async (w) => {
        const a = await personWith(w.org);
        const b = await personWith(w.org);
        const bystander = await personWith(w.org);
        await linkToMain(w, a);
        await linkToMain(w, b);
        const reply = await receive(w, await conversation(w, {}));
        return { reply, expected: [a, b], everyone: [a, b, bystander] };
      },
    },
    {
      name: '9a. a conversation from before go-live in the main mailbox, its only linked reader on "Linked to me": nobody is told, and it is logged',
      run: async (w) => {
        const reader = await personWith(w.org);
        await linkToMain(w, reader);
        const reply = await receive(w, await conversation(w, { origin: 'migrated' }));
        return { reply, expected: [], everyone: [reader] };
      },
    },
    {
      name: '9b. a mailbox whose holder cannot use the Email page, and an assignee outside it: nobody is told, and it is logged',
      run: async (w) => {
        const holder = await personWith(w.org, withDependantsOff(['access_communication']));
        const assignee = await personWith(w.org);
        const box = await userMailbox(w.org, holder);
        const job = await fx.addJob(w.org, w.customer, { crew: [assignee.id] });
        const reply = await receive(w, await conversation(w, { mailbox: box, assignee: assignee.id, job: job.id }));
        return { reply, expected: [], everyone: [holder, assignee] };
      },
    },
    {
      name: '10. a notice about a job (a record conversation) in the main mailbox: its crew is told',
      run: async (w) => {
        const crew = await personWith(w.org);
        const bystander = await personWith(w.org);
        const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
        const reply = await receive(w, await conversation(w, { aboutJob: job.id, job: job.id }));
        return { reply, expected: [crew], everyone: [crew, bystander] };
      },
    },
    {
      name: '11. a notice about a job: a holder of "Alert me about every job" who opens every job but does not see the conversation in the Email list gets no copy; the crew is told',
      run: async (w) => {
        const crew = await personWith(w.org);
        const watcher = await personWith(w.org, { jobs_scope: 'all', alert_every_job: true });
        const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
        const reply = await receive(w, await conversation(w, { aboutJob: job.id, job: job.id }));
        // The Admin box holds the same switch and lists every conversation (All): its copy can be followed.
        return { reply, expected: [crew], everyone: [crew, watcher], adminTold: true };
      },
    },
    {
      name: '12. a notice about a job nobody is on: the linked reader who opens every job but does not see it in the Email list is not told; the Admin box covers it',
      run: async (w) => {
        const reader = await personWith(w.org, { jobs_scope: 'all' });
        await linkToMain(w, reader);
        const job = await fx.addJob(w.org, w.customer, {});
        const reply = await receive(w, await conversation(w, { aboutJob: job.id, job: job.id }));
        return { reply, expected: [], everyone: [reader], adminTold: true };
      },
    },
    {
      name: '13. a notice about a job in the main mailbox, its crew member linked to the main mailbox: told, and the bell opens "My mailbox", where the main mailbox leaves the record\'s people out',
      run: async (w) => {
        const crew = await personWith(w.org);
        await linkToMain(w, crew);
        const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
        const reply = await receive(w, await conversation(w, { aboutJob: job.id, job: job.id }));
        return { reply, expected: [crew], everyone: [crew], linkTo: [[crew, 'mine']] };
      },
    },
    {
      name: '14. a notice about a job in the main mailbox: the crew (not linked) and the Dispatcher (linked to the main mailbox) are both told, each opening "My mailbox"',
      run: async (w) => {
        const crew = await personWith(w.org);
        const dispatcher = await personWith(w.org);
        await linkToMain(w, dispatcher);
        const job = await fx.addJob(w.org, w.customer, { crew: [crew.id], dispatcher: dispatcher.id });
        const reply = await receive(w, await conversation(w, { aboutJob: job.id, job: job.id }));
        return { reply, expected: [crew, dispatcher], everyone: [crew, dispatcher], linkTo: [[crew, 'mine'], [dispatcher, 'mine']] };
      },
    },
    {
      name: '15. a notice about a job in the main mailbox, assigned to its crew member who is linked to the main mailbox: in both lists, so the bell keeps the main mailbox',
      run: async (w) => {
        const crew = await personWith(w.org);
        await linkToMain(w, crew);
        const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
        const reply = await receive(w, await conversation(w, { aboutJob: job.id, job: job.id, assignee: crew.id }));
        return { reply, expected: [crew], everyone: [crew], linkTo: [[crew, 'main']] };
      },
    },
    {
      name: '16. a notice about a job sent by hand by a person who opens every job, is not on it and is linked to the main mailbox: told, opening the main mailbox',
      run: async (w) => {
        const crew = await personWith(w.org);
        const sender = await personWith(w.org, { jobs_scope: 'all' });
        await linkToMain(w, sender);
        const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
        const reply = await receive(w, await conversation(w, { aboutJob: job.id, job: job.id, sentBy: sender.id }));
        return { reply, expected: [crew, sender], everyone: [crew, sender], linkTo: [[crew, 'mine'], [sender, 'main']] };
      },
    },
    {
      name: '17. the same hand sender, not linked to the main mailbox: told, opening "My mailbox"',
      run: async (w) => {
        const crew = await personWith(w.org);
        const sender = await personWith(w.org, { jobs_scope: 'all' });
        const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
        const reply = await receive(w, await conversation(w, { aboutJob: job.id, job: job.id, sentBy: sender.id }));
        return { reply, expected: [crew, sender], everyone: [crew, sender], linkTo: [[crew, 'mine'], [sender, 'mine']] };
      },
    },
    {
      name: '18. a notice about a job in its holder\'s own mailbox, the crew member linked to the main mailbox: the holder opens their mailbox, the crew "My mailbox"',
      run: async (w) => {
        const holder = await personWith(w.org, { jobs_scope: 'all' });
        const box = await userMailbox(w.org, holder);
        const crew = await personWith(w.org);
        await linkToMain(w, crew);
        const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
        const reply = await receive(w, await conversation(w, { mailbox: box, aboutJob: job.id, job: job.id }));
        return { reply, expected: [holder, crew], everyone: [holder, crew], linkTo: [[holder, box], [crew, 'mine']] };
      },
    },
    {
      name: '19. a notice about a job in the main mailbox: a holder of "Alert me about every job" linked to the main mailbox gets no copy; the crew is told',
      run: async (w) => {
        const crew = await personWith(w.org);
        const watcher = await personWith(w.org, { jobs_scope: 'all', alert_every_job: true });
        await linkToMain(w, watcher);
        const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
        const reply = await receive(w, await conversation(w, { aboutJob: job.id, job: job.id }));
        return { reply, expected: [crew], everyone: [crew, watcher], linkTo: [[crew, 'mine']] };
      },
    },
  ];

  for (const scene of SCENES) {
    it(scene.name, async () => {
      const w = await newOrg();
      const warn = vi.spyOn(logger, 'warn');
      try {
        const { reply, expected, everyone, adminTold, linkTo } = await scene.run(w);
        const { rung, linkOf } = await bellOf(reply.provider_message_id!);
        const people = new Map([...everyone, ...expected].map((p) => [p.id, p]));

        // The people expected to take it are told, and nobody else among those in the scene.
        const rungInScene = rung.filter((id) => people.has(id)).sort();
        expect(rungInScene).toEqual(expected.map((p) => p.id).sort());

        // Every person rung, whoever they are (the Admin box included), can follow the bell.
        const all = new Map<string, Who>(people);
        if (rung.includes(w.admin.id)) all.set(w.admin.id, { ...w.admin, api: () => fx.signedInAs(w.admin) });
        for (const id of rung) {
          const person = all.get(id);
          expect(person, `a person outside the scene was rung: ${id}`).toBeDefined();
          const links = linkOf.get(id)!;
          // Told once, by one alert, whose link is theirs.
          expect(links, `${id} is told once`).toHaveLength(1);
          expect(await follows(person!, reply, links[0]!), `${id} follows ${links[0]}`).toEqual({ opens: true, listed: true });
        }
        for (const [person, list] of linkTo ?? []) {
          const mailbox = new URLSearchParams((linkOf.get(person.id)?.[0] ?? '').split('?')[1] ?? '').get('mailbox');
          const want = list === 'mine' ? null : list === 'main' ? w.main : list;
          expect(mailbox, `${person.id}'s bell opens ${list}`).toBe(want);
        }

        if (adminTold !== undefined) expect(rung.includes(w.admin.id), 'the Admin box is told').toBe(adminTold);
        // Nobody at all is told only when nobody can follow it, and then the empty chain is logged.
        const loggedNobody = warn.mock.calls.some(([line]) => String(line).includes('nobody to tell'));
        expect(loggedNobody).toBe(rung.length === 0);
        if (expected.length === 0 && !adminTold) expect(rung).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  }
});
