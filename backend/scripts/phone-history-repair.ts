#!/usr/bin/env tsx
/**
 * One-off repair of a company's phone history (#3028, parent #3013 decision 6, Q29). Run by hand, per company, after the
 * fixes it repairs for (#3015, #3025) are live. It is never scheduled: every new call is filed by those rules as it
 * arrives. It does two things, each with the SAME rule the live path uses, so the repair cannot drift from what a call
 * arriving today gets:
 *   1. re-files each INCOMING call on a shared number by the fixed order (#3015, `callFilingByFixedOrder`). A call we
 *      placed is left where it is: it may have been placed from a record, and a placed call stays on its record;
 *   2. deletes the fake "ringing" calls a text's events made (#3025's detection, `isTextActivity`). A call a text's events
 *      made that is not ringing is left as it is, and listed.
 *
 * TEXTS ARE NEVER TOUCHED (Ran's ruling on #3028, 2026-11-06). A rule sets a text's lead or job only when the text first
 * arrives; a person's change always stands and is never re-applied by a rule later. A stored text's tie may be a person's
 * choice (an untie leaves no trace), so the tool reads no text and writes no text: an untied reply stays untied until a
 * person attaches it from the inbox.
 *
 * The fixed order reads today's data. A call it would move is LEFT as it is, and listed by id with the reason, when any
 * of these things that decide its pick today was made after the call (Ran's ruling on #3028, 2026-11-06):
 *   - the customer the order picks (its making);
 *   - that customer's carrying of the number, from the earliest of the ways it carries it, each dated as the data allows:
 *       - a lead's or job's own entry: the LATER of its making and its last correction (a correction rewrites the entry in
 *         place and stamps updated_at), so a corrected number counts from the correction;
 *       - a phone-list row: the LATER of when the row was saved and the last rewrite of the list the customer's history
 *         shows (a CUSTOMER_UPDATED timeline line naming 'phones': the office review rewrites a row's number in place, and
 *         which row is not recorded, so its last rewrite dates every row). The customer form saves the whole list again as
 *         new rows on every save, so a list saved after the call counts from that save even when the number was on it
 *         before (the call is left: the safe side);
 *       - the customer's own phone fields (phone, second phone): the LATER of the customer's making and the last save of
 *         them the customer's history shows (a CUSTOMER_UPDATED timeline line naming 'phone' or 'secondary_phone', which a
 *         customer edit and the office review write). The customer form sends the phone on every save, so any save after
 *         the call counts, even one that kept the number (left: the safe side);
 *   - any OPEN lead or job, of any customer, carrying the number as its own (the record made after the call, or its entry
 *     made or corrected after it): it decides the first step, alone or by making two such records where there was one;
 *   - any OPEN lead or job of the customer the order picks, ONLY when the second step decides the pick (no one open lead or
 *     job carrying the number as its own decided it): its newest one decides the second step.
 * Not covered: a status changed since the call (a lead or job opened, closed or reopened, a customer archived), a number
 * removed since, and a number written in place with no history line to date it (a phone field or phone-list row written
 * outside those two paths); what the order does not pick cannot decide the pick (a customer made later that loses today
 * changes nothing). The calls moved take the order's lead or job too, as a call arriving today is filed.
 *
 * A repair is not an arrival: it raises no alert, sends no text, marks no conversation unread, moves no lead's status and
 * starts no automation. It only writes where a call is filed, or deletes a fake call.
 *
 * DRY RUN BY DEFAULT: it prints the before-and-after list, and every call it leaves as it is with the reason, and writes
 * nothing. It writes only with --confirm. The list names ids only (no name, no number). What is left to do is worked out
 * from the data on every run, never from a mark, and each write is one guarded statement under that call's lock, so a run
 * stopped at any point and run again ends as one clean run does, and a second run changes nothing. Generic: no company is
 * named here; the companies are an argument (--org, or --all for every company).
 *
 * ALL work for a company runs inside runWithOrg(orgId) (see ctm-backfill.ts for why).
 *
 * Usage:
 *   npm run phone:repair-history -- --org <uuid> [--org <uuid>]    dry run, those companies
 *   npm run phone:repair-history -- --all                          dry run, every company
 *   ... add --confirm to write.
 *
 * Exit code 0 = completed, 1 = refused or failed.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { carriersOfNumbers, matchCallerByPhone, normalizeNAPhone } from '../src/lib/comms-identity';
import { callFilingByFixedOrder, isTextActivity, lockCallEvents, unwrapActivity, type CallFiling } from '../src/lib/ctm/ingest';
import { DONE_OR_CANCELLED_JOB_STATUSES } from '../src/lib/job-status-order';
import { prisma } from '../src/lib/prisma';
import { livePhoneEntriesSql } from '../src/lib/record-contact-entries';
import { TERMINAL_LEAD_STATUSES } from '../src/services/lead-stage.service';
import { runUnscoped, runWithOrg } from '../src/lib/tenant-context';

export interface RepairDeps {
  prisma: PrismaClient;
  print: (line: string) => void;
}

/** A call on a shared number and the customer (with the lead or job) the fixed order files it on. */
interface CallRefiling {
  id: string;
  sid: string | null;
  startedAt: Date;
  fromCustomerId: string;
  to: CallFiling & { customer_id: string };
}

