/**
 * emailReplyAlerts.ts - who a customer's email reply rings (Roles & Permissions, PRD 10, S10.10). The email verb on M6.
 *
 * Nobody is addressed by a role name, and the bell is the only channel. A recipient is always "someone": active, holding Access
 * Communication, and able to read the conversation under their Communication scope (the single read of an email conversation,
 * `readersOfConversation`, which for a record conversation also asks whether they can open the record and, for an estimate or an
 * invoice, that estimate or invoice). The single read is asked for everybody at once, never for one person at a time.
 *
 * A RECORD CONVERSATION (the one a send to a customer opens about a job, lead, estimate or invoice). Replies go to the record's
 * people, never to a shared box.
 *   Lane 1, always told: the holder of the user mailbox the conversation sits in (whoever took it over), the person who sent the
 *     mail being answered by hand, the record's Owner or Sold By, its crew, its Dispatcher and the conversation's assignee.
 *   Fallback, only when lane 1 finds nobody: the people linked to the main mailbox who can read it, else the company's
 *     Admins, told why ("This job has no Dispatcher or Sold By who can take this reply"). Nobody who cannot read the
 *     conversation is told, so there is no alert without details: an alert never says more to a person than the screens show them.
 *   Copies: holders of the "Alert me about every ..." switch of the record's kind, on top, if they can read the conversation.
 *
 * A reply in an ORDINARY conversation (started here, migrated, moved in) rings its assignee, else its mailbox's holder. In the main
 * mailbox, which has no holder, it rings the people linked to it who can read the conversation; while nobody active is linked, the
 * company's Admins, told why ("Nobody is linked to the main mailbox").
 *
 * "The mail being answered": the latest mail that went OUT in the conversation, whose sender is recorded on it (`sent_by_user_id`,
 * written by a hand send; an automated send records nobody, and then a reply has no hand sender). The reply token the customer
 * answered on names the same person (`created_by_user_id`) but a token is reused for every later mail in the conversation, so the
 * sent mail is the one that says who sent THIS one. The person who sent it is lane 1 as the hand sender whatever else they are on
 * the record (a crew member who sent the mail is told once, as the sender), while they can still read the conversation.
 *
 * A reply from an address we did not send to (a token reply held in a Needs review list, S10.19) rings exactly the people a customer's
 * reply in the token's conversation would, by the same walk (lanes, fallback, copies, the ordinary conversation's assignee, holder or
 * readers): only the words of the bell differ, and it opens the held message instead of the Email page.
 *
 * The bell opens the conversation it is about (`conversationLink`), in a list where THAT person sees it (Ran 2026-10-28; M1,
 * ticket 31): the mailbox it sits in when that mailbox's list shows it to them, else "My mailbox" (`emailBellLinks`, which asks the
 * Email page's own lists). A person no list shows it to is not rung, so nobody is told about a reply they cannot follow; people
 * whose bells open different lists get one alert per list. The held reply above opens the held message instead.
 *
 * A chain that ends with nobody is logged (kind of alert, conversation and company, nothing the customer said), never dropped.
 * While ServWave has the Email plan feature off for the company nobody is rung and no chain runs (the webhook does not call this,
 * and this checks again). A redelivery rings nobody twice: the dedup key is the provider's message id, the alert with the reason
 * line adds `:why` (WHY_KEY), an alert that opens a list other than the conversation's own mailbox adds that list (`:mine`,
 * `:all`), and all of them are looked for before anything is read.
 *
 * Cost, the same for a company of 20 and of 270: the dedup check, the conversation, the plan, the company's active people, their
 * switches, the record's people, then the single read for lane 1 and the copies and, only when lane 1 found nobody, a second one
 * for the fallback (the main mailbox's links, then the single read). Nothing is read per person. Sent after the delivery was
 * acknowledged and after the reply was committed, never inside a transaction.
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { jobCrewIds } from '../../lib/job-crew';
import { isFollowingRecordType } from '../../lib/communication/communicationScope';
import { emailBellLinks, readersOfConversation } from '../../lib/communication/conversationReaders';
import { orgEmailFeatureOn } from '../../lib/communication/emailFeature';
import { linkedReaderIds } from '../../lib/communication/mainMailboxReaders';
import { tieOf } from '../../lib/communication/recordTie';
import type { PermissionUser } from '../../lib/permissions/enforce';
import { isSuperUser } from '../../lib/permissions/effectiveRole';
import { resolveSwitchesForPeople } from '../../lib/permissions/switches/store';
import { logNobodyToTell, sendByWhyLine, WHY_KEY, type TwoLaneAnswer } from './alertChain';
import { emit } from './notificationService';
import { conversationLink } from './conversationLink';
import { unmatchedReplyLink } from './unmatchedReplyLink';

/** PRD 10's reason line for a job, word for word. */
export const NO_ONE_ON_JOB_REASON = 'This job has no Dispatcher or Sold By who can take this reply';
/** The same sentence for a lead, which has an Owner where a job has a Sold By. */
export const NO_ONE_ON_LEAD_REASON = 'This lead has no Dispatcher or Owner who can take this reply';
/** For a conversation about a record that has no job or lead (an invoice made for the customer alone, a customer's own). */
export const NO_ONE_ON_RECORD_REASON = 'Nobody on this conversation\'s record can take this reply';
/** PRD 10's reason line for a reply in the main mailbox while nobody active is linked to it. */
export const NOBODY_LINKED_REASON = 'Nobody is linked to the main mailbox';

