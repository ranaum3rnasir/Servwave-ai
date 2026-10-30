/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.24 - a missed call, a voicemail or an inbound text is never silent.

   When the lookup that names the people of the alert (S08.22 for calls, S08.23 for texts) finds NOBODY after the access filter - no
   one on the record, nobody on Communication scope "All", nobody linked to the company number, nobody the reply names - the net
   under it tells the company's active Admins (the holders of Manage roles and permissions until that switch retired, AL-18). When
   there is no active Admin either, one log line is written (the alert, the call or conversation, the company; nothing of the
   customer).

   Since AL-18 an Admin is the flag on the person, and an Admin holds every switch at its widest, Communication scope All included.
   So whenever the company has an active Admin, the lookup itself already names them and the ordinary alert, with the caller's
   details, reaches them: the call or text is never silent while an Admin is active. The net's own alerts (the reason line, the
   second alert without caller details for a holder who could not read the conversation) can no longer be reached, because the
   only time the lookup finds nobody is when the company has no active Admin, and then the net finds nobody too. The cases about
   those two alerts are gone with the switch; what is proved here is the rule as it now stands: the Admins are always told, a
   non-Admin is never the fallback, and a company with nobody to tell leaves one log line.

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
/** The caller and what they wrote: none of it may reach the server's log. */
const CALLER = '+15557770188';
const CALLER_PARTS = ['7770188', '777-0188', '777 0188'];
const CUSTOMER_NAME = 'Pat Payer';
const TEXT_WORDS = 'Gate code is 9931';
/** The company number the cases use, as the app shows it, and the instant and the company's zone. */
const COMPANY_E164 = '+15555550142';
const COMPANY_SHOWN = '(555) 555-0142';
const AT = new Date(Date.UTC(2026, 9, 13, 2, 5, 0));
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
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    const all = {
      view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached',
      access_communication: true, view_communication: true, communication_scope: 'attached',
      see_main_line_when_no_number: false, ...switchValues,
    };
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: all, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true });
    for (const phone_number_id of opts.numbers ?? []) await db.userPhoneNumber.create({ data: { user_id: person.id, phone_number_id } });
    if (opts.inactive) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { base });
  }

  /**
   * An Admin (the flag, AL-18) on a custom role whose own switches say Linked to me unless the case says otherwise: the switches do
   * not narrow an Admin, who holds every switch at its widest.
   */
  const anAdmin = (org: string, values: Record<string, boolean | string> = {}, opts: { inactive?: boolean } = {}) =>
    personWith(org, { is_admin: true, ...values }, opts);

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

  /** The ordinary alert: the caller's details and, for a text, its words; no reason line, since nobody had to be found for it. */
  function expectTheOrdinaryAlert(row: Row, kind: Kind) {
    expect(row.title).toContain(CUSTOMER_NAME);
    if (kind === 'text') expect(row.body).toContain(TEXT_WORDS);
    expect(everythingOf(row)).not.toContain(REASON_LINE);
    expect(everythingOf(row)).not.toContain('Nobody is linked');
    // Nothing a person reads names the phone service.
    expect(everythingOf(row)).not.toMatch(/ctm|calltracking|supabase|render/i);
  }

  for (const kind of ['call', 'text'] as const) {
    const door = doors[kind];

    describe(kind === 'call' ? 'a missed call' : 'an inbound text', () => {
      // ─── An active Admin is always told: the net never has to reach for anyone else ───────────────

      it('on a number nobody is linked to, tied to no record, with nobody else on All, tells every active Admin, whatever their Communication switches, with the ordinary alert and no reason line', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const people = {
          adminA: await anAdmin(org),
          // An Admin whose own switches would shut the section: the switches do not narrow an Admin.
          adminB: await anAdmin(org, NO_SECTION),
          notAnAdmin: await personWith(org, {}),
          deactivatedAdmin: await anAdmin(org, {}, { inactive: true }),
        };
        const stranger = await quietCompany({ keepAdmin: true });
        const strangersAdmin = await anAdmin(stranger.org);

        const { sid } = await door.arrive(org, number, {});
        const rows = await rowsOf(kind, org, sid);

        const told = toldBy(rows);
        expect(told.has(people.adminA.id)).toBe(true);
        expect(told.has(people.adminB.id)).toBe(true);
        // A non-Admin is never the fallback.
        expect(told.has(people.notAnAdmin.id)).toBe(false);
        expect(told.has(people.deactivatedAdmin.id)).toBe(false);
        expect(told.has(strangersAdmin.id)).toBe(false);
        expect(told.has(stranger.admin.id)).toBe(false);
        // One alert, the ordinary one, under the event's own key: the net added nothing.
        expect(rows).toHaveLength(1);
        expect(rows[0]!.dedup_key).toBe(`ctm:${sid}:${door.keyPart}`);
        expectTheOrdinaryAlert(rows[0]!, kind);
        for (const person of [people.adminA, people.adminB]) {
          // Each person is told once.
          expect(rows.flatMap((r) => r.recipients).filter((r) => r.recipient_id === person.id)).toHaveLength(1);
        }
        // The alert is about the call or the conversation, so it opens there.
        for (const row of rows) expect(row.object_type).toBe(kind === 'call' ? 'CALL' : 'MESSAGE_THREAD');
      }, 240_000);

      it('with one other active person on All, tells that person and the Admins, and nobody else, with no reason line', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const holderOfAll = await personWith(org, { communication_scope: 'all' });
        const adminA = await anAdmin(org);
        const linkedElsewhere = await personWith(org, {}, { numbers: [(await addNumber(org)).id] });

        const { sid } = await door.arrive(org, number, {});
        const rows = await rowsOf(kind, org, sid);

        expect(rows).toHaveLength(1);
        expect([...toldBy(rows)].sort()).toEqual([holderOfAll.id, adminA.id].sort());
        expect(toldBy(rows).has(linkedElsewhere.id)).toBe(false);
        expect(everythingOf(rows[0]!)).not.toContain('Nobody is linked');
        expect(rows[0]!.dedup_key).toBe(`ctm:${sid}:${door.keyPart}`);
      }, 240_000);

      it('adds nobody while someone qualifies: a person linked to the number is told with the Admins, and there is no reason line', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const linked = await personWith(org, {}, { numbers: [number.id] });
        const adminA = await anAdmin(org);
        const bystander = await personWith(org, {});

        const { sid } = await door.arrive(org, number, {});
        const rows = await rowsOf(kind, org, sid);

        expect([...toldBy(rows)].sort()).toEqual([linked.id, adminA.id].sort());
        expect(toldBy(rows).has(bystander.id)).toBe(false);
        expect(rows.map((r) => everythingOf(r)).join()).not.toContain('Nobody is linked');
      }, 240_000);

      // The cases about what the net's own alert says (the company number as the app shows it, the time in the company's zone) and
      // about the second alert without caller details went with the Manage roles and permissions switch (AL-18): the net's alerts
      // can no longer be reached, because an active Admin is on All and the ordinary alert reaches them first.

      it('keeps its kind\'s priority: a missed call interrupts and asks for a call back, a text is a feed item', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const adminA = await anAdmin(org);
        const adminB = await anAdmin(org, NO_SECTION);

        const { sid } = await door.arrive(org, number, {});
        const rows = await rowsOf(kind, org, sid);

        const mine = rows.flatMap((r) => r.recipients).filter((r) => [adminA.id, adminB.id].includes(r.recipient_id));
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

      it('covers every empty answer: a conversation tied to a job whose people cannot read it reaches the Admins, not the job\'s people', async () => {
        const { org, customer } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const crewNoJobs = await personWith(org, withDependantsOff(['view_jobs']));
        const job = await fx.addJob(org, customer, { crew: [crewNoJobs.id], soldBy: crewNoJobs.id });
        const adminA = await anAdmin(org);

        const { sid } = await door.arrive(org, number, { jobId: job.id });
        const rows = await rowsOf(kind, org, sid);

        expect(toldBy(rows).has(crewNoJobs.id)).toBe(false);
        expect(toldBy(rows).has(adminA.id)).toBe(true);
        expectTheOrdinaryAlert(rowFor(rows, adminA)!, kind);
      }, 240_000);

      it('tells by no path a person the access filter drops, while an Admin is told whatever their own Communication switches say', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        // Linked to the number but unable to use the section: the filter drops them from the alert. They are no one.
        const linkedNoAccess = await personWith(org, withDependantsOff(['access_communication']), { numbers: [number.id] });
        const adminNoSection = await anAdmin(org, NO_SECTION);

        const { sid } = await door.arrive(org, number, {});
        const rows = await rowsOf(kind, org, sid);

        expect(toldBy(rows).has(linkedNoAccess.id)).toBe(false);
        expect(toldBy(rows).has(adminNoSection.id)).toBe(true);
        expectTheOrdinaryAlert(rowFor(rows, adminNoSection)!, kind);
      }, 240_000);

      // ─── A chain that still finds nobody is logged once, with no customer content ──────────────

      it('writes exactly one log line when there is no active Admin either, carrying the alert, the id and the company and nothing of the customer', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        await anAdmin(org, {}, { inactive: true });
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
        await anAdmin(org);
        const warn = watchLog();

        await door.arrive(org, number, {});

        expect(warn.mock.calls.filter(([message]) => isTheGap(message))).toEqual([]);
      }, 240_000);

      // ─── Duplicates, privacy of the rows ───────────────────────────────────────────────────────

      it('writes nothing twice when the event is delivered again', async () => {
        const { org, customer } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const job = await fx.addJob(org, customer, {});
        await anAdmin(org);
        await anAdmin(org, { jobs_scope: 'all' });
        const sid = `${kind === 'call' ? 'CA' : 'MSG'}-s0824-${randomUUID().slice(0, 12)}`;

        await door.arrive(org, number, { sid, jobId: job.id });
        const first = await rowsOf(kind, org, sid);
        await door.arrive(org, number, { sid });
        await door.arrive(org, number, { sid });
        const after = await rowsOf(kind, org, sid);

        expect(first).toHaveLength(1);
        expect(first.flatMap((r) => r.recipients)).toHaveLength(2);
        expect(after.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
        expect(after.flatMap((r) => r.recipients).length).toBe(first.flatMap((r) => r.recipients).length);
      }, 240_000);

      it('does not add anyone to an event already told, even if a redelivery would find nobody else', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const linked = await personWith(org, {}, { numbers: [number.id] });
        const adminA = await anAdmin(org);
        const sid = `${kind === 'call' ? 'CA' : 'MSG'}-s0824-${randomUUID().slice(0, 12)}`;

        await door.arrive(org, number, { sid });
        await db.userPhoneNumber.deleteMany({ where: { user_id: linked.id } });
        await door.arrive(org, number, { sid });

        const rows = await rowsOf(kind, org, sid);
        expect(rows).toHaveLength(1);
        expect([...toldBy(rows)].sort()).toEqual([linked.id, adminA.id].sort());
      }, 240_000);

      it('does not write a second alert on a redelivery once the Admins were told, even if somebody has been linked since', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const adminA = await anAdmin(org);
        const sid = `${kind === 'call' ? 'CA' : 'MSG'}-s0824-${randomUUID().slice(0, 12)}`;

        await door.arrive(org, number, { sid });
        await personWith(org, {}, { numbers: [number.id] });
        await door.arrive(org, number, { sid });

        const rows = await rowsOf(kind, org, sid);
        expect(rows).toHaveLength(1);
        expect([...toldBy(rows)]).toEqual([adminA.id]);
      }, 240_000);

      it('lets only the person an alert was written for read it: a non-recipient finds the alert by no route', async () => {
        const { org } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        const recipient = await anAdmin(org);
        const bystander = await anAdmin(org);
        const outsider = await personWith(org, {});
        // The second Admin is on the alert too (every Admin is). Take them off it to make them a bystander by hand.
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
        await anAdmin(org);
        const warn = watchLog();

        const { sid } = await door.arrive(org, number, { suppress: true });

        expect(await rowsOf(kind, org, sid)).toEqual([]);
        expect(warn.mock.calls.filter(([message]) => isTheGap(message))).toEqual([]);
      }, 240_000);

      it('raises no alert and no log for a caller on the blocked list: a blocked event never becomes a fallback alert', async () => {
        const { org, admin } = await quietCompany();
        const number = await addNumber(org, { e164: COMPANY_E164 });
        await anAdmin(org);
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
    const adminA = await anAdmin(org);

    const { sid } = await doors.call.arrive(org, number, { status: 'voicemail', jobId: job.id });
    const rows = await rowsOf('call', org, sid);

    const row = rowFor(rows, adminA)!;
    expect(row.title).toMatch(/^Voicemail — Pat Payer/);
    expect(row.title).not.toMatch(/^Missed call/);
    expect(everythingOf(row)).not.toContain(REASON_LINE);
    for (const r of rows) {
      expect(r.priority).toBe('INTERRUPT');
      expect(r.needs_action).toBe(true);
    }
  }, 240_000);

  // The case about a text's preview in the net's second alert went with the Manage roles and permissions switch (AL-18); the
  // ordinary alert's preview is checked by expectTheOrdinaryAlert above.
});