/** A ringing call a text's events made. */
interface FakeCall {
  id: string;
  sid: string;
  startedAt: Date;
}

/** A call the run leaves as it is, and why. */
interface LeftCall {
  id: string;
  startedAt: Date;
  why: string;
}

/** One company's list: what the run does (or, dry, would do), and each call it leaves as it is. */
export interface CompanyRepair {
  orgId: string;
  callRefilings: CallRefiling[];
  fakeCalls: FakeCall[];
  left: {
    pickMadeLater: LeftCall[];
    textMadeNotRinging: LeftCall[];
    changedSinceTheList: LeftCall[];
  };
}

export type RepairResult = { ok: true; confirmed: boolean; companies: CompanyRepair[] } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tool's arguments: the companies (--org <id>, repeatable, or --all) and whether to write (--confirm). */
export function parseRepairArgs(argv: string[]): { ok: true; orgIds: string[] | 'all'; confirm: boolean } | { ok: false; error: string } {
  const known = new Set(['--org', '--all', '--confirm']);
  const orgIds: string[] = [];
  const notIds: string[] = [];
  const unknown: string[] = [];
  argv.forEach((a, i) => {
    if (a === '--org') {
      const id = argv[i + 1] ?? '';
      (UUID.test(id) ? orgIds : notIds).push(id);
    } else if (!known.has(a) && argv[i - 1] !== '--org') {
      unknown.push(a);
    }
  });
  if (notIds.length > 0) {
    return { ok: false, error: `--org takes a company id; not one: ${notIds.map((id) => JSON.stringify(id)).join(', ')}.` };
  }
  if (unknown.length > 0) return { ok: false, error: `Unknown argument(s): ${unknown.join(' ')}. Use --org <id> or --all, and --confirm.` };
  const all = argv.includes('--all');
  if (!all && orgIds.length === 0) return { ok: false, error: 'Name the companies with --org <id> (repeatable), or pass --all.' };
  if (all && orgIds.length > 0) return { ok: false, error: 'Pass either --org <id> or --all, not both.' };
  return { ok: true, orgIds: all ? 'all' : orgIds, confirm: argv.includes('--confirm') };
}

/** Why a call is left as it is: one of the things that decide the fixed order's pick was made after the call. */
const MADE_AFTER_THE_CALL = {
  customer: 'the customer the fixed order picks was made after the call',
  /** Says which dated ways the picked customer carries the number by, each of them dated after the call. */
  number: ({ phoneFields, phoneList, ownEntry }: Omit<Carrying, 'since'>) => {
    const ways = [
      phoneFields ? 'on its own phone fields, saved after the call' : null,
      phoneList ? 'on its phone list, saved or rewritten after the call' : null,
      ownEntry ? 'on a lead\'s or job\'s own entry, made or corrected after the call' : null,
    ].filter((w): w is string => w !== null);
    return ways.length > 0
      ? `the customer the fixed order picks carries the number only ${ways.join(' and ')}`
      : 'the customer the fixed order picks carries the number in no way the data dates';
  },
  ownRecord: 'an open lead or job carrying the number as its own was made after the call, or its entry of the number was made or corrected after it',
  work: 'an open lead or job of the customer the fixed order picks was made after the call',
} as const;

/** How the picked customer carries the number, as far as the data dates it (see the header). */
interface Carrying {
  /** Since when, by the earliest of its ways (null: no dated way found, so not shown to be before the call). */
  since: Date | null;
  /** It carries the number on its own phone fields (dated by the later of its making and its history's last save of them). */
  phoneFields: boolean;
  /** It carries the number on a phone-list row (dated by the later of the row's saving and its history's last rewrite of the list). */
  phoneList: boolean;
  /** It carries the number on a lead's or job's own entry (dated by the later of its making and its last correction). */
  ownEntry: boolean;
}