const REPLY_VERB = 'communication.email_inbound';
const ALERT_NAME = 'customer email reply alert';

/** The "Alert me about every ..." switch of each kind of record a conversation can be about. */
/** The lists a reply bell can open besides the conversation's own mailbox (`emailBellLinks`): "My mailbox", and every mailbox. */
const OWN_LIST = 'own';
const OTHER_LISTS = ['mine', 'all'] as const;

const COPY_SWITCH: Record<string, string> = {
  job: 'alert_every_job', lead: 'alert_every_lead', estimate: 'alert_every_estimate', invoice: 'alert_every_invoice',
};

export interface EmailReplyAlertArgs {
  organizationId: string;
  threadId: string;
  /** The provider's id for the received message: what makes a redelivery the same event. */
  providerMessageId: string;
  /**
   * The stored reply itself (the email row): the bell quotes it, so it goes only to people who open THIS message (M1, ticket 31),
   * never to someone who opens another message of the conversation. For a held reply it is the held message, read through the
   * conversation its reply address belongs to (`heldEmailId`).
   */
  emailId: string;
  /** Who the reply is from, as the bell shows it. */
  senderLabel: string;
  subject: string;
  /**
   * Set when the reply came from an address we did not send to (a token reply held in a Needs review list): the id of the held
   * message. `threadId` is then the conversation its reply address belongs to, which it joined nothing of; it rings the same
   * people a customer's reply there would, with the bell that opens that held message (S10.19).
   */
  heldEmailId?: string;
}

// ─── The record's people ─────────────────────────────────────────────────────────────────────────────────────────────────

const crew = { visits: { select: { assignees: { select: { user_id: true } } } } } as const;
const jobPeopleSelect = { salesperson_id: true, dispatcher_id: true, ...crew } as const;
const leadPeopleSelect = { commission_owner_id: true, dispatcher_id: true, ...crew } as const;

interface JobRow { salesperson_id: string | null; dispatcher_id: string | null; visits: { assignees: { user_id: string }[] }[] }
interface LeadRow { commission_owner_id: string | null; dispatcher_id: string | null; visits: { assignees: { user_id: string }[] }[] }

/** The people on the record a conversation is about, and which reason line fits when none of them can take a reply. */
interface RecordPeople {
  people: string[];
  reason: string;
}

const present = (ids: Array<string | null | undefined>): string[] => ids.flatMap((id) => id ?? []);
const jobPeople = (job: JobRow | null | undefined): string[] => (job ? present([job.salesperson_id, job.dispatcher_id, ...jobCrewIds(job)]) : []);
const leadPeople = (lead: LeadRow | null | undefined): string[] => (lead ? present([lead.commission_owner_id, lead.dispatcher_id, ...jobCrewIds(lead)]) : []);

/**
 * The people of the job or lead a record conversation is tied to (`tieOf`, the one rule: an estimate to its job else its lead; an
 * invoice to its own job, else its estimate's job, else its estimate's lead). An estimate's lead Owner is also one of its people
 * when the estimate sits on a job, as M6's estimate alerts and the Email page's list for the record's people have it.
 * Read from the records on every alert, so a person taken off a crew is not rung.
 */
