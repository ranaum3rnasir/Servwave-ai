/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.24 - a missed call, a voicemail or an inbound text is never silent.

   When the lookup that names the people of the alert (S08.22 for calls, S08.23 for texts) finds NOBODY after the access filter - no
   one on the record, nobody on Communication scope "All", nobody linked to the company number, nobody the reply names - the
   holders of Manage roles and permissions are told, with the reason line "Nobody is linked to this number and nobody sees every call
   and text.", the company number and the time in the COMPANY's zone. A holder who cannot read the conversation under their scope is
   told in a second alert that carries no caller details and no text preview. When there is no such holder either, one log line is
   written (the alert, the call or conversation, the company; nothing of the customer).

   Every case drives the REAL call or text ingest entry point with a synthetic payload (no call is placed, no text is sent), the way
   the webhook does: the alert is handed over by `afterCommit` and run once the row is stored. People are on custom roles built from
   the catalog, never a built-in role name. The built-in Admin is deactivated where a case needs "nobody on All" (it holds every
   switch). Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import { logger } from '../lib/logger';

const suite = realClient ? describe : describe.skip;

/** The line from PRD 8, word for word. It is typed here on purpose: the code's own constant is not the source of truth. */
const REASON_LINE = 'Nobody is linked to this number and nobody sees every call and text.';
/** The caller and what they wrote: none of it may reach a holder who cannot read the conversation. */
const CALLER = '+15557770188';
const CALLER_PARTS = ['7770188', '777-0188', '777 0188'];
const CUSTOMER_NAME = 'Pat Payer';
const TEXT_WORDS = 'Gate code is 9931';
/** The company number the cases use, as the app shows it, and the instant and the company's zone the time is judged in. */
const COMPANY_E164 = '+15555550142';
const COMPANY_SHOWN = '(555) 555-0142';
/** 2:05 AM on 13 October in UTC is 7:05 PM on the 12th in Los Angeles: the day and the hour both tell the zones apart. */
const AT = new Date(Date.UTC(2026, 9, 13, 2, 5, 0));
const AT_SHOWN = 'October 12, 2026 at 7:05 PM';
const ZONE = 'America/Los_Angeles';

type Kind = 'call' | 'text';

