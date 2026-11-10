import type { Request } from 'express';
import { prisma } from '../prisma';
import { scopeWhereForReq } from '../permissions/enforce';
import { isSuperUser } from '../permissions/effectiveRole';
import { relationScopeFilter, anchorInheritedWhere } from '../permissions/anchorVisibility';
import type { ChannelVisibility } from '../job-communications';
import { resolveSwitches } from '../permissions/switches/store';
import { estimateOpenerFor } from '../permissions/estimateAccess';
import { invoiceOpenerFor } from '../permissions/invoiceAccess';
import { tenantWhere } from '../tenant';
import { attachedReach } from '../permissions/recordPeople';
import { substituteConditions } from '../permissions/substituteConditions';
import { MATCH_NOTHING } from '../permissions/scopeWhereFor';
import { canReadCustomerById } from '../permissions/customerScope';
import { recordPeopleThreads, type PeopleThread } from './recordPeopleThreads';
import { emailFeatureOn } from './emailFeature';
import { departmentMemberIds } from '../permissions/moduleReach';
import { numbersCarriedInReach } from './numberCarriers';

/**
 * M11 Communication scope (Roles & Permissions PRD 8).
 *
 * One module answers two questions for the Communication section:
 *   - which conversations does a section list show this person (`callsInSectionWhere`), and
 *   - may this person read this one conversation (`callReadWhere`).
 *
 * S08.2 built the calls half; S08.3 adds the main-line fallback and the company numbers list; S08.5 adds the text
 * branch; S08.6 adds reply attribution to it; S08.7 adds the email branch, which reads the mailbox ids PRD 10 supplies instead of company numbers; S08.8 adds the rule
 * of the record Communication tabs, which asks about reach and nothing else. The core is pure: the person, their Communication scope value, their
 * linked company numbers and their record reach are INJECTED, so it is tested without a request. The loaders at the
 * bottom gather those inputs from the request, and read them afresh every time: nothing is cached across requests, so
 * linking or unlinking a number shows on the next one.
 *
 * It replaces, for calls, the "tied to nothing means company-wide" branch of the anchor visibility rule
 * (lib/permissions/anchorVisibility.ts). The record branches keep the same job > lead > customer > vendor precedence.
 */

type Where = Record<string, unknown>;

/**
 * The Communication scope (P6): Attached (the section lists what is the person's own: the numbers linked to them, their
 * own and handed-over mailboxes, the calls and texts they took part in), Team (the same for everyone in their
 * department) or All. The people whose own rows count are `CommunicationScopeInputs.personIds`.
 */
export type CommunicationScopeValue = 'attached' | 'team' | 'all';

/**
 * The filter on an email message or an `email_threads` row that matches nothing: what every reader gets while the company's
 * Email plan feature is off (PRD 10, S10.6; see `emailFeatureOn`). The mail itself is stored as ever, so this is the whole
 * of "hidden": no list, read, count or tab can name a row, and nothing needs to be unmarked when the feature returns.
 */
export const NO_EMAIL: Where = { id: { in: [] } };

/** What the person can open, as the access resolver answers it for each kind of record a call can hang off. */
export interface RecordReach {
  /** Row scope on Job, Lead and Customer, as `scopeWhereForReq` returns it ({} = unrestricted, MATCH_NOTHING = none). */
  job: Where;
  lead: Where;
  customer: Where;
  /** Holds View vendors. */
  vendors: boolean;
}

export interface CommunicationScopeInputs {
  /** The person asking. */
  personId: string;
  /**
   * The people whose own conversations the section lists: the person alone under Attached, everyone in their department
   * under Team (the person included, when they have a department; none, and so nothing of their own, when they have none:
   * P3). Left out, it is the person alone.
   */
  personIds?: readonly string[];
  scope: CommunicationScopeValue;
  /** The company numbers ticked against the person (or, under Team, against anyone in their department) on Settings > Caller ID. The Organization default number is among
   *  them only when it is ticked there; sending from it does not link a person to it. */
  linkedNumberIds: readonly string[];
  /** Holds "See the main line when I have no number". Read only when the person has no linked number. */
  seeMainLineWhenNoNumber: boolean;
  /** The Organization default number (the main line), or null when the organization has none. */
  orgDefaultNumberId: string | null;
  /** The mailboxes whose email conversations the person reads under Attached: the ones they HOLD (PRD 10, S10.7):
   *  their own, and each one handed to them (`Mailbox.holder_user_id` is the person). The main-line fallback never adds one. */
  mailboxIds: readonly string[];
  /** The company's main mailbox, when the person READS it (PRD 10, S10.8), else null: see `mainMailboxReadFor`. Under Attached
   *  it lists only the conversations started in it after go-live. Nothing but the Email page reads it. */
  mainMailboxId: string | null;
  /** The record conversations the person reaches through their record (S10.7): the ids the loader found the person can
   *  still open the record of (and, for an invoice or an estimate, that invoice or estimate). Which candidates it asked
   *  about depends on the question: the person's own conversations for a list, the one conversation for a read. */
  recordThreadIds: readonly string[];
  /** The inbound texts that are the person's by reply attribution (`replyAttributedMessageIds`). Read only for texts. */
  repliedMessageIds: readonly string[];
  reach: RecordReach;
  /** The record conversations the person gets as one of the record's people (S10.9), found by `recordPeopleThreadsTheyReach`:
   *  present only where the Email section lists them (Attached). */
  recordPeopleThreadIds?: readonly string[];
  /**
   * #3021 (#3013 decision 4): the numbers (E.164) carried by at least one customer the person reaches, among the numbers of
   * the text conversations the question is about (`numbersCarriedInReach`). A text of a conversation keyed by one of them
   * that is tied to no lead or job is the person's to read. Left out, none.
   */
  carrierNumbers?: readonly string[];
}

/** The fields of a text message that reply attribution reads. */
export interface ReplyCandidate {
  id: string;
  thread_id: string;
  direction: string;
  phone_number_id: string | null;
  sent_by_user_id: string | null;
  ts: Date;
  created_at?: Date;
}

/**
 * Reply attribution [Ran 4 Oct, Q64]: an inbound text is the person's when the latest outbound message before it, in
 * the same conversation and on the same company number, was sent by them. So a person with no linked number who texts
 * a customer from the Organization default number sees the answers. The latest outbound counts even when nobody sent it
 * from the app (an automated text), and then the reply is nobody's by attribution. A message with no company number
 * takes part on neither side.
 *
 * This answers it for EVERY inbound text at once: the map holds, for each inbound text that has a company number, the person
 * who sent the latest outbound message before it (null when that message was automated, or there was none). It is the one
 * statement of the rule: the lists and single reads ask it per person (`replyAttributedMessageIds`) and the inbound-text alert
 * asks it per message, so the two cannot disagree about whose reply a text is. `messages` need only hold the conversations
 * the question is about.
 */
export function replySendersOf(messages: readonly ReplyCandidate[]): Map<string, string | null> {
  const time = (m: ReplyCandidate) => [m.ts.getTime(), m.created_at?.getTime() ?? 0];
  const ordered = messages
    .filter((m) => m.phone_number_id !== null)
    .sort((a, b) => {
      const [ta, ca] = time(a);
      const [tb, cb] = time(b);
      return ta - tb || ca - cb;
    });
  // Who sent the latest outbound message so far, per conversation and company number.
  const lastSender = new Map<string, string | null>();
  const senders = new Map<string, string | null>();
  for (const m of ordered) {
    const key = `${m.thread_id}:${m.phone_number_id}`;
    if (m.direction === 'out') lastSender.set(key, m.sent_by_user_id);
    else if (m.direction === 'in') senders.set(m.id, lastSender.get(key) ?? null);
  }
  return senders;
}

/** The inbound texts that are the person's by reply attribution: those whose latest outbound sender (`replySendersOf`) is them. */
export function replyAttributedMessageIds(personId: string, messages: readonly ReplyCandidate[]): string[] {
  return [...replySendersOf(messages)].filter(([, sender]) => sender === personId).map(([id]) => id);
}

