/* =============================================================================
   Roles & Permissions security, M7 (ticket 36): a person whose Show Email is off gets no customer-reply bell.

   The bell opens the conversation on the Email page, which a person with Show Email off cannot use, so a lane that would ring
   them rings them no more (Ran, ticket 31: if no list shows them the conversation, they get no alert). One table over every
   lane of the reply chain: the record's people, the person who sent the mail by hand, the holder of the mailbox, the assignee,
   the copy holders, the people linked to the main mailbox (for a record conversation and for an ordinary one), a reply held for
   review, and the Admins. Each scene runs twice, in its own company: with the person's Show Email on they are told as before, with
   it off they are not and the colleague on the same lane (Show Email on) still is. An Admin is the one exception: the Admin flag
   opens every page whatever their switches, the Email page included, so they are told either way.

   Driven through the real inbound entry point (`processResendEvent`) with fixture payloads; only the call that fetches the
   received message from the provider is replaced. People are on custom roles (never a built-in role name). Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient, fetchReceived, emitSpy } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, fetchReceived: vi.fn(), emitSpy: vi.fn() };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The provider call that fetches a received message is the only thing replaced.
vi.mock('../lib/inbound-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inbound-email')>()),
  fetchReceivedEmail: fetchReceived,
}));

// The real bell, watched: every call is counted, none is stopped.
vi.mock('../services/notifications/notificationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/notifications/notificationService')>();
  emitSpy.mockImplementation(actual.emit);
  return { ...actual, emit: emitSpy };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;

suite('Show Email off rings no customer-reply bell (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM resend_events WHERE (payload->'data'->>'email_id') LIKE 'rp-s10-10-${org.slice(0, 8)}%'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_readers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  beforeEach(() => {
    emitSpy.mockClear();
    fetchReceived.mockReset();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;
  const token = () => randomBytes(16).toString('base64url');
  const ARRIVED = new Date('2026-07-01T15:00:00.000Z');

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

  /** A company with its main mailbox, which nobody is linked to. */
  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const main = await db.mailbox.create({ data: { organization_id: made.org, kind: 'main', status: 'active' }, select: { id: true } });
    return { ...made, main: main.id };
  }
  type World = Awaited<ReturnType<typeof newOrg>>;

  /** A person on a fresh custom role of this base holding exactly these switch values, with the Email page open. */
  async function personWith(org: string, values: Record<string, boolean | string> = {}, base: Role = 'DISPATCHER'): Promise<Who> {
    const key = `rpb-role-${++sequence}`;
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

  /** The user mailbox a person holds (what the user-mailbox migration gives every active user). */
  async function userMailbox(org: string, person: Person, holder: Person = person) {
    const id = randomUUID();
    await db.mailbox.create({ data: { id, organization_id: org, kind: 'user', status: 'active', user_id: person.id, holder_user_id: holder.id } });
    return id;
  }

  /** Link a person to the company's main mailbox, as a holder of Company settings does on the Sender Address page. */
  const linkToMain = (w: World, person: Person) =>
    db.mailboxReader.create({ data: { organization_id: w.org, mailbox_id: w.main, user_id: person.id } });

  interface Convo { thread: string; token: string; sent: string; org: string }

  /**
   * The conversation a send to a customer opened (or a started one): its thread, the mail that went out (`sentBy` is the person
   * who pressed Send by hand, empty for an automated send) and the reply token the customer was given.
   */
  async function conversation(
    w: World,
    opts: {
      record?: { type: string; id: string }; mailbox?: string; assignee?: string | null; sentBy?: string | null;
      origin?: 'record' | 'started' | 'migrated'; job?: string; lead?: string;
    } = {},
  ): Promise<Convo> {
    const thread = randomUUID();
    await db.emailThread.create({
      data: {
        id: thread, organization_id: w.org, mailbox_id: opts.mailbox ?? w.main, assigned_to_user_id: opts.assignee ?? null,
        origin: opts.origin ?? (opts.record ? 'record' : 'started'),
        record_type: opts.record?.type ?? null, record_id: opts.record?.id ?? null,
      },
    });
    const sent = randomUUID();
    await db.email.create({
      data: {
        id: sent, organization_id: w.org, thread_id: thread, customer_id: w.customer, job_id: opts.job ?? null, lead_id: opts.lead ?? null,
        account: opts.sentBy ? 'user' : 'system', direction: 'out', folder: 'sent', sent_by_user_id: opts.sentBy ?? null,
        from: { name: null, email: 'office@example.com' }, to: 'angel@example.com',
        subject: 'Your visit', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now() - 86_400_000),
      },
      select: { id: true },
    });
    const tok = token();
    await db.replyToken.create({
      data: {
        token: tok, organization_id: w.org, thread_id: thread, entity_type: opts.record?.type ?? null, entity_id: opts.record?.id ?? null,
        customer_id: w.customer, expected_from: 'angel@example.com', created_by_user_id: opts.sentBy ?? null,
      },
    });
    return { thread, token: tok, sent, org: w.org };
  }

  /** A customer's reply arriving through the delivery webhook's handler, once or again (`providerId` repeats a delivery). */
  async function receive(c: Convo, opts: { from?: string; providerId?: string } = {}) {
    const providerId = opts.providerId ?? `rp-s10-10-${c.org.slice(0, 8)}-${++sequence}`;
    fetchReceived.mockResolvedValueOnce({
      providerId,
      from: opts.from ?? 'Angel <angel@example.com>',
      receivedFor: [`${c.token}@reply.test.com`],
      to: [`${c.token}@reply.test.com`],
      subject: 'Re: Your visit',
      messageId: `<${providerId}@mail.example.com>`,
      receivedAt: ARRIVED,
      text: 'Sounds good, thank you.',
      html: '<div>Sounds good.</div>',
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
    const row = await db.email.findUniqueOrThrow({ where: { provider_message_id: providerId } });
    return { providerId, row };
  }

  /**
   * What the reply rang: who got the plain alert, who got the one with the reason line, and the line. The Admin box holds every
   * switch, so it is always a copy holder ("Alert me about every ...") and is told apart (`admin`) rather than mixed into the lists.
   */
  async function bells(providerId: string, w: World) {
    // One alert per list the bells open (M1): the conversation's own mailbox has the plain key, "My mailbox" adds `:mine`; the alert
    // with the reason line adds `:why` before it. Every one of them is this reply's.
    const key = `email_inbound:${providerId}`;
    const rows = await db.notification.findMany({
      where: { dedup_key: { startsWith: key } },
      select: { dedup_key: true, title: true, body: true, data: true, object_type: true, object_id: true, recipients: { select: { recipient_id: true, priority: true } } },
    });
    const isWhy = (r: (typeof rows)[number]) => r.dedup_key!.slice(key.length).startsWith(':why');
    const ids = (list: typeof rows) => list.flatMap((r) => r.recipients.map((x) => x.recipient_id)).filter((id) => id !== w.admin.id).sort();
    const plain = rows.filter((r) => !isWhy(r));
    const why = rows.filter(isWhy);
    const adminIn = rows.some((r) => r.recipients.some((x) => x.recipient_id === w.admin.id));
    return {
      plain: ids(plain), why: ids(why),
      reason: ((why[0]?.data ?? {}) as { fallback_reason?: string }).fallback_reason ?? null,
      all: [...ids(plain), ...ids(why)].sort(), admin: adminIn, rows,
    };
  }
  const sorted = (...people: Person[]) => people.map((p) => p.id).sort();


  const SPOUSE = 'Spouse <spouse@example.com>';
  const allJobs = { jobs_scope: 'all' };
  // On All the Email list shows every conversation, so a bell there can be followed (M1, ticket 31).
  const listsEveryConversation = { communication_scope: 'all' };

  /** One lane: builds the conversation, returns who is told as the person under test and as their colleague on the same lane. */
  interface Scene {
    name: string;
    run: (showEmail: boolean) => Promise<{ subject: Person; colleague: Person | null; rung: Awaited<ReturnType<typeof bells>> }>;
    /** An Admin is told whatever their Show Email says. */
    admin?: boolean;
  }

  const scenes: Scene[] = [
    {
      name: 'the record\'s people (crew on the job)',
      run: async (show) => {
        const w = await newOrg();
        const subject = await personWith(w.org, { show_email: show });
        const colleague = await personWith(w.org);
        const job = await fx.addJob(w.org, w.customer, { crew: [subject.id, colleague.id] });
        const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });
        return { subject, colleague, rung: await bells((await receive(convo)).providerId, w) };
      },
    },
    {
      name: 'the person who sent the mail by hand',
      run: async (show) => {
        const w = await newOrg();
        const subject = await personWith(w.org, { show_email: show, ...allJobs });
        const colleague = await personWith(w.org, allJobs);
        const job = await fx.addJob(w.org, w.customer, { crew: [colleague.id] });
        const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id, sentBy: subject.id });
        return { subject, colleague, rung: await bells((await receive(convo)).providerId, w) };
      },
    },
    {
      name: 'the holder of the mailbox the conversation sits in',
      run: async (show) => {
        const w = await newOrg();
        const subject = await personWith(w.org, { show_email: show, ...allJobs });
        const colleague = await personWith(w.org);
        const job = await fx.addJob(w.org, w.customer, { crew: [colleague.id] });
        const box = await userMailbox(w.org, subject);
        const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id, mailbox: box });
        return { subject, colleague, rung: await bells((await receive(convo)).providerId, w) };
      },
    },
    {
      name: 'the assignee of an ordinary conversation',
      run: async (show) => {
        const w = await newOrg();
        // Assignment opens nothing (ticket 31): the assignee reads the conversation because their scope reaches the mailbox.
        const subject = await personWith(w.org, { show_email: show, communication_scope: 'all' });
        const holder = await personWith(w.org);
        const box = await userMailbox(w.org, holder);
        const convo = await conversation(w, { mailbox: box, assignee: subject.id });
        return { subject, colleague: null, rung: await bells((await receive(convo)).providerId, w) };
      },
    },
    {
      name: 'the holder of an ordinary conversation\'s mailbox',
      run: async (show) => {
        const w = await newOrg();
        const subject = await personWith(w.org, { show_email: show });
        const box = await userMailbox(w.org, subject);
        const convo = await conversation(w, { mailbox: box });
        return { subject, colleague: null, rung: await bells((await receive(convo)).providerId, w) };
      },
    },
    {
      name: 'a copy holder ("Alert me about every job")',
      run: async (show) => {
        const w = await newOrg();
        const subject = await personWith(w.org, { show_email: show, alert_every_job: true, ...allJobs, ...listsEveryConversation });
        const colleague = await personWith(w.org);
        const job = await fx.addJob(w.org, w.customer, { crew: [colleague.id] });
        const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });
        return { subject, colleague, rung: await bells((await receive(convo)).providerId, w) };
      },
    },
    {
      name: 'a person linked to the main mailbox, for a record conversation nobody on the record can take (the fallback)',
      run: async (show) => {
        const w = await newOrg();
        const subject = await personWith(w.org, { show_email: show, ...allJobs, ...listsEveryConversation });
        const colleague = await personWith(w.org, { ...allJobs, ...listsEveryConversation });
        await linkToMain(w, subject);
        await linkToMain(w, colleague);
        const job = await fx.addJob(w.org, w.customer, {});
        const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });
        return { subject, colleague, rung: await bells((await receive(convo)).providerId, w) };
      },
    },
    {
      name: 'a person linked to the main mailbox, for an ordinary conversation in it',
      run: async (show) => {
        const w = await newOrg();
        const subject = await personWith(w.org, { show_email: show });
        const colleague = await personWith(w.org);
        await linkToMain(w, subject);
        await linkToMain(w, colleague);
        const convo = await conversation(w, {});
        return { subject, colleague, rung: await bells((await receive(convo)).providerId, w) };
      },
    },
    {
      name: 'a reply held for review (from an address we did not send to), to the record\'s people',
      run: async (show) => {
        const w = await newOrg();
        const subject = await personWith(w.org, { show_email: show });
        const colleague = await personWith(w.org);
        const job = await fx.addJob(w.org, w.customer, { crew: [subject.id, colleague.id] });
        const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });
        const reply = await receive(convo, { from: SPOUSE });
        const rung = await bells(reply.providerId, w);
        // It really is the held lane: the bell opens the held message, not the conversation.
        expect(rung.rows.some((r) => (r.data as { unmatched_reply?: boolean } | null)?.unmatched_reply === true)).toBe(true);
        return { subject, colleague, rung };
      },
    },
    {
      name: 'the Admins, when nobody else is linked (the Admin fallback)',
      admin: true,
      run: async (show) => {
        const w = await newOrg();
        const subject = await personWith(w.org, { show_email: show, is_admin: true });
        const convo = await conversation(w, {});
        return { subject, colleague: null, rung: await bells((await receive(convo)).providerId, w) };
      },
    },
  ];

  describe.each(scenes)('$name', (scene) => {
    it('tells the person, and their colleague on the same lane, with Show Email on', async () => {
      const { subject, colleague, rung } = await scene.run(true);
      expect(rung.all).toContain(subject.id);
      if (colleague) expect(rung.all).toContain(colleague.id);
    });

    it(scene.admin ? 'still tells an Admin with Show Email off (the Admin flag opens the Email page)' : 'does not tell the person with Show Email off, and still tells their colleague', async () => {
      const { subject, colleague, rung } = await scene.run(false);
      if (scene.admin) {
        expect(rung.all).toContain(subject.id);
      } else {
        expect(rung.all).not.toContain(subject.id);
        if (colleague) expect(rung.all).toContain(colleague.id);
      }
    });
  });

  /** The `nobody to tell` lines written for this company (an earlier case's late alert may log into the same spy). */
  const ownLines = (calls: unknown[][], org: string) =>
    calls.filter(([line, meta]) => String(line).includes('nobody to tell') && (meta as { organizationId?: string } | undefined)?.organizationId === org);

  // Filtering a person out must never stop the chain: when the people a lane would tell have Show Email off, the next lane is told.
  describe('the chain goes on when the first lane\'s people have Show Email off', () => {
    const JOB_REASON = 'This job has no Dispatcher or Sold By who can take this reply';

    it('tells the linked readers, with the reason line, when a record conversation\'s only people have Show Email off', async () => {
      const w = await newOrg();
      const crew = await personWith(w.org, { show_email: false });
      const linked = await personWith(w.org, { ...allJobs, ...listsEveryConversation });
      await linkToMain(w, linked);
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.all).not.toContain(crew.id);
      expect(rung.why).toEqual(sorted(linked));
      expect(rung.reason).toBe(JOB_REASON);
    });

    it('tells the Admins, with the reason line, when nobody is linked and a record conversation\'s only people have Show Email off', async () => {
      const w = await newOrg();
      const crew = await personWith(w.org, { show_email: false });
      const admin = await personWith(w.org, { is_admin: true });
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.all).not.toContain(crew.id);
      expect(rung.all).toContain(admin.id);
      expect(rung.admin).toBe(true);
    });

    it('tells the rest of the record\'s people when the first-lane holder of the mailbox has Show Email off', async () => {
      const w = await newOrg();
      const holder = await personWith(w.org, { show_email: false, ...allJobs, ...listsEveryConversation });
      const crew = await personWith(w.org, { ...listsEveryConversation });
      const job = await fx.addJob(w.org, w.customer, { crew: [crew.id] });
      const box = await userMailbox(w.org, holder);
      const convo = await conversation(w, { record: { type: 'job', id: job.id }, job: job.id, mailbox: box });

      const rung = await bells((await receive(convo)).providerId, w);

      expect(rung.all).not.toContain(holder.id);
      expect(rung.all).toContain(crew.id);
    });

    it('tells the other linked readers when a main-mailbox conversation\'s assignee has Show Email off', async () => {
      const w = await newOrg();
      const assignee = await personWith(w.org, { show_email: false });
      const linked = await personWith(w.org);
      await linkToMain(w, assignee);
      await linkToMain(w, linked);

      const rung = await bells((await receive(await conversation(w, { assignee: assignee.id }))).providerId, w);

      expect(rung.all).not.toContain(assignee.id);
      expect(rung.all).toContain(linked.id);
    });

    it('tells nobody, and logs it, when every person linked to the main mailbox has Show Email off (ticket 31: the Admins cover only while nobody is linked at all)', async () => {
      const w = await newOrg();
      const linked = await personWith(w.org, { show_email: false });
      const admin = await personWith(w.org, { is_admin: true });
      await linkToMain(w, linked);
      const warn = vi.spyOn(logger, 'warn');
      try {
        const reply = await receive(await conversation(w, {}));
        const rung = await bells(reply.providerId, w);
        expect(rung.all).not.toContain(linked.id);
        expect(rung.all).not.toContain(admin.id);
        expect(ownLines(warn.mock.calls as unknown[][], w.org)).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('is logged, like a chain that ends with nobody, when an ordinary conversation\'s only holder has Show Email off', async () => {
      const w = await newOrg();
      const holder = await personWith(w.org, { show_email: false });
      const box = await userMailbox(w.org, holder);
      const warn = vi.spyOn(logger, 'warn');
      try {
        const reply = await receive(await conversation(w, { mailbox: box }));
        // Only this company's line: an earlier case's late alert may log into the same spy.
        expect(ownLines(warn.mock.calls as unknown[][], w.org)).toHaveLength(1);
        const rung = await bells(reply.providerId, w);
        expect(rung.rows).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  });
});