async function recordPeopleOf(organizationId: string, record: { type: string | null; id: string | null }): Promise<RecordPeople> {
  const none: RecordPeople = { people: [], reason: NO_ONE_ON_RECORD_REASON };
  if (!record.type || !record.id) return none;
  const where = { id: record.id, organization_id: organizationId };
  const ofJob = (job: JobRow | null | undefined): RecordPeople => ({ people: jobPeople(job), reason: NO_ONE_ON_JOB_REASON });
  const ofLead = (lead: LeadRow | null | undefined): RecordPeople => ({ people: leadPeople(lead), reason: NO_ONE_ON_LEAD_REASON });

  switch (record.type) {
    case 'job':
      return ofJob(await prisma.job.findFirst({ where, select: jobPeopleSelect }));
    case 'lead':
      return ofLead(await prisma.lead.findFirst({ where, select: leadPeopleSelect }));
    case 'estimate': {
      const estimate = await prisma.estimate.findFirst({
        where,
        select: { job_id: true, lead_id: true, lead: { select: leadPeopleSelect }, job_link: { select: jobPeopleSelect } },
      });
      if (!estimate) return none;
      const tie = tieOf({ type: 'estimate', jobId: estimate.job_id, leadId: estimate.lead_id });
      if (tie.jobId) {
        const found = ofJob(estimate.job_link);
        return { ...found, people: [...found.people, ...present([estimate.lead?.commission_owner_id])] };
      }
      return tie.leadId ? ofLead(estimate.lead) : none;
    }
    case 'invoice': {
      const invoice = await prisma.invoice.findFirst({
        where,
        select: {
          job_id: true, job: { select: jobPeopleSelect },
          estimate: { select: { job_id: true, lead_id: true, lead: { select: leadPeopleSelect }, job_link: { select: jobPeopleSelect } } },
        },
      });
      if (!invoice) return none;
      const tie = tieOf({
        type: 'invoice', jobId: invoice.job_id,
        estimate: invoice.estimate ? { jobId: invoice.estimate.job_id, leadId: invoice.estimate.lead_id } : null,
      });
      if (tie.jobId) return ofJob(invoice.job_id ? invoice.job : invoice.estimate?.job_link);
      return tie.leadId ? ofLead(invoice.estimate?.lead) : none;
    }
    default:
      // A customer's own conversation, a calendar entry: no job or lead whose people they could be.
      return none;
  }
}

// ─── The chain ───────────────────────────────────────────────────────────────────────────────────────────────────────────

interface ThreadFacts {
  mailbox_id: string | null;
  origin: string;
  record_type: string | null;
  record_id: string | null;
  assigned_to_user_id: string | null;
  mailbox: { kind: string; holder_user_id: string | null; status: string } | null;
  emails: { sent_by_user_id: string | null }[];
}

/** What the lookups below share: the company's active people, their switches, and the single read of this conversation. */
interface Walk {
  organizationId: string;
  threadId: string;
  /** Holders of a switch among the company's active people. */
  holders(key: string): string[];
  /** The company's active Admins: the last fallback, since managing people and roles is theirs alone (AL-18). */
  admins: string[];
  /**
   * Who, among these ids, may read what the bell quotes: the reply itself, or, for a held reply (which sits in no conversation),
   * the conversation its item opens through. One batched read, asked of active people only.
   */
  readable(ids: string[], recordPeople?: readonly string[]): Promise<ReadonlySet<string>>;
}

const unique = (ids: string[]): string[] => [...new Set(ids)];

