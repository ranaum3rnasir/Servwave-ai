/**
 * conversationAlertRecipients.ts - who a missed call, a voicemail or an inbound text alerts (Roles & Permissions, PRD 8, S08.22
 * and S08.23).
 *
 * The union of the same groups for both kinds of conversation, never a role name:
 *   1. the people on the job or lead the call or text is tied to: its Owner or Sold By, its Dispatcher and its crew (the crew of
 *      a lead is its walkthroughs' crew; a lead's assignees are not among the record's people);
 *   2. the holders of Communication scope "All";
 *   3. everyone linked to the company number it came in on. For the main line (the Organization default number) that is
 *      the people ticked on it AND the people the main-line fallback covers: a person on "Linked to me" with no linked number
 *      of their own who holds "See the main line when I have no number" (M11's `effectiveLinkedNumberIds`, which a call log
 *      uses for the same person). A person with a number of their own who is not ticked on the main line is not covered;
 *   4. for a text only, the person reply attribution names: the sender of the latest outbound text before it, in the same
 *      conversation and on the same company number (M11's `replySendersOf`, the one rule the inbox lists and single reads use).
 *      They are told even with no linked number, and still have to pass everything below.
 *
 * Every one of them is an active person of the company, and the list is then run through the access filter
 * (filterByAccess.ts, S08.21), which keeps a person only if they hold View communication and Access Communication and the
 * single-read rule opens this call or conversation for them; for a text, the single read of THAT message (the text the alert quotes), so
 * nobody is told a text their thread then leaves out. The filter has the last word, so the answer is exactly the people
 * the section would show it to, and "nobody" below is known after it: an All holder who cannot use the section is not somebody.
 * A person who sent a text in a conversation reads it by that message alone (M11 counts a message the person sent as theirs), so
 * the filter keeps the person reply attribution names and drops one who may not use the section. `emit` does not ask the filter
 * a second time for these alerts.
 *
 * Nobody acts on an inbound missed call or text, so there is no actor to leave out, and "placed or answered" adds no one. The
 * "Alert me about every ..." switches belong to the record alerts and add nothing here.
 *
 * Cost: a constant number of reads however many people the company has (the call or the text, the record it hangs off, for a
 * text the one read of the conversation's messages on that number, the company's active people, their switches, the number's
 * links and, for the main line, the links of the people the fallback could cover, then the access filter's own batch). Nothing is
 * read per person.
 *
 * WHEN NOBODY IS FOUND the answer is an empty list. `emit` then hands the conversation to the never-silent fallback
 * (conversationAlertFallback.ts, S08.24), which is the one place that may tell a person this lookup, and the access filter inside it,
 * left out. `conversationAlertAudience` returns what the fallback needs beside the list (the number and the time of the call or
 * text), read here once; `conversationAlertRecipients` is the plain list.
 */

import { prisma } from '../../lib/prisma';
import { formatServWaveNumber } from '../performerPhone';
import { jobCrewIds } from '../../lib/job-crew';
import { resolveSwitchesForPeople } from '../../lib/permissions/switches/store';
import { replySendersOf, scopeValueOf } from '../../lib/communication/communicationScope';
import { filterRecipientsByAccess } from './filterByAccess';

const crew = { visits: { select: { assignees: { select: { user_id: true } } } } } as const;

/** The people on the job or lead a call or text is tied to: a job when it has one (the precedence M11 uses), else the lead. */
async function recordPeopleOf(call: { job_id: string | null; lead_id: string | null }): Promise<string[]> {
  if (call.job_id) {
    const job = await prisma.job.findUnique({
      where: { id: call.job_id },
      select: { salesperson_id: true, dispatcher_id: true, ...crew },
    });
    return job ? [job.salesperson_id, job.dispatcher_id, ...jobCrewIds(job)].flatMap((id) => id ?? []) : [];
  }
  if (call.lead_id) {
    const lead = await prisma.lead.findUnique({
      where: { id: call.lead_id },
      select: { commission_owner_id: true, dispatcher_id: true, ...crew },
    });
    return lead ? [lead.commission_owner_id, lead.dispatcher_id, ...jobCrewIds(lead)].flatMap((id) => id ?? []) : [];
  }
  return [];
}

/** What an alert is about: a call, or the inbound text of a conversation (its message when the caller knows it). */
export type ConversationAlert =
  | { kind: 'call'; organizationId: string; callId: string }
  | { kind: 'text'; organizationId: string; threadId: string; messageId?: string | null };

/** What the lookup needs to know about the call or the text, however it was read. */
export interface ConversationSubject {
  objectType: 'CALL' | 'MESSAGE_THREAD';
  objectId: string;
  /** The inbound text the alert quotes, for a text: who is told is who reads that message, not merely the conversation. */
  messageId: string | null;
  phone_number_id: string | null;
  is_org_default: boolean;
  job_id: string | null;
  lead_id: string | null;
  /** The person reply attribution names, for a text. */
  replySender: string | null;
  /** When the call started or the text arrived. */
  at: Date;
  /** The company number it came in on, as the app shows it; null when it is not one of the company's own numbers. */
  numberShown: string | null;
}

/** A company number as the company's own screens show it (the same rendering the emails use); null when there is no such number. */
const shownNumber = (number: { e164: string; formatted: string | null } | null | undefined): string | null =>
  number ? formatServWaveNumber(number) || null : null;

const numberFields = { is_org_default: true, e164: true, formatted: true } as const;

