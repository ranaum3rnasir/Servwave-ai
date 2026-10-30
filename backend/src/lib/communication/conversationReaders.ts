import { prisma } from '../prisma';
import { logger } from '../logger';
import { abilityForUser, scopeWhereForUser, type PermissionUser } from '../permissions/enforce';
import type { AppAbility } from '../permissions/defineAbility';
import { isSuperUser } from '../permissions/effectiveRole';
import { MATCH_NOTHING, type ScopeResource } from '../permissions/scopeWhereFor';
import { resolveSwitchesForPeople } from '../permissions/switches/store';
import type { ResolvedSwitches } from '../permissions/switches/cache';
import { readersWithEntityAccess } from '../tasks/entityAccessCohort';
import {
  callReadWhere,
  emailReadWhere,
  emailsInSectionWhere,
  narrowedTo,
  selectionNarrowing,
  type EmailSection,
  type MailboxSelection,
  textReadWhere,
  isFollowingRecordType,
  scopeValueOf,
  replySendersOf,
  type CommunicationScopeInputs,
  type CommunicationScopeValue,
  type RecordReach,
} from './communicationScope';
import { orgEmailFeatureOn } from './emailFeature';
import { rowMatchesWhere, type Row } from './rowMatchesWhere';

/**
 * M11 Communication scope, asked for MANY people about ONE conversation (Roles & Permissions S08.21).
 *
 * The routes that open a call, a text conversation or an email conversation ask `callReadWhereForReq`,
 * `textReadScopeForReq` and `emailThreadReadWhereForReq`: the SAME pure rule (`callReadWhere`, `textReadWhere`,
 * `emailReadWhere`, written once in communicationScope.ts) fed the requester's inputs and run by the database. The
 * notification access filter has no requester and many people, so this gathers the same inputs for all of them in a
 * constant number of reads, loads the conversation once, and runs the very same rule over it in memory
 * (rowMatchesWhere). Nothing here restates who may read what; only how the inputs are gathered differs.
 * `permission-communication-conversation-readers-db.test.ts` holds this and the routes equal over a wide fixture set.
 *
 * A person reads a conversation when they may use the section (Access Communication, which the alert's destination
 * needs) and the route's own gate (View communication) and the single-read rule says yes. Show Phone and Show Text hide a menu
 * entry and decide nothing here; Show Email does decide for an email conversation, because its mail routes refuse a person with it off.
 *
 * Cost, however many people are asked: one read of the conversation, one of the people's company-number links (a call or
 * a text), at most one of the Organization default number, and, for the people the conversation's own ties do not settle,
 * one cohort look (readersWithEntityAccess) per record it hangs off. For an email, one more read of the company's plan,
 * and one of the main mailbox's readers when the conversation sits there. Nothing is read per person: the switches are
 * read once for all (and cached).
 */

export type ConversationKind = 'call' | 'text' | 'email';

type Where = Record<string, unknown>;
type RecordType = 'JOB' | 'LEAD' | 'CUSTOMER' | 'ESTIMATE' | 'INVOICE';
interface RecordRef { type: RecordType; id: string }

const RESOURCE: Record<RecordType, ScopeResource> = {
  JOB: 'Job', LEAD: 'Lead', CUSTOMER: 'Customer', ESTIMATE: 'Estimate', INVOICE: 'Invoice',
};

/** A person who may use the section, with what the single read needs to know about them. */
interface Reader {
  person: PermissionUser;
  ability: AppAbility;
  scope: CommunicationScopeValue;
  seeMainLineWhenNoNumber: boolean;
  /** The people whose own conversations the section lists for this reader (`peopleForScope`): themself, or their department. */
  people: string[];
}