/** The people whose own conversations the section lists (see `CommunicationScopeInputs.personIds`). */
const peopleOf = (i: Pick<CommunicationScopeInputs, 'personId' | 'personIds'>): readonly string[] => i.personIds ?? [i.personId];

/** The column is the person, or is any of the people when there are several (none matches nothing). */
const byPeople = (column: string, ids: readonly string[]): Where => (ids.length === 1 ? { [column]: ids[0] } : { [column]: { in: [...ids] } });

/** A column filter for one person (equality) or several (`in`), so the one-person query keeps the shape it always had. */
const oneOrIn = (ids: readonly string[]): string | { in: string[] } => (ids.length === 1 ? ids[0]! : { in: [...ids] });

/** The inputs that decide which company numbers are the person's. */
type NumberInputs = Pick<CommunicationScopeInputs, 'linkedNumberIds' | 'seeMainLineWhenNoNumber' | 'orgDefaultNumberId'>;

/**
 * The company numbers the section treats as the person's: the ones ticked against them, or, for a person with none
 * who holds the main-line switch, the Organization default number. A person with at least one linked number never
 * gets the fallback, whatever the switch says. Under "All" the section does not narrow by number, so this is read
 * only under Attached.
 */
export function effectiveLinkedNumberIds(i: NumberInputs): string[] {
  if (i.linkedNumberIds.length > 0) return [...i.linkedNumberIds];
  return i.seeMainLineWhenNoNumber && i.orgDefaultNumberId ? [i.orgDefaultNumberId] : [];
}

/** The calls the section list shows under Attached: a linked number, or a call the person placed or answered. */
function ownCallBranches(i: CommunicationScopeInputs): Where[] {
  const numberIds = effectiveLinkedNumberIds(i);
  return [
    ...(numberIds.length > 0 ? [{ phone_number_id: { in: numberIds } }] : []),
    // `agent_id` holds the ServWave user who placed an outbound call or answered an inbound one.
    byPeople('agent_id', peopleOf(i)),
  ];
}

/**
 * The rows (a call, a text message, an email message) a person can open through the record they hang off, by the
 * precedence job > lead > customer > vendor. They all carry the same four ties.
 */
function recordBranches(reach: RecordReach, { vendor = true }: { vendor?: boolean } = {}): Where[] {
  return [
    { job_id: { not: null }, ...relationScopeFilter('job', reach.job) },
    { job_id: null, lead_id: { not: null }, ...relationScopeFilter('lead', reach.lead) },
    { job_id: null, lead_id: null, customer_id: { not: null }, ...relationScopeFilter('customer', reach.customer) },
    ...(reach.vendors && vendor ? [{ job_id: null, lead_id: null, customer_id: null, vendor_id: { not: null } }] : []),
  ];
}

/**
 * The `where` for the call log. Under "All" it is {} (every call); under Attached it is an `{ OR }`, so a handler
 * that also builds its own search OR must merge with `addOrFilter` (lib/permissions/whereCompose).
 */
export function callsInSectionWhere(inputs: CommunicationScopeInputs): Where {
  if (inputs.scope === 'all') return {};
  return { OR: ownCallBranches(inputs) };
}

/**
 * The `where` for opening one call: it is in the section scope, or reachable through its record. A call tied to
 * nothing is reachable through the scope alone.
 */
export function callReadWhere(inputs: CommunicationScopeInputs): Where {
  if (inputs.scope === 'all') return {};
  return { OR: [...ownCallBranches(inputs), ...recordBranches(inputs.reach)] };
}

/**
 * The conversations (`email_threads`) whose record they follow (PRD 10, "Record conversations follow the record"): the one
 * a send to a customer opens about an estimate, an invoice, a job, a lead, a calendar entry or a customer. Wherever such a conversation
 * sits, it is reachable only through its record, so none of the mailbox branches below may list it. Every other
 * conversation (started here, migrated, moved in, or opened about a kind of record with no rule yet) is ordinary.
 */
export const FOLLOWING_RECORD_TYPES = ['estimate', 'invoice', 'job', 'lead', 'calendar_entry', 'customer'] as const;
export type FollowingRecordType = (typeof FOLLOWING_RECORD_TYPES)[number];

export function isFollowingRecordType(type: string | null | undefined): type is FollowingRecordType {
  return (FOLLOWING_RECORD_TYPES as readonly string[]).includes(type ?? '');
}

/** An ordinary conversation: the filter on `email_threads` for one that does not follow a record. */
const ORDINARY_THREAD: Where = {
  OR: [{ origin: { not: 'record' } }, { record_type: { notIn: [...FOLLOWING_RECORD_TYPES] } }],
};

/**
 * What makes a conversation the person's own correspondence, apart from its record (PRD 10, "Section email rule"): it sits
 * in a mailbox they hold, it is assigned to them, or they wrote in it (a message they sent from the app).
 *
 * Only the mailbox OPENS a conversation (finding M1, ticket 31): mail reach is per message, so being assigned a
 * conversation or replying in it grants nothing beyond what the person already reaches. The other two only NARROW what
 * the section already shows ("My mailbox", `mailboxSelectionWhere`), and the reach rule (`threadsInSectionWhere`) reads
 * the mailbox alone.
 */
function theirConversationBranches(personIds: readonly string[], mailboxIds: readonly string[]): Where[] {
  return [
    ...(mailboxIds.length > 0 ? [{ mailbox_id: { in: [...mailboxIds] } }] : []),
    byPeople('assigned_to_user_id', personIds),
    { emails: { some: byPeople('sent_by_user_id', personIds) } },
  ];
}

/**
 * What the main mailbox lists to a person who reads it, under Attached (PRD 10, "What the main mailbox lists"): the
 * conversations STARTED in it, that is with origin "started", which is the marker S10.4 gives a conversation that came to
 * be in a mailbox after go-live. That leaves out, by the origin alone, the record conversations (they follow their
 * record), the migrated ones (what was there before go-live) and the ones moved in from a leaver's mailbox (S10.21 writes
 * "moved"), so the two kinds a reader must not inherit never need a list of ids. A conversation tied to a vendor is also
 * left out for a person without View vendors: it would show them a vendor's name.
 */
function mainMailboxThreads(mainMailboxId: string, reach: RecordReach): Where {
  return {
    mailbox_id: mainMailboxId,
    origin: 'started',
    ...(reach.vendors ? {} : { emails: { none: { vendor_id: { not: null } } } }),
  };
}

/**
 * The `where` on `email_threads` for the person's conversations under Attached: an ordinary conversation in a mailbox
 * they hold, or one the main mailbox lists to its reader, or a record conversation whose record they can still open (`recordThreadIds`, found by the loader). Written
 * ONCE here: the Email list, the single read, mark read, reply, the attachment link and every unread count all go
 * through it.
 */
function threadsInSectionWhere(i: CommunicationScopeInputs): Where {
  const branches: Where[] = [
    // An ordinary conversation is reached through the mailbox it sits in, never through an assignment or a message the
    // person wrote in it (M1): either would open every message of a conversation they may read only message by message.
    ...(i.mailboxIds.length > 0 ? [{ AND: [ORDINARY_THREAD, { mailbox_id: { in: [...i.mailboxIds] } }] }] : []),
    ...(i.mainMailboxId ? [mainMailboxThreads(i.mainMailboxId, i.reach)] : []),
    ...(i.recordThreadIds.length > 0 ? [{ id: { in: [...i.recordThreadIds] } }] : []),
    ...(i.recordPeopleThreadIds && i.recordPeopleThreadIds.length > 0 ? [{ id: { in: [...i.recordPeopleThreadIds] } }] : []),
  ];
  // A person with no mailbox, no main mailbox to read and no record conversation reaches no conversation. Said outright: an
  // empty `OR` nested under an `AND` is read by the database client as no condition at all, which would open every one.
  return branches.length > 0 ? { OR: branches } : NO_EMAIL;
}

