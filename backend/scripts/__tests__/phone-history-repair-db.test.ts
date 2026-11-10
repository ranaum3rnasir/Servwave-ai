/* =============================================================================
   #3028 (parent #3013, decision 6, Q29): repair a company's phone history (scripts/phone-history-repair.ts).

   A generic one-off tool, run per company with a dry run first, that:
     - re-files the incoming calls on shared numbers by the fixed order (#3015);
     - deletes the fake "ringing" calls a text's events made (#3025's detection).
   It never touches a text (Ran's ruling on #3028: a rule sets a text's lead or job only when it first arrives; a person's
   change always stands). It prints the before-and-after list and writes only with --confirm. A second run changes nothing.

   Real migrated database (TEST_DATABASE_URL; skips when unset). The tool's public entry is run on seeded companies, the
   way a person runs it, and what it printed and wrote is read back. A second company carrying the very same numbers is
   seeded too: the runs name one company and leave the other as it was. A run stopped at any write (a failure injected
   at the database edge, the Prisma client's own query hook) and run again ends as one clean run does.
   Every number is a 555-01xx placeholder.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { runPhoneHistoryRepair } from '../phone-history-repair';
import { lockCallEvents } from '../../src/lib/ctm/ingest';

const { realClient } = (() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) as PrismaClient };
})();

const suite = realClient ? describe : describe.skip;

/** The number two customers share, stored bare the way the customer form stores a phone. */
const SHARED = '5550103002';
const SHARED_E164 = '+15550103002';
/** A number one customer carries alone. */
const SOLO = '5550103004';
/** A number a lead carries as its own, the lead made before the text. */
const OWN_EARLIER = '5550103005';
/** A number a lead carries as its own, the lead made after the text. */
const OWN_LATER = '5550103007';
/** A number nobody carries. */
const NOBODYS_E164 = '+15550103009';
/** Shared numbers where one customer's open lead (or job) carries the number as its own: the fixed order's first step. */
const LEAD_WINS = '5550103101';
const JOB_WINS = '5550103102';
/** A shared number whose own lead was made after the call. */
const OWN_LEAD_LATER = '5550103103';
/** Shared numbers where one other thing that decides the pick came after the call (see the seed). */
const TOOK_NUMBER_LATER = '5550103104';
const LOSER_OWN_LATER = '5550103105';
const WORK_LATER = '5550103106';
const CUSTOMER_LATER = '5550103107';
/** A shared number a lead's own entry took by a correction after the call (the entry first held another number). */
const CORRECTED_LATER = '5550103108';
/** A shared number the picked customer's own phone field took by an edit after the call (dated in its history). */
const FIELD_SAVED_LATER = '5550103110';
/** A shared number the office review wrote into the picked customer's phone-list row in place after the call. */
const LIST_REWRITTEN_LATER = '5550103111';

const at = (iso: string) => new Date(`${iso}Z`);

/** The customers' and records' names: placeholders the tool's output must never print. */
const NAMES = ['Pat', 'Payer', 'Jordan', 'Lee', 'Sam', 'Solo', 'Kit', 'Keeper', 'Robin', 'Holder', 'Alex', 'Owner'];