/**
 * The ids, among `people`, who may read the conversation `id` of this `kind` in the company.
 *
 * For a text conversation `messageId` narrows the question to ONE message of it: who may read that very text when they open the
 * conversation (the message read rule, which holds the message back from a person who reaches neither its number, its sender
 * nor its record). A text alert quotes one message, so it asks this: a person is told about a text only if they read it. Without
 * it the question is the conversation's: at least one of its messages opens for the person.
 *
 * For an email conversation `messageId` asks the same of one email of it (M1, ticket 31: mail reach is per message, so a reply's
 * bell goes only to people who open that reply, never to someone who opens another message of the conversation). A message that
 * is not in the conversation is read by nobody. `wholeConversation` asks instead who reaches the conversation itself, by the
 * section rule (a mailbox they hold, the main mailbox they read, the record it follows): the reach a held reply's item and its
 * link need, which no single message of the conversation gives. Asked with both, a person must reach the conversation AND open
 * that message: who a reply's bell can go to, since the bell opens the conversation in the Email list and then the reply.
 *
 * Who a customer's reply bell may go to, and where each one's bell links, is `emailBellLinks` below.
 */
export async function readersOfConversation(
  people: PermissionUser[], kind: ConversationKind, id: string, organizationId: string,
  opts: { messageId?: string | null; wholeConversation?: boolean } = {},
): Promise<Set<string>> {
  // Nobody from another company reads this company's conversation, whoever the caller hands over.
  const ofCompany = people.filter((p) => p.organization_id === organizationId);
  if (ofCompany.length === 0) return new Set();
  switch (kind) {
    case 'call': return callReaders(ofCompany, id, organizationId);
    case 'text': return textReaders(ofCompany, id, organizationId, opts.messageId ?? null);
    case 'email': return new Set((await emailReaders(ofCompany, id, organizationId, opts.messageId ?? null, opts.wholeConversation === true, null)).keys());
  }
}

/**
 * Who, among `people`, may be told about the customer's reply `messageId` in the email conversation `id`, and the Email list each
 * one's bell must open (M1, ticket 31; Ran 2026-10-28: an alert always links to a list where THAT recipient sees the
 * conversation). The value is the `mailbox` the link carries: the conversation's own mailbox when that mailbox's list shows it to
 * the person, else null for "My mailbox" when that list shows it, else (scope All, a conversation in no mailbox) 'all'. A person
 * who opens the reply but whom no list shows the conversation is absent: they are told nothing.
 *
 * The lists are the Email page's own (communicationScope.ts): the section is built from the same inputs, and the selection is
 * narrowed by `selectionNarrowing` itself, run in memory over this one conversation. So the main mailbox leaves the record's
 * people out exactly as the page does, and "My mailbox" counts only the person's own assignment and authorship. `recordPeople`
 * are the people of the record a record conversation follows (the job's or lead's, as the page's list for them has it).
 */
export async function emailBellLinks(
  people: PermissionUser[], id: string, organizationId: string, opts: { messageId: string; recordPeople: readonly string[] },
): Promise<Map<string, string | null>> {
  const ofCompany = people.filter((p) => p.organization_id === organizationId);
  if (ofCompany.length === 0) return new Map();
  return emailReaders(ofCompany, id, organizationId, opts.messageId, true, { recordPeople: opts.recordPeople });
}

// ─── Who may use the section ────────────────────────────────────────────────────────────────

/**
 * The people who hold View communication and Access Communication (the route's gate and the section's), with their
 * Communication scope. Everyone else cannot read any conversation. One many-people switch read; each person's ability is
 * then built from the cached values, and a person whose permissions cannot be worked out is left out (fail closed).
 */