/** When each thing that decides a shared number's pick today was made (see the header). */
interface PickDates {
  customerMade: Date;
  carrying: Carrying;
  /**
   * The newest open lead or job, of any customer, carrying the number as its own: the latest of the record's making, its
   * entry's making and its entry's last correction.
   */
  newestOwnRecord: Date | null;
  /** The picked customer's newest open lead or job. */
  newestPickedWork: Date | null;
}

/**
 * The dates of what decides each shared number's pick, for every number at once (one query, whatever the count of numbers:
 * the numbers and customers go in as two arrays). Openness is the fixed order's own (`TERMINAL_LEAD_STATUSES`,
 * `DONE_OR_CANCELLED_JOB_STATUSES`) and the own entries are its own (`livePhoneEntriesSql`), so this reads what the order reads.
 */
async function datesOfPicks(db: PrismaClient, orgId: string, picks: ReadonlyMap<string, string>): Promise<Map<string, PickDates>> {
  const numbers = [...picks.keys()];
  if (numbers.length === 0) return new Map();
  const customers = numbers.map((n) => picks.get(n)!);
  const spellings = [...new Set(numbers.flatMap((n) => [n, n.slice(2)]))];
  const openLead = Prisma.sql`l.status::text <> ALL(${[...TERMINAL_LEAD_STATUSES]}::text[])`;
  const openJob = Prisma.sql`j.status::text <> ALL(${[...DONE_OR_CANCELLED_JOB_STATUSES]}::text[])`;
  const openOwnRecord = Prisma.sql`(o.lead_status <> ALL(${[...TERMINAL_LEAD_STATUSES]}::text[])
      OR o.job_status <> ALL(${[...DONE_OR_CANCELLED_JOB_STATUSES]}::text[]))`;
  const rows = await db.$queryRaw<Array<{
    e164: string; customer_made: Date; on_customer_record: boolean; phone_fields_saved: Date | null; phone_list_rewritten: Date | null;
    phone_list_since: Date | null; own_entry_since: Date | null;
    newest_own_record: Date | null; newest_picked_work: Date | null;
  }>>`
    WITH pick AS (
      SELECT * FROM unnest(${numbers}::text[], ${customers}::uuid[]) AS p(e164, customer_id)
    ),
    spelling AS (
      SELECT e164, e164 AS value FROM pick UNION SELECT e164, substr(e164, 3) FROM pick
    ),
    -- An own entry dates from the later of its record's making, its own making and its last correction (updated_at).
    own AS (
      SELECT s.e164, o.customer_id, o.lead_status, o.job_status, greatest(e.created_at, e.updated_at, l.created_at, j.created_at) AS made
        FROM (${livePhoneEntriesSql(orgId, spellings)}) o
        JOIN spelling s ON s.value = o.value
        JOIN record_contact_entries e ON e.id = o.id
        LEFT JOIN leads l ON l.id = o.lead_id
        LEFT JOIN jobs j ON j.id = o.job_id
    )
    SELECT p.e164, c.created_at AS customer_made,
           EXISTS (SELECT 1 FROM spelling s WHERE s.e164 = p.e164 AND s.value IN (c.phone, c.secondary_phone)) AS on_customer_record,
           -- The phone fields keep no date; the customer's history does: a customer edit or the office review writes
           -- CUSTOMER_UPDATED with the fields it saved (customer.controller.ts update, job-review-finish.ts).
           (SELECT max(t.created_at) FROM timeline_events t
             WHERE t.organization_id = ${orgId}::uuid AND t.entity_type = 'CUSTOMER' AND t.entity_id = c.id
               AND t.event_type = 'CUSTOMER_UPDATED'
               AND jsonb_exists_any(t.metadata->'fields', array['phone', 'secondary_phone'])) AS phone_fields_saved,
           -- A phone-list row keeps the date it was saved; the office review rewrites a row's number in place, and its
           -- history line (fields 'phones') dates that. The customer form saves the whole list as new rows (dated).
           (SELECT max(t.created_at) FROM timeline_events t
             WHERE t.organization_id = ${orgId}::uuid AND t.entity_type = 'CUSTOMER' AND t.entity_id = c.id
               AND t.event_type = 'CUSTOMER_UPDATED' AND jsonb_exists_any(t.metadata->'fields', array['phones'])) AS phone_list_rewritten,
           (SELECT min(cp.created_at) FROM customer_phones cp JOIN spelling s ON s.e164 = p.e164 AND s.value = cp.phone
             WHERE cp.customer_id = c.id) AS phone_list_since,
           (SELECT min(o.made) FROM own o WHERE o.e164 = p.e164 AND o.customer_id = c.id) AS own_entry_since,
           (SELECT max(o.made) FROM own o WHERE o.e164 = p.e164 AND ${openOwnRecord}) AS newest_own_record,
           (SELECT max(w.created_at) FROM (
              SELECT l.created_at FROM leads l WHERE l.customer_id = c.id AND l.organization_id = ${orgId}::uuid AND ${openLead}
              UNION ALL
              SELECT j.created_at FROM jobs j WHERE j.customer_id = c.id AND j.organization_id = ${orgId}::uuid AND ${openJob}
            ) w) AS newest_picked_work
      FROM pick p
      JOIN customers c ON c.id = p.customer_id AND c.organization_id = ${orgId}::uuid`;
  const earliest = (...dates: Array<Date | null>) =>
    dates.reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);
  const latest = (...dates: Array<Date | null>) =>
    dates.reduce<Date | null>((max, d) => (d && (!max || d > max) ? d : max), null);
  return new Map(rows.map((r) => [r.e164, {
    customerMade: r.customer_made,
    // A number on the customer's own phone fields counts from the customer's making, or from the last save of those fields
    // its history shows, whichever is later.
    carrying: {
      since: earliest(
        r.on_customer_record ? latest(r.customer_made, r.phone_fields_saved) : null,
        // Which row the review rewrote is not recorded: its last rewrite dates every row of the list.
        r.phone_list_since ? latest(r.phone_list_since, r.phone_list_rewritten) : null,
        r.own_entry_since,
      ),
      phoneFields: r.on_customer_record,
      phoneList: r.phone_list_since !== null,
      ownEntry: r.own_entry_since !== null,
    },
    newestOwnRecord: r.newest_own_record,
    newestPickedWork: r.newest_picked_work,
  }]));
}