/**
 * The `where` for the Email page's message list. An email conversation (an `email_threads` row) sits in one mailbox, so
 * under Attached a message is listed when its conversation is the person's (see `threadsInSectionWhere`); a tie to
 * a job, lead or customer plays no part for an ordinary one, and a loose system email (no conversation, so no mailbox) is
 * not listed. Under "All" every message. The main-line fallback is for calls and texts only: it never opens a mailbox.
 */
export function emailsInSectionWhere(inputs: CommunicationScopeInputs): Where {
  if (inputs.scope === 'all') return {};
  return { thread: threadsInSectionWhere(inputs) };
}

/**
 * The `where` for opening one email message, or acting on its conversation. Conversation-level when the conversation is
 * in the section scope, or is a record conversation the person can open the record of; otherwise, for an ordinary
 * conversation or a loose email, message by message through the record each message hangs off. A record conversation is
 * never read message by message: its record decides, whatever job, lead or customer its rows carry.
 */
export function emailReadWhere(inputs: CommunicationScopeInputs): Where {
  if (inputs.scope === 'all') return {};
  return {
    OR: [
      { thread: threadsInSectionWhere(inputs) },
      { AND: [{ OR: [{ thread_id: null }, { thread: ORDINARY_THREAD }] }, { OR: recordBranches(inputs.reach) }] },
    ],
  };
}

/**
 * Which mailbox the Email page is showing (PRD 10, Screens): "My mailbox", one mailbox picked from the list, or, for a
 * person on All, every mailbox. It only NARROWS what the section scope lets the person see, never widens it.
 */
export type MailboxSelection = { kind: 'mine' } | { kind: 'mailbox'; id: string } | { kind: 'all' };

/**
 * The `where` for a selection, spread beside the section scope (under `AND`, as both own the `thread` key). "My
 * mailbox" is the person's own correspondence: their own mailbox, what is assigned to them, what they wrote in and, under
 * Attached, the record conversations they get as one of the record's people (`recordPeopleThreadIds`, from the section).
 */
export function mailboxSelectionWhere(
  selection: MailboxSelection, person: { id: string; ownMailboxId: string | null; recordPeopleThreadIds?: readonly string[] },
): Where {
  switch (selection.kind) {
    case 'all':
      return {};
    case 'mailbox':
      return { thread: { mailbox_id: selection.id } };
    case 'mine':
      return {
        thread: {
          OR: [
            ...theirConversationBranches([person.id], person.ownMailboxId ? [person.ownMailboxId] : []),
            ...(person.recordPeopleThreadIds && person.recordPeopleThreadIds.length > 0 ? [{ id: { in: [...person.recordPeopleThreadIds] } }] : []),
          ],
        },
      };
  }
}

/**
 * The text messages the section list shows under Attached: a message on a linked company number (inbound or
 * outbound), one the person sent from the app, an inbound reply attributed to them, and anything in their own staff
 * conversation (the one keyed to them). A message with no company number matches none of these unless they sent it, so
 * the main-line fallback never lists it.
 */
function ownTextBranches(i: CommunicationScopeInputs): Where[] {
  const numberIds = effectiveLinkedNumberIds(i);
  return [
    ...(numberIds.length > 0 ? [{ phone_number_id: { in: numberIds } }] : []),
    byPeople('sent_by_user_id', peopleOf(i)),
    ...(i.repliedMessageIds.length > 0 ? [{ id: { in: [...i.repliedMessageIds] } }] : []),
    { thread: byPeople('user_id', peopleOf(i)) },
  ];
}

/**
 * A text message reaches its record by the same precedence as a call, but only the job and the lead sit on the message
 * itself: the customer and the vendor sit on its conversation.
 *
 * #3021 (#3013 decision 4): a text tied to no lead or job, in a conversation keyed by its pair of numbers, is reached through
 * ANY customer carrying the conversation's number (`carrierNumbers`), never through the customer it happens to be filed on.
 * A conversation from before pairs (no number of its own yet) is reached through the customer it is filed on, as always.
 */
function textRecordBranches(reach: RecordReach, carrierNumbers: readonly string[] = []): Where[] {
  return [
    { job_id: { not: null }, ...relationScopeFilter('job', reach.job) },
    { job_id: null, lead_id: { not: null }, ...relationScopeFilter('lead', reach.lead) },
    {
      job_id: null, lead_id: null,
      thread: { other_party_e164: null, customer_id: { not: null }, ...relationScopeFilter('customer', reach.customer) },
    },
    ...(carrierNumbers.length > 0 ? [{ job_id: null, lead_id: null, thread: { other_party_e164: { in: [...carrierNumbers] } } }] : []),
    ...(reach.vendors ? [{ job_id: null, lead_id: null, thread: { customer_id: null, vendor_id: { not: null } } }] : []),
  ];
}

/**
 * The `where` for the nested messages of a text conversation in the section list, and the one that decides which
 * conversations are listed (see `textThreadHolding`). Under "All" it is {} (every message); under Attached an
 * `{ OR }`.
 */
export function textsInSectionWhere(inputs: CommunicationScopeInputs): Where {
  if (inputs.scope === 'all') return {};
  return { OR: ownTextBranches(inputs) };
}

/**
 * The `where` for the messages a conversation returns when it is opened (detail, mark read, reply, attach, a record
 * tab's drawer): each message is the person's, or reachable through the record it hangs off. Every other message is
 * left out of the response.
 */
export function textReadWhere(inputs: CommunicationScopeInputs): Where {
  if (inputs.scope === 'all') return {};
  return { OR: [...ownTextBranches(inputs), ...textRecordBranches(inputs.reach, inputs.carrierNumbers)] };
}

/**
 * The `where` for a conversation (`message_threads` row) given the filter for its messages: it holds at least one.
 * Its existence and customer link are themselves information, so a conversation with nothing readable in it drops out.
 * {} stays {} ("All": no restriction), since an empty fragment under `some` would mean "has any message".
 */
export function textThreadHolding(messages: Where): Where {
  return Object.keys(messages).length === 0 ? {} : { messages: { some: messages } };
}

/**
 * #3013 decision 4 on a record's Communication tab: a text tied to no lead or job is readable by a person who reaches at least
 * one customer carrying its number, or who holds Communication "All". The caller passes only numbers such a customer of the
 * person's carries, or every number for "All" (on a lead's or a job's tab, `recordNumbersOpenedForReq`).
 * The text's own number (#3014) is matched, so a conversation filed on another customer of a shared number, or on nobody,
 * does not hide it. Tied texts keep record reach; nothing else is opened.
 */
function untiedTextsOnCarriedNumbers(carrierNumbers: readonly string[]): Where[] {
  return carrierNumbers.length > 0 ? [{ job_id: null, lead_id: null, other_party_e164: { in: [...carrierNumbers] } }] : [];
}

/**
 * The rows a record's Communication tab may list, one filter per source (S08.8). A tab asks one question, "may this
 * person open the record this row hangs off", and the section scope (company numbers, mailboxes) plays no part in it:
 * a person on Attached reads a job's whole tab, from any number or mailbox, whenever they can open the job.
 * Each row is judged by the same job > lead > customer precedence as a single read, so on a customer's tab a row tied
 * to a job needs that job, one tied to a lead (and no job) needs that lead, and a customer-only row needs the customer.
 * The job and lead tabs fetch rows by their own tie, so the record's own gate and this filter agree there, and the
 * filter keeps a row that also names a job the person cannot open off the lead's tab.
 *
 * A text keeps its customer on its conversation, which `textRecordBranches` handles; a logged entry names exactly one
 * of job, lead and customer and has no vendor column. WhatsApp is a demo-only prototype and stays on the job and lead
 * rule it has always had.
 *
 * The customer's estimate decisions (S08.9) hang off an estimate, which carries its own job, lead and customer, so the
 * same precedence reads its columns; on top of it the person must be able to open the estimate itself, which
 * `estimateScope` (the Estimates row scope) says.
 *
 * A payment received (S08.10) hangs off an invoice, which reads the same way through its own job, else its estimate's job,
 * else its estimate's lead, else its customer; on top of it the person must be able to open the invoice, which
 * `invoiceScope` (the Invoices row scope) says.
 */