async function readersInSection(people: PermissionUser[]): Promise<Reader[]> {
  const values: Map<string, ResolvedSwitches> = await resolveSwitchesForPeople(people);
  const teams = await teamsOf(people.filter((p) => scopeValueOf(values.get(p.id)?.communication_scope) === 'team'));
  const readers: Reader[] = [];
  for (const person of people) {
    try {
      const ability = await abilityForUser(person);
      if (!ability.can('read', 'Communication') || !ability.can('access_inbox', 'Communication')) continue;
      const own = values.get(person.id);
      readers.push({
        person, ability, scope: scopeValueOf(own?.communication_scope),
        seeMainLineWhenNoNumber: own?.see_main_line_when_no_number === true,
        people: scopeValueOf(own?.communication_scope) === 'team' ? teams.get(person.id) ?? [] : [person.id],
      });
    } catch (err) {
      logger.warn('[conversationReaders] permissions could not be worked out - leaving the person out', {
        personId: person.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return readers;
}

/**
 * The people of each Team reader's department, in two reads however many readers there are. The department is read from
 * the database, not from the person handed in: a caller may hold a partial person, and a missing department must not read
 * as "none" for someone who has one. A reader with no department has no people (P3).
 */
async function teamsOf(readers: PermissionUser[]): Promise<Map<string, string[]>> {
  const teams = new Map<string, string[]>();
  if (readers.length === 0) return teams;
  const own = await prisma.user.findMany({ where: { id: { in: readers.map((r) => r.id) } }, select: { id: true, department_id: true } });
  const departments = [...new Set(own.flatMap((u) => u.department_id ?? []))];
  const members = departments.length > 0
    ? await prisma.user.findMany({ where: { department_id: { in: departments } }, select: { id: true, department_id: true } })
    : [];
  for (const u of own) {
    teams.set(u.id, u.department_id ? members.filter((m) => m.department_id === u.department_id).map((m) => m.id) : []);
  }
  return teams;
}

// ─── The inputs the rule reads ──────────────────────────────────────────────────────────────

/** The company numbers each person is linked to, and the main line, read together for everyone under Attached. */
async function numberInputsFor(readers: Reader[], organizationId: string) {
  const narrow = readers.filter((r) => r.scope !== 'all');
  const linked = new Map<string, string[]>();
  if (narrow.length === 0) return { linked, orgDefaultNumberId: null as string | null };
  const links = await prisma.userPhoneNumber.findMany({
    where: { user_id: { in: [...new Set(narrow.flatMap((r) => r.people))] }, phone_number: { organization_id: organizationId } },
    select: { user_id: true, phone_number_id: true },
  });
  const byPerson = new Map<string, string[]>();
  for (const link of links) byPerson.set(link.user_id, [...(byPerson.get(link.user_id) ?? []), link.phone_number_id]);
  // A reader's numbers are those linked to any of their people.
  for (const r of narrow) linked.set(r.person.id, [...new Set(r.people.flatMap((id) => byPerson.get(id) ?? []))]);
  // The main line is looked up only when the fallback could apply to someone: no linked number and the switch on.
  const needsMainLine = narrow.some((r) => (linked.get(r.person.id)?.length ?? 0) === 0 && r.seeMainLineWhenNoNumber);
  const orgDefault = needsMainLine
    ? await prisma.phoneNumber.findFirst({ where: { organization_id: organizationId, is_org_default: true }, select: { id: true } })
    : null;
  return { linked, orgDefaultNumberId: orgDefault?.id ?? null };
}

const OPEN: Where = {};
const closed = (): Where => ({ ...MATCH_NOTHING });

/** The record a row hangs off, by the precedence job > lead > customer (a vendor is not a record the reach opens). */
function recordOf(ties: { job_id: string | null; lead_id: string | null; customer_id: string | null }): RecordRef | null {
  if (ties.job_id) return { type: 'JOB', id: ties.job_id };
  if (ties.lead_id) return { type: 'LEAD', id: ties.lead_id };
  if (ties.customer_id) return { type: 'CUSTOMER', id: ties.customer_id };
  return null;
}

/** "Does this person reach this record": phase one has reached nothing; phase two asks the people phase one left out. */
type Reaches = (personId: string, ref: RecordRef) => boolean;
const reachesNothing: Reaches = () => false;

const refKey = (ref: RecordRef): string => `${ref.type}:${ref.id}`;

/**
 * What the rule's `reach` input says about ONE record, for a person: that record opens (an unrestricted scope) or nothing
 * does. The rule only ever asks about the record a row hangs off, so this is exactly the person's real reach as far as
 * that row is concerned.
 */
function reachOf(r: Reader, record: RecordRef | null, reaches: Reaches): RecordReach {
  const opens = (type: RecordType) => (record?.type === type && reaches(r.person.id, record) ? OPEN : closed());
  return { job: opens('JOB'), lead: opens('LEAD'), customer: opens('CUSTOMER'), vendors: r.ability.can('read', 'Vendor') };
}

function scopeInputs(r: Reader, reach: RecordReach, rest: Partial<CommunicationScopeInputs> = {}): CommunicationScopeInputs {
  return {
    personId: r.person.id, personIds: r.people, scope: r.scope, linkedNumberIds: [], seeMainLineWhenNoNumber: false, orgDefaultNumberId: null,
    mailboxIds: [], mainMailboxId: null, recordThreadIds: [], repliedMessageIds: [], reach, ...rest,
  };
}

/**
 * Who, among `people`, can open each record: an unrestricted scope opens it without a look (as the single read does), the
 * rest are looked at together, once for the record.
 */
function recordReach(readers: Reader[]) {
  const answers = new Map<string, Promise<Set<string>>>();
  return (ref: RecordRef): Promise<Set<string>> => {
    const key = refKey(ref);
    let answer = answers.get(key);
    if (!answer) {
      answer = (async () => {
        const reached = new Set<string>();
        const asked: PermissionUser[] = [];
        for (const r of readers) {
          const scope = await scopeWhereForUser(r.person, RESOURCE[ref.type]);
          if (Object.keys(scope).length === 0) reached.add(r.person.id);
          else asked.push(r.person);
        }
        if (asked.length > 0) (await readersWithEntityAccess(asked, ref)).withAccess.forEach((id) => reached.add(id));
        return reached;
      })();
      answers.set(key, answer);
    }
    return answer;
  };
}

/**
 * Ask the rule in two steps. First with no record reached: whoever the conversation's own ties settle (a linked number, a
 * mailbox they hold, a message they sent) never costs a look at a record. Then, for the rest, with the records they reach.
 */
async function askInTwoSteps(
  readers: Reader[],
  records: () => RecordRef[],
  readable: (r: Reader, reaches: Reaches) => boolean,
): Promise<Set<string>> {
  const out = new Set<string>();
  const left: Reader[] = [];
  for (const r of readers) {
    if (r.scope === 'all' || readable(r, reachesNothing)) out.add(r.person.id);
    else left.push(r);
  }
  if (left.length === 0) return out;

  const reach = recordReach(left);
  const refs = new Map(records().map((ref) => [refKey(ref), ref]));
  const reached = new Map<string, Set<string>>();
  for (const [key, ref] of refs) reached.set(key, await reach(ref));
  const reaches: Reaches = (personId, ref) => reached.get(refKey(ref))?.has(personId) ?? false;
  for (const r of left) if (readable(r, reaches)) out.add(r.person.id);
  return out;
}

// ─── A call ─────────────────────────────────────────────────────────────────────────────────

async function callReaders(people: PermissionUser[], id: string, organizationId: string): Promise<Set<string>> {
  const call = await prisma.callSession.findFirst({
    where: { id, organization_id: organizationId },
    select: { phone_number_id: true, agent_id: true, job_id: true, lead_id: true, customer_id: true, vendor_id: true },
  });
  if (!call) return new Set();
  const readers = await readersInSection(people);
  const numbers = await numberInputsFor(readers, organizationId);
  const record = recordOf(call);
  return askInTwoSteps(readers, () => (record ? [record] : []), (r, reaches) =>
    rowMatchesWhere(call as Row, callReadWhere(scopeInputs(r, reachOf(r, record, reaches), numberRest(r, numbers)))),
  );
}

function numberRest(r: Reader, numbers: Awaited<ReturnType<typeof numberInputsFor>>): Partial<CommunicationScopeInputs> {
  return {
    linkedNumberIds: numbers.linked.get(r.person.id) ?? [],
    seeMainLineWhenNoNumber: r.seeMainLineWhenNoNumber,
    orgDefaultNumberId: numbers.orgDefaultNumberId,
  };
}

// ─── A text conversation ────────────────────────────────────────────────────────────────────

async function textReaders(people: PermissionUser[], id: string, organizationId: string, messageId: string | null): Promise<Set<string>> {
  const thread = await prisma.messageThread.findFirst({
    where: { id, organization_id: organizationId },
    select: {
      customer_id: true, vendor_id: true, user_id: true,
      messages: {
        select: { id: true, thread_id: true, direction: true, ts: true, created_at: true, phone_number_id: true, sent_by_user_id: true, job_id: true, lead_id: true },
      },
    },
  });
  if (!thread) return new Set();
  const readers = await readersInSection(people);
  const numbers = await numberInputsFor(readers, organizationId);
  const threadRow = { user_id: thread.user_id, customer_id: thread.customer_id, vendor_id: thread.vendor_id };
  const recordOfMessage = (m: { job_id: string | null; lead_id: string | null }) =>
    recordOf({ job_id: m.job_id, lead_id: m.lead_id, customer_id: thread.customer_id });

  // One message of the conversation (a text alert's) or all of them (the conversation's own question).
  const asked = messageId ? thread.messages.filter((m) => m.id === messageId) : thread.messages;
  const records = () => asked.flatMap((m) => recordOfMessage(m) ?? []);
  // Reply attribution (an inbound text is the person's when the latest outbound before it was theirs) is left out of the
  // conversation's question on purpose: it only ever names messages in a conversation the person has sent a text in, and that
  // text is a message of their own, which opens the conversation by itself. Asked per conversation, it can change no answer.
  // Asked of one message it can: the reply is theirs while the message it answers is not on their number, so it is read here.
  const repliedTo = messageId ? replySendersOf(thread.messages).get(messageId) ?? null : null;
  // A conversation opens when at least one of its messages does (the conversation's own existence is information).
  return askInTwoSteps(readers, records, (r, reaches) =>
    asked.some((m) => {
      const inputs = scopeInputs(r, reachOf(r, recordOfMessage(m), reaches), {
        ...numberRest(r, numbers),
        repliedMessageIds: repliedTo !== null && r.people.includes(repliedTo) ? [m.id] : [],
      });
      return rowMatchesWhere({ ...m, thread: threadRow }, textReadWhere(inputs));
    }),
  );
}

// ─── An email conversation ──────────────────────────────────────────────────────────────────

async function emailReaders(
  people: PermissionUser[], id: string, organizationId: string, messageId: string | null, wholeConversation: boolean,
  inEmailList: { recordPeople: readonly string[] } | null,
): Promise<Map<string, string | null>> {
  // While the company's Email plan feature is off nobody reads a conversation (the routes answer with a filter that matches
  // nothing). One read of the company's plan columns, for the whole alert.
  if (!(await orgEmailFeatureOn(prisma, organizationId))) return new Map();
  const thread = await prisma.emailThread.findFirst({
    where: { id, organization_id: organizationId },
    select: {
      id: true, mailbox_id: true, origin: true, record_type: true, record_id: true, assigned_to_user_id: true,
      mailbox: { select: { kind: true, holder_user_id: true, user_id: true, status: true } },
      emails: {
        select: {
          id: true, thread_id: true, job_id: true, lead_id: true, customer_id: true, vendor_id: true, sent_by_user_id: true,
          direction: true, inbound_match: true,
        },
      },
    },
  });
  if (!thread) return new Map();
  // M7 (ticket 36): the bell opens the conversation on the Email page, which a person whose Show Email is off cannot use (the
  // mail routes refuse them), so no lane tells them: if no list shows them the conversation, they get no alert. The Admin flag
  // opens every page whatever the switches, so an Admin's ability keeps the check true. This only leaves the person out of who
  // may be told; the reply's fallback (the record's people, then the linked readers, then the Admins) still runs for the rest.
  const readers = (await readersInSection(people)).filter((r) => r.ability.can('show_email', 'Communication'));
  const mainReaders = await mainMailboxReadersOf(readers, thread, organizationId);

  const threadRow = {
    id: thread.id, mailbox_id: thread.mailbox_id, origin: thread.origin, record_type: thread.record_type,
    record_id: thread.record_id, assigned_to_user_id: thread.assigned_to_user_id, emails: thread.emails,
  };
  // A conversation opened about a job, lead, estimate, invoice, calendar entry or customer follows that record.
  const followed = recordFollowedBy(thread);
  const recordOfEmail = (m: (typeof thread.emails)[number]) => recordOf(m);
  const records = () => [...(followed?.records ?? []), ...thread.emails.flatMap((m) => recordOfEmail(m) ?? [])];

  // The Email page's lists for this conversation (communicationScope.ts), built for one reader: their section, then each list
  // the bell could open, narrowed by the page's own `selectionNarrowing`. The candidates for the list's record branches are the
  // page's too: a record conversation is in the section when its record is reached AND it sits in a mailbox they hold, is
  // assigned to them or they wrote in it (`recordThreadsTheyReach`, 'theirs'), or they are one of the record's people and the
  // customer has replied (`recordPeopleThreadsTheyReach`).
  const customerReplied = thread.emails.some((m) => m.direction === 'in' && (m.inbound_match === null || m.inbound_match === 'MATCHED'));
  const PEOPLE_RECORD_TYPES = ['job', 'lead', 'estimate', 'invoice'];
  const listOf = (r: Reader, reaches: Reaches, recordPeople: readonly string[]): string | null | undefined => {
    const box = thread.mailbox_id;
    // The mailboxes a person holds are theirs and, under Team, their department's (`heldMailboxesFor`); a merged one nobody holds.
    const holders = [r.person.id, ...r.people];
    const holds = box !== null && thread.mailbox?.holder_user_id != null && holders.includes(thread.mailbox.holder_user_id) && thread.mailbox.status !== 'merged';
    const own = holds && thread.mailbox?.user_id === r.person.id;
    const readsMain = box !== null && thread.mailbox?.kind === 'main' && mainReaders.has(r.person.id);
    const reached = followed !== null && followed.records.length > 0 && followed.records.every((ref) => reaches(r.person.id, ref));
    const theirs = holds
      || (thread.assigned_to_user_id !== null && r.people.includes(thread.assigned_to_user_id))
      || thread.emails.some((m) => m.sent_by_user_id !== null && r.people.includes(m.sent_by_user_id));
    const asPerson = reached && customerReplied && PEOPLE_RECORD_TYPES.includes(thread.record_type ?? '') && recordPeople.some((p) => r.people.includes(p));
    const inputs = scopeInputs(r, reachOf(r, null, reaches), {
      mailboxIds: holds ? [box!] : [],
      mainMailboxId: readsMain ? box : null,
      recordThreadIds: reached && theirs ? [thread.id] : [],
      recordPeopleThreadIds: asPerson ? [thread.id] : [],
    });
    const section: EmailSection = {
      scope: r.scope, personId: r.person.id, where: emailsInSectionWhere(inputs),
      mailboxes: { held: holds ? [box!] : [], main: readsMain ? box : null, own: own ? box : null, handedOver: [] },
      inputs,
    };
    const row = { thread: threadRow };
    // The conversation's own mailbox first (a person who sees it there keeps that link), then "My mailbox". A mailbox the person
    // may not open reads as "My mailbox" on the page (`resolveMailboxSelection`), so it is no list of its own.
    const lists: { selection: MailboxSelection; link: string | null }[] = [
      ...(holds || readsMain ? [{ selection: { kind: 'mailbox' as const, id: box! }, link: box }] : []),
      { selection: { kind: 'mine' as const }, link: null },
    ];
    for (const { selection, link } of lists) {
      if (rowMatchesWhere(row, narrowedTo(section.where, selectionNarrowing(section, selection)))) return link;
    }
    return undefined;
  };

  // One message of it (a reply's bell), or every message (the conversation opens when any one does).
  const asked = messageId ? thread.emails.filter((m) => m.id === messageId) : thread.emails;
  const links = new Map<string, string | null>();
  const told = await askInTwoSteps(readers, records, (r, reaches) => {
    // The mailboxes a person holds are their own and, under Team, their department's: the same holders `listOf` and the Email
    // page use (`heldMailboxesFor` always adds the person), so a Team reader with no department still holds their own (CR-6).
    const holders = [r.person.id, ...r.people];
    const held = thread.mailbox_id && thread.mailbox?.holder_user_id && holders.includes(thread.mailbox.holder_user_id) && thread.mailbox.status !== 'merged' ? thread.mailbox_id : null;
    const followsReachedRecord = followed !== null && followed.records.length > 0 && followed.records.every((ref) => reaches(r.person.id, ref));
    const sectionInputs = (reach: RecordReach) => scopeInputs(r, reach, {
      mailboxIds: held ? [held] : [],
      mainMailboxId: mainReaders.has(r.person.id) ? thread.mailbox_id : null,
      recordThreadIds: followsReachedRecord ? [thread.id] : [],
    });
    const opens = () => asked.some((m) => rowMatchesWhere({ ...m, thread: threadRow }, emailReadWhere(sectionInputs(reachOf(r, recordOfEmail(m), reaches)))));
    if (inEmailList) {
      // A bell: the person opens the reply AND one of the Email page's lists shows them the conversation.
      const link = listOf(r, reaches, inEmailList.recordPeople);
      if (link === undefined || !opens()) return false;
      links.set(r.person.id, link);
      return true;
    }
    if (wholeConversation) {
      // The conversation itself, as the section rule reaches it: no message's own tie counts.
      const reachesIt = rowMatchesWhere({ thread: threadRow }, emailsInSectionWhere(sectionInputs(reachOf(r, null, reaches))));
      // Asked with a message too, both must hold: the person reaches the conversation AND opens that message.
      if (!messageId || !reachesIt) return reachesIt;
    }
    return opens();
  });
  // A person on All (asked no question: they read everything) opens the conversation's own mailbox, or every mailbox.
  for (const id of told) if (!links.has(id)) links.set(id, inEmailList ? thread.mailbox_id ?? 'all' : null);
  return links;
}

/**
 * The records a conversation follows, or null for an ordinary one: the same candidates the Email page asks about (a record
 * conversation of a kind that follows its record, with the record named). A calendar entry joins nothing, so it is tied to
 * the customers it was sent to, and every one of them must be reachable; one that names none is reachable by no one.
 */
function recordFollowedBy(thread: {
  origin: string; record_type: string | null; record_id: string | null;
  emails: { customer_id: string | null }[];
}): { records: RecordRef[] } | null {
  if (thread.origin !== 'record' || !isFollowingRecordType(thread.record_type) || !thread.record_id) return null;
  switch (thread.record_type) {
    case 'job': return { records: [{ type: 'JOB', id: thread.record_id }] };
    case 'lead': return { records: [{ type: 'LEAD', id: thread.record_id }] };
    case 'customer': return { records: [{ type: 'CUSTOMER', id: thread.record_id }] };
    case 'estimate': return { records: [{ type: 'ESTIMATE', id: thread.record_id }] };
    case 'invoice': return { records: [{ type: 'INVOICE', id: thread.record_id }] };
    case 'calendar_entry': {
      const customers = [...new Set(thread.emails.flatMap((e) => e.customer_id ?? []))];
      return { records: customers.map((id) => ({ type: 'CUSTOMER' as const, id })) };
    }
  }
}

/**
 * Who reads the company's main mailbox, among the people under Attached, when the conversation sits in it: a person
 * linked to it, or, while nobody ACTIVE is, an Admin (the same rule as the Email page; it was the holders of Manage roles and
 * permissions until that switch retired, AL-18).
 * One read of the mailbox's readers; nothing at all for a conversation in any other mailbox.
 */
async function mainMailboxReadersOf(
  readers: Reader[], thread: { mailbox_id: string | null; mailbox: { kind: string } | null }, organizationId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!thread.mailbox_id || thread.mailbox?.kind !== 'main') return out;
  const narrow = readers.filter((r) => r.scope !== 'all');
  if (narrow.length === 0) return out;
  const rows = await prisma.mailboxReader.findMany({
    where: { mailbox_id: thread.mailbox_id, organization_id: organizationId },
    select: { user_id: true, user: { select: { is_active: true } } },
  });
  const linked = new Set(rows.map((row) => row.user_id));
  const anyoneActive = rows.some((row) => row.user.is_active);
  for (const r of narrow) {
    if (linked.has(r.person.id) || (!anyoneActive && isSuperUser(r.person))) out.add(r.person.id);
  }
  return out;
}