/**
 * What decides the pick and was made after the call, as the reasons the list prints; empty when nothing was. The picked
 * customer's open work decides only the second step: when the one open lead or job carrying the number as its own decided
 * the pick (the first step; `byOwnRecord`), that customer's newest work is never reached and is not weighed.
 */
function madeAfterTheCall(dates: PickDates, call: Date, byOwnRecord: boolean): string[] {
  const after = (d: Date | null) => d !== null && d > call;
  const why: Array<string | null> = [
    after(dates.customerMade) ? MADE_AFTER_THE_CALL.customer : null,
    !after(dates.customerMade) && (dates.carrying.since === null || after(dates.carrying.since))
      ? MADE_AFTER_THE_CALL.number(dates.carrying) : null,
    after(dates.newestOwnRecord) ? MADE_AFTER_THE_CALL.ownRecord : null,
    !byOwnRecord && after(dates.newestPickedWork) ? MADE_AFTER_THE_CALL.work : null,
  ];
  return why.filter((w): w is string => w !== null);
}

/**
 * The calls on a shared number (two or more customers carry it) the fixed order files on another customer, judged on
 * today's carriers. Only an incoming call filed on a customer alone is weighed: a call we placed may have been placed from
 * a record and stays on it (the fixed order is for calls nobody placed from a record), a call on a lead or a job was put
 * there by that record or by a person and keeps it, and a call filed on nobody or on a supplier is left too. A call whose
 * pick is decided by anything made after it is left as it is, with the reason. One read of the calls, one of the carriers,
 * one fixed-order pick per shared number, and one read of the dates of what decided every pick.
 */