export function recordTabWhere(
  reach: RecordReach, estimateScope: Where, invoiceScope: Where, carrierNumbers: readonly string[] = [],
): ChannelVisibility {
  const estimateReach = (): Where => {
    const record = {
      OR: [
        { job_id: { not: null }, ...relationScopeFilter('job_link', reach.job) },
        { job_id: null, lead_id: { not: null }, ...relationScopeFilter('lead', reach.lead) },
        { job_id: null, lead_id: null, ...relationScopeFilter('customer', reach.customer) },
      ],
    };
    return { AND: [estimateScope, record] };
  };
  const paymentReach = (): Where => {
    const record = {
      OR: [
        { job_id: { not: null }, ...relationScopeFilter('job', reach.job) },
        { job_id: null, estimate: { job_id: { not: null }, ...relationScopeFilter('job_link', reach.job) } },
        { job_id: null, estimate: { job_id: null, lead_id: { not: null }, ...relationScopeFilter('lead', reach.lead) } },
        {
          job_id: null,
          AND: [{ OR: [{ estimate_id: null }, { estimate: { job_id: null, lead_id: null } }] }, relationScopeFilter('customer', reach.customer)],
        },
      ],
    };
    return { invoice: { AND: [invoiceScope, record] } };
  };
  // A person who can open every job, lead and customer can open every row a tab holds: no filter, as for an unrestricted
  // requester everywhere else.
  if ([reach.job, reach.lead, reach.customer].every((scope) => Object.keys(scope).length === 0)) {
    return {
      perChannel: true, calls: {}, emails: {}, messages: {}, whatsapps: {}, manuals: {}, estimates: estimateScope,
      payments: Object.keys(invoiceScope).length === 0 ? {} : { invoice: invoiceScope },
    };
  }
  const rows = { OR: recordBranches(reach) };
  return {
    perChannel: true,
    calls: rows,
    emails: rows,
    messages: { OR: [...textRecordBranches(reach, carrierNumbers), ...untiedTextsOnCarriedNumbers(carrierNumbers)] },
    whatsapps: anchorInheritedWhere(reach.job, reach.lead),
    manuals: { OR: recordBranches(reach, { vendor: false }) },
    estimates: estimateReach(),
    payments: paymentReach(),
  };
}

/**
 * The `where` for the company numbers list: every number under "All", the person's own (the main line included when the
 * fallback covers them) under Attached. Spread it beside the tenant filter.
 */
export function numbersInSectionWhere(inputs: CommunicationScopeInputs): Where {
  if (inputs.scope === 'all') return {};
  return { id: { in: effectiveLinkedNumberIds(inputs) } };
}

// ─── Request-facing loaders ─────────────────────────────────────────────────────────────────

/** Anything but an explicit "All" is the narrow value, so an unknown stored value never widens the section. */
export function scopeValueOf(raw: unknown): CommunicationScopeValue {
  if (raw === 'all') return 'all';
  if (raw === 'team') return 'team';
  return 'attached';
}

/**
 * The people whose own conversations a scope lists for this person: themself under Attached, everyone in their
 * department under Team (none when they have no department, so nothing of their own: P3), nobody under All (it does not
 * narrow by person).
 */
export async function peopleForScope(
  user: { id: string; organization_id: string; department_id?: string | null }, scope: CommunicationScopeValue,
): Promise<string[]> {
  if (scope === 'attached') return [user.id];
  if (scope === 'team') return departmentMemberIds(user.organization_id, user.department_id);
  return [];
}

/** The company numbers ticked against the person on Settings > Caller ID, read from the database on every call. */
async function linkedNumberIdsFor(req: Request, people: readonly string[]): Promise<string[]> {
  const user = req.user!;
  const links = await prisma.userPhoneNumber.findMany({
    where: { user_id: oneOrIn(people), phone_number: { organization_id: user.organization_id } },
    select: { phone_number_id: true },
  });
  return [...new Set(links.map((l) => l.phone_number_id))];
}

async function scopeValueForReq(req: Request): Promise<CommunicationScopeValue> {
  return scopeValueOf((await resolveSwitches(req.user!)).communication_scope);
}

/**
 * #3013 decision 4 on a lead's or a job's tab: a text tied to no lead or job is readable by a person who can open at least one
 * customer carrying its number, or who holds Communication "All". The record's customer carries every number its card shows
 * (`numbers`), so those numbers open the record's untied texts (`recordTabVisibilityForReq`'s `carriedNumbers`) for a person
 * who can open that customer or holds "All", and for nobody else. Opening the record is not opening its customer: without
 * View customers (the preset Technician) a person reads the record's tied texts only, as before #3022.
 */
export async function recordNumbersOpenedForReq(
  req: Request, record: { customerId: string; numbers: readonly string[] },
): Promise<readonly string[]> {
  if (record.numbers.length === 0) return [];
  if ((await scopeValueForReq(req)) === 'all') return record.numbers;
  return (await canReadCustomerById(req, record.customerId)) ? record.numbers : [];
}

/**
 * The number links and the main-line fallback inputs, read from the database on every call. The Organization default
 * number is looked up only when the fallback could apply (no linked number and the switch on).
 */
async function numberInputsForReq(req: Request, people: readonly string[]): Promise<NumberInputs> {
  const [linkedNumberIds, switches] = await Promise.all([linkedNumberIdsFor(req, people), resolveSwitches(req.user!)]);
  const seeMainLineWhenNoNumber = switches.see_main_line_when_no_number === true;
  const needsMainLine = linkedNumberIds.length === 0 && seeMainLineWhenNoNumber;
  const orgDefault = needsMainLine
    ? await prisma.phoneNumber.findFirst({
        where: { organization_id: req.user!.organization_id, is_org_default: true },
        select: { id: true },
      })
    : null;
  return { linkedNumberIds, seeMainLineWhenNoNumber, orgDefaultNumberId: orgDefault?.id ?? null };
}

/**
 * The mailboxes the person HOLDS, read from the database on every call (PRD 10, S10.7): `Mailbox.holder_user_id` is the
 * person. A user mailbox is held by the person it was issued to until the hand-over slices (S10.21, S10.22) give it to
 * someone else; this reads that column, so a mailbox handed to a person is theirs from the day those slices write it, with
 * no change here. A mailbox merged into the main one is held by nobody. `own` is the one issued to the person themselves.
 */
export async function heldMailboxesFor(
  req: Request, { withMain = true, people }: { withMain?: boolean; people?: readonly string[] } = {},
): Promise<HeldMailboxes> {
  const user = req.user!;
  // Under Team the mailboxes held by anyone in the person's department are read as the person's own are; the others
  // listed beside "My mailbox" are every one of them but the person's own.
  const holders = people ?? await peopleForScope(user, await scopeValueForReq(req));
  const [rows, main] = await Promise.all([
    prisma.mailbox.findMany({
      where: { organization_id: user.organization_id, holder_user_id: oneOrIn([...new Set([user.id, ...holders])]), status: { not: 'merged' } },
      select: { id: true, user_id: true, user: { select: { first_name: true, last_name: true } } },
    }),
    withMain ? mainMailboxReadFor(req) : null,
  ]);
  const own = rows.find((m) => m.user_id === user.id);
  return {
    held: rows.map((m) => m.id),
    own: own?.id ?? null,
    main,
    handedOver: rows
      .filter((m) => m.id !== own?.id)
      .map((m) => ({ id: m.id, ownerName: m.user ? `${m.user.first_name} ${m.user.last_name}`.trim() : null })),
  };
}