/** Lane 1, fallback and copies for a record conversation. */
async function recordConversationAnswer(walk: Walk, thread: ThreadFacts): Promise<{ answer: TwoLaneAnswer; owners: string[] }> {
  const { organizationId } = walk;
  const record = await recordPeopleOf(organizationId, { type: thread.record_type, id: thread.record_id });
  const holder = thread.mailbox?.kind === 'user' && thread.mailbox.status !== 'merged' ? thread.mailbox.holder_user_id : null;
  // The conversation's own people: the ones it is theirs to answer (their reply is interrupting, the rest are told on the feed).
  const handSender = thread.emails[0]?.sent_by_user_id ?? null;
  const owners = present([holder, handSender, thread.assigned_to_user_id]);
  const candidates = unique([...owners, ...record.people]);
  const copySwitch = COPY_SWITCH[thread.record_type ?? ''];
  const copyHolders = copySwitch ? walk.holders(copySwitch) : [];

  // Everyone told about it, the copies and the covering people included, must find it in the Email list the bell opens (M1).
  const reading = await walk.readable(unique([...candidates, ...copyHolders]), record.people);
  const laneOne = candidates.filter((id) => reading.has(id));
  const copies = copyHolders.filter((id) => reading.has(id));

  let fallback: string[] = [];
  if (laneOne.length === 0) {
    const linked = await linkedReaderIds(organizationId);
    const managers = walk.admins;
    const fallbackReading = await walk.readable(unique([...linked, ...managers]), record.people);
    fallback = linked.filter((id) => fallbackReading.has(id));
    if (fallback.length === 0) fallback = managers.filter((id) => fallbackReading.has(id));
  }
  return {
    answer: { laneOne, laneTwo: fallback, copies, fallbackReason: fallback.length ? record.reason : null },
    owners,
  };
}

/** The assignee, else the mailbox's holder; in the main mailbox, the people who read it. */
async function ordinaryConversationAnswer(walk: Walk, thread: ThreadFacts): Promise<{ answer: TwoLaneAnswer; owners: string[] }> {
  const { organizationId } = walk;
  const holder = thread.mailbox?.kind === 'user' && thread.mailbox.status !== 'merged' ? thread.mailbox.holder_user_id : null;
  const owners = present([thread.assigned_to_user_id, holder]);
  const reading = await walk.readable(owners);
  const first = owners.find((id) => reading.has(id));
  const answer: TwoLaneAnswer = { laneOne: first ? [first] : [], laneTwo: [], copies: [], fallbackReason: null };

  if (!first && thread.mailbox?.kind === 'main') {
    // The main mailbox has no holder: its readers are the people linked to it, and while nobody active is linked, the company's
    // Admins.
    const linked = await linkedReaderIds(organizationId);
    if (linked.length > 0) {
      const mainReading = await walk.readable(linked);
      answer.laneOne = linked.filter((id) => mainReading.has(id));
    } else {
      const managers = walk.admins;
      const mainReading = await walk.readable(managers);
      answer.laneTwo = managers.filter((id) => mainReading.has(id));
      answer.fallbackReason = answer.laneTwo.length ? NOBODY_LINKED_REASON : null;
    }
  }
  return { answer, owners };
}

/**
 * Ring the people a customer's reply is for. Returns everyone rung, [] when nobody was or the reply was already announced.
 * Never throws: like `emit`, a failure to alert must not reach the caller.
 */