async function planCallRefilings(
  db: PrismaClient, orgId: string, textMade: ReadonlySet<string>,
): Promise<{ refilings: CallRefiling[]; pickMadeLater: LeftCall[] }> {
  const read = await db.callSession.findMany({
    where: { organization_id: orgId, direction: 'in', customer_id: { not: null }, lead_id: null, job_id: null, vendor_id: null },
    select: { id: true, ctm_call_id: true, direction: true, from_number: true, to_number: true, started_at: true, customer_id: true },
    orderBy: [{ started_at: 'asc' }, { id: 'asc' }],
  });
  // A call a text's events made is no call: it is never re-filed.
  const calls = read.filter((c) => !textMade.has(c.id));
  // The other party's number, read as the call ingest reads its customer side: the caller, or the number we called.
  const numberOf = new Map(calls.map((c) => [c.id, normalizeNAPhone(c.direction === 'in' ? c.from_number : c.to_number)]));
  const numbers = [...new Set([...numberOf.values()].filter((n): n is string => n !== null))];
  const carriers = await carriersOfNumbers(db, orgId, numbers);
  const filingOf = new Map<string, CallFiling>();
  for (const n of numbers) {
    if ((carriers.get(n)?.length ?? 0) < 2) continue;
    filingOf.set(n, callFilingByFixedOrder(await matchCallerByPhone(db, orgId, n)));
  }
  const picks = new Map([...filingOf].flatMap(([n, f]) => (f.customer_id ? [[n, f.customer_id] as const] : [])));
  const datesOf = await datesOfPicks(db, orgId, picks);
  const refilings: CallRefiling[] = [];
  const pickMadeLater: LeftCall[] = [];
  for (const c of calls) {
    const number = numberOf.get(c.id);
    const filing = number ? filingOf.get(number) : undefined;
    if (!number || !filing?.customer_id || filing.customer_id === c.customer_id) continue;
    const dates = datesOf.get(number);
    const byOwnRecord = filing.lead_id !== null || filing.job_id !== null;
    const why = dates ? madeAfterTheCall(dates, c.started_at, byOwnRecord) : [MADE_AFTER_THE_CALL.customer];
    if (why.length > 0) {
      pickMadeLater.push({ id: c.id, startedAt: c.started_at, why: why.join('; ') });
      continue;
    }
    refilings.push({
      id: c.id, sid: c.ctm_call_id, startedAt: c.started_at, fromCustomerId: c.customer_id!,
      to: { ...filing, customer_id: filing.customer_id },
    });
  }
  return { refilings, pickMadeLater };
}

/**
 * The calls a text's events made (#3025's detection, `isTextActivity`, read off the events the webhook stored for the
 * call's sid): every stored call event of the call is a text's. A call with no stored event, or with one call event, is a
 * call. Of these, the ringing ones are the fake calls to delete; any other is left as it is and listed. Returns the
 * fake calls, the ones left, and the ids of every call a text made.
 */
async function planFakeCalls(db: PrismaClient, orgId: string) {
  // The events are stored under `<sid>:<position>`, a call's `starts` and `end` (ctm-webhook.controller.ts). The table has no
  // company column: the call's sid, unique across companies, ties the event to the company's own call.
  const rows = await db.$queryRaw<Array<{ id: string; sid: string; status: string; started_at: Date; payload: unknown }>>`
    SELECT cs.id, cs.ctm_call_id AS sid, cs.status, cs.started_at, e.payload
      FROM call_sessions cs
      JOIN ctm_events e ON e.ctm_event_id IN (cs.ctm_call_id || ':starts', cs.ctm_call_id || ':end')
     WHERE cs.organization_id = ${orgId}::uuid AND cs.ctm_call_id IS NOT NULL
     ORDER BY cs.started_at ASC, cs.id ASC`;
  const byCall = new Map<string, { sid: string; status: string; startedAt: Date; allText: boolean }>();
  for (const r of rows) {
    const isText = r.payload != null && typeof r.payload === 'object' && isTextActivity(unwrapActivity(r.payload as Record<string, any>));
    const seen = byCall.get(r.id);
    if (seen) seen.allText &&= isText;
    else byCall.set(r.id, { sid: r.sid, status: r.status, startedAt: r.started_at, allText: isText });
  }
  const textMade = new Set<string>();
  const fakes: FakeCall[] = [];
  const notRinging: LeftCall[] = [];
  for (const [id, c] of byCall) {
    if (!c.allText) continue;
    textMade.add(id);
    if (c.status === 'ringing') fakes.push({ id, sid: c.sid, startedAt: c.startedAt });
    else notRinging.push({ id, startedAt: c.startedAt, why: 'a text\'s events made it, and it is not ringing' });
  }
  return { fakes, notRinging, textMade };
}

/** Deletes one fake call, only while it is still ringing. Under the call's lock, in one statement. */
async function deleteFakeCall(db: PrismaClient, orgId: string, c: FakeCall): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await lockCall(tx, c.sid);
    const gone = await tx.callSession.deleteMany({ where: { id: c.id, organization_id: orgId, ctm_call_id: c.sid, status: 'ringing' } });
    return gone.count === 1;
  });
}

/** Takes the call's own lock (the one the call ingest takes for each of its events), so a late event of it waits. */
async function lockCall(tx: Prisma.TransactionClient, sid: string | null) {
  if (sid) await lockCallEvents(tx, sid);
}

