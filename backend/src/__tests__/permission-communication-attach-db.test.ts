/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.19 - attaching, moving and detaching a call, a text or an email.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding exactly
   the switch values under test, against a real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('attaching, moving and detaching a conversation (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_thread_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM messages WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}' AND kind = 'user'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** A person on a fresh custom role of this base holding exactly these switch values, with the section open. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `attach-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, view_leads: true, jobs_scope: 'all', leads_scope: 'all', access_communication: true,
        view_communication: true, communication_scope: 'all', attach_conversations: true, edit_communication_records: false,
        ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  // The three kinds of conversation, each with the route that attaches it, the row it is stored in and a way to make
  // one. `tie` is where the new row is tied on creation; `agentId` / `sentBy` make it the person's own.
  type Ties = { jobId?: string; leadId?: string; customerId?: string };
  type Mine = { personId?: string };
  interface Kind {
    name: 'call' | 'text' | 'email';
    make: (org: string, ties: Ties, mine?: Mine) => Promise<string>;
    jobRoute: (id: string) => string;
    leadRoute: (id: string) => string;
    tiedTo: (id: string) => Promise<Ties>;
    /** The key the route answers the row under. */
    answerKey: string;
  }

  const KINDS: Kind[] = [
    {
      name: 'call',
      answerKey: 'call',
      jobRoute: (id) => `/api/communication/calls/${id}/job`,
      leadRoute: (id) => `/api/communication/calls/${id}/lead`,
      make: async (org, ties, mine) => {
        const id = randomUUID();
        await db.callSession.create({
          data: {
            id, organization_id: org, direction: 'inbound', from_number: '+15555550100', to_number: '+15555550199',
            status: 'completed', answered_by: {}, started_at: new Date(),
            job_id: ties.jobId ?? null, lead_id: ties.leadId ?? null, customer_id: ties.customerId ?? null,
            agent_id: mine?.personId ?? null,
          },
          select: { id: true },
        });
        return id;
      },
      tiedTo: async (id) => {
        const row = await db.callSession.findUniqueOrThrow({ where: { id }, select: { job_id: true, lead_id: true } });
        return { jobId: row.job_id ?? undefined, leadId: row.lead_id ?? undefined };
      },
    },
    {
      name: 'text',
      answerKey: 'message',
      jobRoute: (id) => `/api/communication/sms/${id}/job`,
      leadRoute: (id) => `/api/communication/sms/${id}/lead`,
      make: async (org, ties, mine) => {
        const thread = randomUUID();
        await db.messageThread.create({
          data: { id: thread, organization_id: org, channel: 'sms', campaign_type: 'customer_care', customer_id: ties.customerId ?? null },
          select: { id: true },
        });
        const id = randomUUID();
        await db.message.create({
          data: {
            id, organization_id: org, thread_id: thread, direction: mine?.personId ? 'out' : 'in', body: 'run-text', ts: new Date(),
            status: 'received', job_id: ties.jobId ?? null, lead_id: ties.leadId ?? null, sent_by_user_id: mine?.personId ?? null,
          },
          select: { id: true },
        });
        return id;
      },
      tiedTo: async (id) => {
        const row = await db.message.findUniqueOrThrow({ where: { id }, select: { job_id: true, lead_id: true } });
        return { jobId: row.job_id ?? undefined, leadId: row.lead_id ?? undefined };
      },
    },
    {
      name: 'email',
      answerKey: 'email',
      jobRoute: (id) => `/api/communication/emails/${id}/job`,
      leadRoute: (id) => `/api/communication/emails/${id}/lead`,
      make: async (org, ties, mine) => {
        let threadId: string | null = null;
        if (mine?.personId) {
          // A conversation in a mailbox the person holds is in their section scope.
          const mailbox = randomUUID();
          await db.mailbox.create({
            data: { id: mailbox, organization_id: org, kind: 'user', user_id: mine.personId, holder_user_id: mine.personId, status: 'active' },
          });
          threadId = randomUUID();
          await db.emailThread.create({ data: { id: threadId, organization_id: org, mailbox_id: mailbox, origin: 'started' } });
        }
        const id = randomUUID();
        await db.email.create({
          data: {
            id, organization_id: org, account: 'user', from: { name: null, email: 'someone@example.com' }, to: 'office@example.com',
            subject: 'run-email', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()), folder: 'inbox',
            thread_id: threadId, job_id: ties.jobId ?? null, lead_id: ties.leadId ?? null, customer_id: ties.customerId ?? null,
          },
          select: { id: true },
        });
        return id;
      },
      tiedTo: async (id) => {
        const row = await db.email.findUniqueOrThrow({ where: { id }, select: { job_id: true, lead_id: true } });
        return { jobId: row.job_id ?? undefined, leadId: row.lead_id ?? undefined };
      },
    },
  ];

  describe.each(KINDS)('a $name', (kind) => {
    it('is attached to a job and to a lead the person can open by a custom role with the attach switch and without Edit communication records', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);
      const person = await personWith(org, { attach_conversations: true, edit_communication_records: false }, 'TECHNICIAN');
      const api = await person.api();

      const toJob = await kind.make(org, { customerId: customer });
      const attachedJob = await api.patch(kind.jobRoute(toJob), { job_id: job.id });
      expect(attachedJob.status).toBe(200);
      expect(attachedJob.body[kind.answerKey]).toBeTruthy();
      expect((await kind.tiedTo(toJob)).jobId).toBe(job.id);

      const toLead = await kind.make(org, { customerId: customer });
      const attachedLead = await api.patch(kind.leadRoute(toLead), { lead_id: lead.id });
      expect(attachedLead.status).toBe(200);
      expect(attachedLead.body[kind.answerKey]).toBeTruthy();
      expect((await kind.tiedTo(toLead)).leadId).toBe(lead.id);
    });

    it('is refused for a job or a lead the person cannot open, and stays where it was', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);
      const person = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached' });
      const api = await person.api();

      const row = await kind.make(org, { customerId: customer });
      expect((await api.patch(kind.jobRoute(row), { job_id: job.id })).status).toBe(404);
      expect((await api.patch(kind.leadRoute(row), { lead_id: lead.id })).status).toBe(404);
      expect(await kind.tiedTo(row)).toEqual({});
    });

    it('is refused when the person cannot read it, for an attach and for a detach', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);
      // "Linked to me" with nothing linked: a conversation tied to nothing is not theirs to read.
      const person = await personWith(org, { communication_scope: 'linked_to_me', see_main_line_when_no_number: false });
      const api = await person.api();

      const unreadable = await kind.make(org, {});
      expect((await api.patch(kind.jobRoute(unreadable), { job_id: job.id })).status).toBe(404);
      expect((await api.patch(kind.leadRoute(unreadable), { lead_id: lead.id })).status).toBe(404);
      expect((await api.patch(kind.jobRoute(unreadable), { job_id: null })).status).toBe(404);
      expect((await api.patch(kind.leadRoute(unreadable), { lead_id: null })).status).toBe(404);
      expect(await kind.tiedTo(unreadable)).toEqual({});
    });

    it('is refused without the attach switch even with Edit communication records on, for a role of any base', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const person = await personWith(org, { attach_conversations: false, edit_communication_records: true }, base);
        const api = await person.api();
        const row = await kind.make(org, { customerId: customer });
        expect((await api.patch(kind.jobRoute(row), { job_id: job.id })).status, `${base} job`).toBe(403);
        expect((await api.patch(kind.leadRoute(row), { lead_id: lead.id })).status, `${base} lead`).toBe(403);
        expect(await kind.tiedTo(row), base).toEqual({});
      }
    });

    it('is moved to another job when it is readable only through the job it hangs off', async () => {
      const { org, customer } = await newOrg();
      const first = await fx.addJob(org, customer);
      const second = await fx.addJob(org, customer);
      const person = await personWith(org, { communication_scope: 'linked_to_me' });
      const row = await kind.make(org, { customerId: customer, jobId: first.id });

      const moved = await (await person.api()).patch(kind.jobRoute(row), { job_id: second.id });
      expect(moved.status).toBe(200);
      expect(moved.body[kind.answerKey]).toBeTruthy();
      expect((await kind.tiedTo(row)).jobId).toBe(second.id);
    });

    it('detaches and leaves the person\'s list cleanly when it was readable only through the record it is taken off', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const person = await personWith(org, { communication_scope: 'linked_to_me', see_main_line_when_no_number: false });
      // No customer on the row, so the job was the only way to it.
      const row = await kind.make(org, { jobId: job.id });

      const detached = await (await person.api()).patch(kind.jobRoute(row), { job_id: null });
      expect(detached.status).toBe(200);
      expect(detached.body.left).toBe(true);
      expect(detached.body[kind.answerKey]).toBeNull();
      expect(await kind.tiedTo(row)).toEqual({});

      // It is gone from their reach: opening it again is the ordinary "not found".
      expect((await (await person.api()).patch(kind.jobRoute(row), { job_id: null })).status).toBe(404);
    });

    it('detaches and answers with the row when it stays readable, and does not say it left', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const person = await personWith(org, { communication_scope: 'linked_to_me' });
      // The person\'s own row stays in their section scope after it is taken off the job.
      const own = await kind.make(org, { customerId: customer, jobId: job.id }, { personId: person.id });

      const detached = await (await person.api()).patch(kind.jobRoute(own), { job_id: null });
      expect(detached.status).toBe(200);
      expect(detached.body.left).toBeUndefined();
      expect(detached.body[kind.answerKey]).toBeTruthy();
      expect((await kind.tiedTo(own)).jobId).toBeUndefined();
    });
  });

  describe('filing an unmatched inbound email into a conversation', () => {
    it('still needs Edit communication records: the attach switch does not allow it, and Edit communication records alone does', async () => {
      const { org } = await newOrg();
      const missing = randomUUID();
      const attachOnly = await personWith(org, { attach_conversations: true, edit_communication_records: false, communication_scope: 'all' });
      expect((await (await attachOnly.api()).patch(`/api/communication/emails/${missing}/link`, {})).status).toBe(403);

      const editOnly = await personWith(org, { attach_conversations: false, edit_communication_records: true, communication_scope: 'all' });
      const res = await (await editOnly.api()).patch(`/api/communication/emails/${missing}/link`, {});
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  });
});