suite('a missed call, a voicemail or an inbound text is never silent (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM notifications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM blocked_numbers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM messages WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());

  /** The server's log, watched from now: nothing written before this call counts. */
  const watchLog = () => {
    const spy = vi.spyOn(logger, 'warn');
    spy.mockClear();
    return spy;
  };

  type Member = Person & { base: Role };
  let sequence = 0;

  /** A company in the Los Angeles zone whose one customer is the caller, with the built-in Admin deactivated: nobody is on All. */
  async function quietCompany(opts: { keepAdmin?: boolean } = {}) {
    const made = await fx.newOrg();
    orgs.push(made.org);
    await db.organization.update({ where: { id: made.org }, data: { timezone: ZONE } });
    await db.customer.update({ where: { id: made.customer }, data: { phone: CALLER.replace('+1', '') } });
    if (!opts.keepAdmin) await db.user.update({ where: { id: made.admin.id }, data: { is_active: false } });
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

  /** Neither Access Communication nor View communication, and every switch that needs them off with them: a person who cannot use the section. */
  const NO_SECTION = withDependantsOff(['access_communication', 'view_communication']);

  /** A person on a fresh custom role of the Technician base holding exactly these switch values, linked to these company numbers. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { numbers?: string[]; inactive?: boolean } = {},
  ): Promise<Member> {
    const base: Role = 'TECHNICIAN';
    const key = `never-silent-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    const all = {
      view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached',
      access_communication: true, view_communication: true, communication_scope: 'linked_to_me',
      see_main_line_when_no_number: false, ...values,
    };
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: all, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    for (const phone_number_id of opts.numbers ?? []) await db.userPhoneNumber.create({ data: { user_id: person.id, phone_number_id } });
    if (opts.inactive) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { base });
  }

  /** A holder of Manage roles and permissions (View users is the switch it needs), on Linked to me unless the case says otherwise. */
  const manager = (org: string, values: Record<string, boolean | string> = {}, opts: { inactive?: boolean } = {}) =>
    personWith(org, { view_users: true, manage_roles_and_permissions: true, ...values }, opts);

  /** A manager whose own place lets them open the job the case ties the conversation to (jobs seen company-wide), but who is not on All. */
  const managerWhoReadsJobs = (org: string) => manager(org, { jobs_scope: 'all' });

  async function addNumber(org: string, opts: { orgDefault?: boolean; e164?: string } = {}) {
    const id = randomUUID();
    const e164 = opts.e164 ?? `+1555${String(++sequence).padStart(7, '0')}`;
    await db.phoneNumber.create({
      data: { id, organization_id: org, e164, label: 'run-number', is_org_default: opts.orgDefault ?? false, status: 'active' },
    });
    return { id, e164 };
  }

  interface Arrive { jobId?: string; sid?: string; at?: Date; status?: 'missed' | 'voicemail'; suppress?: boolean }
  interface Row {
    id: string; title: string; body: string | null; data: unknown; object_label: string | null; object_type: string; object_id: string;
    dedup_key: string | null; priority: string; needs_action: boolean;
    recipients: Array<{ id: string; recipient_id: string; priority: string; needs_action: boolean }>;
  }

  /** What each kind of conversation needs to arrive through its real ingest door, and where its alerts are keyed. */
  const doors: Record<Kind, {
    verb: string;
    keyPart: string;
    arrive: (org: string, number: { id: string; e164: string }, opts: Arrive) => Promise<{ sid: string; objectId: string }>;
  }> = {
    call: {
      verb: 'communication.call_missed',
      keyPart: 'missed',
      async arrive(org, number, opts) {
        const sid = opts.sid ?? `CA-s0824-${randomUUID().slice(0, 12)}`;
        const at = opts.at ?? AT;
        if (opts.jobId) {
          await db.callSession.create({
            data: {
              organization_id: org, ctm_call_id: sid, direction: 'in', from_number: CALLER, to_number: number.e164, status: 'ringing',
              answered_by: {}, started_at: at, job_id: opts.jobId,
            },
          });
        }
        const { ingestCall } = await import('../lib/ctm/ingest.js');
        const raised: Array<() => Promise<unknown>> = [];
        const status = opts.status === 'voicemail' ? 'voicemail' : 'no-answer';
        const result = await ingestCall(db, org, {
          sid, account_id: 596375, caller_number: CALLER, tracking_number: number.e164, direction: 'inbound',
          dial_status: status, call_status: status, talk_time: 0, unix_time: Math.floor(at.getTime() / 1000),
        }, 'end', { suppressNotifications: opts.suppress, afterCommit: (raise) => { raised.push(raise); } });
        await Promise.all(raised.map((raise) => raise()));
        return { sid, objectId: result!.callSessionId };
      },
    },
    text: {
      verb: 'communication.sms_inbound',
      keyPart: 'inbound',
      async arrive(org, number, opts) {
        const sid = opts.sid ?? `MSG-s0824-${randomUUID().slice(0, 12)}`;
        const at = opts.at ?? AT;
        let thread = await db.messageThread.findFirst({ where: { organization_id: org, channel: 'sms', title: CALLER } });
        if (!thread) thread = await db.messageThread.create({ data: { organization_id: org, channel: 'sms', campaign_type: 'customer_care', title: CALLER } });
        const { ingestSms } = await import('../lib/ctm/ingest.js');
        const raised: Array<() => Promise<unknown>> = [];
        const result = await ingestSms(db, org, {
          message_id: sid, account_id: 596375, caller_number: CALLER, tracking_number: number.e164, direction: 'msg_inbound',
          message_body: TEXT_WORDS, unix_time: Math.floor(at.getTime() / 1000),
        }, { suppressNotifications: opts.suppress, afterCommit: (raise) => { raised.push(raise); } });
        // Tied to the job the way an attach would, before the alert runs.
        if (opts.jobId) await db.message.update({ where: { id: result!.messageId }, data: { job_id: opts.jobId } });
        await Promise.all(raised.map((raise) => raise()));
        return { sid, objectId: result!.threadId };
      },
    },
  };

  /** Every alert row the event wrote, however it was keyed. */
  async function rowsOf(kind: Kind, org: string, sid: string): Promise<Row[]> {
    return db.notification.findMany({
      where: { organization_id: org, dedup_key: { startsWith: `ctm:${sid}:${doors[kind].keyPart}` } },
      orderBy: { created_at: 'asc' },
      select: {
        id: true, title: true, body: true, data: true, object_label: true, object_type: true, object_id: true, dedup_key: true, priority: true,
        needs_action: true, recipients: { select: { id: true, recipient_id: true, priority: true, needs_action: true } },
      },
    }) as unknown as Row[];
  }

  /** The line the fallback writes (other alerts log their own gaps with similar words). */
  const isTheGap = (message: unknown) => String(message).startsWith('[conversationAlert] nobody to tell');

  const toldBy = (rows: Row[]) => new Set(rows.flatMap((r) => r.recipients.map((x) => x.recipient_id)));
  const rowFor = (rows: Row[], person: { id: string }) => rows.find((r) => r.recipients.some((x) => x.recipient_id === person.id));
  const everythingOf = (row: Row) => JSON.stringify([row.title, row.body, row.data, row.object_label]);

  /** What nobody who may not read the conversation may see in the alert: the caller, the customer, the words. */
  function expectNoCallerDetails(row: Row, kind: Kind) {
    const all = everythingOf(row);
    for (const secret of [CUSTOMER_NAME, ...CALLER_PARTS, ...(kind === 'text' ? [TEXT_WORDS, '9931'] : [])]) {
      expect(all, `the alert must not carry "${secret}"`).not.toContain(secret);
    }
    expect(row.object_label).toBeNull();
    expect(all).not.toContain('undefined');
  }

  /** The line that says what happened on which company number and when, and why the person is being told. */
  function expectTheNeutralFacts(row: Row, kind: Kind) {
    const all = everythingOf(row);
    expect(all).toContain(REASON_LINE);
    expect(all).toContain(COMPANY_SHOWN);
    expect(all).toContain(AT_SHOWN);
    // Nothing a person reads names the phone service.
    expect(all).not.toMatch(/ctm|calltracking|supabase|render/i);
    expect(row.title).toMatch(kind === 'call' ? /^Missed call/ : /^New text/);
  }

  for (const kind of ['call', 'text'] as const) {
    const door = doors[kind];

    describe(kind === 'call' ? 'a missed call' : 'an inbound text', () => {
      // ─── Criterion 1: nobody linked, nobody on All: the Manage roles and permissions holders ───────

      it('on a number nobody is linked to, tied to no record, with nobody on All, tells the Manage roles and permissions holders with the reason line, the company number and the time in the company zone', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const people = {
          managerA: await manager(org),
          managerB: await manager(org, NO_SECTION),
          notAManager: await personWith(org, {}),
          deactivatedManager: await manager(org, {}, { inactive: true }),
        };
        const stranger = await quietCompany({ keepAdmin: true });
        const strangersManager = await manager(stranger.org);

        const { sid } = await door.arrive(org, number, {});
        const rows = await rowsOf(kind, org, sid);

        const told = toldBy(rows);
        expect(told.has(people.managerA.id)).toBe(true);
        // The never-silent net does not depend on the Communication switches: a manager who cannot use the section is told too.
        expect(told.has(people.managerB.id)).toBe(true);
        expect(told.has(people.notAManager.id)).toBe(false);
        expect(told.has(people.deactivatedManager.id)).toBe(false);
        expect(told.has(strangersManager.id)).toBe(false);
        expect(told.has(stranger.admin.id)).toBe(false);
        for (const person of [people.managerA, people.managerB]) {
          expectTheNeutralFacts(rowFor(rows, person)!, kind);
          // Each person is told once.
          expect(rows.flatMap((r) => r.recipients).filter((r) => r.recipient_id === person.id)).toHaveLength(1);
        }
        // The alert is about the call or the conversation, so it opens there.
        for (const row of rows) expect(row.object_type).toBe(kind === 'call' ? 'CALL' : 'MESSAGE_THREAD');
      }, 240_000);

      it('with ONE active person on All, tells only that person: no fallback, no reason line, and the managers are not told', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const holderOfAll = await personWith(org, { communication_scope: 'all' });
        const managerA = await manager(org);
        const linkedElsewhere = await personWith(org, {}, { numbers: [(await addNumber(org)).id] });

        const { sid } = await door.arrive(org, number, {});
        const rows = await rowsOf(kind, org, sid);

        expect(rows).toHaveLength(1);
        expect([...toldBy(rows)]).toEqual([holderOfAll.id]);
        expect(toldBy(rows).has(managerA.id)).toBe(false);
        expect(toldBy(rows).has(linkedElsewhere.id)).toBe(false);
        expect(everythingOf(rows[0]!)).not.toContain('Nobody is linked');
        expect(rows[0]!.dedup_key).toBe(`ctm:${sid}:${door.keyPart}`);
      }, 240_000);

      it('adds nobody while someone qualifies: a person linked to the number is told, the managers are not, and there is no reason line', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const linked = await personWith(org, {}, { numbers: [number.id] });
        const managerA = await manager(org);

        const { sid } = await door.arrive(org, number, {});
        const rows = await rowsOf(kind, org, sid);

        expect([...toldBy(rows)]).toEqual([linked.id]);
        expect(rows.map((r) => everythingOf(r)).join()).not.toContain('Nobody is linked');
        expect(toldBy(rows).has(managerA.id)).toBe(false);
      }, 240_000);

      it('names the time in the company zone, not the server\'s, and the number as the app shows it', async () => {
        const { org } = await quietCompany();
        // The number the app shows is the stored display form when there is one.
        const id = randomUUID();
        await db.phoneNumber.create({ data: { id, organization_id: org, e164: COMPANY_E164, formatted: '(555) 555-0142', label: 'run-shown', status: 'active' } });
        const managerA = await manager(org);

        const { sid } = await door.arrive(org, { id, e164: COMPANY_E164 }, {});
        const row = rowFor(await rowsOf(kind, org, sid), managerA)!;

        expect(everythingOf(row)).toContain(AT_SHOWN);
        // The server runs in UTC, where the same instant is the next morning: that must not be the time named.
        expect(everythingOf(row)).not.toContain('October 13, 2026');
        expect(everythingOf(row)).not.toContain('2:05 AM');
        expect(everythingOf(row)).not.toContain(COMPANY_E164);
      }, 240_000);

      it('keeps its kind\'s priority: a missed call interrupts and asks for a call back, a text is a feed item', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const managerA = await manager(org);
        const managerB = await manager(org, NO_SECTION);

        const { sid } = await door.arrive(org, number, {});
        const rows = await rowsOf(kind, org, sid);

        const mine = rows.flatMap((r) => r.recipients).filter((r) => [managerA.id, managerB.id].includes(r.recipient_id));
        expect(mine).toHaveLength(2);
        for (const r of mine) {
          expect(r.priority).toBe(kind === 'call' ? 'INTERRUPT' : 'FEED');
          expect(r.needs_action).toBe(kind === 'call');
        }
        for (const row of rows) {
          expect(row.priority).toBe(kind === 'call' ? 'INTERRUPT' : 'FEED');
          expect(row.needs_action).toBe(kind === 'call');
        }
      }, 240_000);

      // ─── Criterion 2: a holder who cannot read it gets no caller details and no preview ──────

      it('gives a holder who cannot read the conversation no caller name, number, customer or text, in any field of the stored row or the bell\'s answer', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const cannotRead = await manager(org);
        const noSection = await manager(org, NO_SECTION);

        const { sid } = await door.arrive(org, number, {});
        const rows = await rowsOf(kind, org, sid);

        for (const person of [cannotRead, noSection]) {
          const row = rowFor(rows, person)!;
          expectNoCallerDetails(row, kind);
          expectTheNeutralFacts(row, kind);
          expect(row.data).not.toHaveProperty('preview');
          expect(row.data).not.toHaveProperty('customer_name');
          expect(row.data).not.toHaveProperty('caller_number');
          // The bell's own answer for that person carries nothing more.
          const api = await fx.signedInAs(person);
          const answer = await api.get('/api/notifications');
          expect(answer.status).toBe(200);
          // The bell lists a person's own recipient rows, so an item is known by that row's id.
          const mineId = row.recipients.find((r) => r.recipient_id === person.id)!.id;
          const item = (answer.body.items as Array<{ id: string }>).find((i) => i.id === mineId);
          expect(item, 'the alert is in their bell').toBeDefined();
          const shown = JSON.stringify(item);
          for (const secret of [CUSTOMER_NAME, ...CALLER_PARTS, '9931']) expect(shown).not.toContain(secret);
          expect(shown).toContain(REASON_LINE);
        }
      }, 240_000);

      it('gives a holder who CAN read the conversation the normal details, in an alert of their own that the others never receive', async () => {
        const { org, customer } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        // Tied to a job nobody is on: the lookup finds nobody. A manager who sees every job can open it.
        const job = await fx.addJob(org, customer, {});
        const reads = await managerWhoReadsJobs(org);
        const cannotRead = await manager(org);

        const { sid } = await door.arrive(org, number, { jobId: job.id });
        const rows = await rowsOf(kind, org, sid);

        expect(rows).toHaveLength(2);
        const withDetails = rowFor(rows, reads)!;
        const redacted = rowFor(rows, cannotRead)!;
        expect(withDetails.id).not.toBe(redacted.id);
        expect(withDetails.recipients.map((r) => r.recipient_id)).toEqual([reads.id]);
        expect(redacted.recipients.map((r) => r.recipient_id)).toEqual([cannotRead.id]);
        // The reader gets what any reader of the conversation gets, and still why they are being told, and the number and time.
        expect(withDetails.title).toContain(CUSTOMER_NAME);
        if (kind === 'text') expect(withDetails.body).toContain(TEXT_WORDS);
        expectTheNeutralFacts(withDetails, kind);
        // The other cannot read it and gets none of it.
        expectNoCallerDetails(redacted, kind);
        expectTheNeutralFacts(redacted, kind);
        // The two rows have their own keys, both under the event's.
        expect(new Set(rows.map((r) => r.dedup_key)).size).toBe(2);
        for (const row of rows) expect(row.dedup_key!.startsWith(`ctm:${sid}:${door.keyPart}`)).toBe(true);
      }, 240_000);

      it('writes only the redacted alert when no holder can read it, and only the full one when every holder can', async () => {
        const none = await quietCompany();
        const noneNumber = await addNumber(none.org, { e164: COMPANY_E164 });
        const a = await manager(none.org);
        const all = await quietCompany();
        const allNumber = await addNumber(all.org, { e164: COMPANY_E164 });
        const allJob = await fx.addJob(all.org, all.customer, {});
        const b = await managerWhoReadsJobs(all.org);

        const noneRows = await rowsOf(kind, none.org, (await door.arrive(none.org, noneNumber, {})).sid);
        const allSid = (await door.arrive(all.org, allNumber, { jobId: allJob.id })).sid;
        const allRows = await rowsOf(kind, all.org, allSid);

        expect(noneRows).toHaveLength(1);
        expectNoCallerDetails(noneRows[0]!, kind);
        expect(toldBy(noneRows).has(a.id)).toBe(true);
        expect(allRows).toHaveLength(1);
        expect(allRows[0]!.title).toContain(CUSTOMER_NAME);
        expect(toldBy(allRows).has(b.id)).toBe(true);
      }, 240_000);

      it('is the control: with someone on All the same call or text carries the caller\'s details, so the redaction above can fail', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        await personWith(org, { communication_scope: 'all' });

        const { sid } = await door.arrive(org, number, {});
        const [row] = await rowsOf(kind, org, sid);

        expect(row!.title).toContain(CUSTOMER_NAME);
        if (kind === 'text') expect(row!.body).toBe(TEXT_WORDS);
      }, 240_000);

      it('covers every empty answer: a conversation tied to a job whose people cannot read it, with nobody on All, is not silent either', async () => {
        const { org, customer } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const crewNoJobs = await personWith(org, withDependantsOff(['view_jobs']));
        const job = await fx.addJob(org, customer, { crew: [crewNoJobs.id], soldBy: crewNoJobs.id });
        const managerA = await manager(org);

        const { sid } = await door.arrive(org, number, { jobId: job.id });
        const rows = await rowsOf(kind, org, sid);

        expect(toldBy(rows).has(crewNoJobs.id)).toBe(false);
        expect(toldBy(rows).has(managerA.id)).toBe(true);
        expect(everythingOf(rowFor(rows, managerA)!)).toContain(REASON_LINE);
      }, 240_000);

      it('is the only path that tells a person the access filter would drop, and it tells them only the redacted alert', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        // Linked to the number but unable to use the section: the filter drops them from the normal alert. They are no one.
        const linkedNoAccess = await personWith(org, withDependantsOff(['access_communication']), { numbers: [number.id] });
        // A manager who cannot use the section: reached by the net, with no details.
        const managerNoAccess = await manager(org, NO_SECTION);

        const { sid } = await door.arrive(org, number, {});
        const rows = await rowsOf(kind, org, sid);

        expect(toldBy(rows).has(linkedNoAccess.id)).toBe(false);
        expect(toldBy(rows).has(managerNoAccess.id)).toBe(true);
        expectNoCallerDetails(rowFor(rows, managerNoAccess)!, kind);
      }, 240_000);

      // ─── Criterion 3: a chain that still finds nobody is logged once, with no customer content ──

      it('writes exactly one log line when there is no Manage roles and permissions holder either, carrying the alert, the id and the company and nothing of the customer', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        await manager(org, {}, { inactive: true });
        await personWith(org, {});
        const warn = watchLog();

        const { sid, objectId } = await door.arrive(org, number, {});

        expect(await rowsOf(kind, org, sid)).toEqual([]);
        const gaps = warn.mock.calls.filter(([message]) => isTheGap(message));
        expect(gaps).toHaveLength(1);
        expect((gaps[0] as unknown[])[1]).toEqual(
          kind === 'call'
            ? { alert: 'communication.call_missed', callId: objectId, organizationId: org }
            : { alert: 'communication.sms_inbound', conversationId: objectId, organizationId: org },
        );
        // No customer content in the line, whichever way it is printed.
        const printed = JSON.stringify(gaps[0]);
        for (const secret of [CUSTOMER_NAME, ...CALLER_PARTS, '9931', COMPANY_E164, COMPANY_SHOWN]) expect(printed).not.toContain(secret);
        // The line is in the server's own log: nothing in it is shown to a person, so it may name what it likes, but it names no vendor
        // product in the part the message carries.
        expect(String(gaps[0]![0])).not.toMatch(/ctm|calltracking|supabase|render/i);
      }, 240_000);

      it('writes one log line per delivery of an event nobody could be told about, because nothing was written to deduplicate it against', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const warn = watchLog();
        const sid = `${kind === 'call' ? 'CA' : 'MSG'}-s0824-${randomUUID().slice(0, 12)}`;

        await door.arrive(org, number, { sid });
        await door.arrive(org, number, { sid });

        // A redelivered CALL runs the whole lookup again and finds nobody again; no alert row exists to recognise it by, so each delivery
        // is one line, never two. A redelivered TEXT is stopped by the ingest itself (the message is stored already), before any alert.
        expect(warn.mock.calls.filter(([message]) => isTheGap(message))).toHaveLength(kind === 'call' ? 2 : 1);
        expect(await rowsOf(kind, org, sid)).toEqual([]);
      }, 240_000);

      it('logs nothing when somebody was told', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        await manager(org);
        const warn = watchLog();

        await door.arrive(org, number, {});

        expect(warn.mock.calls.filter(([message]) => isTheGap(message))).toEqual([]);
      }, 240_000);

      // ─── Duplicates, privacy of the rows ───────────────────────────────────────────────────────

      it('writes nothing twice when the event is delivered again, whether one alert or two went out', async () => {
        const { org, customer } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const job = await fx.addJob(org, customer, {});
        await managerWhoReadsJobs(org);
        await manager(org);
        const sid = `${kind === 'call' ? 'CA' : 'MSG'}-s0824-${randomUUID().slice(0, 12)}`;

        await door.arrive(org, number, { sid, jobId: job.id });
        const first = await rowsOf(kind, org, sid);
        await door.arrive(org, number, { sid });
        await door.arrive(org, number, { sid });
        const after = await rowsOf(kind, org, sid);

        expect(first).toHaveLength(2);
        expect(after.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
        expect(after.flatMap((r) => r.recipients).length).toBe(first.flatMap((r) => r.recipients).length);
      }, 240_000);

      it('writes nothing twice when only the redacted alert went out', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        await manager(org);
        const sid = `${kind === 'call' ? 'CA' : 'MSG'}-s0824-${randomUUID().slice(0, 12)}`;

        await door.arrive(org, number, { sid });
        await door.arrive(org, number, { sid });

        expect(await rowsOf(kind, org, sid)).toHaveLength(1);
      }, 240_000);

      it('does not add the fallback to an event the normal path already told, even if a redelivery would find nobody', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const linked = await personWith(org, {}, { numbers: [number.id] });
        await manager(org);
        const sid = `${kind === 'call' ? 'CA' : 'MSG'}-s0824-${randomUUID().slice(0, 12)}`;

        await door.arrive(org, number, { sid });
        await db.userPhoneNumber.deleteMany({ where: { user_id: linked.id } });
        await door.arrive(org, number, { sid });

        const rows = await rowsOf(kind, org, sid);
        expect(rows).toHaveLength(1);
        expect([...toldBy(rows)]).toEqual([linked.id]);
      }, 240_000);

      it('does not write the ordinary alert on a redelivery once the fallback has told the managers, even if somebody has been linked since', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const managerA = await manager(org);
        const sid = `${kind === 'call' ? 'CA' : 'MSG'}-s0824-${randomUUID().slice(0, 12)}`;

        await door.arrive(org, number, { sid });
        await personWith(org, {}, { numbers: [number.id] });
        await door.arrive(org, number, { sid });

        const rows = await rowsOf(kind, org, sid);
        expect(rows).toHaveLength(1);
        expect([...toldBy(rows)]).toEqual([managerA.id]);
      }, 240_000);

      it('lets only the person an alert was written for read it: a non-recipient finds the redacted alert by no route', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const recipient = await manager(org);
        const bystander = await manager(org);
        const outsider = await personWith(org, {});
        // The second manager is on the alert too (every manager is). Take them off it to make them a bystander by hand.
        const { sid } = await door.arrive(org, number, {});
        const [row] = await rowsOf(kind, org, sid);
        const mine = row!.recipients.find((r) => r.recipient_id === recipient.id)!;
        await db.notificationRecipient.deleteMany({ where: { notification_id: row!.id, recipient_id: { in: [bystander.id] } } });

        for (const stranger of [bystander, outsider]) {
          const api = await fx.signedInAs(stranger);
          const theirs = await api.get('/api/notifications');
          expect(theirs.status).toBe(200);
          expect(JSON.stringify(theirs.body)).not.toContain(row!.id);
          expect(JSON.stringify(theirs.body)).not.toContain(mine.id);
          expect(JSON.stringify(theirs.body)).not.toContain(REASON_LINE);
          for (const id of [row!.id, mine.id]) {
            for (const verb of ['read', 'act', 'dismiss'] as const) {
              expect((await api.patch(`/api/notifications/${id}/${verb}`)).status, `${verb} ${id}`).toBe(404);
            }
          }
        }
        const api = await fx.signedInAs(recipient);
        expect(JSON.stringify((await api.get('/api/notifications')).body)).toContain(mine.id);
      }, 240_000);

      // ─── Blocked and suppressed events trigger no fallback ──────────────────────────────────────

      it('raises no alert and no log for an event that is suppressed (a backfill)', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        await manager(org);
        const warn = watchLog();

        const { sid } = await door.arrive(org, number, { suppress: true });

        expect(await rowsOf(kind, org, sid)).toEqual([]);
        expect(warn.mock.calls.filter(([message]) => isTheGap(message))).toEqual([]);
      }, 240_000);

      it('raises no alert and no log for a caller on the blocked list: a blocked event never becomes a fallback alert', async () => {
        const { org, admin } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        await manager(org);
        await db.blockedNumber.create({
          data: { organization_id: org, number: CALLER, reason: 'spam', blocked_at: new Date(), blocked_by: 'run', blocked_by_id: admin.id },
        });
        const warn = watchLog();

        const { sid } = await door.arrive(org, number, {});

        expect(await rowsOf(kind, org, sid)).toEqual([]);
        expect(warn.mock.calls.filter(([message]) => isTheGap(message))).toEqual([]);
      }, 240_000);
    });
  }

  // ─── What is particular to each kind ───────────────────────────────────────────────────────────

  it('treats a voicemail exactly like a missed call', async () => {
    const { org, customer } = await quietCompany();
    const number = await addNumber(org, { e164: COMPANY_E164 });
    const job = await fx.addJob(org, customer, {});
    const reads = await managerWhoReadsJobs(org);
    const cannotRead = await manager(org);

    const { sid } = await doors.call.arrive(org, number, { status: 'voicemail', jobId: job.id });
    const rows = await rowsOf('call', org, sid);

    const redacted = rowFor(rows, cannotRead)!;
    expect(redacted.title).toMatch(/^Voicemail/);
    expect(redacted.title).not.toMatch(/^Missed call/);
    expectNoCallerDetails(redacted, 'call');
    expect(everythingOf(redacted)).toContain(REASON_LINE);
    expect(everythingOf(redacted)).toContain(COMPANY_SHOWN);
    expect(everythingOf(redacted)).toContain(AT_SHOWN);
    expect(rowFor(rows, reads)!.title).toMatch(/^Voicemail — Pat Payer/);
    for (const row of rows) {
      expect(row.priority).toBe('INTERRUPT');
      expect(row.needs_action).toBe(true);
    }
  }, 240_000);

  it('carries the preview of a text only in the alert of a holder who can read it, never in the redacted one', async () => {
    const { org, customer } = await quietCompany();
    const number = await addNumber(org, { e164: COMPANY_E164 });
    const job = await fx.addJob(org, customer, {});
    const reads = await managerWhoReadsJobs(org);
    const cannotRead = await manager(org);

    const { sid } = await doors.text.arrive(org, number, { jobId: job.id });
    const rows = await rowsOf('text', org, sid);

    expect(rowFor(rows, reads)!.body).toContain(TEXT_WORDS);
    expect(JSON.stringify(rowFor(rows, reads)!.data)).toContain(TEXT_WORDS);
    const redacted = rowFor(rows, cannotRead)!;
    expect(everythingOf(redacted)).not.toContain(TEXT_WORDS);
    expect(redacted.data).not.toHaveProperty('preview');
  }, 240_000);

  it('names the main line as the company number when that is the number nobody covers', async () => {
    const { org } = await quietCompany();
    const main = await addNumber(org, { e164: COMPANY_E164, orgDefault: true });
    // The fallback for a person with no number of their own is off for everyone here, so nobody covers the main line either.
    const managerA = await manager(org);

    const { sid } = await doors.call.arrive(org, main, {});
    const row = rowFor(await rowsOf('call', org, sid), managerA)!;

    expect(everythingOf(row)).toContain(COMPANY_SHOWN);
  }, 240_000);
});