suite('repair a company\'s phone history: dry run, real run, and a second run that changes nothing (real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];
  const sids: string[] = [];
  let sequence = 0;

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    const inOrgs = orgs.map((o) => `'${o}'`).join(', ');
    if (orgs.length) {
      for (const table of ['call_sessions', 'messages', 'message_threads', 'record_contact_entries', 'jobs', 'leads', 'timeline_events']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id IN (${inOrgs})`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM service_locations WHERE customer_id IN (SELECT id FROM customers WHERE organization_id IN (${inOrgs}))`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM customers WHERE organization_id IN (${inOrgs})`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id IN (${inOrgs})`));
      await quietly(db.organization.deleteMany({ where: { id: { in: orgs } } }));
    }
    if (sids.length) await quietly(db.ctmEvent.deleteMany({ where: { ctm_event_id: { in: sids.flatMap((s) => [`${s}:starts`, `${s}:end`]) } } }));
    await db.$disconnect();
  });

  async function seedOrg() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const account = `3028${++sequence}${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `repair-${tag}`, email: `repair-${tag}@example.test`, ctm_account_id: account,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    await db.phoneNumber.create({
      data: { organization_id: org, e164: `+1555010${String(sequence).padStart(4, '0')}`.slice(0, 12), is_org_default: true, status: 'active', sms_enabled: true },
    });
    return { org, tag, account };
  }
  type Org = Awaited<ReturnType<typeof seedOrg>>;

  async function customer(
    org: string, first: string, last: string, created: string, phone: string | null, opts: { archived?: string } = {},
  ) {
    const id = randomUUID();
    await db.customer.create({
      data: {
        id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: first, last_name: last, phone, created_at: at(created),
        ...(opts.archived ? { is_active: false, archived_at: at(opts.archived) } : {}),
      },
    });
    return id;
  }

  /**
   * A lead; with `ownPhone`, the lead carries that number as its own, added when the lead was made (an entry is stamped
   * made and last changed at once, as the add does).
   */
  async function lead(org: string, customerId: string, created: string, opts: { status?: 'NEW' | 'LOST'; ownPhone?: string } = {}) {
    const id = randomUUID();
    const lost = opts.status === 'LOST';
    await db.lead.create({
      data: {
        id, organization_id: org, customer_id: customerId, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door',
        status: opts.status ?? 'NEW', created_at: at(created),
        lost_at: lost ? at(created) : null, lost_reason: lost ? 'Went elsewhere' : null,
      },
    });
    if (opts.ownPhone) {
      await db.recordContactEntry.create({
        data: {
          organization_id: org, lead_id: id, kind: 'PHONE', intent: 'ADDED', value: opts.ownPhone,
          created_at: at(created), updated_at: at(created),
        },
      });
    }
    return id;
  }

  /** An open job; with `ownPhone`, the job carries that number as its own, added when the job was made. */
  async function job(org: string, customerId: string, created: string, opts: { ownPhone?: string } = {}) {
    const id = randomUUID();
    const location = randomUUID();
    await db.serviceLocation.create({ data: { id: location, customer_id: customerId, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' } });
    await db.job.create({
      data: {
        id, organization_id: org, customer_id: customerId, service_location_id: location, job_number: `J-${id.slice(0, 8)}`,
        status: 'UNSCHEDULED', created_at: at(created),
      },
    });
    if (opts.ownPhone) {
      await db.recordContactEntry.create({
        data: {
          organization_id: org, job_id: id, kind: 'PHONE', intent: 'ADDED', value: opts.ownPhone,
          created_at: at(created), updated_at: at(created),
        },
      });
    }
    return { id, number: `J-${id.slice(0, 8)}` };
  }

  /** The customer's history line a save of its details writes: which fields were saved, and when. */
  async function customerSaved(org: string, customerId: string, when: string, fields: string[], via?: 'office_review') {
    await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'CUSTOMER', entity_id: customerId, event_type: 'CUSTOMER_UPDATED',
        description: 'Customer details updated', metadata: { fields, ...(via ? { via } : {}) }, created_at: at(when),
      },
    });
  }

  async function conversation(org: string, otherParty: string, customerId: string | null) {
    return (await db.messageThread.create({
      data: { organization_id: org, channel: 'sms', campaign_type: 'customer_care', customer_id: customerId, other_party_e164: otherParty },
    })).id;
  }

  async function text(
    org: string, threadId: string, direction: 'in' | 'out', ts: string,
    opts: { lead?: string; job?: string; status?: string; from?: string } = {},
  ) {
    return (await db.message.create({
      data: {
        organization_id: org, thread_id: threadId, direction, body: 'Words', ts: at(ts),
        status: opts.status ?? (direction === 'in' ? 'received' : 'delivered'),
        lead_id: opts.lead ?? null, job_id: opts.job ?? null, job_label: opts.job ? 'J-label' : null,
        other_party_e164: opts.from ?? null,
      },
    })).id;
  }

  async function call(
    org: string, started: string,
    opts: { direction?: 'in' | 'out'; number: string; status?: string; customer?: string; lead?: string; sid?: string },
  ) {
    const direction = opts.direction ?? 'in';
    return (await db.callSession.create({
      data: {
        organization_id: org, direction, status: opts.status ?? 'completed', started_at: at(started),
        from_number: direction === 'in' ? opts.number : '+15550100100', to_number: direction === 'in' ? '+15550100100' : opts.number,
        answered_by: { kind: 'none' }, customer_id: opts.customer ?? null, lead_id: opts.lead ?? null, ctm_call_id: opts.sid ?? null,
      },
    })).id;
  }

  /** An event the phone system stored for a call's sid, as the webhook stores it. */
  async function storedEvent(sid: string, position: 'starts' | 'end', payload: Record<string, unknown>) {
    await db.ctmEvent.create({ data: { ctm_event_id: `${sid}:${position}`, event_type: position, payload: payload as object } });
  }

  /**
   * The test day, on a seeded company. Two customers share (555) 010-3002: Pat Payer, made in 2022 with no open work, and
   * Jordan Lee, made this October with an open lead. The conversation for the number was filed on the older one, and so
   * were the calls.
   */
  async function seedTestDay(o: Org) {
    const { org } = o;
    const older = await customer(org, 'Pat', 'Payer', '2022-03-01T09:00:00', SHARED);
    const newer = await customer(org, 'Jordan', 'Lee', '2026-10-01T09:00:00', SHARED);
    const newerLead = await lead(org, newer, '2026-10-29T09:00:00');
    const olderLostLead = await lead(org, older, '2022-04-01T09:00:00', { status: 'LOST' });
    const solo = await customer(org, 'Sam', 'Solo', '2025-01-01T09:00:00', SOLO);
    const keeper = await customer(org, 'Kit', 'Keeper', '2025-02-01T09:00:00', null);
    const ownLeadEarlier = await lead(org, keeper, '2026-10-20T09:00:00', { ownPhone: OWN_EARLIER });
    const ownLeadLater = await lead(org, keeper, '2026-11-01T09:00:00', { ownPhone: OWN_LATER });
    const { id: keeperJob } = await job(org, keeper, '2026-10-15T09:00:00');

    // The shared number's conversation: the lead's text, the phone system's opt-in confirmation (no lead), two replies.
    const shared = await conversation(org, SHARED_E164, older);
    await text(org, shared, 'out', '2026-10-30T10:00:00', { lead: newerLead, from: SHARED_E164 });
    await text(org, shared, 'out', '2026-10-30T10:01:00', { from: SHARED_E164 });
    const reply1 = await text(org, shared, 'in', '2026-10-30T10:05:00', { from: SHARED_E164 });
    const reply2 = await text(org, shared, 'in', '2026-10-30T10:06:00', { from: SHARED_E164 });
    // A reply a person already tied (to the older customer's lost lead): never re-tied.
    const tiedByAPerson = await text(org, shared, 'in', '2026-10-30T10:07:00', { lead: olderLostLead, from: SHARED_E164 });
    // A number nobody carries, no text sent to it: stays untied.
    const nobodys = await conversation(org, NOBODYS_E164, null);
    const nobodysText = await text(org, nobodys, 'in', '2026-10-30T10:08:00', { from: NOBODYS_E164 });
    // A reply from the number a lead made before it carries as its own: takes that lead.
    const ownEarlier = await conversation(org, `+1${OWN_EARLIER}`, keeper);
    const ownEarlierText = await text(org, ownEarlier, 'in', '2026-10-30T10:09:00', { from: `+1${OWN_EARLIER}` });
    // A reply from the number a lead made AFTER it carries as its own: that lead did not exist when it came in.
    const ownLater = await conversation(org, `+1${OWN_LATER}`, keeper);
    const ownLaterText = await text(org, ownLater, 'in', '2026-10-30T10:10:00', { from: `+1${OWN_LATER}` });
    // A job's text and its reply.
    const jobConversation = await conversation(org, '+15550103011', keeper);
    await text(org, jobConversation, 'out', '2026-10-30T10:02:00', { job: keeperJob, from: '+15550103011' });
    const jobReply = await text(org, jobConversation, 'in', '2026-10-30T10:11:00', { from: '+15550103011' });
    // A reply the rule tied to the job when it came in, and a person then took off it (an untie leaves no trace).
    const untiedByAPerson = await text(org, jobConversation, 'in', '2026-10-30T10:12:00', { job: keeperJob, from: '+15550103011' });
    await db.message.update({ where: { id: untiedByAPerson }, data: { job_id: null, job_label: null } });

    // Calls. An incoming call on the shared number, filed on the older customer: the fixed order files it on the newer one.
    const misfiledCall = await call(org, '2026-10-30T10:20:00', { number: SHARED_E164, customer: older, sid: `CA3028${o.tag}moved` });
    // An incoming call on a number one customer carries alone, filed on another customer: not a shared number, never moved.
    const soloNumberCall = await call(org, '2026-10-30T10:21:00', { number: `+1${SOLO}`, customer: older });
    // A call we placed to the shared number from the older customer's page: a placed call stays where it was placed.
    const placedCall = await call(org, '2026-10-30T10:22:00', { direction: 'out', number: SHARED_E164, customer: older });
    // An incoming call a person attached to a lead: it keeps its lead and its customer.
    const attachedCall = await call(org, '2026-10-30T10:23:00', { number: SHARED_E164, customer: older, lead: olderLostLead });
    // An incoming call from before the newer customer was made: the fixed order could not have picked them then.
    const earlierCall = await call(org, '2026-09-01T10:00:00', { number: SHARED_E164, customer: older });

    // The fixed order's first step: the one open lead or job carrying the number as its own decides the pick, and the call
    // is filed on that record and its customer. Robin Holder carries each number on her customer record; Alex Owner's
    // record carries it as its own, made before the call.
    const leadNumberHolder = await customer(org, 'Robin', 'Holder', '2024-01-01T09:00:00', LEAD_WINS);
    const leadOwner = await customer(org, 'Alex', 'Owner', '2024-02-01T09:00:00', null);
    const ownLead = await lead(org, leadOwner, '2026-10-10T09:00:00', { ownPhone: LEAD_WINS });
    // Alex opens an unrelated job after the call. It does not decide the pick: the one open lead carrying the number as its
    // own decided it then and decides it now (the newest open work is never reached), so the call still moves.
    await job(org, leadOwner, '2026-11-04T09:00:00');
    const callOntoOwnLead = await call(org, '2026-10-30T10:40:00', { number: `+1${LEAD_WINS}`, customer: leadNumberHolder, sid: `CA3028${o.tag}lead` });
    const jobNumberHolder = await customer(org, 'Robin', 'Holder', '2024-01-01T09:00:00', JOB_WINS);
    const jobOwner = await customer(org, 'Alex', 'Owner', '2024-02-01T09:00:00', null);
    const ownJob = await job(org, jobOwner, '2026-10-12T09:00:00', { ownPhone: JOB_WINS });
    const callOntoOwnJob = await call(org, '2026-10-30T10:41:00', { number: `+1${JOB_WINS}`, customer: jobNumberHolder });
    // The same, but the lead carrying the number as its own was made after the call: the live rule could not have picked it.
    const laterNumberHolder = await customer(org, 'Robin', 'Holder', '2024-01-01T09:00:00', OWN_LEAD_LATER);
    const laterLeadOwner = await customer(org, 'Alex', 'Owner', '2024-02-01T09:00:00', null);
    const ownLeadMadeLater = await lead(org, laterLeadOwner, '2026-11-01T09:00:00', { ownPhone: OWN_LEAD_LATER });
    const callBeforeItsOwnLead = await call(org, '2026-10-30T10:42:00', { number: `+1${OWN_LEAD_LATER}`, customer: laterNumberHolder });

    // Each of these calls would move by today's fixed order, but ONE thing that decides the pick came after the call.
    // The customer the order picks added the number to its phone list after the call (its open lead is older).
    const tookNumberHolder = await customer(org, 'Robin', 'Holder', '2024-01-01T09:00:00', TOOK_NUMBER_LATER);
    const tookNumberLater = await customer(org, 'Alex', 'Owner', '2024-02-01T09:00:00', null);
    await db.customerPhone.create({ data: { customer_id: tookNumberLater, phone: TOOK_NUMBER_LATER, created_at: at('2026-11-02T09:00:00') } });
    await lead(org, tookNumberLater, '2026-10-05T09:00:00');
    const callBeforeNumberTaken = await call(org, '2026-10-30T10:44:00', { number: `+1${TOOK_NUMBER_LATER}`, customer: tookNumberHolder });
    // An archived customer's lead took the number as its own after the call: two own leads now, so neither decides the pick
    // and the call would lose the lead that was the one when it came in.
    const loserNumberHolder = await customer(org, 'Robin', 'Holder', '2024-01-01T09:00:00', LOSER_OWN_LATER);
    const loserOwner = await customer(org, 'Alex', 'Owner', '2024-02-01T09:00:00', null);
    await lead(org, loserOwner, '2026-10-10T09:00:00', { ownPhone: LOSER_OWN_LATER });
    const archivedOwner = await customer(org, 'Kit', 'Keeper', '2024-03-01T09:00:00', null, { archived: '2026-01-01T09:00:00' });
    await lead(org, archivedOwner, '2026-11-03T09:00:00', { ownPhone: LOSER_OWN_LATER });
    const callBeforeSecondOwnLead = await call(org, '2026-10-30T10:45:00', { number: `+1${LOSER_OWN_LATER}`, customer: loserNumberHolder });
    // The older customer's open job, made after the call, makes it the newest open work (the verifier's case): when the
    // call came in, the newest customer was the pick, and the call is on it.
    const workLaterOwner = await customer(org, 'Robin', 'Holder', '2024-01-01T09:00:00', WORK_LATER);
    await job(org, workLaterOwner, '2026-11-04T09:00:00');
    const workLaterNewest = await customer(org, 'Alex', 'Owner', '2025-06-01T09:00:00', WORK_LATER);
    const callBeforeTheWork = await call(org, '2026-10-30T10:46:00', { number: `+1${WORK_LATER}`, customer: workLaterNewest });
    // The newest customer, the pick by the last step, was made after the call.
    const customerLaterHolder = await customer(org, 'Robin', 'Holder', '2024-01-01T09:00:00', CUSTOMER_LATER);
    await customer(org, 'Alex', 'Owner', '2026-11-05T09:00:00', CUSTOMER_LATER);
    const callBeforeTheCustomer = await call(org, '2026-10-30T10:47:00', { number: `+1${CUSTOMER_LATER}`, customer: customerLaterHolder });
    // The open lead carrying the number as its own took it by a correction after the call: its entry was added with another
    // number when the lead was made, and a person corrected it to this one after the call (a correction rewrites the entry in
    // place and stamps updated_at, as the contact-entry correction does). When the call came in, the lead did not carry it.
    const correctedNumberHolder = await customer(org, 'Robin', 'Holder', '2024-01-01T09:00:00', CORRECTED_LATER);
    const correctedOwner = await customer(org, 'Alex', 'Owner', '2024-02-01T09:00:00', null);
    const correctedLead = await lead(org, correctedOwner, '2026-10-10T09:00:00', { ownPhone: '5550103180' });
    await db.recordContactEntry.updateMany({
      where: { lead_id: correctedLead }, data: { value: CORRECTED_LATER, updated_at: at('2026-11-02T09:00:00') },
    });
    const callBeforeTheCorrection = await call(org, '2026-10-30T10:48:00', { number: `+1${CORRECTED_LATER}`, customer: correctedNumberHolder });
    // The customer the order picks (its open lead is the newest work) took the number on its own phone field by an edit after
    // the call: the field keeps no date, but the customer's history dates the save of its phone.
    const fieldSavedHolder = await customer(org, 'Robin', 'Holder', '2024-01-01T09:00:00', FIELD_SAVED_LATER);
    const fieldSavedOwner = await customer(org, 'Alex', 'Owner', '2024-02-01T09:00:00', FIELD_SAVED_LATER);
    await lead(org, fieldSavedOwner, '2026-10-05T09:00:00');
    await customerSaved(org, fieldSavedOwner, '2026-11-02T09:00:00', ['first_name', 'phone', 'phone_ext']);
    const callBeforeTheFieldSave = await call(org, '2026-10-30T10:49:00', { number: `+1${FIELD_SAVED_LATER}`, customer: fieldSavedHolder });
    // The same with its phone list: the office review replaced the number on a row made in 2024 by this one after the call.
    // The row keeps its making date, but the customer's history dates the review's write to its phone list.
    const listRewrittenHolder = await customer(org, 'Robin', 'Holder', '2024-01-01T09:00:00', LIST_REWRITTEN_LATER);
    const listRewrittenOwner = await customer(org, 'Alex', 'Owner', '2024-02-01T09:00:00', null);
    await db.customerPhone.create({ data: { customer_id: listRewrittenOwner, phone: LIST_REWRITTEN_LATER, created_at: at('2024-03-01T09:00:00') } });
    await lead(org, listRewrittenOwner, '2026-10-05T09:00:00');
    await customerSaved(org, listRewrittenOwner, '2026-11-02T09:00:00', ['phones'], 'office_review');
    const callBeforeTheListRewrite = await call(org, '2026-10-30T10:50:00', { number: `+1${LIST_REWRITTEN_LATER}`, customer: listRewrittenHolder });

    // Calls a text's events made (#3025's detection: the stored event carries a message id or a message direction).
    const sid = (name: string) => { const made = `CA3028${o.tag}${name}`; sids.push(made); return made; };
    const fakeSid1 = sid('fake1');
    const fakeFromIncomingText = await call(org, '2026-10-30T10:05:00', { number: SHARED_E164, customer: older, status: 'ringing', sid: fakeSid1 });
    await storedEvent(fakeSid1, 'starts', { sid: fakeSid1, message_id: `MSG${fakeSid1}`, direction: 'msg_inbound', caller_number: SHARED_E164, account_id: o.account });
    const fakeSid2 = sid('fake2');
    const fakeFromOutgoingText = await call(org, '2026-10-30T10:01:00', { number: SHARED_E164, status: 'ringing', sid: fakeSid2 });
    await storedEvent(fakeSid2, 'starts', { call: { sid: fakeSid2, direction: 'msg_outbound', called_number: SHARED_E164, account_id: o.account } });
    // A call a text's end event made, not ringing: left as it is, and counted.
    const textSid3 = sid('text3');
    const textMadeNotRinging = await call(org, '2026-10-30T10:06:00', { number: SHARED_E164, status: 'completed', sid: textSid3 });
    await storedEvent(textSid3, 'end', { sid: textSid3, message_id: `MSG${textSid3}`, direction: 'msg_inbound', caller_number: SHARED_E164, account_id: o.account });
    // A real call still ringing: its event is a call's. Never deleted.
    const realSid = sid('real1');
    const realRingingCall = await call(org, '2026-10-30T10:30:00', { number: `+1${SOLO}`, customer: solo, status: 'ringing', sid: realSid });
    await storedEvent(realSid, 'starts', { sid: realSid, direction: 'inbound', caller_number: `+1${SOLO}`, account_id: o.account });
    // A ringing call with no stored event: nothing shows a text made it. Never deleted.
    const ringingWithoutEvent = await call(org, '2026-10-30T10:31:00', { number: `+1${SOLO}`, customer: solo, status: 'ringing', sid: sid('real2') });

    return {
      fakeFromIncomingText, fakeFromOutgoingText, textMadeNotRinging, realRingingCall, ringingWithoutEvent,
      misfiledCall, soloNumberCall, placedCall, attachedCall, earlierCall,
      callOntoOwnLead, leadNumberHolder, leadOwner, ownLead, callOntoOwnJob, jobNumberHolder, jobOwner, ownJob,
      callBeforeItsOwnLead, laterNumberHolder, laterLeadOwner, ownLeadMadeLater,
      callBeforeNumberTaken, tookNumberHolder, callBeforeSecondOwnLead, loserNumberHolder, callBeforeTheWork, workLaterNewest,
      callBeforeTheCustomer, customerLaterHolder, callBeforeTheCorrection, correctedNumberHolder,
      callBeforeTheFieldSave, fieldSavedHolder, callBeforeTheListRewrite, listRewrittenHolder,
      older, newer, newerLead, olderLostLead, solo, keeper, ownLeadEarlier, ownLeadLater, keeperJob,
      reply1, reply2, tiedByAPerson, nobodysText, ownEarlierText, ownLaterText, jobReply, untiedByAPerson,
    };
  }
  type Seeded = Awaited<ReturnType<typeof seedTestDay>>;

  const lines: string[] = [];
  const print = (line: string) => { lines.push(line); };
  async function run(argv: string[], client: PrismaClient = db) {
    lines.length = 0;
    const result = await runPhoneHistoryRepair(argv, { prisma: client, print });
    return { result, output: [...lines] };
  }

  /** What a person sees of each seeded text: its lead and job. */
  async function textsOf(o: Org) {
    const rows = await db.message.findMany({ where: { organization_id: o.org, direction: 'in' }, select: { id: true, lead_id: true, job_id: true } });
    return Object.fromEntries(rows.map((r) => [r.id, { lead: r.lead_id, job: r.job_id }]));
  }

  /** Every column of every text of the companies this file made: the whole of what a run could change on a text. */
  async function textRows() {
    return db.message.findMany({ where: { organization_id: { in: [...orgs] } }, orderBy: { id: 'asc' } });
  }

  /** Where each seeded call is filed, with the job number the call shows (a deleted call is absent). */
  async function callsOf(o: Org) {
    const rows = await db.callSession.findMany({
      where: { organization_id: o.org }, select: { id: true, customer_id: true, lead_id: true, job_id: true, job_label: true },
    });
    return Object.fromEntries(rows.map((r) => [r.id, { customer: r.customer_id, lead: r.lead_id, job: r.job_id, jobLabel: r.job_label }]));
  }
  /** A call filed on a customer alone, or with a lead, as `callsOf` reads it. */
  const onCustomer = (customer: string | null, lead: string | null = null) => ({ customer, lead, job: null, jobLabel: null });

  /** What an arriving text or call may set off: alerts, timeline entries, automations, unread counts, lead statuses. */
  async function sideEffectsOf(o: Org) {
    const where = { organization_id: o.org };
    return {
      alerts: await db.notification.count({ where }),
      timeline: await db.timelineEvent.count({ where }),
      automations: await db.workflowEnrollment.count({ where }),
      unread: (await db.messageThread.findMany({ where, select: { id: true, unread: true }, orderBy: { id: 'asc' } })),
      leads: (await db.lead.findMany({ where, select: { id: true, status: true }, orderBy: { id: 'asc' } })),
    };
  }

  let A: Org;
  let B: Org;
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    A = await seedOrg();
    B = await seedOrg();
    a = await seedTestDay(A);
    b = await seedTestDay(B);
  }, 120_000);

  /** The before-and-after list a run prints for a seeded test day: exactly these moves, nothing else. */
  const expectedList = (x: Seeded) => [
    `    call ${x.misfiledCall} started 2026-10-30T10:20:00.000Z: customer ${x.older} -> customer ${x.newer}`,
    `    call ${x.callOntoOwnLead} started 2026-10-30T10:40:00.000Z: customer ${x.leadNumberHolder} -> customer ${x.leadOwner}, lead ${x.ownLead}`,
    `    call ${x.callOntoOwnJob} started 2026-10-30T10:41:00.000Z: customer ${x.jobNumberHolder} -> customer ${x.jobOwner}, job ${x.ownJob.id}`,
    `    call ${x.fakeFromOutgoingText} started 2026-10-30T10:01:00.000Z: ringing -> deleted`,
    `    call ${x.fakeFromIncomingText} started 2026-10-30T10:05:00.000Z: ringing -> deleted`,
  ];
  /** Why a call is left as it is: what decides the fixed order's pick was made after the call. */
  const PICKED_MADE_LATER = 'the customer the fixed order picks was made after the call';
  // What dates the picked customer's carrying of the number: its own phone fields by its history's last save of them, a
  // phone-list row by when it was saved or (the office review) rewritten, a lead's or job's own entry by the later of its
  // making and its last correction.
  const PICKED_NUMBER_ON_LIST_LATER =
    'the customer the fixed order picks carries the number only on its phone list, saved or rewritten after the call';
  const PICKED_NUMBER_ON_ENTRY_LATER =
    'the customer the fixed order picks carries the number only on a lead\'s or job\'s own entry, made or corrected after the call';
  const PICKED_NUMBER_ON_FIELDS_LATER = 'the customer the fixed order picks carries the number only on its own phone fields, saved after the call';
  const OWN_RECORD_LATER =
    'an open lead or job carrying the number as its own was made after the call, or its entry of the number was made or corrected after it';
  const PICKED_WORK_LATER = 'an open lead or job of the customer the fixed order picks was made after the call';

  /** The calls a run on a seeded test day leaves as they are, each by id with the reason, in the order they started. */
  const expectedLeft = (x: Seeded) => [
    '  Left as they are - calls on a shared number the fixed order would file elsewhere, but something that decides the pick was made after the call: 9',
    `    call ${x.earlierCall} started 2026-09-01T10:00:00.000Z: ${PICKED_MADE_LATER}; ${PICKED_WORK_LATER}`,
    `    call ${x.callBeforeItsOwnLead} started 2026-10-30T10:42:00.000Z: ${PICKED_NUMBER_ON_ENTRY_LATER}; ${OWN_RECORD_LATER}`,
    `    call ${x.callBeforeNumberTaken} started 2026-10-30T10:44:00.000Z: ${PICKED_NUMBER_ON_LIST_LATER}`,
    `    call ${x.callBeforeSecondOwnLead} started 2026-10-30T10:45:00.000Z: ${OWN_RECORD_LATER}`,
    `    call ${x.callBeforeTheWork} started 2026-10-30T10:46:00.000Z: ${PICKED_WORK_LATER}`,
    `    call ${x.callBeforeTheCustomer} started 2026-10-30T10:47:00.000Z: ${PICKED_MADE_LATER}`,
    `    call ${x.callBeforeTheCorrection} started 2026-10-30T10:48:00.000Z: ${PICKED_NUMBER_ON_ENTRY_LATER}; ${OWN_RECORD_LATER}`,
    `    call ${x.callBeforeTheFieldSave} started 2026-10-30T10:49:00.000Z: ${PICKED_NUMBER_ON_FIELDS_LATER}`,
    `    call ${x.callBeforeTheListRewrite} started 2026-10-30T10:50:00.000Z: ${PICKED_NUMBER_ON_LIST_LATER}`,
    '  Left as they are - calls a text\'s events made that are not ringing: 1',
    `    call ${x.textMadeNotRinging} started 2026-10-30T10:06:00.000Z: a text's events made it, and it is not ringing`,
  ];
  /** What a run printed under its "Left as they are" headings. */
  const leftAsTheyAre = (output: string[]) => {
    const from = output.findIndex((l) => l.startsWith('  Left as they are'));
    return from < 0 ? [] : output.slice(from).filter((l) => !l.startsWith('Company ') && !l.includes('changed since the list: 0'));
  };

  /** The moves a run printed: each call listed with where it goes. */
  const moves = (output: string[]) => output.filter((l) => l.startsWith('    ') && l.includes(' -> '));

  it('a dry run prints exactly the expected moves, naming ids only: no customer name, no phone number, no vendor', async () => {
    const { output } = await run(['--org', A.org]);

    expect(moves(output)).toEqual(expectedList(a));
    const printed = output.join('\n');
    for (const name of NAMES) expect(printed).not.toContain(name);
    expect(printed).not.toMatch(/555-?01|5550\d{6}/);
    expect(printed).not.toMatch(/ctm|calltrackingmetrics|supabase|render|twilio/i);
  });

  it('refuses to run without a company, or with a company that is not an id, and writes nothing', async () => {
    const before = { texts: await textsOf(A), calls: await callsOf(A) };

    expect((await run(['--confirm'])).result).toEqual({ ok: false, error: 'Name the companies with --org <id> (repeatable), or pass --all.' });
    expect((await run(['--org', 'the-pilot', '--confirm'])).result.ok).toBe(false);
    expect((await run(['--org', A.org, '--all', '--confirm'])).result).toEqual({ ok: false, error: 'Pass either --org <id> or --all, not both.' });
    expect((await run(['--orgs', A.org, '--confirm'])).result.ok).toBe(false);

    expect({ texts: await textsOf(A), calls: await callsOf(A) }).toEqual(before);
  });

  it('a dry run lists each incoming call on a shared number the fixed order files on another customer, from and to, and writes nothing', async () => {
    const before = await callsOf(A);

    const { output } = await run(['--org', A.org]);

    expect(output).toEqual(expect.arrayContaining([
      '  Incoming calls on a shared number re-filed by the fixed order (to be): 3',
      `    call ${a.misfiledCall} started 2026-10-30T10:20:00.000Z: customer ${a.older} -> customer ${a.newer}`,
      `    call ${a.callOntoOwnLead} started 2026-10-30T10:40:00.000Z: customer ${a.leadNumberHolder} -> customer ${a.leadOwner}, lead ${a.ownLead}`,
      `    call ${a.callOntoOwnJob} started 2026-10-30T10:41:00.000Z: customer ${a.jobNumberHolder} -> customer ${a.jobOwner}, job ${a.ownJob.id}`,
    ]));
    for (const kept of [a.soloNumberCall, a.placedCall, a.attachedCall]) {
      expect(output.join('\n')).not.toContain(kept);
    }
    expect(await callsOf(A)).toEqual(before);
  });

  it('a dry run lists each fake ringing call a text\'s events made, to delete, and writes nothing', async () => {
    const before = await callsOf(A);

    const { output } = await run(['--org', A.org]);

    expect(output).toEqual(expect.arrayContaining([
      '  Fake ringing calls a text\'s events made, deleted (to be): 2',
      `    call ${a.fakeFromOutgoingText} started 2026-10-30T10:01:00.000Z: ringing -> deleted`,
      `    call ${a.fakeFromIncomingText} started 2026-10-30T10:05:00.000Z: ringing -> deleted`,
    ]));
    // A call a text made is not a call on the shared number: it is never re-filed.
    expect(output).toEqual(expect.arrayContaining(['  Incoming calls on a shared number re-filed by the fixed order (to be): 3']));
    for (const kept of [a.realRingingCall, a.ringingWithoutEvent]) {
      expect(output.join('\n')).not.toContain(kept);
    }
    expect(await callsOf(A)).toEqual(before);
  });

  it('a dry run lists every call it leaves as it is by id, with the reason: whatever decides the pick that was made after the call', async () => {
    // Ruling (Ran, 2026-11-06): if anything that decides the fixed order's pick (the customer, its number, a lead or job in
    // the order) was made after the call, the call is left as it is and listed by id with the reason.
    const before = await callsOf(A);

    const { output } = await run(['--org', A.org]);

    expect(leftAsTheyAre(output)).toEqual(expectedLeft(a));
    expect(await callsOf(A)).toEqual(before);
  });

  it('with --all, a dry run lists every company, each with its own moves and the calls it leaves, and writes nothing', async () => {
    const before = { a: await callsOf(A), b: await callsOf(B) };

    const { result, output } = await run(['--all']);

    expect(output[0]).toBe('Phone history repair - every company');
    /** What the run printed for one company: from its line to the next company's. */
    const section = (org: string) => {
      const from = output.indexOf(`Company ${org}`);
      const next = output.findIndex((l, i) => i > from && l.startsWith('Company '));
      return from < 0 ? [] : output.slice(from, next < 0 ? undefined : next);
    };
    for (const [o, x] of [[A, a], [B, b]] as const) {
      expect(moves(section(o.org))).toEqual(expectedList(x));
      expect(leftAsTheyAre(section(o.org))).toEqual(expectedLeft(x));
    }
    expect(result.ok && result.companies.map((c) => c.orgId)).toEqual(expect.arrayContaining([A.org, B.org]));
    expect({ a: await callsOf(A), b: await callsOf(B) }).toEqual(before);
  });

  it('a call a person changes between the list and the write is left as the person left it, and listed by id', async () => {
    const o = await seedOrg();
    const x = await seedTestDay(o);
    // A person attaches the first listed call to a lead after the list was made, just before the run writes it.
    let attached = false;
    const client = db.$extends({
      query: {
        callSession: {
          async updateMany({ args, query }) {
            if (!attached) {
              attached = true;
              await db.callSession.update({ where: { id: x.misfiledCall }, data: { lead_id: x.olderLostLead } });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const { output } = await run(['--org', o.org, '--confirm'], client);

    expect(output.slice(output.indexOf('  Left as they are - changed since the list: 1'))).toEqual([
      '  Left as they are - changed since the list: 1',
      `    call ${x.misfiledCall} started 2026-10-30T10:20:00.000Z: it changed since the list`,
    ]);
    expect((await callsOf(o))[x.misfiledCall]).toEqual(onCustomer(x.older, x.olderLostLead));
  });

  it('waits for a live event of a call that holds the call\'s lock, and leaves the call as that event left it, listed by id', async () => {
    const o = await seedOrg();
    const x = await seedTestDay(o);
    // A live event of the first listed call is being filed: it holds the call's lock (the one the call ingest takes for every
    // event) and puts the call on a lead before it lets go.
    let letGo!: () => void;
    const mayLetGo = new Promise<void>((resolve) => { letGo = resolve; });
    let holding!: () => void;
    const lockHeld = new Promise<void>((resolve) => { holding = resolve; });
    const liveEvent = db.$transaction(async (tx) => {
      await lockCallEvents(tx, `CA3028${o.tag}moved`);
      holding();
      await mayLetGo;
      await tx.callSession.update({ where: { id: x.misfiledCall }, data: { lead_id: x.olderLostLead } });
    }, { timeout: 60_000 });
    await lockHeld;

    let finished = false;
    const repair = run(['--org', o.org, '--confirm']).finally(() => { finished = true; });
    // The event lets go once the repair waits on a lock, or once the repair finished without waiting.
    const waitingOnALock = async () => (await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0].n > 0;
    while (!finished && !(await waitingOnALock())) await new Promise((resolve) => setTimeout(resolve, 50));
    letGo();
    await liveEvent;
    const { output } = await repair;

    expect(output.slice(output.indexOf('  Left as they are - changed since the list: 1'))).toEqual([
      '  Left as they are - changed since the list: 1',
      `    call ${x.misfiledCall} started 2026-10-30T10:20:00.000Z: it changed since the list`,
    ]);
    expect((await callsOf(o))[x.misfiledCall]).toEqual(onCustomer(x.older, x.olderLostLead));
  }, 60_000);

  it('never touches a text: untied replies the reply rule would tie, and texts a person tied or untied, stay exactly as they are, dry and real', async () => {
    // #3028 ruling (Ran, 2026-11-06): a rule sets a text's lead or job only when the text first arrives; a person's change
    // always stands. The seeded day holds four untied replies the reply rule (#3020) would tie, a reply a person tied to
    // another lead, and a reply a person took off its job.
    const p = await seedOrg();
    const x = await seedTestDay(p);
    const before = await textRows();
    // The day's eleven texts: three we sent, eight replies.
    expect(before.filter((t) => t.organization_id === p.org)).toHaveLength(11);
    expect(before.map((t) => t.id)).toEqual(expect.arrayContaining([x.reply1, x.reply2, x.ownEarlierText, x.jobReply, x.tiedByAPerson, x.untiedByAPerson]));

    const dry = await run(['--org', p.org]);
    expect(await textRows()).toEqual(before);

    const real = await run(['--org', p.org, '--confirm']);
    expect(await textRows()).toEqual(before);

    for (const { output } of [dry, real]) {
      expect(output).toContain('Texts are never touched: a person\'s change to a text\'s lead or job always stands.');
      for (const t of before) expect(output.join('\n')).not.toContain(t.id);
    }
  });

  const WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

  /**
   * The database as the tool sees it, with a failure injected at the database edge (Prisma's own query hook): the write
   * numbered `failAt` throws, as a dropped connection would, and every write is counted.
   */
  function databaseFailingAt(failAt: number | null) {
    const seen = { writes: 0 };
    const client = db.$extends({
      query: {
        $allModels: {
          async $allOperations({ operation, args, query }) {
            if (WRITES.has(operation)) {
              seen.writes += 1;
              if (seen.writes === failAt) throw new Error(`connection lost at write ${failAt}`);
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    return { client, seen };
  }

  /** A seeded test day once repaired: what each text and call reads. */
  async function repairedAsExpected(o: Org, x: Seeded) {
    // Every text as it was seeded: the repair never touches a text.
    expect(await textsOf(o)).toEqual({
      [x.reply1]: { lead: null, job: null },
      [x.reply2]: { lead: null, job: null },
      [x.tiedByAPerson]: { lead: x.olderLostLead, job: null },
      [x.nobodysText]: { lead: null, job: null },
      [x.ownEarlierText]: { lead: null, job: null },
      [x.ownLaterText]: { lead: null, job: null },
      [x.jobReply]: { lead: null, job: null },
      [x.untiedByAPerson]: { lead: null, job: null },
    });
    expect(await callsOf(o)).toEqual({
      [x.misfiledCall]: onCustomer(x.newer),
      [x.callOntoOwnLead]: onCustomer(x.leadOwner, x.ownLead),
      [x.callOntoOwnJob]: { customer: x.jobOwner, lead: null, job: x.ownJob.id, jobLabel: x.ownJob.number },
      [x.callBeforeItsOwnLead]: onCustomer(x.laterNumberHolder),
      [x.callBeforeNumberTaken]: onCustomer(x.tookNumberHolder),
      [x.callBeforeSecondOwnLead]: onCustomer(x.loserNumberHolder),
      [x.callBeforeTheWork]: onCustomer(x.workLaterNewest),
      [x.callBeforeTheCustomer]: onCustomer(x.customerLaterHolder),
      [x.callBeforeTheCorrection]: onCustomer(x.correctedNumberHolder),
      [x.callBeforeTheFieldSave]: onCustomer(x.fieldSavedHolder),
      [x.callBeforeTheListRewrite]: onCustomer(x.listRewrittenHolder),
      [x.soloNumberCall]: onCustomer(x.older),
      [x.placedCall]: onCustomer(x.older),
      [x.attachedCall]: onCustomer(x.older, x.olderLostLead),
      [x.earlierCall]: onCustomer(x.older),
      [x.textMadeNotRinging]: onCustomer(null),
      [x.realRingingCall]: onCustomer(x.solo),
      [x.ringingWithoutEvent]: onCustomer(x.solo),
    });
  }

  it('a run stopped at any write, then run again, ends as one clean run does, and a run after it lists nothing', async () => {
    const clean = await seedOrg();
    const cleanIds = await seedTestDay(clean);
    await runPhoneHistoryRepair(['--org', clean.org, '--confirm'], { prisma: databaseFailingAt(null).client, print: () => {} });
    await repairedAsExpected(clean, cleanIds);

    // Stop the run at its first write, then its second, and so on, until a run meets no stop (it made fewer writes).
    let stops = 0;
    for (let failAt = 1; ; failAt += 1) {
      const o = await seedOrg();
      const x = await seedTestDay(o);
      const stopped = databaseFailingAt(failAt);
      const outcome = await runPhoneHistoryRepair(['--org', o.org, '--confirm'], { prisma: stopped.client, print: () => {} }).then(
        () => 'finished', (err: Error) => err.message,
      );
      if (outcome === 'finished') break;
      expect(outcome).toBe(`connection lost at write ${failAt}`);
      stops += 1;

      await run(['--org', o.org, '--confirm']);

      await repairedAsExpected(o, x);
      expect({ failAt, list: moves((await run(['--org', o.org])).output) }).toEqual({ failAt, list: [] });
    }
    // The seeded day has five moves (three calls re-filed, two fake calls deleted): every one of them was a stopping point.
    expect(stops).toBeGreaterThanOrEqual(5);
  }, 300_000);

  describe('the real run, then a second one', () => {
    let real: Awaited<ReturnType<typeof run>>;
    let rowsBefore: Awaited<ReturnType<typeof textRows>>;
    let afterReal: Awaited<ReturnType<typeof textsOf>>;
    let second: Awaited<ReturnType<typeof run>>;
    let bBefore: Awaited<ReturnType<typeof textsOf>>;
    let callsBefore: Awaited<ReturnType<typeof callsOf>>;
    let callsAfterReal: Awaited<ReturnType<typeof callsOf>>;
    let bCallsBefore: Awaited<ReturnType<typeof callsOf>>;
    let sideBefore: Awaited<ReturnType<typeof sideEffectsOf>>;

    beforeAll(async () => {
      bBefore = await textsOf(B);
      bCallsBefore = await callsOf(B);
      callsBefore = await callsOf(A);
      sideBefore = await sideEffectsOf(A);
      rowsBefore = await textRows();
      real = await run(['--org', A.org, '--confirm']);
      afterReal = await textsOf(A);
      callsAfterReal = await callsOf(A);
      second = await run(['--org', A.org, '--confirm']);
    }, 120_000);

    it('prints the same list it printed dry, and no customer name, number or vendor', () => {
      expect(moves(real.output)).toEqual(expectedList(a));
      expect(leftAsTheyAre(real.output)).toEqual(expectedLeft(a));
      const printed = real.output.join('\n');
      for (const name of NAMES) expect(printed).not.toContain(name);
      expect(printed).not.toMatch(/ctm|calltrackingmetrics|supabase|render|twilio/i);
    });

    it('leaves every text exactly as it was', async () => {
      expect(real.result.ok).toBe(true);
      expect(real.output).toEqual(expect.arrayContaining(['Writing (--confirm).']));
      expect(await textRows()).toEqual(rowsBefore);
    });

    it('re-files exactly the listed calls onto the customer the fixed order picks, with its lead or job, and no other call', async () => {
      expect(real.output).toEqual(expect.arrayContaining(['  Incoming calls on a shared number re-filed by the fixed order: 3']));
      expect(callsAfterReal).toEqual(expect.objectContaining({
        [a.misfiledCall]: onCustomer(a.newer),
        // The one open lead carrying the number as its own decided the pick: the call is filed on it and its customer.
        [a.callOntoOwnLead]: onCustomer(a.leadOwner, a.ownLead),
        // The same for a job, which the call shows by its job number.
        [a.callOntoOwnJob]: { customer: a.jobOwner, lead: null, job: a.ownJob.id, jobLabel: a.ownJob.number },
      }));
      const { [a.misfiledCall]: _m1, [a.callOntoOwnLead]: _m2, [a.callOntoOwnJob]: _m3, ...others } = callsAfterReal;
      const {
        [a.misfiledCall]: _w1, [a.callOntoOwnLead]: _w2, [a.callOntoOwnJob]: _w3, [a.fakeFromIncomingText]: _f1, [a.fakeFromOutgoingText]: _f2,
        ...othersBefore
      } = callsBefore;
      expect(others).toEqual(othersBefore);
    });

    it('deletes exactly the listed fake ringing calls, and keeps the real ringing call, the one with no event and the text-made call that is not ringing', async () => {
      expect(real.output).toEqual(expect.arrayContaining(['  Fake ringing calls a text\'s events made, deleted: 2']));
      expect(Object.keys(callsAfterReal).sort()).toEqual(
        Object.keys(callsBefore).filter((id) => id !== a.fakeFromIncomingText && id !== a.fakeFromOutgoingText).sort(),
      );
      for (const kept of [a.realRingingCall, a.ringingWithoutEvent, a.textMadeNotRinging]) expect(callsAfterReal[kept]).toBeDefined();
    });

    it('a repair is not an arrival: no alert, no automation, no unread count or lead status changed', async () => {
      expect(await sideEffectsOf(A)).toEqual(sideBefore);
    });

    it('a second run lists nothing and changes nothing', async () => {
      expect(second.output).toEqual(expect.arrayContaining([
        '  Incoming calls on a shared number re-filed by the fixed order: 0',
        '  Fake ringing calls a text\'s events made, deleted: 0',
      ]));
      expect(moves(second.output)).toEqual([]);
      // What it left the first time it leaves again, and says so again.
      expect(leftAsTheyAre(second.output)).toEqual(expectedLeft(a));
      expect(await textsOf(A)).toEqual(afterReal);
      expect(await callsOf(A)).toEqual(callsAfterReal);
    });

    it('the company not named is left as it was: its own dry run still lists its calls', async () => {
      expect(await textsOf(B)).toEqual(bBefore);
      expect(await callsOf(B)).toEqual(bCallsBefore);
      const { output } = await run(['--org', B.org]);
      expect(output).toEqual(expect.arrayContaining([
        `Company ${B.org}`,
        '  Incoming calls on a shared number re-filed by the fixed order (to be): 3',
        '  Fake ringing calls a text\'s events made, deleted (to be): 2',
      ]));
    });
  });
});