/** Re-files one call, only while it is still filed as listed. Under the call's lock, in one statement. */
async function writeCallRefiling(db: PrismaClient, orgId: string, c: CallRefiling): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await lockCall(tx, c.sid);
    const moved = await tx.callSession.updateMany({
      where: { id: c.id, organization_id: orgId, customer_id: c.fromCustomerId, lead_id: null, job_id: null, vendor_id: null },
      data: { customer_id: c.to.customer_id, lead_id: c.to.lead_id, job_id: c.to.job_id, job_label: c.to.job_label },
    });
    return moved.count === 1;
  });
}

const filingWords = (f: CallFiling & { customer_id: string }) =>
  [`customer ${f.customer_id}`, f.lead_id ? `lead ${f.lead_id}` : null, f.job_id ? `job ${f.job_id}` : null].filter(Boolean).join(', ');

async function repairCompany(db: PrismaClient, orgId: string, confirm: boolean): Promise<CompanyRepair> {
  return runWithOrg(orgId, async () => {
    const { fakes: fakeCalls, notRinging, textMade } = await planFakeCalls(db, orgId);
    const { refilings: callRefilings, pickMadeLater } = await planCallRefilings(db, orgId, textMade);
    const changedSinceTheList: LeftCall[] = [];
    const changed = (c: { id: string; startedAt: Date }) => {
      changedSinceTheList.push({ id: c.id, startedAt: c.startedAt, why: 'it changed since the list' });
    };
    if (confirm) {
      for (const c of callRefilings) if (!(await writeCallRefiling(db, orgId, c))) changed(c);
      for (const c of fakeCalls) if (!(await deleteFakeCall(db, orgId, c))) changed(c);
    }
    return { orgId, callRefilings, fakeCalls, left: { pickMadeLater, textMadeNotRinging: notRinging, changedSinceTheList } };
  });
}

/** The tool's public entry: parse the arguments, list (and with --confirm, make) each company's repairs. */
export async function runPhoneHistoryRepair(argv: string[], deps: RepairDeps): Promise<RepairResult> {
  const args = parseRepairArgs(argv);
  if (!args.ok) {
    deps.print(args.error);
    return args;
  }
  const orgIds =
    args.orgIds === 'all'
      ? (await runUnscoped(() => deps.prisma.organization.findMany({ select: { id: true }, orderBy: { id: 'asc' } }))).map((o) => o.id)
      : args.orgIds;

  deps.print(`Phone history repair - ${args.orgIds === 'all' ? 'every company' : `${orgIds.length} company(ies)`}`);
  deps.print(args.confirm ? 'Writing (--confirm).' : 'Dry run: nothing is written. Re-run with --confirm to write.');
  deps.print('Texts are never touched: a person\'s change to a text\'s lead or job always stands.');
  const will = args.confirm ? '' : ' (to be)';

  const companies: CompanyRepair[] = [];
  for (const orgId of orgIds) {
    const company = await repairCompany(deps.prisma, orgId, args.confirm);
    companies.push(company);
    deps.print(`Company ${orgId}`);
    deps.print(`  Incoming calls on a shared number re-filed by the fixed order${will}: ${company.callRefilings.length}`);
    for (const c of company.callRefilings) {
      deps.print(`    call ${c.id} started ${c.startedAt.toISOString()}: customer ${c.fromCustomerId} -> ${filingWords(c.to)}`);
    }
    deps.print(`  Fake ringing calls a text's events made, deleted${will}: ${company.fakeCalls.length}`);
    for (const c of company.fakeCalls) deps.print(`    call ${c.id} started ${c.startedAt.toISOString()}: ringing -> deleted`);
    const leftList = (heading: string, calls: LeftCall[]) => {
      deps.print(`  Left as they are - ${heading}: ${calls.length}`);
      for (const c of calls) deps.print(`    call ${c.id} started ${c.startedAt.toISOString()}: ${c.why}`);
    };
    leftList(
      'calls on a shared number the fixed order would file elsewhere, but something that decides the pick was made after the call',
      company.left.pickMadeLater,
    );
    leftList('calls a text\'s events made that are not ringing', company.left.textMadeNotRinging);
    if (args.confirm) leftList('changed since the list', company.left.changedSinceTheList);
  }
  return { ok: true, confirmed: args.confirm, companies };
}

// Only run when executed directly (not when imported by tests).
if (require.main === module) {
  runPhoneHistoryRepair(process.argv.slice(2), { prisma: prisma as unknown as PrismaClient, print: (line) => console.log(line) })
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error('Repair failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
