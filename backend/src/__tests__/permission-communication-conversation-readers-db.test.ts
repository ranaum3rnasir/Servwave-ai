/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.21 - the notification access filter covers calls, text conversations and email
   conversations.

   A communication alert reaches only people who may read the conversation it is about, and "may read" is the one
   question the routes that open a call, a text conversation and an email message ask (M11's single read). The filter asks
   it for many people at once (lib/communication/conversationReaders.ts); this suite holds the two readings equal over a wide
   fixture set: for every person and every conversation, the filter keeps the person exactly when the real route opens it
   (and the person may use the section, which the alert's destination needs).

   Everything runs against people on custom roles (never a built-in role name) holding exactly the switch values under test,
   on a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
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
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { clearAllSwitchCaches } from '../lib/permissions/switches/cache';

const suite = realClient ? describe : describe.skip;

suite('the notification access filter asks the single read for calls, texts and email (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM notification_recipients WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_thread_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM messages WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_readers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM vendors WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Member = Person & { api: () => Promise<Api>; mayUseSection: boolean };
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

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

  /** A person on a fresh custom role of this base holding exactly these switch values, linked to these company numbers. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; numbers?: string[]; departmentId?: string } = {},
  ): Promise<Member> {
    const base = opts.base ?? 'DISPATCHER';
    const key = `readers-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    const all = {
      view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached',
      access_communication: true, view_communication: true, communication_scope: 'attached', ...switchValues,
    };
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: all, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true, departmentId: opts.departmentId });
    for (const phone_number_id of opts.numbers ?? []) await db.userPhoneNumber.create({ data: { user_id: person.id, phone_number_id } });
    return Object.assign(person, { api: () => fx.signedInAs(person), mayUseSection: all.access_communication === true });
  }

  async function addNumber(org: string, tag: string, opts: { orgDefault?: boolean } = {}) {
    const id = randomUUID();
    await db.phoneNumber.create({
      data: { id, organization_id: org, e164: `+1555${String(++sequence).padStart(7, '0')}`, label: tag, is_org_default: opts.orgDefault ?? false, status: 'active' },
    });
    return id;
  }

  const filterObject = async (objectType: string, id: string, ids: string[], org: string) => {
    const { filterRecipientsByAccess } = await import('../services/notifications/filterByAccess.js');
    return filterRecipientsByAccess(objectType, id, ids, org);
  };

  /**
   * The agreement: the filter keeps a person exactly when the route that opens this conversation answers them (and they may
   * use the section). `opens` is the route; the people are everyone in the company the case is about.
   */
  async function expectAgreement(
    label: string, objectType: string, id: string, org: string, people: Member[], opens: (person: Member) => Promise<boolean>,
  ) {
    const kept = new Set(await filterObject(objectType, id, people.map((p) => p.id), org));
    const verdicts: Record<string, boolean> = {};
    for (const [i, person] of people.entries()) {
      const expected = person.mayUseSection && (await opens(person));
      verdicts[`#${i}`] = expected;
      expect(kept.has(person.id), `${label}: person #${i} (route opens: ${expected})`).toBe(expected);
    }
    return { kept, verdicts };
  }

  // ─── The company every agreement case runs in ──────────────────────────────────────────

  /** One company with the people and records the three conversation kinds are tied to. */
  async function world() {
    const { org, admin, customer } = await newOrg();
    const mine = await addNumber(org, 'run-mine');
    const other = await addNumber(org, 'run-other');
    const main = await addNumber(org, 'run-main', { orgDefault: true });

    const crew = await personWith(org, {
      view_jobs: true, jobs_scope: 'attached', view_estimates: true, leads_scope: 'attached', view_invoices: true,
    });
    const leadPerson = await personWith(org, { ...withDependantsOff(['view_jobs']), view_leads: true, leads_scope: 'attached' });
    const job = await fx.addJob(org, customer, { crew: [crew.id] });
    const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
    const lead = await fx.addLead(org, customer, { assignees: [leadPerson.id] });
    const otherLead = await fx.addLead(org, customer, { assignees: [admin.id] });
    const vendor = randomUUID();
    await db.vendor.create({ data: { id: vendor, organization_id: org, name: `Vendor ${vendor.slice(0, 6)}`, category: 'Supplies' } });

    const people = {
      linkedMine: await personWith(org, {}, { numbers: [mine] }),
      linkedOther: await personWith(org, {}, { numbers: [other] }),
      mainOn: await personWith(org, { see_main_line_when_no_number: true }),
      mainOff: await personWith(org, { see_main_line_when_no_number: false }),
      wide: await personWith(org, { communication_scope: 'all' }),
      crew,
      leadPerson,
      customerViewer: await personWith(org, { view_customers: true, jobs_scope: 'all', view_jobs: true }),
      vendorViewer: await personWith(org, { view_vendors: true }),
      agent: await personWith(org, { see_main_line_when_no_number: false }),
      noView: await personWith(org, withDependantsOff(['view_communication'])),
      noAccess: await personWith(org, withDependantsOff(['access_communication'])),
      noSection: await personWith(org, { ...withDependantsOff(['access_communication', 'view_communication']), communication_scope: 'all' }),
    };
    return {
      org, admin, customer, mine, other, main, job, otherJob, lead, otherLead, vendor, people,
      everyone: [...Object.values(people), Object.assign(admin, { api: () => fx.signedInAs(admin), mayUseSection: true }) as Member],
    };
  }

  // ─── Calls ─────────────────────────────────────────────────────────────────────────────────

  describe('a call', () => {
    async function addCall(
      org: string, fields: { numberId?: string; agentId?: string; jobId?: string; leadId?: string; customerId?: string; vendorId?: string } = {},
    ) {
      const id = randomUUID();
      await db.callSession.create({
        data: {
          id, organization_id: org, direction: 'in', from_number: '+15555550100', to_number: '+15555550199',
          status: 'missed', answered_by: {}, started_at: new Date(),
          phone_number_id: fields.numberId ?? null, agent_id: fields.agentId ?? null, job_id: fields.jobId ?? null,
          lead_id: fields.leadId ?? null, customer_id: fields.customerId ?? null, vendor_id: fields.vendorId ?? null,
        },
      });
      return id;
    }

    it('keeps exactly the people the route that opens the call answers, over numbers, ties, the main line and the agent', async () => {
      const w = await world();
      const calls: Record<string, string> = {
        'on my number': await addCall(w.org, { numberId: w.mine }),
        'on another number': await addCall(w.org, { numberId: w.other }),
        'on the main line': await addCall(w.org, { numberId: w.main }),
        'no number, answered by the agent': await addCall(w.org, { agentId: w.people.agent.id }),
        'tied to the crew job': await addCall(w.org, { numberId: w.other, jobId: w.job.id }),
        'tied to a job nobody here is on': await addCall(w.org, { numberId: w.other, jobId: w.otherJob.id }),
        'tied to the assigned lead': await addCall(w.org, { numberId: w.other, leadId: w.lead.id }),
        'tied to a lead nobody here is on': await addCall(w.org, { numberId: w.other, leadId: w.otherLead.id }),
        'tied to the customer': await addCall(w.org, { numberId: w.other, customerId: w.customer }),
        'tied to a vendor': await addCall(w.org, { numberId: w.other, vendorId: w.vendor }),
        'tied to nothing': await addCall(w.org, { numberId: w.other }),
        'tied to nothing, no number': await addCall(w.org),
        'job beats the lead on the same call': await addCall(w.org, { numberId: w.other, jobId: w.otherJob.id, leadId: w.lead.id }),
      };
      // Whether the person's main-line fallback applies is read per request, so link nobody after this point.
      const outcomes: Record<string, boolean[]> = {};
      for (const [label, id] of Object.entries(calls)) {
        const { verdicts } = await expectAgreement(label, 'CALL', id, w.org, w.everyone, async (p) =>
          (await (await p.api()).get(`/api/communication/calls/${id}`)).status === 200);
        outcomes[label] = Object.values(verdicts);
      }
      // The matrix is not vacuous: calls that some people read and others do not.
      expect(outcomes['on my number']).toContain(true);
      expect(outcomes['on my number']).toContain(false);
      expect(outcomes['tied to the crew job']).toContain(true);
      expect(outcomes['tied to a job nobody here is on']).toContain(false);
    }, 240_000);

    it('keeps a person on the main-line fallback for a main-line call, and not one with the switch off or a number of their own', async () => {
      const w = await world();
      const call = await addCall(w.org, { numberId: w.main });
      const kept = await filterObject('CALL', call, w.everyone.map((p) => p.id), w.org);
      expect(kept).toContain(w.people.mainOn.id);
      expect(kept).not.toContain(w.people.mainOff.id);
      expect(kept).not.toContain(w.people.linkedMine.id);
      expect(kept).toContain(w.people.wide.id);
      expect(kept).toContain(w.admin.id);
    });
  });

  // ─── Text conversations ────────────────────────────────────────────────────────────────────

  describe('a text conversation', () => {
    type Msg = { dir: 'in' | 'out'; numberId?: string; sentBy?: string; jobId?: string; leadId?: string };

    /** A conversation holding these messages, oldest first (each a minute after the one before). */
    async function addThread(
      org: string, fields: { customerId?: string; vendorId?: string; userId?: string }, messages: Msg[],
    ) {
      const id = randomUUID();
      await db.messageThread.create({
        data: {
          id, organization_id: org, campaign_type: 'none', customer_id: fields.customerId ?? null,
          vendor_id: fields.vendorId ?? null, user_id: fields.userId ?? null,
        },
      });
      const start = Date.now() - 3_600_000;
      for (const [i, m] of messages.entries()) {
        await db.message.create({
          data: {
            id: randomUUID(), organization_id: org, thread_id: id, direction: m.dir, body: 'run-text', ts: new Date(start + i * 60_000),
            phone_number_id: m.numberId ?? null, sent_by_user_id: m.sentBy ?? null, job_id: m.jobId ?? null, lead_id: m.leadId ?? null,
          },
        });
      }
      return id;
    }

    it('keeps exactly the people the route that opens the conversation answers, over numbers, replies, ties and the staff thread', async () => {
      const w = await world();
      const agent = w.people.agent.id;
      const threads: Record<string, string> = {
        'inbound on my number': await addThread(w.org, { customerId: w.customer }, [{ dir: 'in', numberId: w.mine }]),
        'inbound on another number': await addThread(w.org, {}, [{ dir: 'in', numberId: w.other }]),
        'inbound on the main line': await addThread(w.org, {}, [{ dir: 'in', numberId: w.main }]),
        'a reply to the agent\'s text on another number': await addThread(w.org, {}, [
          { dir: 'out', numberId: w.other, sentBy: agent }, { dir: 'in', numberId: w.other },
        ]),
        'a reply to someone else\'s text on another number': await addThread(w.org, {}, [
          { dir: 'out', numberId: w.other, sentBy: w.people.linkedMine.id }, { dir: 'in', numberId: w.other },
        ]),
        'a reply on a different number than the agent texted from': await addThread(w.org, {}, [
          { dir: 'out', numberId: w.other, sentBy: agent }, { dir: 'in', numberId: w.main },
        ]),
        'tied to the crew job': await addThread(w.org, {}, [{ dir: 'in', numberId: w.other, jobId: w.job.id }]),
        'tied to a job nobody here is on': await addThread(w.org, {}, [{ dir: 'in', numberId: w.other, jobId: w.otherJob.id }]),
        'tied to the assigned lead': await addThread(w.org, {}, [{ dir: 'in', numberId: w.other, leadId: w.lead.id }]),
        'tied to a lead nobody here is on': await addThread(w.org, {}, [{ dir: 'in', numberId: w.other, leadId: w.otherLead.id }]),
        'with the customer, no message tie': await addThread(w.org, { customerId: w.customer }, [{ dir: 'in', numberId: w.other }]),
        'with a vendor': await addThread(w.org, { vendorId: w.vendor }, [{ dir: 'in', numberId: w.other }]),
        'a staff conversation keyed to the agent': await addThread(w.org, { userId: agent }, [{ dir: 'in' }]),
        'mixed: one message on nobody\'s number, one on the crew job': await addThread(w.org, { customerId: w.customer }, [
          { dir: 'in', numberId: w.other }, { dir: 'in', numberId: w.other, jobId: w.job.id },
        ]),
        'a message with no number at all': await addThread(w.org, {}, [{ dir: 'in' }]),
      };
      const outcomes: Record<string, boolean[]> = {};
      for (const [label, id] of Object.entries(threads)) {
        const { verdicts } = await expectAgreement(label, 'MESSAGE_THREAD', id, w.org, w.everyone, async (p) =>
          (await (await p.api()).get(`/api/communication/threads/${id}`)).status === 200);
        outcomes[label] = Object.values(verdicts);
      }
      expect(outcomes['inbound on my number']).toContain(true);
      expect(outcomes['inbound on my number']).toContain(false);
      expect(outcomes['a reply to the agent\'s text on another number']).toContain(true);
      expect(outcomes['tied to the crew job']).toContain(true);
      expect(outcomes['tied to a job nobody here is on']).toContain(false);
    }, 240_000);
  });

  // ─── Email conversations ───────────────────────────────────────────────────────────────────

  describe('an email conversation', () => {
    type Msg = { dir?: 'in' | 'out'; sentBy?: string; jobId?: string; leadId?: string; customerId?: string; vendorId?: string };
    type Conversation = { origin?: string; record?: { type: string; id: string }; assignedTo?: string; messages?: Msg[] };

    /** The user mailbox issued to `owner`, held by `holder` (the owner unless it was handed over). */
    async function userMailbox(org: string, owner: Person, holder: Person | null = owner) {
      const id = randomUUID();
      await db.mailbox.create({ data: { id, organization_id: org, kind: 'user', user_id: owner.id, holder_user_id: holder?.id ?? null, status: 'active' } });
      await db.mailboxAddress.create({ data: { local_part: `u-${id}`, organization_id: org, mailbox_id: id, is_primary: true } });
      return id;
    }

    async function mainMailbox(org: string): Promise<string> {
      const found = await db.mailbox.findFirst({ where: { organization_id: org, kind: 'main' }, select: { id: true } });
      if (found) return found.id;
      const id = randomUUID();
      await db.mailbox.create({ data: { id, organization_id: org, kind: 'main', status: 'active' } });
      return id;
    }

    /** A conversation in `mailboxId` (or in none), holding the messages given (one inbound message when none are). */
    async function addConversation(org: string, mailboxId: string | null, customer: string, conv: Conversation = {}) {
      const thread = randomUUID();
      await db.emailThread.create({
        data: {
          id: thread, organization_id: org, mailbox_id: mailboxId, origin: conv.origin ?? (conv.record ? 'record' : 'started'),
          record_type: conv.record?.type ?? null, record_id: conv.record?.id ?? null, assigned_to_user_id: conv.assignedTo ?? null,
        },
      });
      const ids: string[] = [];
      for (const m of conv.messages ?? [{}]) {
        const id = randomUUID();
        const out = m.dir === 'out';
        await db.email.create({
          data: {
            id, organization_id: org, thread_id: thread, customer_id: m.customerId ?? customer, job_id: m.jobId ?? null,
            lead_id: m.leadId ?? null, vendor_id: m.vendorId ?? null, account: 'user', direction: out ? 'out' : 'in', folder: out ? 'sent' : 'inbox',
            sent_by_user_id: m.sentBy ?? null,
            from: { name: null, email: out ? 'office@example.com' : 'customer@example.com' },
            to: out ? 'customer@example.com' : 'office@example.com',
            subject: 'run-email', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
          },
          select: { id: true },
        });
        ids.push(id);
      }
      return { thread, ids };
    }

    /** Whether a person opens any message of the conversation through the route (the conversation opens when one does). */
    const opensAny = (ids: string[]) => async (p: Member) => {
      const api = await p.api();
      for (const id of ids) if ((await api.get(`/api/communication/emails/${id}`)).status === 200) return true;
      return false;
    };

    async function emailWorld() {
      const w = await world();
      const { org, customer } = w;
      const holder = await personWith(org, {});
      const leaver = await personWith(org, {});
      const secondLeaver = await personWith(org, {});
      const handedTo = await personWith(org, {});
      const assignee = await personWith(org, {});
      const writer = await personWith(org, {});
      const mainReader = await personWith(org, {});
      const mine = await userMailbox(org, holder);
      const elsewhere = await userMailbox(org, leaver, null);
      const handed = await userMailbox(org, secondLeaver, handedTo);
      const main = await mainMailbox(org);
      await db.mailboxReader.create({ data: { organization_id: org, mailbox_id: main, user_id: mainReader.id } });
      const estimate = await fx.addEstimate(org, customer, w.admin.id, { jobId: w.job.id });
      const invoice = await fx.addInvoice(org, customer, { jobId: w.job.id });
      const people = [...w.everyone, holder, handedTo, assignee, writer, mainReader];
      return { ...w, holder, handedTo, assignee, writer, mainReader, mine, elsewhere, handed, main, estimate, invoice, people };
    }

    it('keeps exactly the people the route that opens the conversation answers, over mailboxes, assignment, authorship, the main mailbox and the record', async () => {
      const e = await emailWorld();
      const { org, customer } = e;
      const conversations: Record<string, { thread: string; ids: string[] }> = {
        'in the holder\'s mailbox': await addConversation(org, e.mine, customer),
        'in a colleague\'s mailbox': await addConversation(org, e.elsewhere, customer),
        'in a mailbox handed over': await addConversation(org, e.handed, customer),
        'in a colleague\'s mailbox, assigned to a person': await addConversation(org, e.elsewhere, customer, { assignedTo: e.assignee.id }),
        'in a colleague\'s mailbox, a person wrote in it': await addConversation(org, e.elsewhere, customer, {
          messages: [{ dir: 'in' }, { dir: 'out', sentBy: e.writer.id }],
        }),
        'started in the main mailbox': await addConversation(org, e.main, customer),
        'started in the main mailbox, with a vendor message': await addConversation(org, e.main, customer, { messages: [{ vendorId: e.vendor }] }),
        'migrated in the main mailbox': await addConversation(org, e.main, customer, { origin: 'migrated' }),
        'moved into the main mailbox': await addConversation(org, e.main, customer, { origin: 'moved' }),
        'in no mailbox': await addConversation(org, null, customer),
        'ordinary, a message tied to the crew job': await addConversation(org, e.elsewhere, customer, { messages: [{ jobId: e.job.id }] }),
        'ordinary, a message tied to a job nobody is on': await addConversation(org, e.elsewhere, customer, { messages: [{ jobId: e.otherJob.id }] }),
        'ordinary, a message tied to the assigned lead': await addConversation(org, e.elsewhere, customer, { messages: [{ leadId: e.lead.id }] }),
        'ordinary, a message tied to the customer only': await addConversation(org, e.elsewhere, customer),
        'ordinary, a message tied to a vendor': await addConversation(org, e.elsewhere, customer, { messages: [{ vendorId: e.vendor }] }),
        'about the crew job': await addConversation(org, e.elsewhere, customer, { record: { type: 'job', id: e.job.id } }),
        'about the crew job, in the holder\'s mailbox': await addConversation(org, e.mine, customer, { record: { type: 'job', id: e.job.id } }),
        'about a job nobody is on, in the holder\'s mailbox': await addConversation(org, e.mine, customer, { record: { type: 'job', id: e.otherJob.id } }),
        'about the assigned lead': await addConversation(org, e.elsewhere, customer, { record: { type: 'lead', id: e.lead.id } }),
        'about the customer': await addConversation(org, e.elsewhere, customer, { record: { type: 'customer', id: customer } }),
        'about the job\'s estimate': await addConversation(org, e.elsewhere, customer, { record: { type: 'estimate', id: e.estimate.id } }),
        'about the job\'s invoice': await addConversation(org, e.elsewhere, customer, { record: { type: 'invoice', id: e.invoice.id } }),
        'about a calendar entry sent to the customer': await addConversation(org, e.elsewhere, customer, { record: { type: 'calendar_entry', id: randomUUID() } }),
        'about a record that is gone': await addConversation(org, e.elsewhere, customer, { record: { type: 'job', id: randomUUID() } }),
        'the record conversation, assigned to a person': await addConversation(org, e.elsewhere, customer, {
          record: { type: 'job', id: e.otherJob.id }, assignedTo: e.assignee.id,
        }),
      };
      const outcomes: Record<string, boolean[]> = {};
      for (const [label, c] of Object.entries(conversations)) {
        const { verdicts } = await expectAgreement(label, 'EMAIL_THREAD', c.thread, org, e.people, opensAny(c.ids));
        outcomes[label] = Object.values(verdicts);
      }
      expect(outcomes['in the holder\'s mailbox']).toContain(true);
      expect(outcomes['in the holder\'s mailbox']).toContain(false);
      expect(outcomes['started in the main mailbox']).toContain(true);
      expect(outcomes['about the crew job']).toContain(true);
      expect(outcomes['about a job nobody is on, in the holder\'s mailbox']).toContain(false);
    }, 480_000);

    it('keeps an Admin for the main mailbox whether or not anyone is linked (it was the holders of Manage roles and permissions until AL-18), and the linked person once there is one', async () => {
      const { org, customer } = await newOrg();
      const main = await mainMailbox(org);
      const manager = await personWith(org, { is_admin: true, communication_scope: 'attached' });
      const plain = await personWith(org, { communication_scope: 'attached' });
      const started = await addConversation(org, main, customer);
      const kept = () => filterObject('EMAIL_THREAD', started.thread, [manager.id, plain.id], org);

      const people = [manager, plain];
      await expectAgreement('nobody linked', 'EMAIL_THREAD', started.thread, org, people, opensAny(started.ids));
      expect(await kept()).toEqual([manager.id]);

      await db.mailboxReader.create({ data: { organization_id: org, mailbox_id: main, user_id: plain.id } });
      await expectAgreement('one person linked', 'EMAIL_THREAD', started.thread, org, people, opensAny(started.ids));
      expect((await kept()).sort()).toEqual([manager.id, plain.id].sort());
    });
  });

  // ─── What the rule does with the person, not the conversation ─────────────────────────────

  // ─── Team ──────────────────────────────────────────────────────────────────────────────────

  describe('Communication scope Team', () => {
    it('keeps exactly the people the routes answer for a call, a text conversation and an email conversation, and tells a teammate of the people linked', async () => {
      const { org, admin, customer } = await newOrg();
      const north = await fx.addDepartment(org, 'North');
      const south = await fx.addDepartment(org, 'South');
      const numberNorth = await addNumber(org, 'run-north');
      const numberSouth = await addNumber(org, 'run-south');
      const mate = await personWith(org, {}, { numbers: [numberNorth], departmentId: north });
      const stranger = await personWith(org, {}, { numbers: [numberSouth], departmentId: south });
      const teamNorth = await personWith(org, { communication_scope: 'team' }, { departmentId: north });
      const teamSouth = await personWith(org, { communication_scope: 'team' }, { departmentId: south });
      const teamless = await personWith(org, { communication_scope: 'team' });
      const attached = await personWith(org, {}, { departmentId: north });
      const people: Member[] = [mate, stranger, teamNorth, teamSouth, teamless, attached];

      // A call on the north number.
      const call = randomUUID();
      await db.callSession.create({
        data: {
          id: call, organization_id: org, direction: 'in', from_number: '+15555550100', to_number: '+15555550199', status: 'missed',
          answered_by: {}, started_at: new Date(), phone_number_id: numberNorth,
        },
      });
      const callVerdicts = (await expectAgreement('call on the north number', 'CALL', call, org, people, async (p) =>
        (await (await p.api()).get(`/api/communication/calls/${call}`)).status === 200)).verdicts;
      expect(Object.values(callVerdicts)).toEqual([true, false, true, false, false, false]);

      // A text on the north number.
      const thread = randomUUID();
      await db.messageThread.create({ data: { id: thread, organization_id: org, campaign_type: 'none', customer_id: customer } });
      await db.message.create({
        data: { id: randomUUID(), organization_id: org, thread_id: thread, direction: 'in', body: 'run-text', ts: new Date(), phone_number_id: numberNorth },
      });
      const textVerdicts = (await expectAgreement('text on the north number', 'MESSAGE_THREAD', thread, org, people, async (p) =>
        (await (await p.api()).get(`/api/communication/threads/${thread}`)).status === 200)).verdicts;
      expect(Object.values(textVerdicts)).toEqual([true, false, true, false, false, false]);

      // An email conversation in the north teammate's mailbox.
      const mailbox = randomUUID();
      await db.mailbox.create({ data: { id: mailbox, organization_id: org, kind: 'user', user_id: mate.id, holder_user_id: mate.id, status: 'active' } });
      await db.mailboxAddress.create({ data: { local_part: `u-${mailbox}`, organization_id: org, mailbox_id: mailbox, is_primary: true } });
      const emailThread = randomUUID();
      await db.emailThread.create({ data: { id: emailThread, organization_id: org, mailbox_id: mailbox, origin: 'started' } });
      const emailId = randomUUID();
      await db.email.create({
        data: {
          id: emailId, organization_id: org, thread_id: emailThread, customer_id: customer, account: 'user', direction: 'in', folder: 'inbox',
          from: { name: null, email: 'customer@example.com' }, to: 'office@example.com', subject: 'run-email', snippet: 's', body: ['b'],
          at: '1:00 PM', ts: BigInt(Date.now()),
        },
      });
      const emailVerdicts = (await expectAgreement('email in a teammate mailbox', 'EMAIL_THREAD', emailThread, org, people, async (p) =>
        (await (await p.api()).get(`/api/communication/emails/${emailId}`)).status === 200)).verdicts;
      expect(Object.values(emailVerdicts)).toEqual([true, false, true, false, false, false]);

      // The alert goes to the people linked and, on Team, to their department; the access filter has the last word.
      const { conversationAlertRecipients } = await import('../services/notifications/conversationAlertRecipients.js');
      const told = await conversationAlertRecipients({ kind: 'call', organizationId: org, callId: call });
      expect(told).toEqual(expect.arrayContaining([mate.id, teamNorth.id]));
      for (const out of [stranger, teamSouth, teamless, attached]) expect(told).not.toContain(out.id);
      expect(admin.id).toBeTruthy();
    }, 240_000);
  });

  describe('who is asked', () => {
    /** One conversation of each kind that the first person below reads through a number linked to them. */
    async function oneOfEach(org: string, numberId: string) {
      const call = randomUUID();
      await db.callSession.create({
        data: {
          id: call, organization_id: org, direction: 'in', from_number: '+15555550100', to_number: '+15555550199',
          status: 'missed', answered_by: {}, started_at: new Date(), phone_number_id: numberId,
        },
      });
      const thread = randomUUID();
      await db.messageThread.create({ data: { id: thread, organization_id: org, campaign_type: 'none' } });
      await db.message.create({
        data: { id: randomUUID(), organization_id: org, thread_id: thread, direction: 'in', body: 'run-text', ts: new Date(), phone_number_id: numberId },
      });
      const mailbox = randomUUID();
      return { call, thread, mailbox };
    }

    it('lets Show Phone and Show Text decide nothing, and Show Email decide for email only: a call or text reader is kept with them off, an email reader is dropped with Show Email off, and one who may not read is dropped with them on', async () => {
      const { org } = await newOrg();
      const number = await addNumber(org, 'run-linked');
      const unrelated = await addNumber(org, 'run-unrelated');
      const ids = await oneOfEach(org, number);
      const email = randomUUID();
      const mailboxOwner = await personWith(org, { show_email: true });
      await db.mailbox.create({ data: { id: email, organization_id: org, kind: 'user', user_id: mailboxOwner.id, holder_user_id: mailboxOwner.id, status: 'active' } });
      const emailThread = randomUUID();
      await db.emailThread.create({ data: { id: emailThread, organization_id: org, mailbox_id: email, origin: 'started' } });
      await db.email.create({
        data: {
          id: randomUUID(), organization_id: org, thread_id: emailThread, account: 'user', direction: 'in', folder: 'inbox',
          from: { name: null, email: 'customer@example.com' }, to: 'office@example.com', subject: 'run-email', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
      });

      for (const shown of [false, true]) {
        const show = { show_phone: shown, show_text: shown, show_email: shown };
        const reads = await personWith(org, show, { numbers: [number] });
        const owner = await personWith(org, show);
        await db.mailbox.update({ where: { id: email }, data: { holder_user_id: owner.id, user_id: owner.id } });
        const readsNothing = await personWith(org, show, { numbers: [unrelated] });

        expect(await filterObject('CALL', ids.call, [reads.id, readsNothing.id], org), `call, pages shown: ${shown}`).toEqual([reads.id]);
        expect(await filterObject('MESSAGE_THREAD', ids.thread, [reads.id, readsNothing.id], org), `text, pages shown: ${shown}`).toEqual([reads.id]);
        // Show Email closes the Email page, the destination of an email alert (M7, ticket 36): off, nobody is told.
        expect(await filterObject('EMAIL_THREAD', emailThread, [owner.id, readsNothing.id], org), `email, pages shown: ${shown}`).toEqual(shown ? [owner.id] : []);
      }
    });

    it('drops a person who cannot use the section, one who cannot view communication, a deactivated person and another company\'s person, and keeps the Admin box', async () => {
      const w = await world();
      const call = randomUUID();
      await db.callSession.create({
        data: {
          id: call, organization_id: w.org, direction: 'in', from_number: '+15555550100', to_number: '+15555550199',
          status: 'missed', answered_by: {}, started_at: new Date(), phone_number_id: w.mine,
        },
      });
      const reader = await personWith(w.org, {}, { numbers: [w.mine] });
      const noAccess = await personWith(w.org, withDependantsOff(['access_communication']), { numbers: [w.mine] });
      const noView = await personWith(w.org, withDependantsOff(['view_communication']), { numbers: [w.mine] });
      const deactivated = await personWith(w.org, {}, { numbers: [w.mine] });
      await db.user.update({ where: { id: deactivated.id }, data: { is_active: false } });
      const elsewhere = await newOrg();
      const stranger = await personWith(elsewhere.org, { communication_scope: 'all' });

      const kept = await filterObject('CALL', call, [reader, noAccess, noView, deactivated, stranger, w.admin].map((p) => p.id), w.org);
      expect(kept).toEqual([reader.id, w.admin.id]);
      // The other company's own Admin, asked about this company's call, is no more welcome.
      expect(await filterObject('CALL', call, [elsewhere.admin.id], w.org)).toEqual([]);
    });

    it('drops everyone when the conversation is not in the company or is gone', async () => {
      const w = await world();
      const elsewhere = await newOrg();
      const call = randomUUID();
      await db.callSession.create({
        data: {
          id: call, organization_id: elsewhere.org, direction: 'in', from_number: '+15555550100', to_number: '+15555550199',
          status: 'missed', answered_by: {}, started_at: new Date(),
        },
      });
      const everyone = w.everyone.map((p) => p.id);
      expect(await filterObject('CALL', call, everyone, w.org)).toEqual([]);
      expect(await filterObject('CALL', randomUUID(), everyone, w.org)).toEqual([]);
      expect(await filterObject('MESSAGE_THREAD', randomUUID(), everyone, w.org)).toEqual([]);
      expect(await filterObject('EMAIL_THREAD', randomUUID(), everyone, w.org)).toEqual([]);
    });

    it('stops keeping a person once their reach to the record is gone, on the next alert, for all three kinds', async () => {
      const { org, admin, customer } = await newOrg();
      const other = await addNumber(org, 'run-other');
      const crew = await personWith(org, { view_jobs: true, jobs_scope: 'attached' });
      const job = await fx.addJob(org, customer, { crew: [crew.id] });

      const call = randomUUID();
      await db.callSession.create({
        data: {
          id: call, organization_id: org, direction: 'in', from_number: '+15555550100', to_number: '+15555550199',
          status: 'missed', answered_by: {}, started_at: new Date(), phone_number_id: other, job_id: job.id,
        },
      });
      const thread = randomUUID();
      await db.messageThread.create({ data: { id: thread, organization_id: org, campaign_type: 'none' } });
      await db.message.create({
        data: { id: randomUUID(), organization_id: org, thread_id: thread, direction: 'in', body: 'run-text', ts: new Date(), phone_number_id: other, job_id: job.id },
      });
      const emailThread = randomUUID();
      await db.emailThread.create({ data: { id: emailThread, organization_id: org, mailbox_id: null, origin: 'record', record_type: 'job', record_id: job.id } });
      await db.email.create({
        data: {
          id: randomUUID(), organization_id: org, thread_id: emailThread, customer_id: customer, job_id: job.id, account: 'user', direction: 'in', folder: 'inbox',
          from: { name: null, email: 'customer@example.com' }, to: 'office@example.com', subject: 'run-email', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
      });

      const askAll = async () => ({
        call: await filterObject('CALL', call, [crew.id, admin.id], org),
        text: await filterObject('MESSAGE_THREAD', thread, [crew.id, admin.id], org),
        email: await filterObject('EMAIL_THREAD', emailThread, [crew.id, admin.id], org),
      });
      expect(await askAll()).toEqual({ call: [crew.id, admin.id], text: [crew.id, admin.id], email: [crew.id, admin.id] });

      await db.visitAssignee.deleteMany({ where: { user_id: crew.id } });
      expect(await askAll()).toEqual({ call: [admin.id], text: [admin.id], email: [admin.id] });
    });

    it('keeps nobody for an email conversation while the company\'s Email plan feature is off, and nothing else changes', async () => {
      const { org, admin, customer } = await newOrg();
      const number = await addNumber(org, 'run-mine');
      const holder = await personWith(org, {}, { numbers: [number] });
      await db.mailbox.create({ data: { id: randomUUID(), organization_id: org, kind: 'user', user_id: holder.id, holder_user_id: holder.id, status: 'active' } });
      const mailbox = (await db.mailbox.findFirst({ where: { organization_id: org, user_id: holder.id }, select: { id: true } }))!.id;
      const thread = randomUUID();
      await db.emailThread.create({ data: { id: thread, organization_id: org, mailbox_id: mailbox, origin: 'started' } });
      await db.email.create({
        data: {
          id: randomUUID(), organization_id: org, thread_id: thread, customer_id: customer, account: 'user', direction: 'in', folder: 'inbox',
          from: { name: null, email: 'customer@example.com' }, to: 'office@example.com', subject: 'run-email', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
      });
      const call = randomUUID();
      await db.callSession.create({
        data: {
          id: call, organization_id: org, direction: 'in', from_number: '+15555550100', to_number: '+15555550199',
          status: 'missed', answered_by: {}, started_at: new Date(), phone_number_id: number,
        },
      });

      expect(await filterObject('EMAIL_THREAD', thread, [holder.id, admin.id], org)).toEqual([holder.id, admin.id]);
      await db.organization.update({ where: { id: org }, data: { feature_overrides: { email: false } } });
      expect(await filterObject('EMAIL_THREAD', thread, [holder.id, admin.id], org)).toEqual([]);
      expect(await filterObject('CALL', call, [holder.id, admin.id], org)).toEqual([holder.id, admin.id]);
      await db.organization.update({ where: { id: org }, data: { feature_overrides: {} } });
      expect(await filterObject('EMAIL_THREAD', thread, [holder.id, admin.id], org)).toEqual([holder.id, admin.id]);
    });
  });

  // ─── Alerts already delivered ──────────────────────────────────────────────────────────────

  describe('an alert already delivered', () => {
    it('is not recalled when access is removed: the bell row stays as delivered, and opening the conversation from it finds nothing', async () => {
      const { emit } = await import('../services/notifications/notificationService.js');
      const { alertEmailReply } = await import('../services/notifications/emailReplyAlerts.js');
      const { org, admin, customer } = await newOrg();
      const number = await addNumber(org, 'run-mine');
      const person = await personWith(org, {}, { numbers: [number] });

      const call = randomUUID();
      await db.callSession.create({
        data: {
          id: call, organization_id: org, direction: 'in', from_number: '+15555550100', to_number: '+15555550199',
          status: 'missed', answered_by: {}, started_at: new Date(), phone_number_id: number,
        },
      });
      const thread = randomUUID();
      await db.messageThread.create({ data: { id: thread, organization_id: org, campaign_type: 'none' } });
      await db.message.create({
        data: { id: randomUUID(), organization_id: org, thread_id: thread, direction: 'in', body: 'run-text', ts: new Date(), phone_number_id: number },
      });
      const mailbox = randomUUID();
      await db.mailbox.create({ data: { id: mailbox, organization_id: org, kind: 'user', user_id: person.id, holder_user_id: person.id, status: 'active' } });
      const emailThread = randomUUID();
      await db.emailThread.create({ data: { id: emailThread, organization_id: org, mailbox_id: mailbox, origin: 'started', assigned_to_user_id: person.id } });
      const message = randomUUID();
      await db.email.create({
        data: {
          id: message, organization_id: org, thread_id: emailThread, customer_id: customer, account: 'user', direction: 'in', folder: 'inbox',
          from: { name: null, email: 'customer@example.com' }, to: 'office@example.com', subject: 'run-email', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
        },
      });

      const alerts = [
        { verb: 'communication.call_missed', object: { type: 'CALL', id: call, label: 'Caller' }, data: { call_status: 'missed', caller_number: '+15555550100' }, entity: {} },
        { verb: 'communication.sms_inbound', object: { type: 'MESSAGE_THREAD', id: thread, label: 'Caller' }, data: { preview: 'hello there' }, entity: {} },
        { verb: 'communication.email_inbound', object: { type: 'EMAIL_THREAD', id: emailThread, label: 'customer@example.com' }, data: { subject: 'run-email' }, entity: {} },
      ];
      // A customer's email reply finds its people itself (S10.10): the conversation's assignee here, through the same single read.
      const ring = (a: (typeof alerts)[number], key: string) => a.verb === 'communication.email_inbound'
        ? alertEmailReply({ organizationId: org, threadId: emailThread, providerMessageId: key, emailId: message, senderLabel: 'customer@example.com', subject: 'run-email' })
        : emit({ ...a, organizationId: org, actorId: null, dedupKey: `s0821:${key}` });
      const rowsOf = () => db.notificationRecipient.findMany({
        where: { organization_id: org, recipient_id: person.id },
        select: { notification: { select: { verb: true, title: true, body: true, data: true, object_type: true, object_id: true } } },
        orderBy: { created_at: 'asc' },
      });
      const key = (r: Awaited<ReturnType<typeof rowsOf>>[number]) => r.notification.verb;

      for (const [i, a] of alerts.entries()) {
        const told = await ring(a, `${a.verb}:${i}:${randomUUID()}`);
        expect(told, a.verb).toContain(person.id);
      }
      const delivered = (await rowsOf()).sort((a, b) => key(a).localeCompare(key(b)));
      expect(delivered.map(key)).toEqual(alerts.map((a) => a.verb).sort());

      // Access removed: unlinked from the number, the mailbox handed away and the conversation given to someone else.
      await db.userPhoneNumber.deleteMany({ where: { user_id: person.id } });
      await db.mailbox.update({ where: { id: mailbox }, data: { holder_user_id: admin.id } });
      await db.emailThread.update({ where: { id: emailThread }, data: { assigned_to_user_id: admin.id } });

      const api = await fx.signedInAs(person);
      expect((await api.get(`/api/communication/calls/${call}`)).status).toBe(404);
      expect((await api.get(`/api/communication/threads/${thread}`)).status).toBe(404);
      expect((await api.get(`/api/communication/emails/${message}`)).status).toBe(404);
      // The notice itself is still there, unchanged, in their bell.
      const bell = await api.get('/api/notifications');
      expect(bell.status).toBe(200);
      const inBell = (bell.body.notifications ?? bell.body.items ?? bell.body) as { verb: string; title: string }[];
      expect(inBell.map((n) => n.verb).sort()).toEqual(alerts.map((a) => a.verb).sort());
      const after = (await rowsOf()).sort((a, b) => key(a).localeCompare(key(b)));
      expect(after).toEqual(delivered);

      // The next alert about the same conversations no longer reaches them.
      for (const [i, a] of alerts.entries()) {
        const told = await ring(a, `again:${a.verb}:${i}:${randomUUID()}`);
        expect(told, a.verb).not.toContain(person.id);
      }
    });
  });

  // ─── The inbound webhooks ──────────────────────────────────────────────────────────────────

  describe('an inbound call or text from the phone service (a synthetic event, no call placed, no text sent)', () => {
    /** Run one webhook event through the handler the route uses, as the phone service would deliver it. */
    async function deliver(position: string, payload: Record<string, unknown>) {
      const { processCtmEvent } = await import('../controllers/ctm-webhook.controller.js');
      let status = 0;
      const res = { status(code: number) { status = code; return this; }, json() { return this; } };
      await processCtmEvent(position, payload, res as never, { syncUnknownNumbers: false });
      return status;
    }

    async function connectedOrg() {
      const made = await newOrg();
      const account = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
      await db.organization.update({ where: { id: made.org }, data: { ctm_account_id: account } });
      const tracking = `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
      const numberId = randomUUID();
      await db.phoneNumber.create({ data: { id: numberId, organization_id: made.org, e164: tracking, label: 'run-main', is_org_default: true, status: 'active' } });
      return { ...made, account, tracking, numberId };
    }

    const bellFor = async (org: string, person: string, verb: string) =>
      db.notificationRecipient.findMany({ where: { organization_id: org, recipient_id: person, notification: { verb } }, select: { id: true } });

    it('rings the bell of a person who may read the missed call, which only exists once the webhook\'s transaction has committed', async () => {
      const c = await connectedOrg();
      const sid = `CA${randomUUID().slice(0, 8)}`;
      const status = await deliver('end', {
        sid, account_id: Number(c.account), caller_number: '+15550001111', tracking_number: c.tracking, direction: 'inbound',
        dial_status: 'no-answer', call_status: 'no-answer', talk_time: 0, unix_time: Math.floor(Date.now() / 1000),
      });
      expect(status).toBe(0);
      await vi.waitFor(async () => expect(await bellFor(c.org, c.admin.id, 'communication.call_missed')).toHaveLength(1), { timeout: 5000 });
    });

    it('rings the bell of a person who may read the inbound text, and not one who may not', async () => {
      const c = await connectedOrg();
      // A Dispatcher-based person on a number of their own is no recipient's reader of the main line.
      const own = await addNumber(c.org, 'run-own');
      const outsider = await personWith(c.org, {}, { numbers: [own] });
      const status = await deliver('inbound_text', {
        message_id: `MSG${randomUUID().slice(0, 8)}`, account_id: Number(c.account), caller_number: '+15550002222', tracking_number: c.tracking,
        direction: 'msg_inbound', message_body: 'Is the gate code still 4412?', unix_time: Math.floor(Date.now() / 1000),
      });
      expect(status).toBe(0);
      await vi.waitFor(async () => expect(await bellFor(c.org, c.admin.id, 'communication.sms_inbound')).toHaveLength(1), { timeout: 5000 });
      // They are on the Dispatcher role list, so the role list names them; the single read of the conversation does not.
      expect(await bellFor(c.org, outsider.id, 'communication.sms_inbound')).toHaveLength(0);
    });
  });
});