/**
 * The company's main mailbox, when the person reads it through a link or as an Admin (PRD 10, "Who reads the main mailbox";
 * the holders of Manage roles and permissions until that switch retired, AL-18), else null. People on All read it as they read every mailbox, so this never
 * stands for them. Read afresh on every request, so linking or unlinking shows on the next one.
 *
 * ONE statement, whoever asks: the company's main mailbox, whether the person is linked to it, and whether anybody ACTIVE is
 * (a deactivated person's link is ignored). The person reads it when they are linked, or when nobody active is and they
 * are an Admin (the flag on the signed-in person, so no read). It never grows with the people linked or the mail in it.
 */
async function mainMailboxReadFor(req: Request): Promise<string | null> {
  const user = req.user!;
  const rows = await prisma.$queryRaw<{ id: string; linked: boolean; anyone: boolean }[]>`
    SELECT m.id::text AS id,
      EXISTS (SELECT 1 FROM mailbox_readers r WHERE r.mailbox_id = m.id AND r.user_id = ${user.id}::uuid) AS linked,
      EXISTS (SELECT 1 FROM mailbox_readers r JOIN users u ON u.id = r.user_id WHERE r.mailbox_id = m.id AND u.is_active) AS anyone
    FROM mailboxes m
    WHERE m.organization_id = ${user.organization_id}::uuid AND m.kind = 'main'
    LIMIT 1`;
  const main = rows[0];
  if (!main) return null;
  const reads = main.linked || (!main.anyone && isSuperUser(user));
  return reads ? main.id : null;
}

/** The mailboxes a person holds: all of them, the one issued to them, and the others (handed over) with whose they were. */
export interface HeldMailboxes {
  held: string[];
  /** The main mailbox, when the person reads it under Attached (see `mainMailboxReadFor`). */
  main: string | null;
  own: string | null;
  handedOver: { id: string; ownerName: string | null }[];
}

/**
 * The inbound texts attributed to the people as replies, read from the database on every call. Only the conversations
 * one of them has sent a text in can hold one, so those are the only messages fetched.
 */
async function repliedMessageIdsFor(req: Request, people: readonly string[]): Promise<string[]> {
  const user = req.user!;
  if (people.length === 0) return [];
  const candidates = await prisma.message.findMany({
    where: {
      organization_id: user.organization_id,
      phone_number_id: { not: null },
      thread: { messages: { some: { sent_by_user_id: oneOrIn(people), phone_number_id: { not: null } } } },
    },
    select: { id: true, thread_id: true, direction: true, phone_number_id: true, sent_by_user_id: true, ts: true, created_at: true },
  });
  return people.flatMap((id) => replyAttributedMessageIds(id, candidates));
}

/** What the person can open, as the access resolver answers it now. */
async function reachForReq(req: Request): Promise<RecordReach> {
  const [job, lead, customer] = await Promise.all([
    scopeWhereForReq(req, 'Job'),
    scopeWhereForReq(req, 'Lead'),
    scopeWhereForReq(req, 'Customer'),
  ]);
  return { job, lead, customer, vendors: req.ability?.can('read', 'Vendor') ?? false };
}

/** `withReplies` is for the text callers: the other channels never read the attributed replies, so they skip the query. */
async function inputsForReq(
  req: Request, scope: CommunicationScopeValue, { withReplies = false }: { withReplies?: boolean } = {},
): Promise<CommunicationScopeInputs> {
  const people = await peopleForScope(req.user!, scope);
  const [numberInputs, repliedMessageIds, reach] = await Promise.all([
    numberInputsForReq(req, people), withReplies ? repliedMessageIdsFor(req, people) : [], reachForReq(req),
  ]);
  // The calls and texts never read the mailbox inputs: email has its own loader (`emailInputsForReq`).
  return { personId: req.user!.id, personIds: people, scope, ...numberInputs, mailboxIds: [], mainMailboxId: null, recordThreadIds: [], repliedMessageIds, reach };
}

/**
 * Controller-facing: the row filters for a record's Communication tab (job, lead or customer). It reads reach (and the
 * Estimates and Invoices scopes, for the customer's estimate decisions and the payments received) only, so it is the same under both scope values and with Access Communication off. Pass it as the aggregator's `visibility`.
 */
export async function recordTabVisibilityForReq(
  req: Request, { carriedNumbers = [] }: { carriedNumbers?: readonly string[] } = {},
): Promise<ChannelVisibility> {
  const [reach, estimateScope, invoiceScope] = await Promise.all([
    reachForReq(req), scopeWhereForReq(req, 'Estimate'), scopeWhereForReq(req, 'Invoice'),
  ]);
  // `carriedNumbers`: the numbers of the customer whose tab it is, which the person can open (the tab's own gate), so each is
  // carried by a customer they reach (#3021); or the numbers a lead's or job's card shows, kept only for a person who can open
  // the record's customer or holds "All" (`recordNumbersOpenedForReq`, #3022).
  const tab = recordTabWhere(reach, estimateScope, invoiceScope, carriedNumbers);
  // While the company's Email plan feature is off the tabs show no email, sent or received (PRD 10, S10.6). Calls, texts and
  // the rest are decided by their own features and are untouched.
  return emailFeatureOn(req) ? tab : { ...tab, emails: NO_EMAIL, emailHidden: true };
}

/** Controller-facing: the call log's row filter. Spread it beside `tenantWhere(req)`. */
export async function callsInSectionWhereForReq(req: Request): Promise<Where> {
  const scope = await scopeValueForReq(req);
  if (scope === 'all') return {};
  return callsInSectionWhere(await inputsForReq(req, scope));
}

/** Controller-facing: the row filter for opening one call by id. Spread it beside `tenantWhere(req)`. */
export async function callReadWhereForReq(req: Request): Promise<Where> {
  const scope = await scopeValueForReq(req);
  if (scope === 'all') return {};
  return callReadWhere(await inputsForReq(req, scope));
}

const EVERYTHING_REACHED: RecordReach = { job: {}, lead: {}, customer: {}, vendors: true };

/** What the loaders find out about the person for the Email page: the mailboxes they hold and what they can open. */
async function emailInputsForReq(
  req: Request, scope: CommunicationScopeValue, candidates: RecordCandidates, known?: HeldMailboxes,
): Promise<{ inputs: CommunicationScopeInputs; mailboxes: HeldMailboxes }> {
  // Under All the section does not narrow and the mailbox list reads the main mailbox itself, so nothing asks about it.
  const people = await peopleForScope(req.user!, scope);
  const mailboxes = known ?? await heldMailboxesFor(req, { withMain: scope !== 'all', people });
  const { held } = mailboxes;
  // Under All the section does not narrow, so there is no record to ask about.
  const reach = scope === 'all' ? EVERYTHING_REACHED : await reachForReq(req);
  const recordThreadIds = scope === 'all' ? [] : await recordThreadsTheyReach(req, reach, held, candidates, people);
  // The record's people come to the Email list and the counts only: opening one conversation needs the record alone, which
  // `recordThreadIds` above already holds for the conversation a read names.
  const recordPeopleThreadIds = scope === 'all' || candidates.kind !== 'theirs' ? [] : await recordPeopleThreadsTheyReach(req, reach, people);
  return {
    mailboxes,
    inputs: {
      personId: req.user!.id, personIds: people, scope, linkedNumberIds: [], seeMainLineWhenNoNumber: false, orgDefaultNumberId: null,
      mailboxIds: held, mainMailboxId: mailboxes.main, recordThreadIds, repliedMessageIds: [], reach, recordPeopleThreadIds,
    },
  };
}

/** The one email message, or the one conversation, a read is about. */
export type EmailTarget = { emailId: string } | { threadId: string };

/**
 * Which record conversations to ask about: the person's own (a list, a count), the one a read is about, those that held replies
 * point at (the Needs review list, S10.18: `held` names the mailboxes the list is built from) or these conversations by id
 * (the target of a link).
 */
