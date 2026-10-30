/**
 * conversationAlertFallback.ts - the never-silent net under a missed call, a voicemail and an inbound text (Roles & Permissions,
 * PRD 8, S08.24).
 *
 * `conversationAlertRecipients` names the people of the alert: the record's people, the holders of All, the people linked to the
 * company number and, for a text, the reply's sender, every one of them through the access filter. When that answer is EMPTY the
 * call or text would reach no one. Then, and only then, the Admins are told, with the reason line
 * below, the company number it came in on and the time in the COMPANY's zone. "Empty" is the lookup's answer, not a re-derivation of
 * "unlinked and tied to no record": a conversation tied to a job whose people cannot read it, with nobody on All, is nobody too, and
 * is not silent either. The reason line is PRD 8's sentence and is the only one; it fits every empty answer.
 *
 * This is the ONE path that may tell a person the access filter would have dropped, so it does it with care:
 *   - every active holder is told, whatever their Communication switches say (the PRD names the holders of the switch and nothing
 *     more), but a holder who cannot read the conversation under their scope (the filter's own question, asked of them) is told in
 *     a SECOND alert that carries no caller name, no caller number, no customer, no text preview and no link text that names the
 *     customer: it says what happened, on which company number, when, and why they are being told. A holder who can read it is
 *     told in a full alert, the one the normal path would have written;
 *   - the two alerts are two rows with their own dedup keys, so a redelivery writes neither twice, and the redacted row is
 *     addressed to its own recipients only (the bell returns a person their own recipient rows and nothing else);
 *   - `emit` takes the people from here through a FallbackPeople, which only this module can make: nothing else can ask `emit` to
 *     skip the lookup and its filter, and the filter stays whole for every other path.
 *
 * A chain that still finds nobody (no active holder of the switch) is logged once, with the kind of alert, the call or
 * conversation and the company, and nothing the customer said or is called. The event wrote no row, so a redelivery has nothing to
 * be recognised by: it finds nobody again and logs once more.
 *
 * Cost: a constant number of reads however large the company, and only when the answer is empty: the switch's holders (the
 * company's people and their switches), the company's time zone, and one access-filter look at the conversation for the holders.
 * Nothing runs inside the ingest's transaction: `emit` is called after the commit.
 */

import { logger } from '../../lib/logger';
import { activeAdmins } from '../../lib/permissions/switchHolders';
import { DEFAULT_TIMEZONE, formatDateTimeInZone, getOrgTimezone } from '../../lib/timezone';
import { filterRecipientsByAccess } from './filterByAccess';
import type { ConversationAlert, ConversationSubject } from './conversationAlertRecipients';
import { NOBODY_LINKED_TO_NUMBER_REASON } from './whyLines';

/** PRD 8's reason line, word for word (kept in whyLines.ts with the others). */
export const NOBODY_LINKED_REASON = NOBODY_LINKED_TO_NUMBER_REASON;

/** The suffixes the fallback's two alerts add to the event's dedup key: the full alert, and the one without caller details. */
export const FALLBACK_KEY = ':nobody';
export const FALLBACK_REDACTED_KEY = ':nobody:redacted';

/** Every dedup key an event can be stored under: its own (the normal alert) or either fallback alert's. */
export const conversationAlertKeys = (dedupKey: string): string[] => [dedupKey, dedupKey + FALLBACK_KEY, dedupKey + FALLBACK_REDACTED_KEY];

/**
 * People `emit` may tell without asking the lookup and the access filter. Made only by `nobodyFallbackRows` below (the type has a
 * private brand, and `emit` checks the token was minted here), so no other caller can use it to skip the filter.
 */
declare const fallbackBrand: unique symbol;
export interface FallbackPeople {
  readonly [fallbackBrand]: true;
  readonly ids: readonly string[];
}
const minted = new WeakSet<object>();
const mint = (ids: string[]): FallbackPeople => {
  const token = { ids: Object.freeze([...ids]) } as unknown as FallbackPeople;
  minted.add(token);
  return token;
};
/** True only for a token this module made. */
export const isFallbackPeople = (token: unknown): token is FallbackPeople => typeof token === 'object' && token !== null && minted.has(token);

/** One alert of the fallback: who gets it, what it carries and the suffix of its dedup key. */
export interface FallbackRow {
  people: FallbackPeople;
  data: Record<string, unknown>;
  /** The object label of the alert: the caller's own for a full alert, none for the one without details. */
  label: string | undefined;
  keySuffix: string;
}

/** What an alert without caller details still carries of what the caller sent: whether it was a voicemail. Nothing else. */
const NEUTRAL_DATA = ['call_status'] as const;

/** The call or text's time as the company reads it: its own zone, and the default one when the stored zone is not one the server knows. */
function timeInCompanyZone(at: Date, zone: string): string {
  try {
    return formatDateTimeInZone(at, zone);
  } catch {
    return formatDateTimeInZone(at, DEFAULT_TIMEZONE);
  }
}

/**
 * The alerts of the fallback for a call or text nobody would be told about: none when the company has no active Admin (one log
 * line), else the full alert for the Admins who can read the conversation and the alert without
 * caller details for those who cannot, each only when it has people.
 */
export async function nobodyFallbackRows(
  alert: ConversationAlert,
  subject: ConversationSubject,
  caller: { data: Record<string, unknown>; label: string | undefined },
): Promise<FallbackRow[]> {
  const { organizationId } = alert;
  const holders = await activeAdmins(organizationId);
  if (holders.length === 0) {
    // The kind of alert, the call or conversation and the company, and nothing the customer said or is called.
    logger.warn('[conversationAlert] nobody to tell', {
      alert: alert.kind === 'call' ? 'communication.call_missed' : 'communication.sms_inbound',
      ...(alert.kind === 'call' ? { callId: alert.callId } : { conversationId: alert.threadId }),
      organizationId,
    });
    return [];
  }

  // Who of them may open the conversation under their own scope: the filter's question, for them all at once.
  const readers = new Set(await filterRecipientsByAccess(subject.objectType, subject.objectId, holders, organizationId, { messageId: subject.messageId }));
  const facts = {
    fallback_reason: NOBODY_LINKED_REASON,
    ...(subject.numberShown ? { company_number: subject.numberShown } : {}),
    occurred_at: timeInCompanyZone(subject.at, await getOrgTimezone(organizationId)),
  };

  const rows: FallbackRow[] = [];
  const canRead = holders.filter((id) => readers.has(id));
  const cannotRead = holders.filter((id) => !readers.has(id));
  if (canRead.length) {
    rows.push({ people: mint(canRead), data: { ...caller.data, ...facts }, label: caller.label, keySuffix: FALLBACK_KEY });
  }
  if (cannotRead.length) {
    const neutral = Object.fromEntries(NEUTRAL_DATA.filter((k) => k in caller.data).map((k) => [k, caller.data[k]]));
    rows.push({ people: mint(cannotRead), data: { ...neutral, ...facts, redacted: true }, label: undefined, keySuffix: FALLBACK_REDACTED_KEY });
  }
  return rows;
}