export async function alertEmailReply(args: EmailReplyAlertArgs): Promise<string[]> {
  try {
    return await ringReplyPeople(args);
  } catch (err) {
    logger.warn('[emailReplyAlerts] could not send a customer reply alert', {
      organizationId: args.organizationId, threadId: args.threadId, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function ringReplyPeople(args: EmailReplyAlertArgs): Promise<string[]> {
  const { organizationId, threadId } = args;
  const dedupKey = `email_inbound:${args.providerMessageId}`;

  // A redelivery is the same event: nothing is read for it.
  const already = await prisma.notification.findFirst({
    where: {
      organization_id: organizationId,
      dedup_key: { in: [dedupKey, dedupKey + WHY_KEY].flatMap((key) => ['', ...OTHER_LISTS].map((list) => key + (list ? `:${list}` : ''))) },
    },
    select: { id: true },
  });
  if (already) return [];

  // No chain runs while the company's Email plan feature is off, so none is logged as ending with nobody.
  if (!(await orgEmailFeatureOn(prisma, organizationId))) return [];

  const thread = await prisma.emailThread.findFirst({
    where: { id: threadId, organization_id: organizationId },
    select: {
      mailbox_id: true, origin: true, record_type: true, record_id: true, assigned_to_user_id: true,
      mailbox: { select: { kind: true, holder_user_id: true, status: true } },
      // The mail being answered: the latest that went out, and who sent it by hand (nobody, for an automated send).
      emails: { where: { direction: 'out' }, orderBy: { ts: 'desc' }, take: 1, select: { sent_by_user_id: true } },
    },
  });
  if (!thread) return [];
  const people: PermissionUser[] = await prisma.user.findMany({
    where: { organization_id: organizationId, is_active: true },
    select: {
      id: true, role: true, organization_id: true, department_id: true, location_id: true,
      custom_role_id: true, is_admin: true, custom_role: { select: { key: true } },
    },
  });
  const keys = Object.values(COPY_SWITCH);
  const values = await resolveSwitchesForPeople(people, keys);
  // The `mailbox` each person's bell opens (see `emailBellLinks`): the conversation's own, null for "My mailbox", or 'all'.
  const bellLinks = new Map<string, string | null>();
  const walk: Walk = {
    organizationId,
    threadId,
    holders: (key) => people.filter((p) => values.get(p.id)?.[key] === true).map((p) => p.id),
    admins: people.filter(isSuperUser).map((p) => p.id),
    readable: async (ids, recordPeople = []) => {
      const asked = new Set(ids);
      const them = people.filter((p) => asked.has(p.id));
      if (!args.heldEmailId) {
        // Who can follow the bell, and the list each one's bell opens, from ONE answer, so the two cannot drift apart: the person
        // opens the reply AND one of the Email page's lists shows them the conversation. An owner who cannot falls through to the
        // mailbox's holder or the main mailbox's readers, exactly as one who reaches nothing; a copy or a cover nobody can follow
        // is not sent (Ran 2026-10-28).
        const found = await emailBellLinks(them, threadId, organizationId, { messageId: args.emailId, recordPeople });
        for (const [id, link] of found) bellLinks.set(id, link);
        return new Set(found.keys());
      }
      // Whoever is told must be able to follow the bell. A held reply is not a message of the conversation, and its bell opens the
      // held item, which opens to whoever reaches the conversation itself (needsReviewItemWhereForReq).
      return readersOfConversation(them, 'email', threadId, organizationId, { wholeConversation: true });
    },
  };

  const isRecordConversation = thread.origin === 'record' && Boolean(thread.record_type) && isFollowingRecordType(thread.record_type);
  const { answer, owners } = isRecordConversation
    ? await recordConversationAnswer(walk, thread)
    : await ordinaryConversationAnswer(walk, thread);

  if (!answer.laneOne.length && !answer.laneTwo.length && !answer.copies.length) {
    logNobodyToTell(ALERT_NAME, organizationId, { type: 'EMAIL_THREAD', id: threadId });
    return [];
  }

  const told: string[] = [];
  // One alert per list the bells open: the conversation's own mailbox keeps the plain key, any other list adds its name.
  const listOf = (id: string): string => {
    const link = bellLinks.get(id);
    return link === undefined || link === thread.mailbox_id ? OWN_LIST : link === null ? 'mine' : 'all';
  };
  const groupOf = args.heldEmailId
    ? undefined
    : async (ids: string[]) => new Map(ids.map((id) => [id, listOf(id)] as const));
  await sendByWhyLine(answer, async (entity, whyLine, list) => {
    const opens = list === null || list === OWN_LIST ? thread.mailbox_id : list === 'mine' ? null : 'all';
    const suffix = list === null || list === OWN_LIST ? '' : `:${list}`;
    told.push(...await emit({
      verb: REPLY_VERB,
      organizationId,
      // A customer is not a user of ours, so there is no actor to drop.
      actorId: null,
      object: { type: 'EMAIL_THREAD', id: threadId, label: args.senderLabel },
      // `conversation_owner_ids` is for the priority only: the people the conversation is theirs to answer are interrupted.
      entity: { ...entity, conversation_owner_ids: owners },
      data: {
        subject: args.subject,
        fallback_reason: whyLine ?? '',
        // The bell opens the conversation in the mailbox it sits in; a held reply opens the held message instead.
        link_path: conversationLink(threadId, opens),
        ...(args.heldEmailId ? { unmatched_reply: true, link_path: unmatchedReplyLink(args.heldEmailId) } : {}),
      },
      dedupKey: (whyLine ? dedupKey + WHY_KEY : dedupKey) + suffix,
      readersChecked: true,
    }));
  }, groupOf);
  return unique(told);
}