type RecordCandidates =
  | { kind: 'theirs' }
  | { kind: 'target'; target: EmailTarget }
  | { kind: 'held'; mailboxIds: readonly string[] }
  | { kind: 'threads'; ids: readonly string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FindRows = (where: Where) => Promise<{ id: string }[]>;

/**
 * Which of these rows the person's row scope on their kind keeps: every one for a scope that reaches every row (no read),
 * else the ones a single read of the table keeps.
 */
async function rowsInScope(req: Request, ids: string[], scope: Where, find: FindRows): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  if (Object.keys(scope).length === 0) return new Set(ids);
  return new Set((await find({ id: { in: ids }, ...tenantWhere(req), ...scope })).map((r) => r.id));
}

/**
 * The record conversations the person can open the record of, out of the candidates (PRD 10, "Record conversations follow
 * the record"). A conversation about a job, lead or customer is reachable while the person can open that job, lead or
 * customer; one about a calendar entry (which joins nothing, so it is tied to the customer it was sent to) while they can
 * open that customer; one about an estimate or an invoice only while they can also open that estimate or invoice, the
 * (S10.5's two openers, reused). Wherever it sits, whoever it is assigned to, whoever wrote in it.
 *
 * Bounded however many conversations there are, for the hosted database's one connection: one read for the candidates,
 * one for the customers a calendar entry conversation names, then at most one read per kind of record (none for a person whose scope reaches every row of that kind). Nothing is
 * asked per conversation, and nothing is kept between requests.
 */
async function recordThreadsTheyReach(
  req: Request, reach: RecordReach, held: readonly string[], candidates: RecordCandidates, people: readonly string[],
): Promise<string[]> {
  const user = req.user!;
  let which: Where;
  if (candidates.kind === 'theirs') {
    which = { OR: theirConversationBranches(people, held) };
  } else if (candidates.kind === 'held') {
    // The conversations a held reply in these mailboxes belongs to: a relation filter, so still one statement.
    if (candidates.mailboxIds.length === 0) return [];
    which = { review_items: { some: { review_reason: { not: null }, review_mailbox_id: { in: [...candidates.mailboxIds] } } } };
  } else if (candidates.kind === 'threads') {
    const ids = candidates.ids.filter((id) => UUID.test(id));
    if (ids.length === 0) return [];
    which = { id: { in: ids } };
  } else {
    const t = candidates.target;
    const id = 'emailId' in t ? t.emailId : t.threadId;
    if (!UUID.test(id)) return [];
    which = 'emailId' in t ? { emails: { some: { id } } } : { id };
  }
  const threads = await prisma.emailThread.findMany({
    where: {
      ...tenantWhere(req), origin: 'record', record_type: { in: [...FOLLOWING_RECORD_TYPES] }, record_id: { not: null }, ...which,
    },
    select: { id: true, record_type: true, record_id: true },
  });
  if (threads.length === 0) return [];

  const idsOf = (type: FollowingRecordType) =>
    [...new Set(threads.filter((t) => t.record_type === type).map((t) => t.record_id as string))];
  const rowsReached = (ids: string[], scope: Where, find: FindRows) => rowsInScope(req, ids, scope, find);
  // A calendar entry joins nothing (no job, lead or customer of its own), so its tie is the customer it was sent to:
  // the customer on the messages of its conversation. Read with the customers the customer conversations name, in one query.
  const calendarThreadIds = threads.filter((t) => t.record_type === 'calendar_entry').map((t) => t.id);
  const calendarCustomers = new Map<string, Set<string>>();
  if (calendarThreadIds.length > 0) {
    const rows = await prisma.email.findMany({
      where: { ...tenantWhere(req), thread_id: { in: calendarThreadIds }, customer_id: { not: null } },
      select: { thread_id: true, customer_id: true },
      distinct: ['thread_id', 'customer_id'],
    });
    for (const r of rows) {
      const set = calendarCustomers.get(r.thread_id as string) ?? new Set<string>();
      set.add(r.customer_id as string);
      calendarCustomers.set(r.thread_id as string, set);
    }
  }
  const customerIds = [...new Set([...idsOf('customer'), ...[...calendarCustomers.values()].flatMap((s) => [...s])])];

  const estimateIds = idsOf('estimate');
  const invoiceIds = idsOf('invoice');
  const customersReached = await rowsReached(customerIds, reach.customer, (where) => prisma.customer.findMany({ where, select: { id: true } }));
  const reached: Record<Exclude<FollowingRecordType, 'calendar_entry'>, Set<string>> = {
    job: await rowsReached(idsOf('job'), reach.job, (where) => prisma.job.findMany({ where, select: { id: true } })),
    lead: await rowsReached(idsOf('lead'), reach.lead, (where) => prisma.lead.findMany({ where, select: { id: true } })),
    customer: customersReached,
    estimate: estimateIds.length > 0 ? await (await estimateOpenerFor(req))(estimateIds) : new Set(),
    invoice: invoiceIds.length > 0 ? await (await invoiceOpenerFor(req))(invoiceIds) : new Set(),
  };
  return threads
    .filter((t) => {
      if (t.record_type === 'calendar_entry') {
        // Every customer the conversation names must be one the person can open; one that names none is reachable by no one.
        const named = calendarCustomers.get(t.id);
        return named !== undefined && [...named].every((id) => customersReached.has(id));
      }
      return reached[t.record_type as Exclude<FollowingRecordType, 'calendar_entry'>].has(t.record_id as string);
    })
    .map((t) => t.id);
}

/** Is every row the Attached people reach also a row of this scope? A scope that is the Attached rows, or has them as one arm. */
function scopeHoldsAttached(scope: Where, attached: Where): boolean {
  if (Object.keys(scope).length === 0) return true;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return same(scope, attached) || (Array.isArray(scope.OR) && scope.OR.some((arm) => same(arm, attached)));
}

/**
 * The record conversations the person gets as one of the RECORD'S PEOPLE (PRD 10, S10.9), as ids for the Email page's
 * filter: ONE mechanism with the conversations of their own mailboxes (`recordThreadsTheyReach`), a list of conversation
 * ids found from the records. `recordPeopleThreads` finds, in one statement that starts at the person's own jobs and leads,
 * the record conversations with a customer reply that they are a record person of; this keeps the ones whose record they
 * can still open (their row scope on the job or lead, on the estimate or on the invoice), so
 * losing record reach removes the conversation on the next request.
 *
 * Reading the scope costs nothing for a person whose scope reaches every row, or whose scope has the Attached rows as an arm
 * (Attached, or anything wider that lists it): the record's people are Attached people, so the scope keeps every one of them
 * and no read is needed. Any other scope (None, Through own leads, a Team or Location scope) is asked of the table, one read
 * for each kind of record the conversations are about. Bounded either way, however many conversations there are.
 */
async function recordPeopleThreadsTheyReach(req: Request, reach: RecordReach, people: readonly string[]): Promise<string[]> {
  const user = req.user!;
  if (people.length === 0) return [];
  const threads = await recordPeopleThreads(prisma, { organizationId: user.organization_id, personId: user.id, personIds: people });
  if (threads.length === 0) return [];

  const [estimateScope, invoiceScope] = await Promise.all([scopeWhereForReq(req, 'Estimate'), scopeWhereForReq(req, 'Invoice')]);
  const attached = (subject: 'Job' | 'Lead' | 'Estimate' | 'Invoice') =>
    substituteConditions(attachedReach(subject), { userId: user.id }) as Where;
  const idsOf = (type: PeopleThread['record_type']) => threads.filter((t) => t.record_type === type).map((t) => t.record_id);
  // The Attached rows are the viewer's own: the shortcut holds only when the record's people are the viewer alone.
  const onlyMe = people.length === 1 && people[0] === user.id;
  const reached = async (type: PeopleThread['record_type'], subject: 'Job' | 'Lead' | 'Estimate' | 'Invoice', scope: Where, find: FindRows) =>
    onlyMe && scopeHoldsAttached(scope, attached(subject)) ? new Set(idsOf(type)) : rowsInScope(req, idsOf(type), scope, find);
  const reachedRecords: Record<PeopleThread['record_type'], Set<string>> = {
    job: await reached('job', 'Job', reach.job, (where) => prisma.job.findMany({ where, select: { id: true } })),
    lead: await reached('lead', 'Lead', reach.lead, (where) => prisma.lead.findMany({ where, select: { id: true } })),
    estimate: await reached('estimate', 'Estimate', estimateScope, (where) => prisma.estimate.findMany({ where, select: { id: true } })),
    invoice: await reached('invoice', 'Invoice', invoiceScope, (where) => prisma.invoice.findMany({ where, select: { id: true } })),
  };
  return threads.filter((t) => reachedRecords[t.record_type].has(t.record_id)).map((t) => t.id);
}

