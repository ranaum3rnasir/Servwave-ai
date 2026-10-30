/* =============================================================================
   Roles & Permissions, PRD 8, slices S08.2, S08.5, S08.6 and S08.7 - the call log, call detail, the Text inbox and the Email page
   follow Communication scope.

   Everything goes through the routes, called as people on custom roles (never a built-in role name) holding exactly the
   switch values under test, against a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   Company numbers are linked through the same admin route Settings > Caller ID uses. Every org it creates is removed.
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
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

// Every on/off switch off, read from the catalog: the narrowest person the section can hold.
const EVERY_TOGGLE_OFF = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));

const suite = realClient ? describe : describe.skip;

suite('the call log and call detail follow Communication scope (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
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
    departmentId?: string,
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `scope-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { view_jobs: true, jobs_scope: 'attached', access_communication: true, view_communication: true, ...values },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, departmentId });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  async function addNumber(org: string, tag: string, opts: { orgDefault?: boolean } = {}) {
    const id = randomUUID();
    await db.phoneNumber.create({
      data: { id, organization_id: org, e164: `+1555${String(++sequence).padStart(7, '0')}`, label: tag, is_org_default: opts.orgDefault ?? false, status: 'active' },
    });
    return id;
  }

  async function addCall(
    org: string,
    fields: { numberId?: string; agentId?: string; jobId?: string; customerId?: string; outboundTo?: string } = {},
  ) {
    const id = randomUUID();
    await db.callSession.create({
      data: {
        id, organization_id: org, direction: fields.outboundTo ? 'out' : 'in', from_number: '+15555550100',
        to_number: fields.outboundTo ?? '+15555550199',
        status: 'completed', answered_by: {}, started_at: new Date(),
        phone_number_id: fields.numberId ?? null, agent_id: fields.agentId ?? null, job_id: fields.jobId ?? null,
        customer_id: fields.customerId ?? null,
      },
    });
    return id;
  }

  /** Tick people against a number the way an admin does on Settings > Caller ID. */
  async function link(admin: Person, numberId: string, people: Person[]) {
    const res = await (await fx.signedInAs(admin)).put(`/api/communication/numbers/${numberId}/assignments`, { user_ids: people.map((p) => p.id) });
    expect(res.status).toBe(200);
  }

  const idsOf = (body: { calls: { id: string }[] }) => body.calls.map((c) => c.id);

  describe('the call log', () => {
    it('lists the calls on a number linked to a Technician-preset custom role, not the calls on an unlinked number, and drops them on the next request after unlinking', async () => {
      const { org, admin } = await newOrg();
      const mine = await addNumber(org, 'run-linked');
      const other = await addNumber(org, 'run-unlinked');
      const person = await personWith(org, { communication_scope: 'attached' }, 'TECHNICIAN');
      const onMine = await addCall(org, { numberId: mine });
      const onOther = await addCall(org, { numberId: other });

      await link(admin, mine, [person]);
      const api = await person.api();
      const before = await api.get('/api/communication/calls');
      expect(before.status).toBe(200);
      expect(idsOf(before.body)).toContain(onMine);
      expect(idsOf(before.body)).not.toContain(onOther);

      await link(admin, mine, []);
      const after = await (await person.api()).get('/api/communication/calls');
      expect(idsOf(after.body)).not.toContain(onMine);
    });

    it('lists a call a person placed or answered on a number that is not linked to them', async () => {
      const { org } = await newOrg();
      const other = await addNumber(org, 'run-unlinked');
      const person = await personWith(org, { communication_scope: 'attached' });
      const theirs = await addCall(org, { numberId: other, agentId: person.id });
      const someoneElses = await addCall(org, { numberId: other, agentId: (await personWith(org, {})).id });
      const ids = idsOf((await (await person.api()).get('/api/communication/calls')).body);
      expect(ids).toContain(theirs);
      expect(ids).not.toContain(someoneElses);
    });

    it('shows a number to everyone it is linked to', async () => {
      const { org, admin } = await newOrg();
      const shared = await addNumber(org, 'run-shared');
      const a = await personWith(org, { communication_scope: 'attached' });
      const b = await personWith(org, { communication_scope: 'attached' }, 'SALES');
      await link(admin, shared, [a, b]);
      const call = await addCall(org, { numberId: shared });
      expect(idsOf((await (await a.api()).get('/api/communication/calls')).body)).toContain(call);
      expect(idsOf((await (await b.api()).get('/api/communication/calls')).body)).toContain(call);
    });

    it('does not link a person to the Organization default number by itself, and does once an admin ticks them on it', async () => {
      const { org, admin } = await newOrg();
      const main = await addNumber(org, 'run-main-line', { orgDefault: true });
      // The main-line switch is off here: it is the one thing besides a tick that shows a person the main line.
      const person = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false });
      const call = await addCall(org, { numberId: main });
      expect(idsOf((await (await person.api()).get('/api/communication/calls')).body)).not.toContain(call);

      await link(admin, main, [person]);
      expect(idsOf((await (await person.api()).get('/api/communication/calls')).body)).toContain(call);
    });

    it('lists no call tied to nothing for a person on "Linked to me" who is not linked to its number, and every call on "All"', async () => {
      const { org } = await newOrg();
      const number = await addNumber(org, 'run-unlinked');
      const tiedToNothing = await addCall(org, { numberId: number });
      const noNumber = await addCall(org);

      const narrow = await personWith(org, { communication_scope: 'attached' });
      const narrowIds = idsOf((await (await narrow.api()).get('/api/communication/calls')).body);
      expect(narrowIds).not.toContain(tiedToNothing);
      expect(narrowIds).not.toContain(noNumber);

      const wide = await personWith(org, { communication_scope: 'all' });
      const wideIds = idsOf((await (await wide.api()).get('/api/communication/calls')).body);
      expect(wideIds).toEqual(expect.arrayContaining([tiedToNothing, noNumber]));
    });

    it('gives a person on the Admin box the same call log as before: every call', async () => {
      const { org, admin } = await newOrg();
      const call = await addCall(org, { numberId: await addNumber(org, 'run-any') });
      const body = (await (await fx.signedInAs(admin)).get('/api/communication/calls')).body;
      expect(idsOf(body)).toContain(call);
    });
  });

  describe('the main-line fallback', () => {
    it('lists the main line\'s calls for a person with no linked number who holds the switch, on a role copied from the Technician preset, and not with it off', async () => {
      const { org } = await newOrg();
      const main = await addNumber(org, 'run-main-line', { orgDefault: true });
      const other = await addNumber(org, 'run-unlinked');
      const onMain = await addCall(org, { numberId: main });
      const onOther = await addCall(org, { numberId: other });

      const on = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: true }, 'TECHNICIAN');
      const onIds = idsOf((await (await on.api()).get('/api/communication/calls')).body);
      expect(onIds).toContain(onMain);
      expect(onIds).not.toContain(onOther);

      const off = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false }, 'TECHNICIAN');
      expect(idsOf((await (await off.api()).get('/api/communication/calls')).body)).not.toContain(onMain);
    });

    it('lists only the placed and answered calls with the switch off, and a main-line call tied to a job they can open still opens from the job', async () => {
      const { org, admin, customer } = await newOrg();
      const main = await addNumber(org, 'run-main-line', { orgDefault: true });
      const person = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false });
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      const placed = await addCall(org, { numberId: main, agentId: person.id });
      const jobTied = await addCall(org, { numberId: main, jobId: job.id });
      const otherJobTied = await addCall(org, { numberId: main, jobId: otherJob.id });
      const api = await person.api();

      expect(idsOf((await api.get('/api/communication/calls')).body)).toEqual([placed]);
      expect((await api.get(`/api/communication/calls/${jobTied}`)).status).toBe(200);
      expect((await api.get(`/api/communication/calls/${otherJobTied}`)).status).toBe(404);
    });

    it('gives a person with one linked number no main-line call; linking a first number ends the fallback on the next request and unlinking it restores it', async () => {
      const { org, admin } = await newOrg();
      const main = await addNumber(org, 'run-main-line', { orgDefault: true });
      const mine = await addNumber(org, 'run-linked');
      const person = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: true });
      const onMain = await addCall(org, { numberId: main });

      expect(idsOf((await (await person.api()).get('/api/communication/calls')).body)).toContain(onMain);
      await link(admin, mine, [person]);
      expect(idsOf((await (await person.api()).get('/api/communication/calls')).body)).not.toContain(onMain);
      await link(admin, mine, []);
      expect(idsOf((await (await person.api()).get('/api/communication/calls')).body)).toContain(onMain);
    });

    it('changes nothing for a person on All', async () => {
      const { org } = await newOrg();
      const main = await addNumber(org, 'run-main-line', { orgDefault: true });
      const onMain = await addCall(org, { numberId: main });
      for (const on of [true, false]) {
        const person = await personWith(org, { communication_scope: 'all', see_main_line_when_no_number: on });
        expect(idsOf((await (await person.api()).get('/api/communication/calls')).body)).toContain(onMain);
      }
    });
  });

  describe('the company numbers list', () => {
    const numberIds = (body: { numbers: { id: string }[] }) => body.numbers.map((n) => n.id);

    it('returns only the linked numbers on "Linked to me", the main line when there is none and the switch is on, and every number on All', async () => {
      const { org, admin } = await newOrg();
      const main = await addNumber(org, 'run-main-line', { orgDefault: true });
      const mine = await addNumber(org, 'run-linked');
      const other = await addNumber(org, 'run-unlinked');
      const narrow = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: true });

      expect(numberIds((await (await narrow.api()).get('/api/communication/numbers')).body)).toEqual([main]);
      await link(admin, mine, [narrow]);
      expect(numberIds((await (await narrow.api()).get('/api/communication/numbers')).body)).toEqual([mine]);

      const noFallback = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false });
      expect(numberIds((await (await noFallback.api()).get('/api/communication/numbers')).body)).toEqual([]);

      const wide = await personWith(org, { communication_scope: 'all', see_main_line_when_no_number: false });
      expect(numberIds((await (await wide.api()).get('/api/communication/numbers')).body)).toEqual(expect.arrayContaining([main, mine, other]));
    });

    it('trims the background-sync answer to the same numbers', async () => {
      const { org } = await newOrg();
      const main = await addNumber(org, 'run-main-line', { orgDefault: true });
      await addNumber(org, 'run-unlinked');
      const narrow = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: true });
      const res = await (await narrow.api()).post('/api/communication/numbers/sync-if-stale', {});
      expect(res.status).toBe(200);
      expect(numberIds(res.body)).toEqual([main]);
    });
  });

  describe('call detail', () => {
    it('opens a call in the section scope, a job-tied call on an unlinked number for a person who can open the job, and refuses the rest', async () => {
      const { org, admin, customer } = await newOrg();
      const mine = await addNumber(org, 'run-linked');
      const other = await addNumber(org, 'run-unlinked');
      const person = await personWith(org, { communication_scope: 'attached' });
      const job = await fx.addJob(org, customer, { crew: [person.id] });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      await link(admin, mine, [person]);

      const inScope = await addCall(org, { numberId: mine });
      const jobTied = await addCall(org, { numberId: other, jobId: job.id });
      const otherJobTied = await addCall(org, { numberId: other, jobId: otherJob.id });
      const tiedToNothing = await addCall(org, { numberId: other });
      const api = await person.api();

      expect((await api.get(`/api/communication/calls/${inScope}`)).status).toBe(200);
      expect((await api.get(`/api/communication/calls/${jobTied}`)).status).toBe(200);
      expect((await api.get(`/api/communication/calls/${otherJobTied}`)).status).toBe(404);
      expect((await api.get(`/api/communication/calls/${tiedToNothing}`)).status).toBe(404);
    });

    it('opens a customer-only call for a person who can open that customer, and not for one with View customers off', async () => {
      const { org, customer } = await newOrg();
      const other = await addNumber(org, 'run-unlinked');
      const call = await addCall(org, { numberId: other, customerId: customer });

      const canView = await personWith(org, {
        communication_scope: 'attached', view_customers: true, view_leads: true, jobs_scope: 'all', leads_scope: 'all',
      });
      expect((await (await canView.api()).get(`/api/communication/calls/${call}`)).status).toBe(200);

      const cannot = await personWith(org, {
        ...EVERY_TOGGLE_OFF, access_communication: true, view_communication: true, communication_scope: 'attached',
      });
      expect((await (await cannot.api()).get(`/api/communication/calls/${call}`)).status).toBe(404);
    });

    it('opens any call for a person on All', async () => {
      const { org } = await newOrg();
      const call = await addCall(org, { numberId: await addNumber(org, 'run-unlinked') });
      const person = await personWith(org, { communication_scope: 'all' });
      expect((await (await person.api()).get(`/api/communication/calls/${call}`)).status).toBe(200);
    });
  });

  describe('call counts and "did my call connect" (S08.4)', () => {
    const DIALLED = '+15555550142';
    const since = () => encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
    const outcomeFor = async (person: Person & { api: () => Promise<Api> }) =>
      (await (await person.api()).get(`/api/communication/calls/outcome?to_number=${encodeURIComponent(DIALLED)}&since=${since()}`)).body.call;

    it('answers for a call the person can read and for none they cannot, on the same scope as call detail', async () => {
      const { org, admin } = await newOrg();
      const mine = await addNumber(org, 'run-linked');
      const other = await addNumber(org, 'run-unlinked');
      const person = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false }, 'TECHNICIAN');
      await link(admin, mine, [person]);

      const onOther = await addCall(org, { numberId: other, outboundTo: DIALLED });
      expect(await outcomeFor(person)).toBeNull();

      const onMine = await addCall(org, { numberId: mine, outboundTo: DIALLED });
      expect((await outcomeFor(person))?.id).toBe(onMine);

      await link(admin, mine, []);
      expect(await outcomeFor(person)).toBeNull();
      const placed = await addCall(org, { numberId: other, agentId: person.id, outboundTo: DIALLED });
      expect((await outcomeFor(person))?.id).toBe(placed);
      expect(onOther).not.toBe(placed);
    });

    it('answers for a call tied to nothing on an unlinked number only to a person on All', async () => {
      const { org } = await newOrg();
      const call = await addCall(org, { numberId: await addNumber(org, 'run-unlinked'), outboundTo: DIALLED });
      expect(await outcomeFor(await personWith(org, { communication_scope: 'attached' }))).toBeNull();
      expect((await outcomeFor(await personWith(org, { communication_scope: 'all' })))?.id).toBe(call);
    });

    it('reflects the main-line fallback in what it answers for, on and off', async () => {
      const { org } = await newOrg();
      const main = await addNumber(org, 'run-main-line', { orgDefault: true });
      const call = await addCall(org, { numberId: main, outboundTo: DIALLED });
      const on = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: true }, 'TECHNICIAN');
      const off = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false }, 'TECHNICIAN');
      expect((await outcomeFor(on))?.id).toBe(call);
      expect(await outcomeFor(off)).toBeNull();
    });

    it('counts unread texts on the main line for a person it covers, and none with the switch off', async () => {
      const { org, customer } = await newOrg();
      const main = await addNumber(org, 'run-main-line', { orgDefault: true });
      const thread = randomUUID();
      await db.messageThread.create({
        data: { id: thread, organization_id: org, channel: 'sms', campaign_type: 'customer_care', customer_id: customer },
        select: { id: true },
      });
      await db.message.create({
        data: { id: randomUUID(), organization_id: org, thread_id: thread, direction: 'in', body: 'run-text', ts: new Date(), status: 'received', phone_number_id: main },
        select: { id: true },
      });
      const on = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: true });
      const off = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false });
      expect((await (await on.api()).get('/api/communication/unread-counts')).body.sms).toBe(1);
      expect((await (await off.api()).get('/api/communication/unread-counts')).body.sms).toBe(0);
    });
  });

  describe('the Email page (S08.7)', () => {
    /** A mailbox held by `holder` (or by nobody), as PRD 10 issues them. */
    async function addMailbox(org: string, holderId: string | null) {
      const id = randomUUID();
      await db.mailbox.create({
        data: { id, organization_id: org, kind: 'user', user_id: holderId, holder_user_id: holderId, status: 'active' },
      });
      return id;
    }

    /** One message in a new conversation in `mailboxId` (or in none), optionally tied to a job or a customer. */
    async function addEmail(org: string, mailboxId: string | null, ties: { jobId?: string; customerId?: string } = {}) {
      const threadId = randomUUID();
      if (mailboxId) {
        await db.emailThread.create({ data: { id: threadId, organization_id: org, mailbox_id: mailboxId, origin: 'started' } });
      }
      const id = randomUUID();
      await db.email.create({
        data: {
          id, organization_id: org, account: 'user', from: { name: null, email: 'someone@example.com' }, to: 'office@example.com',
          subject: 'run-email', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()), folder: 'inbox',
          thread_id: mailboxId ? threadId : null, job_id: ties.jobId ?? null, customer_id: ties.customerId ?? null,
        },
        select: { id: true },
      });
      return id;
    }

    const emailIds = (body: { emails: { id: string }[] }) => body.emails.map((e) => e.id);

    it('lists the conversations in a mailbox the person holds, not a colleague\'s, nor customer-only or loose mail', async () => {
      const { org, customer } = await newOrg();
      const person = await personWith(org, { communication_scope: 'attached' }, 'TECHNICIAN');
      const colleague = await personWith(org, { communication_scope: 'attached' });
      const mine = await addMailbox(org, person.id);
      const theirs = await addMailbox(org, colleague.id);
      const inMine = await addEmail(org, mine);
      const inTheirs = await addEmail(org, theirs);
      const customerOnly = await addEmail(org, theirs, { customerId: customer });
      const loose = await addEmail(org, null);

      const res = await (await person.api()).get('/api/communication/emails');
      expect(res.status).toBe(200);
      expect(emailIds(res.body)).toContain(inMine);
      for (const id of [inTheirs, customerOnly, loose]) expect(emailIds(res.body)).not.toContain(id);
    });

    it('adds no mailbox through the main-line fallback, and lists every conversation on All', async () => {
      const { org } = await newOrg();
      await addNumber(org, 'run-main-line', { orgDefault: true });
      const colleague = await personWith(org, {});
      const theirs = await addMailbox(org, colleague.id);
      const inTheirs = await addEmail(org, theirs);

      const fallback = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: true });
      expect(emailIds((await (await fallback.api()).get('/api/communication/emails')).body)).not.toContain(inTheirs);

      const wide = await personWith(org, { communication_scope: 'all' });
      expect(emailIds((await (await wide.api()).get('/api/communication/emails')).body)).toContain(inTheirs);
    });

    it('opens a job-tied message outside the person\'s mailboxes through the job only, and every message of their own mailbox', async () => {
      const { org, admin, customer } = await newOrg();
      const person = await personWith(org, { communication_scope: 'attached' });
      const colleague = await personWith(org, {});
      const mine = await addMailbox(org, person.id);
      const theirs = await addMailbox(org, colleague.id);
      const myJob = await fx.addJob(org, customer, { crew: [person.id] });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      const onMyJob = await addEmail(org, theirs, { jobId: myJob.id });
      const onOtherJob = await addEmail(org, theirs, { jobId: otherJob.id });
      const inMineOtherJob = await addEmail(org, mine, { jobId: otherJob.id });
      const api = await person.api();

      expect((await api.get(`/api/communication/emails/${onMyJob}`)).status).toBe(200);
      expect((await api.get(`/api/communication/emails/${onOtherJob}`)).status).toBe(404);
      expect((await api.get(`/api/communication/emails/${inMineOtherJob}`)).status).toBe(200);
      expect(emailIds((await api.get('/api/communication/emails')).body)).not.toContain(onMyJob);
    });

    it('counts unread email the way the Email page lists it', async () => {
      const { org } = await newOrg();
      const person = await personWith(org, { communication_scope: 'attached' });
      const colleague = await personWith(org, {});
      const mine = await addMailbox(org, person.id);
      const theirs = await addMailbox(org, colleague.id);
      await addEmail(org, mine);
      await addEmail(org, theirs);
      await addEmail(org, theirs);

      const narrow = await (await person.api()).get('/api/communication/unread-counts');
      expect(narrow.status).toBe(200);
      expect(narrow.body.email).toBe(1);

      const wide = await personWith(org, { communication_scope: 'all' });
      expect((await (await wide.api()).get('/api/communication/unread-counts')).body.email).toBe(3);
    });
  });
  describe('the Text inbox (S08.5)', () => {
    /** One text conversation (keyed to `customerId` or to a staff person), holding the messages added to it. */
    async function addThread(org: string, ties: { customerId?: string; staffUserId?: string } = {}) {
      const id = randomUUID();
      await db.messageThread.create({
        data: {
          id, organization_id: org, channel: 'sms', campaign_type: 'customer_care',
          customer_id: ties.customerId ?? null, user_id: ties.staffUserId ?? null,
        },
        select: { id: true },
      });
      return id;
    }

    async function addText(
      org: string,
      threadId: string,
      fields: { numberId?: string; sentBy?: string; direction?: 'in' | 'out'; jobId?: string; at?: Date } = {},
    ) {
      const id = randomUUID();
      await db.message.create({
        data: {
          id, organization_id: org, thread_id: threadId, direction: fields.direction ?? 'in', body: 'run-text', ts: fields.at ?? new Date(),
          status: 'received', phone_number_id: fields.numberId ?? null, sent_by_user_id: fields.sentBy ?? null, job_id: fields.jobId ?? null,
        },
        select: { id: true },
      });
      return id;
    }

    const threadIds = (body: { threads: { id: string }[] }) => body.threads.map((t) => t.id);
    const textIdsIn = (body: { threads: { id: string; messages: { id: string }[] }[] }, thread: string) =>
      (body.threads.find((t) => t.id === thread)?.messages ?? []).map((m) => m.id);

    it('returns, for a conversation mixing a linked and an unlinked number, only the linked messages and the ones the person sent', async () => {
      const { org, admin, customer } = await newOrg();
      const mine = await addNumber(org, 'run-linked');
      const other = await addNumber(org, 'run-unlinked');
      const person = await personWith(org, { communication_scope: 'attached' }, 'TECHNICIAN');
      await link(admin, mine, [person]);
      const thread = await addThread(org, { customerId: customer });
      const onMine = await addText(org, thread, { numberId: mine });
      const onOther = await addText(org, thread, { numberId: other });
      const sentByMe = await addText(org, thread, { numberId: other, direction: 'out', sentBy: person.id });
      const noNumber = await addText(org, thread);

      const res = await (await person.api()).get('/api/communication/threads');
      expect(res.status).toBe(200);
      expect(threadIds(res.body)).toContain(thread);
      const ids = textIdsIn(res.body, thread);
      expect(ids).toEqual(expect.arrayContaining([onMine, sentByMe]));
      for (const id of [onOther, noNumber]) expect(ids).not.toContain(id);
      // The response body itself leaves them out, not only the screen.
      expect(JSON.stringify(res.body)).not.toContain(onOther);
    });

    it('lists no conversation without a message of the person\'s, and drops a number\'s texts on the next request after unlinking', async () => {
      const { org, admin, customer } = await newOrg();
      const mine = await addNumber(org, 'run-linked');
      const other = await addNumber(org, 'run-unlinked');
      const person = await personWith(org, { communication_scope: 'attached' }, 'TECHNICIAN');
      const onMine = await addThread(org, { customerId: customer });
      await addText(org, onMine, { numberId: mine });
      const onOther = await addThread(org);
      await addText(org, onOther, { numberId: other });

      await link(admin, mine, [person]);
      const before = await (await person.api()).get('/api/communication/threads');
      expect(threadIds(before.body)).toContain(onMine);
      expect(threadIds(before.body)).not.toContain(onOther);

      await link(admin, mine, []);
      const after = await (await person.api()).get('/api/communication/threads');
      expect(threadIds(after.body)).not.toContain(onMine);
    });

    it('keeps a text sent from the Organization default number in the sender\'s list with no linked number, and never lists a text with no number through the fallback', async () => {
      const { org, customer } = await newOrg();
      const main = await addNumber(org, 'run-main-line', { orgDefault: true });
      const person = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false }, 'TECHNICIAN');
      const mineThread = await addThread(org, { customerId: customer });
      await addText(org, mineThread, { numberId: main, direction: 'out', sentBy: person.id });
      const mainLineThread = await addThread(org);
      await addText(org, mainLineThread, { numberId: main });

      const off = await (await person.api()).get('/api/communication/threads');
      expect(threadIds(off.body)).toContain(mineThread);
      expect(threadIds(off.body)).not.toContain(mainLineThread);

      const on = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: true }, 'TECHNICIAN');
      const noNumberThread = await addThread(org);
      await addText(org, noNumberThread);
      const onList = await (await on.api()).get('/api/communication/threads');
      expect(threadIds(onList.body)).toContain(mainLineThread);
      expect(threadIds(onList.body)).not.toContain(noNumberThread);
    });

    it('lists the customer\'s reply to a text the person sent from the Organization default number, and no other main-line text (S08.6)', async () => {
      const { org, customer } = await newOrg();
      const main = await addNumber(org, 'run-main-line', { orgDefault: true });
      const person = await personWith(org, { communication_scope: 'attached', see_main_line_when_no_number: false }, 'TECHNICIAN');
      const colleague = await personWith(org, {});
      const minute = (n: number) => new Date(Date.UTC(2026, 9, 1, 10, n));

      const mine = await addThread(org, { customerId: customer });
      await addText(org, mine, { numberId: main, direction: 'out', sentBy: person.id, at: minute(0) });
      const reply = await addText(org, mine, { numberId: main, at: minute(5) });
      // Someone else takes over the conversation: the next answer is theirs.
      await addText(org, mine, { numberId: main, direction: 'out', sentBy: colleague.id, at: minute(10) });
      const laterReply = await addText(org, mine, { numberId: main, at: minute(15) });

      const strangers = await addThread(org);
      const otherMainLineText = await addText(org, strangers, { numberId: main, at: minute(6) });

      const api = await person.api();
      const list = await api.get('/api/communication/threads');
      expect(list.status).toBe(200);
      expect(threadIds(list.body)).toContain(mine);
      expect(threadIds(list.body)).not.toContain(strangers);
      const ids = textIdsIn(list.body, mine);
      expect(ids).toContain(reply);
      expect(ids).not.toContain(laterReply);
      expect(JSON.stringify(list.body)).not.toContain(otherMainLineText);

      const detail = await api.get(`/api/communication/threads/${mine}`);
      expect(detail.body.thread.messages.map((m: { id: string }) => m.id)).toContain(reply);
      expect(detail.body.thread.messages.map((m: { id: string }) => m.id)).not.toContain(laterReply);

      // The colleague sent the later outbound, so the answer to it is theirs.
      const theirs = await (await colleague.api()).get('/api/communication/threads');
      expect(textIdsIn(theirs.body, mine)).toContain(laterReply);
    });

    it('lists the person\'s own staff conversation, and not another person\'s', async () => {
      const { org } = await newOrg();
      const person = await personWith(org, { communication_scope: 'attached' }, 'TECHNICIAN');
      const colleague = await personWith(org, {});
      const mineThread = await addThread(org, { staffUserId: person.id });
      await addText(org, mineThread);
      const theirs = await addThread(org, { staffUserId: colleague.id });
      await addText(org, theirs);

      const ids = threadIds((await (await person.api()).get('/api/communication/threads')).body);
      expect(ids).toContain(mineThread);
      expect(ids).not.toContain(theirs);
    });

    it('opens a conversation from a job the person is on with their own messages and the job\'s, leaving out another job\'s', async () => {
      const { org, admin, customer } = await newOrg();
      const unlinked = await addNumber(org, 'run-unlinked');
      const person = await personWith(org, { communication_scope: 'attached' });
      const myJob = await fx.addJob(org, customer, { crew: [person.id] });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      const thread = await addThread(org, { customerId: customer });
      const onMyJob = await addText(org, thread, { numberId: unlinked, jobId: myJob.id });
      const onOtherJob = await addText(org, thread, { numberId: unlinked, jobId: otherJob.id });
      // Tied to the customer only: the customer's page is the record it hangs off, and the person can open it.
      const customerOnly = await addText(org, thread, { numberId: unlinked });

      const res = await (await person.api()).get(`/api/communication/threads/${thread}`);
      expect(res.status).toBe(200);
      const ids = res.body.thread.messages.map((m: { id: string }) => m.id);
      expect(ids).toEqual(expect.arrayContaining([onMyJob, customerOnly]));
      // The job beats the customer: another job's message stays out although the customer is theirs to open.
      expect(ids).not.toContain(onOtherJob);

      const wide = await personWith(org, { communication_scope: 'all' });
      const all = await (await wide.api()).get(`/api/communication/threads/${thread}`);
      expect(all.body.thread.messages.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining([onMyJob, onOtherJob, customerOnly]));
    });

    it('refuses a reply into a conversation the person cannot read, and still sends a new text to any number', async () => {
      const { org, customer } = await newOrg();
      const unlinked = await addNumber(org, 'run-unlinked');
      const person = await personWith(org, { communication_scope: 'attached', contact_customers: true });
      const thread = await addThread(org, { customerId: customer });
      await addText(org, thread, { numberId: unlinked });
      const api = await person.api();

      const reply = await api.post('/api/communication/sms', { threadId: thread, body: 'run-reply' });
      expect(reply.status).toBe(404);

      const fresh = await api.post('/api/communication/sms', { toNumber: '(201) 555-0188', body: 'run-new-text' });
      expect(fresh.status).toBe(201);
    });

    it('counts unread texts the way the inbox lists them', async () => {
      const { org, admin, customer } = await newOrg();
      const mine = await addNumber(org, 'run-linked');
      const other = await addNumber(org, 'run-unlinked');
      const person = await personWith(org, { communication_scope: 'attached' });
      await link(admin, mine, [person]);
      const ownThread = await addThread(org, { customerId: customer });
      await addText(org, ownThread, { numberId: mine });
      for (let i = 0; i < 2; i++) await addText(org, await addThread(org), { numberId: other });

      const narrow = await (await person.api()).get('/api/communication/unread-counts');
      expect(narrow.status).toBe(200);
      expect(narrow.body.sms).toBe(1);

      const wide = await personWith(org, { communication_scope: 'all' });
      expect((await (await wide.api()).get('/api/communication/unread-counts')).body.sms).toBe(3);
    });

    it('gives a person on the Admin box the same inbox as before: every conversation', async () => {
      const { org, admin } = await newOrg();
      const thread = await addThread(org);
      await addText(org, thread);
      expect(threadIds((await (await fx.signedInAs(admin)).get('/api/communication/threads')).body)).toContain(thread);
    });
  });

  describe('Communication scope Team (P6: Attached for everyone in the person\'s department)', () => {
    async function twoDepartments(org: string) {
      return { north: await fx.addDepartment(org, 'North'), south: await fx.addDepartment(org, 'South') };
    }

    it('lists the calls on a number linked to anyone in the department and the calls a teammate answered, not another department\'s, and nothing of the team without a department', async () => {
      const { org, admin } = await newOrg();
      const { north, south } = await twoDepartments(org);
      const me = await personWith(org, { communication_scope: 'team' }, 'DISPATCHER', north);
      const mate = await personWith(org, { communication_scope: 'attached' }, 'TECHNICIAN', north);
      const stranger = await personWith(org, { communication_scope: 'attached' }, 'TECHNICIAN', south);
      const mateNumber = await addNumber(org, 'run-mate');
      const strangerNumber = await addNumber(org, 'run-stranger');
      await link(admin, mateNumber, [mate]);
      await link(admin, strangerNumber, [stranger]);
      const onMateNumber = await addCall(org, { numberId: mateNumber });
      const answeredByMate = await addCall(org, { agentId: mate.id });
      const onStrangerNumber = await addCall(org, { numberId: strangerNumber });
      const answeredByStranger = await addCall(org, { agentId: stranger.id });

      const list = await (await me.api()).get('/api/communication/calls');
      expect(list.status).toBe(200);
      expect(idsOf(list.body)).toEqual(expect.arrayContaining([onMateNumber, answeredByMate]));
      for (const id of [onStrangerNumber, answeredByStranger]) expect(idsOf(list.body)).not.toContain(id);
      expect((await (await me.api()).get(`/api/communication/calls/${onMateNumber}`)).status).toBe(200);
      expect((await (await me.api()).get(`/api/communication/calls/${onStrangerNumber}`)).status).toBe(404);

      const loner = await personWith(org, { communication_scope: 'team' });
      const none = await (await loner.api()).get('/api/communication/calls');
      expect(idsOf(none.body)).not.toContain(onMateNumber);
      expect(idsOf(none.body)).not.toContain(answeredByMate);
    });

    it('lists the texts on a teammate\'s number and the ones a teammate sent, not another department\'s', async () => {
      const { org, admin, customer } = await newOrg();
      const { north, south } = await twoDepartments(org);
      const me = await personWith(org, { communication_scope: 'team' }, 'DISPATCHER', north);
      const mate = await personWith(org, { communication_scope: 'attached' }, 'TECHNICIAN', north);
      const stranger = await personWith(org, { communication_scope: 'attached' }, 'TECHNICIAN', south);
      const mateNumber = await addNumber(org, 'run-mate');
      const strangerNumber = await addNumber(org, 'run-stranger');
      await link(admin, mateNumber, [mate]);
      await link(admin, strangerNumber, [stranger]);
      const thread = await (async () => {
        const id = randomUUID();
        await db.messageThread.create({ data: { id, organization_id: org, channel: 'sms', campaign_type: 'customer_care', customer_id: customer } });
        return id;
      })();
      const text = async (fields: { numberId?: string; sentBy?: string }) => {
        const id = randomUUID();
        await db.message.create({
          data: {
            id, organization_id: org, thread_id: thread, direction: fields.sentBy ? 'out' : 'in', body: 'run-text', ts: new Date(),
            status: 'received', phone_number_id: fields.numberId ?? null, sent_by_user_id: fields.sentBy ?? null,
          },
        });
        return id;
      };
      const onMate = await text({ numberId: mateNumber });
      const sentByMate = await text({ sentBy: mate.id });
      const onStranger = await text({ numberId: strangerNumber });

      const res = await (await me.api()).get('/api/communication/threads');
      expect(res.status).toBe(200);
      const ids = (res.body.threads.find((t: { id: string }) => t.id === thread)?.messages ?? []).map((m: { id: string }) => m.id);
      expect(ids).toEqual(expect.arrayContaining([onMate, sentByMate]));
      expect(ids).not.toContain(onStranger);
    });

    it('lists the conversations in a mailbox a teammate holds, not another department\'s, nor loose mail', async () => {
      const { org } = await newOrg();
      const { north, south } = await twoDepartments(org);
      const me = await personWith(org, { communication_scope: 'team' }, 'DISPATCHER', north);
      const mate = await personWith(org, { communication_scope: 'attached' }, 'TECHNICIAN', north);
      const stranger = await personWith(org, { communication_scope: 'attached' }, 'TECHNICIAN', south);
      const mailbox = async (holder: Person) => {
        const id = randomUUID();
        await db.mailbox.create({ data: { id, organization_id: org, kind: 'user', user_id: holder.id, holder_user_id: holder.id, status: 'active' } });
        return id;
      };
      const email = async (mailboxId: string | null) => {
        const threadId = randomUUID();
        if (mailboxId) await db.emailThread.create({ data: { id: threadId, organization_id: org, mailbox_id: mailboxId, origin: 'started' } });
        const id = randomUUID();
        await db.email.create({
          data: {
            id, organization_id: org, account: 'user', from: { name: null, email: 'someone@example.com' }, to: 'office@example.com',
            subject: 'run-email', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()), folder: 'inbox', thread_id: mailboxId ? threadId : null,
          },
        });
        return id;
      };
      const inMate = await email(await mailbox(mate));
      const inStranger = await email(await mailbox(stranger));
      const loose = await email(null);

      const res = await (await me.api()).get('/api/communication/emails');
      expect(res.status).toBe(200);
      const ids = res.body.emails.map((e: { id: string }) => e.id);
      expect(ids).toContain(inMate);
      for (const id of [inStranger, loose]) expect(ids).not.toContain(id);
    });
  });
});
