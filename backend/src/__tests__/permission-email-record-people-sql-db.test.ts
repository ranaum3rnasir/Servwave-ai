/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.9 (fix) - the record's people, asked of the database in one statement that
   starts at the person, agree with the rules written in TypeScript.

   `recordPeopleThreads` (lib/communication/recordPeopleThreads.ts) restates two rules in SQL because a query that starts at
   the person cannot ask them of the TypeScript: who the record's people are (`recordPeopleReach`, recordPeople.ts, the
   Prisma condition M6's first lane and the access resolver share) and which job or lead a conversation is tied to
   (`tieOf`, recordTie.ts). This proves the two agree: over a wide fixture of every way a person can be on a record, the
   conversations the statement returns for each person are exactly the ones the TypeScript rules say are theirs, asked of
   every conversation one by one with the Prisma condition and `tieOf`.

   Real database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { recordPeopleThreads } from '../lib/communication/recordPeopleThreads';
import { tieOf } from '../lib/communication/recordTie';
import { recordPeopleReach } from '../lib/permissions/recordPeople';
import { substituteConditions } from '../lib/permissions/substituteConditions';
import { clearTokenCache } from '../middleware/authenticate';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('the record\'s people, in SQL and in TypeScript (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  type Message = { direction: 'out' | 'in'; match?: 'MATCHED' | 'UNMATCHED_SENDER' | null };
  const REPLY: Message[] = [{ direction: 'out' }, { direction: 'in', match: 'MATCHED' }];
  let clock = Date.now();

  async function addThread(
    org: string, mailbox: string, customer: string,
    record: { type: string; id: string } | null, messages: Message[] = REPLY, origin = 'record',
  ) {
    const id = randomUUID();
    await db.emailThread.create({
      data: { id, organization_id: org, mailbox_id: mailbox, origin, record_type: record?.type ?? null, record_id: record?.id ?? null },
    });
    for (const m of messages) {
      const out = m.direction === 'out';
      await db.email.create({
        data: {
          id: randomUUID(), organization_id: org, thread_id: id, customer_id: customer,
          account: out ? 'system' : 'user', direction: m.direction, folder: out ? 'sent' : 'inbox',
          inbound_match: out ? null : m.match === undefined ? 'MATCHED' : m.match,
          from: { name: null, email: out ? 'office@example.com' : 'customer@example.com' },
          to: out ? 'customer@example.com' : 'office@example.com',
          subject: 'run-record-people-sql', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(++clock),
        },
        select: { id: true },
      });
    }
    return id;
  }

  /** The ids of the conversations the TypeScript rules say are the person's, asked of every conversation of the company. */
  async function expectedFor(org: string, person: string): Promise<string[]> {
    const onJob = substituteConditions(recordPeopleReach('Job'), { userId: person })!;
    const onLead = substituteConditions(recordPeopleReach('Lead'), { userId: person })!;
    const threads = await db.emailThread.findMany({
      where: {
        organization_id: org, origin: 'record',
        emails: { some: { direction: 'in', OR: [{ inbound_match: null }, { inbound_match: 'MATCHED' }] } },
      },
      select: { id: true, record_type: true, record_id: true },
    });
    const mine: string[] = [];
    for (const t of threads) {
      const id = t.record_id as string;
      let tie: { jobId: string | null; leadId: string | null } | null = null;
      let ownsItsLead = false;
      switch (t.record_type) {
        case 'job': tie = tieOf({ type: 'job', id }); break;
        case 'lead': tie = tieOf({ type: 'lead', id }); break;
        case 'estimate': {
          const e = await db.estimate.findFirst({ where: { id, organization_id: org }, select: { job_id: true, lead_id: true } });
          if (!e) break;
          tie = tieOf({ type: 'estimate', jobId: e.job_id, leadId: e.lead_id });
          // M6's estimate alerts: the Owner of the estimate's lead is one of its people even when it sits on a job.
          ownsItsLead = e.lead_id != null && (await db.lead.count({ where: { id: e.lead_id, commission_owner_id: person } })) > 0;
          break;
        }
        case 'invoice': {
          const i = await db.invoice.findFirst({
            where: { id, organization_id: org }, select: { job_id: true, estimate: { select: { job_id: true, lead_id: true } } },
          });
          if (!i) break;
          tie = tieOf({ type: 'invoice', jobId: i.job_id, estimate: i.estimate ? { jobId: i.estimate.job_id, leadId: i.estimate.lead_id } : null });
          break;
        }
        default: break; // a customer's or a calendar entry's conversation has no job or lead, so no people
      }
      if (!tie) continue;
      const onTie =
        (tie.jobId != null && (await db.job.count({ where: { id: tie.jobId, organization_id: org, ...onJob } })) > 0) ||
        (tie.leadId != null && (await db.lead.count({ where: { id: tie.leadId, organization_id: org, ...onLead } })) > 0);
      if (onTie || ownsItsLead) mine.push(t.id);
    }
    return mine.sort();
  }

  async function foundFor(org: string, person: string): Promise<string[]> {
    return (await recordPeopleThreads(db, { organizationId: org, personId: person })).map((t) => t.id).sort();
  }

  it('lists to each person exactly the conversations the TypeScript rules give them, over every way of being on a record', async () => {
    const { org, customer, admin } = await fx.newOrg();
    orgs.push(org);
    const other = await fx.newOrg();
    orgs.push(other.org);
    const mailbox = (await db.mailbox.create({ data: { organization_id: org, kind: 'main', status: 'active' }, select: { id: true } })).id;
    const otherMailbox = (await db.mailbox.create({ data: { organization_id: other.org, kind: 'main', status: 'active' }, select: { id: true } })).id;

    const who = Object.fromEntries(await Promise.all(
      ['soldBy', 'crew', 'jobDispatcher', 'leadOwner', 'leadDispatcher', 'walkthroughCrew', 'leadAssignee', 'creator', 'stranger', 'both']
        .map(async (name, n) => [name, (await fx.addUser(org, `sql${n}`, 'DISPATCHER')).id] as const),
    )) as Record<string, string>;

    // Jobs: every way onto one, one nobody is on, one made from a lead, one with the same person in two seats.
    const job1 = await fx.addJob(org, customer, { soldBy: who.soldBy, crew: [who.crew], dispatcher: who.jobDispatcher, createdBy: who.creator });
    const job2 = await fx.addJob(org, customer, { createdBy: who.creator });
    const lead1 = await fx.addLead(org, customer, {
      owner: who.leadOwner, dispatcher: who.leadDispatcher, walkthroughCrew: [who.walkthroughCrew], assignees: [who.leadAssignee], createdBy: who.creator,
    });
    const lead2 = await fx.addLead(org, customer, { owner: who.both });
    const job3 = await fx.addJob(org, customer, { soldBy: who.both, crew: [who.both], fromLead: lead1.id });
    const past = await fx.addJob(org, customer, { crew: [who.crew], pastVisit: true });

    // Estimates: on a job (and its lead too), on a lead alone, on neither, on a job alone, on the other lead.
    const e1 = await fx.addEstimate(org, customer, admin.id, { jobId: job1.id, leadId: lead1.id });
    const e2 = await fx.addEstimate(org, customer, admin.id, { leadId: lead1.id });
    const e3 = await fx.addEstimate(org, customer, admin.id);
    const e4 = await fx.addEstimate(org, customer, admin.id, { jobId: job1.id });
    const e5 = await fx.addEstimate(org, customer, admin.id, { leadId: lead2.id });
    // Invoices: on a job, a deposit invoice on a lead's estimate, one on a job's estimate, a job's invoice whose estimate is
    // on a lead (the lead no longer reaches it), and one for the customer alone.
    const i1 = await fx.addInvoice(org, customer, { jobId: job1.id });
    const i2 = await fx.addInvoice(org, customer, { estimateId: e2.id });
    const i3 = await fx.addInvoice(org, customer, { estimateId: e1.id });
    const i4 = await fx.addInvoice(org, customer, { jobId: job2.id, estimateId: e2.id });
    const i5 = await fx.addInvoice(org, customer);

    const records: [string, string][] = [
      ['job', job1.id], ['job', job2.id], ['job', job3.id], ['job', past.id], ['lead', lead1.id], ['lead', lead2.id],
      ['estimate', e1.id], ['estimate', e2.id], ['estimate', e3.id], ['estimate', e4.id], ['estimate', e5.id],
      ['invoice', i1.id], ['invoice', i2.id], ['invoice', i3.id], ['invoice', i4.id], ['invoice', i5.id],
    ];
    for (const [type, id] of records) await addThread(org, mailbox, customer, { type, id });
    // Conversations that must not count whatever the person is: no reply, a reply held back, a reply with no match mark
    // (listed: it joined its conversation), a conversation that is not a record's, another company's.
    await addThread(org, mailbox, customer, { type: 'job', id: job1.id }, [{ direction: 'out' }]);
    await addThread(org, mailbox, customer, { type: 'job', id: job1.id }, [{ direction: 'out' }, { direction: 'in', match: 'UNMATCHED_SENDER' }]);
    await addThread(org, mailbox, customer, { type: 'job', id: job1.id }, [{ direction: 'in', match: null }]);
    await addThread(org, mailbox, customer, { type: 'job', id: job1.id }, REPLY, 'started');
    await addThread(org, mailbox, customer, { type: 'customer', id: customer });
    await addThread(org, mailbox, customer, { type: 'calendar_entry', id: randomUUID() });
    await addThread(org, mailbox, customer, null, REPLY, 'started');
    await addThread(other.org, otherMailbox, other.customer, { type: 'job', id: job1.id });
    await addThread(other.org, otherMailbox, other.customer, { type: 'lead', id: lead1.id });

    const found: Record<string, string[]> = {};
    for (const [name, id] of Object.entries(who)) {
      const expected = await expectedFor(org, id);
      found[name] = await foundFor(org, id);
      expect(found[name], name).toEqual(expected);
    }
    // The fixture is not vacuous: each seat brings something, and the seats that bring nothing bring nothing.
    const sizes = Object.fromEntries(Object.entries(found).map(([name, ids]) => [name, ids.length]));
    // The job's people: its conversation and the one whose reply has no match mark, its estimates (e1, e4), its invoices (i1, i3).
    expect(sizes.soldBy).toBe(6);
    // The crew member is also on a second job.
    expect(sizes.crew).toBe(7);
    expect(sizes.jobDispatcher).toBe(sizes.soldBy);
    // The lead, its estimate e2, the deposit invoice on that estimate, and (as Owner) e1 on the job.
    expect(sizes.leadOwner).toBe(4);
    expect(sizes.leadDispatcher).toBe(3);
    expect(sizes.walkthroughCrew).toBe(3);
    expect(sizes.leadAssignee).toBe(0);
    expect(sizes.creator).toBe(0);
    expect(sizes.stranger).toBe(0);
    expect(sizes.both).toBeGreaterThan(0);
  });

  it('follows the records as they change: a person taken off a crew, a lead that gains a job', async () => {
    const { org, customer, admin } = await fx.newOrg();
    orgs.push(org);
    const mailbox = (await db.mailbox.create({ data: { organization_id: org, kind: 'main', status: 'active' }, select: { id: true } })).id;
    const crew = (await fx.addUser(org, 'sqlcrew', 'DISPATCHER')).id;
    const owner = (await fx.addUser(org, 'sqlowner', 'DISPATCHER')).id;
    const soldBy = (await fx.addUser(org, 'sqlsold', 'DISPATCHER')).id;
    const lead = await fx.addLead(org, customer, { owner });
    const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
    const thread = await addThread(org, mailbox, customer, { type: 'estimate', id: estimate.id });
    const job = await fx.addJob(org, customer, { crew: [crew], soldBy });

    expect(await foundFor(org, owner)).toEqual([thread]);
    expect(await foundFor(org, soldBy)).toEqual([]);
    // The estimate moves onto the job: its tie moves with it (the job's people now, and the lead's Owner stays one of them).
    await db.estimate.update({ where: { id: estimate.id }, data: { job_id: job.id }, select: { id: true } });
    expect(await foundFor(org, soldBy)).toEqual([thread]);
    expect(await foundFor(org, crew)).toEqual([thread]);
    expect(await foundFor(org, owner)).toEqual([thread]);
    expect(await foundFor(org, owner)).toEqual(await expectedFor(org, owner));
    // The crew member is taken off the visit: gone on the very next read.
    await fx.removeCrew(job.visitId as string, crew);
    expect(await foundFor(org, crew)).toEqual([]);
    expect(await foundFor(org, soldBy)).toEqual([thread]);
  });

  it('gives the most recent customer replies first and stops at the limit', async () => {
    const { org, customer } = await fx.newOrg();
    orgs.push(org);
    const mailbox = (await db.mailbox.create({ data: { organization_id: org, kind: 'main', status: 'active' }, select: { id: true } })).id;
    const person = (await fx.addUser(org, 'sqlcap', 'DISPATCHER')).id;
    const threads: string[] = [];
    for (let n = 0; n < 5; n++) {
      const job = await fx.addJob(org, customer, { soldBy: person });
      threads.push(await addThread(org, mailbox, customer, { type: 'job', id: job.id }));
    }
    const newestFirst = [...threads].reverse();
    expect((await recordPeopleThreads(db, { organizationId: org, personId: person })).map((t) => t.id)).toEqual(newestFirst);
    expect((await recordPeopleThreads(db, { organizationId: org, personId: person, limit: 2 })).map((t) => t.id)).toEqual(newestFirst.slice(0, 2));
  });

  it('is never asked while the company\'s Email plan feature is off: the people\'s statement runs for the Email list only when the feature is on', async () => {
    const { org, customer, admin } = await fx.newOrg();
    orgs.push(org);
    const mailbox = (await db.mailbox.create({ data: { organization_id: org, kind: 'main', status: 'active' }, select: { id: true } })).id;
    const key = `sql-people-role-${org.slice(0, 6)}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_customers: true, access_communication: true, show_email: true,
        view_communication: true, communication_scope: 'linked_to_me',
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, 'sqlfeature', 'DISPATCHER', { customRoleId: role.id });
    const job = await fx.addJob(org, customer, { soldBy: person.id });
    const thread = await addThread(org, mailbox, customer, { type: 'job', id: job.id });
    const peopleStatements = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(([strings]) => Array.isArray(strings) && (strings as string[]).join('?').includes('my_jobs')).length;
    const spy = vi.spyOn(db, '$queryRaw');
    try {
      clearTokenCache();
      const on = await (await fx.signedInAs(person)).get('/api/communication/emails?mailbox=mine');
      expect(on.status).toBe(200);
      expect((on.body.emails as { threadId?: string }[]).length).toBeGreaterThan(0);
      expect(peopleStatements(spy)).toBe(1);

      // Off: the Email page's route is closed, and the loader behind it answers from the request, without the statement.
      await db.organization.update({ where: { id: org }, data: { feature_overrides: { email: false } } });
      clearTokenCache();
      spy.mockClear();
      const off = await (await fx.signedInAs(person)).get('/api/communication/emails?mailbox=mine');
      expect(off.status).toBe(402);
      const { emailSectionForReq } = await import('../lib/communication/communicationScope.js');
      const section = await emailSectionForReq({ user: { id: person.id, organization_id: org, org_features: [] } } as never);
      expect(section.inputs.recordPeopleThreadIds).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    void admin;
  });
});