/**
 * A mailbox the Email page can be asked to show. "mine" and "all" are words; anything else is a mailbox id. Anything the
 * person may not open (a colleague's mailbox under Attached, an id that is not a mailbox of their company) falls
 * back to their own mailbox, so a stale link or a shared one never shows more than the section does.
 */
export async function resolveMailboxSelection(
  req: Request, requested: unknown, scope: CommunicationScopeValue, readable: readonly string[],
): Promise<MailboxSelection> {
  if (typeof requested !== 'string' || requested === 'mine' || requested === '') return { kind: 'mine' };
  if (requested === 'all') return scope === 'all' ? { kind: 'all' } : { kind: 'mine' };
  if (!UUID.test(requested)) return { kind: 'mine' };
  if (readable.includes(requested)) return { kind: 'mailbox', id: requested };
  if (scope !== 'all') return { kind: 'mine' };
  const found = await prisma.mailbox.findFirst({ where: { id: requested, ...tenantWhere(req) }, select: { id: true } });
  return found ? { kind: 'mailbox', id: found.id } : { kind: 'mine' };
}

/** What the Email page lists for the person, before any mailbox is picked, and what they hold. */
export interface EmailSection {
  scope: CommunicationScopeValue;
  personId: string;
  /** The `where` on emails for everything the person's scope lists ({} on All). */
  where: Where;
  mailboxes: HeldMailboxes;
  /** What the section was built from, so a mailbox can be narrowed without asking again. */
  inputs: CommunicationScopeInputs;
}

/** The section while the Email plan feature is off (see `NO_EMAIL`): no mail, no mailbox held or read. */
function hiddenEmailSection(req: Request): EmailSection {
  const mailboxes: HeldMailboxes = { held: [], main: null, own: null, handedOver: [] };
  const reach: RecordReach = { job: { ...MATCH_NOTHING }, lead: { ...MATCH_NOTHING }, customer: { ...MATCH_NOTHING }, vendors: false };
  return {
    scope: 'attached', personId: req.user!.id, where: NO_EMAIL, mailboxes,
    inputs: {
      personId: req.user!.id, scope: 'attached', linkedNumberIds: [], seeMainLineWhenNoNumber: false, orgDefaultNumberId: null,
      mailboxIds: [], mainMailboxId: null, recordThreadIds: [], repliedMessageIds: [], reach,
    },
  };
}

/** The person's section of the Email page: read afresh, once per request, and handed to everything that needs it. */
export async function emailSectionForReq(req: Request): Promise<EmailSection> {
  // The Email plan feature is off: the section lists nothing, whoever asks, and nothing is read to say so.
  if (!emailFeatureOn(req)) return hiddenEmailSection(req);
  const scope = await scopeValueForReq(req);
  const { inputs, mailboxes } = await emailInputsForReq(req, scope, { kind: 'theirs' });
  return { scope, personId: inputs.personId, where: emailsInSectionWhere(inputs), mailboxes, inputs };
}

/**
 * The `where` on emails that narrows the section to one selection of the Email page: "My mailbox" (the person's own
 * correspondence and, under Attached, the record conversations they get as one of the record's people), one mailbox,
 * or all of them. The main mailbox is the one place a record conversation is NOT listed for its people (PRD 10, "What the
 * main mailbox lists"): there it lists what the section lists without them, which leaves a conversation that is theirs only
 * as one of the record's people to "My mailbox" and the section.
 */
export function selectionNarrowing(section: EmailSection, selection: MailboxSelection): Where {
  const { inputs } = section;
  if (selection.kind === 'mailbox' && inputs.scope !== 'all' && selection.id === inputs.mainMailboxId) {
    return { thread: { AND: [{ mailbox_id: selection.id }, threadsInSectionWhere({ ...inputs, recordPeopleThreadIds: undefined })] } };
  }
  return mailboxSelectionWhere(selection, {
    id: section.personId, ownMailboxId: section.mailboxes.own,
    recordPeopleThreadIds: inputs.recordPeopleThreadIds,
  });
}

/**
 * The `where` for the mailbox the page is showing, narrowing the section: "mine", one mailbox, or all of them. A request
 * for a mailbox the person may not open (see `resolveMailboxSelection`) shows their own.
 */
export async function mailboxSelectionFor(
  req: Request, section: EmailSection, requested: unknown,
): Promise<{ selection: MailboxSelection; where: Where }> {
  const { held, main } = section.mailboxes;
  const selection = await resolveMailboxSelection(req, requested, section.scope, main ? [...held, main] : held);
  return { selection, where: selectionNarrowing(section, selection) };
}

/** `section` and the narrowing, as one filter (each is its own `thread` clause, so they sit under AND). */
export function narrowedTo(section: Where, narrowing: Where): Where {
  if (Object.keys(narrowing).length === 0) return section;
  if (Object.keys(section).length === 0) return narrowing;
  return { AND: [section, narrowing] };
}

/**
 * Controller-facing: the Email page's row filter (and the unread count's). Spread it beside `tenantWhere(req)`. Pass the
 * requested mailbox (`?mailbox=`) to narrow it to the one the page is showing; leave it out for everything the person's
 * scope lists (the Email menu badge).
 */
export async function emailsInSectionWhereForReq(req: Request, mailbox?: unknown): Promise<Where> {
  if (!emailFeatureOn(req)) return NO_EMAIL;
  // Everything, for a person on All: nothing to look up.
  if (mailbox === undefined && (await scopeValueForReq(req)) === 'all') return {};
  const section = await emailSectionForReq(req);
  if (mailbox === undefined) return section.where;
  return narrowedTo(section.where, (await mailboxSelectionFor(req, section, mailbox)).where);
}

/**
 * Controller-facing: the row filter for opening one email message, or marking a conversation read. `target` says which
 * message or conversation the read is about, so only that conversation's record is asked about (a conversation about an
 * estimate or an invoice the person cannot open answers with a filter that matches nothing, however the section scope
 * would have let it through). Under "All" the section does not narrow, so neither does this.
 */
export async function emailReadWhereForReq(req: Request, target: EmailTarget): Promise<Where> {
  if (!emailFeatureOn(req)) return NO_EMAIL;
  const scope = await scopeValueForReq(req);
  if (scope === 'all') return {};
  return emailReadWhere((await emailInputsForReq(req, scope, { kind: 'target', target })).inputs);
}

/**
 * Controller-facing (re-audit N16): the filter for an `email_threads` row a person may change AS A WHOLE (assign it, archive it,
 * snooze it). Those change it for everyone who reads it, so it takes the conversation itself being the person's: in a mailbox
 * they hold or read, or a record conversation whose record they can open (`threadsInSectionWhere`, the rule the Email list
 * uses). Reading one message of it through a record (M1, ticket 31) is not enough. Under "All", every conversation.
 */
export async function emailThreadSectionWhereForReq(req: Request, threadId: string): Promise<Where> {
  if (!emailFeatureOn(req)) return NO_EMAIL;
  const scope = await scopeValueForReq(req);
  if (scope === 'all') return {};
  return threadsInSectionWhere((await emailInputsForReq(req, scope, { kind: 'target', target: { threadId } })).inputs);
}