async function callSubject(organizationId: string, callId: string): Promise<ConversationSubject | null> {
  const call = await prisma.callSession.findFirst({
    where: { id: callId, organization_id: organizationId },
    select: { phone_number_id: true, job_id: true, lead_id: true, started_at: true, phone_number: { select: numberFields } },
  });
  if (!call) return null;
  return {
    objectType: 'CALL', objectId: callId, messageId: null, phone_number_id: call.phone_number_id, is_org_default: call.phone_number?.is_org_default === true,
    job_id: call.job_id, lead_id: call.lead_id, replySender: null, at: call.started_at, numberShown: shownNumber(call.phone_number),
  };
}

/**
 * The inbound text the alert is about: the message the caller names or, when it names none, the conversation's latest inbound
 * one. Its record, its company number and, in one more read of the conversation's messages on that number, the person reply
 * attribution names.
 */
async function textSubject(organizationId: string, threadId: string, messageId: string | null | undefined): Promise<ConversationSubject | null> {
  const message = await prisma.message.findFirst({
    where: { organization_id: organizationId, thread_id: threadId, direction: 'in', ...(messageId ? { id: messageId } : {}) },
    orderBy: [{ ts: 'desc' }, { created_at: 'desc' }],
    select: { id: true, job_id: true, lead_id: true, ts: true, phone_number_id: true, phone_number: { select: numberFields } },
  });
  if (!message) return null;

  // The rule is M11's (replySendersOf), not restated: it is handed the conversation's messages on this company number. Messages on
  // another number take no part in it, and a message with no number takes part on neither side.
  let replySender: string | null = null;
  if (message.phone_number_id) {
    const onThisNumber = await prisma.message.findMany({
      where: { organization_id: organizationId, thread_id: threadId, phone_number_id: message.phone_number_id },
      select: { id: true, thread_id: true, direction: true, phone_number_id: true, sent_by_user_id: true, ts: true, created_at: true },
    });
    replySender = replySendersOf(onThisNumber).get(message.id) ?? null;
  }
  return {
    objectType: 'MESSAGE_THREAD', objectId: threadId, messageId: message.id, phone_number_id: message.phone_number_id, is_org_default: message.phone_number?.is_org_default === true,
    job_id: message.job_id, lead_id: message.lead_id, replySender, at: message.ts, numberShown: shownNumber(message.phone_number),
  };
}

/**
 * The people who should hear about this missed call, voicemail or inbound text: active, in the company, named by the record, the
 * scope, the number or (for a text) the reply, and able to read the conversation. Empty when there is nobody.
 */
export async function conversationAlertRecipients(alert: ConversationAlert): Promise<string[]> {
  return (await conversationAlertAudience(alert))?.people ?? [];
}

/**
 * The same people, with the call or text they were found for, or null when the company has no such call or text. Empty `people` is
 * the answer "nobody", known after the access filter: what the never-silent fallback acts on.
 */
export async function conversationAlertAudience(
  alert: ConversationAlert,
): Promise<{ people: string[]; subject: ConversationSubject } | null> {
  const { organizationId } = alert;
  const subject = alert.kind === 'call'
    ? await callSubject(organizationId, alert.callId)
    : await textSubject(organizationId, alert.threadId, alert.messageId);
  if (!subject) return null;

  // Everyone who could be told: the company's active people. A record's person who has left, or who belongs to another
  // company, is not among them and so is never told.
  const people = await prisma.user.findMany({
    where: { organization_id: organizationId, is_active: true },
    select: { id: true, organization_id: true, role: true, custom_role_id: true, custom_role: { select: { key: true } } },
  });
  if (people.length === 0) return { people: [], subject };
  const active = new Set(people.map((p) => p.id));

  // Everyone's switches in a constant number of reads, and cached: the access filter below asks for the same people's switches again
  // and finds them. (A change to a person or a role clears the cache, so what is read here is as current as any request's.)
  const values = await resolveSwitchesForPeople(people);
  const holdersOfAll = people.filter((p) => scopeValueOf(values.get(p.id)?.communication_scope) === 'all').map((p) => p.id);

  const told = new Set<string>(holdersOfAll);
  for (const id of await recordPeopleOf(subject)) if (active.has(id)) told.add(id);
  if (subject.replySender && active.has(subject.replySender)) told.add(subject.replySender);

  if (subject.phone_number_id) {
    const links = await prisma.userPhoneNumber.findMany({
      where: { phone_number_id: subject.phone_number_id, phone_number: { organization_id: organizationId } },
      select: { user_id: true },
    });
    for (const link of links) if (active.has(link.user_id)) told.add(link.user_id);

    // The main line also reaches the people the fallback covers: on "Linked to me", the switch on and no number of their own.
    if (subject.is_org_default) {
      const maybe = people.filter((p) => {
        const own = values.get(p.id);
        return scopeValueOf(own?.communication_scope) !== 'all' && own?.see_main_line_when_no_number === true && !told.has(p.id);
      });
      if (maybe.length > 0) {
        const withNumber = await prisma.userPhoneNumber.findMany({
          where: { user_id: { in: maybe.map((p) => p.id) }, phone_number: { organization_id: organizationId } },
          select: { user_id: true },
          distinct: ['user_id'],
        });
        const own = new Set(withNumber.map((l) => l.user_id));
        for (const p of maybe) if (!own.has(p.id)) told.add(p.id);
      }
    }
  }

  const readers = await filterRecipientsByAccess(subject.objectType, subject.objectId, [...told], organizationId, { messageId: subject.messageId });

  // An empty `readers` is "nobody": nobody is linked, nobody on the record can read it and nobody who is on All can. What happens then
  // is the fallback's (conversationAlertFallback.ts), not this lookup's, which never widens who it names.
  return { people: readers, subject };
}
