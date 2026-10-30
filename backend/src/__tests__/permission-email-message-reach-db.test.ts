/* =============================================================================
   Roles & Permissions security fixes, ticket 31 (finding M1): mail reach is per message, not per conversation.

   A person who can read one message of an ordinary conversation (because it hangs off a job they are on) must not get
   the rest of that conversation by replying to the message, or by having the conversation assigned to them. And a
   conversation is only assigned to someone who can reach it. Every message they cannot reach answers "not found",
   exactly as a message that does not exist.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding exactly the
   switch values under test, against a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } }, log: [{ emit: 'event', level: 'query' }] });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { sendComposedEmail } from '../lib/email';

const suite = realClient ? describe : describe.skip;

suite('M1: mail reach is per message, not per conversation (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  beforeEach(() => {
    vi.mocked(sendComposedEmail).mockImplementation(async () => ({
      status: 'sent', providerMessageId: `re_${randomUUID()}`, fromAddress: 'no-reply@mail.test.com', fromName: null,
    }) as never);
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Someone = Person & { api: () => Promise<Api> };
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** A person on a fresh custom role holding exactly these switch values, with the Email page open, under Attached. */
  async function personWith(org: string, values: Record<string, boolean | string> = {}, base: Role = 'DISPATCHER'): Promise<Someone> {
    const key = `m1-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: 'attached',
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `m1p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** The user mailbox issued to and held by `owner`, with an address (a person without one cannot send). */
  async function userMailbox(org: string, owner: Person): Promise<string> {
    const id = randomUUID();
    await db.mailbox.create({ data: { id, organization_id: org, kind: 'user', user_id: owner.id, holder_user_id: owner.id, status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `m1-${id}`, organization_id: org, mailbox_id: id, is_primary: true } });
    return id;
  }

  /** An ordinary conversation in `mailboxId`: one inbound message per job given, each tied to that job. */
  async function conversation(org: string, mailboxId: string, customer: string, jobIds: string[], assignedTo: string | null = null) {
    const thread = randomUUID();
    await db.emailThread.create({ data: { id: thread, organization_id: org, mailbox_id: mailboxId, origin: 'started', assigned_to_user_id: assignedTo } });
    const ids: string[] = [];
    for (const jobId of jobIds) {
      const id = randomUUID();
      await db.email.create({
        data: {
          id, organization_id: org, thread_id: thread, customer_id: customer, job_id: jobId, account: 'user', direction: 'in', folder: 'inbox',
          from: { name: null, email: 'customer@example.com' }, to: 'office@example.com',
          subject: 'm1-conversation', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
        select: { id: true },
      });
      ids.push(id);
    }
    return { thread, ids };
  }

  /**
   * The scene of the finding: a colleague's mailbox holds a conversation of two messages. The first hangs off a job the
   * person is crewed on, so they can read it; the second hangs off a job they are not on, so they cannot.
   */
  async function scene(personValues: Record<string, boolean | string> = {}) {
    const { org, admin, customer } = await newOrg();
    const person = await personWith(org, { contact_customers: true, ...personValues });
    await userMailbox(org, person);
    const colleague = await personWith(org);
    const theirs = await userMailbox(org, colleague);
    const myJob = await fx.addJob(org, customer, { crew: [person.id] });
    const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
    const conv = await conversation(org, theirs, customer, [myJob.id, otherJob.id]);
    return { org, admin, customer, person, colleague, theirs, myJob, otherJob, conv, reachable: conv.ids[0]!, closed: conv.ids[1]! };
  }

  const read = async (person: Someone, id: string) => (await person.api()).get(`/api/communication/emails/${id}`);
  const listed = async (person: Someone, query = '') => {
    const res = await (await person.api()).get(`/api/communication/emails${query}`);
    expect(res.status).toBe(200);
    return (res.body.emails as { id: string }[]).map((e) => e.id);
  };
  /** What a message that does not exist answers: the out-of-reach answer must be this, word for word. */
  const missing = async (person: Someone) => {
    const res = await read(person, randomUUID());
    return { status: res.status, body: res.body };
  };

  describe('replying to the one message the person can read', () => {
    it('keeps every other message of the conversation closed, answering exactly what a missing message answers', async () => {
      const s = await scene();
      expect((await read(s.person, s.reachable)).status).toBe(200);
      const notFound = await missing(s.person);
      expect(notFound.status).toBe(404);
      expect({ status: (await read(s.person, s.closed)).status, body: (await read(s.person, s.closed)).body }).toEqual(notFound);

      const reply = await (await s.person.api()).post('/api/communication/emails', {
        to: 'customer@example.com', subject: 'Re: m1', body: ['On my way'], thread_id: s.conv.thread,
      });
      expect(reply.status).toBe(201);

      const after = await read(s.person, s.closed);
      expect({ status: after.status, body: after.body }).toEqual(notFound);
      expect(await listed(s.person)).not.toContain(s.closed);
      expect(await listed(s.person, '?mailbox=mine')).not.toContain(s.closed);
    });
  });

  describe('being assigned the conversation', () => {
    const assign = async (by: Someone, thread: string, userId: string | null) =>
      (await by.api()).patch(`/api/communication/emails/threads/${thread}/assign`, { user_id: userId });

    it('opens nothing beyond the one message the person could already read, whether assigned through the inbox or found assigned', async () => {
      const s = await scene();
      const assigner = await personWith(s.org, { communication_scope: 'all', edit_communication_records: true });
      const notFound = await missing(s.person);

      const res = await assign(assigner, s.conv.thread, s.person.id);
      expect(res.status).toBe(200);
      expect(res.body.thread.assignedToUserId).toBe(s.person.id);

      expect((await read(s.person, s.reachable)).status).toBe(200);
      const closed = await read(s.person, s.closed);
      expect({ status: closed.status, body: closed.body }).toEqual(notFound);
      expect(await listed(s.person)).not.toContain(s.closed);
      expect(await listed(s.person, '?assignment=mine')).not.toContain(s.closed);
    });

    it('refuses to assign a conversation to someone who cannot open any of it, and still lets it go to someone who can, or to nobody', async () => {
      const s = await scene();
      const assigner = await personWith(s.org, { communication_scope: 'all', edit_communication_records: true });
      const stranger = await personWith(s.org);

      const refused = await assign(assigner, s.conv.thread, stranger.id);
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('ASSIGNEE_CANNOT_REACH');
      expect((await db.emailThread.findUnique({ where: { id: s.conv.thread }, select: { assigned_to_user_id: true } }))?.assigned_to_user_id).toBeNull();
      const strangerRead = await read(stranger, s.reachable);
      expect({ status: strangerRead.status, body: strangerRead.body }).toEqual(await missing(stranger));

      // The colleague whose mailbox it sits in, and the person on the job, can each take it; and it can be cleared.
      expect((await assign(assigner, s.conv.thread, s.colleague.id)).status).toBe(200);
      expect((await assign(assigner, s.conv.thread, s.person.id)).status).toBe(200);
      expect((await assign(assigner, s.conv.thread, null)).status).toBe(200);
    });

    it('answers "not found" to an assigner who cannot open the conversation, whoever they name, as for one that does not exist', async () => {
      const s = await scene();
      const outsider = await personWith(s.org, { edit_communication_records: true });
      const stranger = await personWith(s.org);
      const absent = await assign(outsider, randomUUID(), s.person.id);
      expect(absent.status).toBe(404);
      for (const named of [s.person.id, stranger.id]) {
        const res = await assign(outsider, s.conv.thread, named);
        expect({ status: res.status, body: res.body }).toEqual({ status: absent.status, body: absent.body });
      }
    });
  });
});