/** Controller-facing: the filter for an `email_threads` row, which is readable when any message in it is. */
export async function emailThreadReadWhereForReq(req: Request, threadId: string): Promise<Where> {
  const messages = await emailReadWhereForReq(req, { threadId });
  return Object.keys(messages).length === 0 ? {} : { emails: { some: messages } };
}

/** The filter for a text conversation's nested messages, and for the conversation itself. */
export interface TextScope {
  messages: Where;
  thread: Where;
}

/** Controller-facing: the text inbox's filters (the list, and the unread count). Both are {} under "All". */
export async function textsInSectionScopeForReq(req: Request): Promise<TextScope> {
  const scope = await scopeValueForReq(req);
  if (scope === 'all') return { messages: {}, thread: {} };
  const messages = textsInSectionWhere(await inputsForReq(req, scope, { withReplies: true }));
  return { messages, thread: textThreadHolding(messages) };
}

/**
 * The one text conversation, or the one text, a read is about (#3021): the conversation's number decides who reaches it. Or
 * (#3023) every conversation with one number (E.164): the ones with that number a person may continue.
 */
export type TextTarget = { threadId: string } | { messageId: string } | { otherPartyE164: string };

/**
 * The number of the conversation a read is about, when a customer the person reaches carries it (#3013 decision 4): one read of
 * the conversation, then `numbersCarriedInReach`. Nothing for a conversation from before pairs (it has no number of its own), for
 * one of another company, or for an id that is no id. For a number itself (#3023), that number when such a customer carries it.
 */
async function carrierNumbersFor(req: Request, reach: RecordReach, target: TextTarget): Promise<string[]> {
  if ('otherPartyE164' in target) {
    return numbersCarriedInReach(prisma, req.user!.organization_id, [target.otherPartyE164], reach.customer);
  }
  const id = 'threadId' in target ? target.threadId : target.messageId;
  if (!UUID.test(id)) return [];
  const thread = await prisma.messageThread.findFirst({
    where: { ...tenantWhere(req), ...('threadId' in target ? { id } : { messages: { some: { id } } }) },
    select: { other_party_e164: true },
  });
  if (!thread?.other_party_e164) return [];
  return numbersCarriedInReach(prisma, req.user!.organization_id, [thread.other_party_e164], reach.customer);
}

/**
 * Controller-facing: the filters for opening one text conversation (detail, mark read, reply) or one message
 * (reassign). Both are {} under "All". `target` names the conversation or the message, so the customers carrying its number
 * are asked about (#3021).
 */
export async function textReadScopeForReq(req: Request, target: TextTarget): Promise<TextScope> {
  const scope = await scopeValueForReq(req);
  if (scope === 'all') return { messages: {}, thread: {} };
  const inputs = await inputsForReq(req, scope, { withReplies: true });
  const messages = textReadWhere({ ...inputs, carrierNumbers: await carrierNumbersFor(req, inputs.reach, target) });
  return { messages, thread: textThreadHolding(messages) };
}

/**
 * Controller-facing (#3023; Ran, 2026-11-06, after spec r3): the filter for the text conversations a person may CONTINUE -
 * send a text in - with the conversation, or every conversation with the number, that `target` names. Decided PER
 * CONVERSATION, never text by text: a person continues a conversation when they can open at least one customer carrying
 * its number (one from before pairs: the customer it is filed on), or can read any text in it. Continuing never shows them
 * a text: what they read in it stays `textReadScopeForReq`'s. {} under "All".
 * Every door that picks a conversation to continue asks this (a reply in one, and a text from a customer, a lead, a job or
 * a number), and the line above its text box with it. Joining the pair's own conversation once the number a text leaves
 * from is known is never narrowed by it (#3019: one conversation per pair).
 */
export async function textContinueScopeForReq(req: Request, target: TextTarget): Promise<Where> {
  const scope = await scopeValueForReq(req);
  if (scope === 'all') return {};
  const inputs = await inputsForReq(req, scope, { withReplies: true });
  const carrierNumbers = await carrierNumbersFor(req, inputs.reach, target);
  return {
    OR: [
      ...(carrierNumbers.length > 0 ? [{ other_party_e164: { in: carrierNumbers } }] : []),
      { other_party_e164: null, customer_id: { not: null }, ...relationScopeFilter('customer', inputs.reach.customer) },
      textThreadHolding(textReadWhere({ ...inputs, carrierNumbers })),
    ],
  };
}

/**
 * Controller-facing: the ids of the company numbers the person's list may show, or null under "All" (every number).
 * Use it to trim a list that is built some other way than by a query, such as the one a background sync returns.
 */
export async function numberIdsInSectionForReq(req: Request): Promise<string[] | null> {
  const scope = await scopeValueForReq(req);
  if (scope === 'all') return null;
  return effectiveLinkedNumberIds(await numberInputsForReq(req, await peopleForScope(req.user!, scope)));
}

/**
 * Controller-facing: the row filter for the company numbers list. Spread it beside `tenantWhere(req)`. Under "All" it
 * is {} (every number); under Attached it limits the list to the person's own numbers.
 */
export async function numbersInSectionWhereForReq(req: Request): Promise<Where> {
  const ids = await numberIdsInSectionForReq(req);
  return ids === null ? {} : { id: { in: ids } };
}

/**
 * Controller-facing, for the Needs review list (S10.18): the `where` on a held message that keeps it from a person who cannot
 * reach the record it replies to. A held reply to an invoice or an estimate (a message on a record conversation's reply
 * address) shows only to people who can open that record, whichever mailbox it is filed under, so a forwarded reply to an
 * invoice never reaches someone with Invoices View off through a mailbox's list. A held message with no conversation, or one on an
 * ordinary conversation, follows its mailbox alone. Under All nothing narrows (as for every conversation), so this is {} there.
 */
export async function heldRecordReachWhereForReq(
  req: Request, scope: CommunicationScopeValue, mailboxIds: readonly string[], known?: HeldMailboxes,
): Promise<Where> {
  if (scope === 'all') return {};
  const withoutRecords: Where[] = [{ review_thread_id: null }, { review_thread: ORDINARY_THREAD }];
  // Nothing in these mailboxes replies to a record conversation (the usual case): there is no record to ask about, and so no
  // reach to work out. One statement decides it.
  const anyRecordReply = await prisma.emailThread.findFirst({
    where: {
      ...tenantWhere(req), origin: 'record', record_type: { in: [...FOLLOWING_RECORD_TYPES] }, record_id: { not: null },
      review_items: { some: { review_reason: { not: null }, review_mailbox_id: { in: [...mailboxIds] } } },
    },
    select: { id: true },
  });
  if (!anyRecordReply) return { OR: withoutRecords };
  const { inputs } = await emailInputsForReq(req, scope, { kind: 'held', mailboxIds }, known);
  return { OR: [...withoutRecords, ...(inputs.recordThreadIds.length > 0 ? [{ review_thread_id: { in: [...inputs.recordThreadIds] } }] : [])] };
}

/**
 * Controller-facing, for linking a held message (S10.18): the `where` on `email_threads` for the conversations among these ids
 * the person can reach: the target of a link must be one. {} on All (every conversation of the company), else the same
 * conversation rule as the Email list (a conversation of a mailbox they hold or read, or a record conversation whose record they
 * can open; being assigned it or having written in it counts for nothing, M1). Matches nothing while the Email plan feature is off.
 */
export async function emailThreadReachWhereForReq(req: Request, threadIds: readonly string[]): Promise<Where> {
  if (!emailFeatureOn(req)) return NO_EMAIL;
  const scope = await scopeValueForReq(req);
  if (scope === 'all') return {};
  return threadsInSectionWhere((await emailInputsForReq(req, scope, { kind: 'threads', ids: threadIds })).inputs);
}

/** The person's Communication scope, for the Needs review list (S10.18), which narrows by it as the Email list does. */
export const communicationScopeForReq = scopeValueForReq;
