import type { Prisma, PrismaClient } from '@prisma/client';
import { resolveOutboundNumber, usableNumberWhere } from './resolveOutboundNumber';
import { mainLineE164 } from '../ctm/smsThread';

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Which of our numbers a person's text leaves from (#3023), as the send route sends it and as the line above the text box
 * names it. One answer for both, so the box never names a number the text does not leave from.
 */
export interface SendingNumber {
  /** Our number the text leaves from (E.164); null only for a company with no number at all. */
  fromE164: string | null;
  /**
   * The number of the conversation the text would have continued, when that number is no longer in use (released, or no
   * longer active): the text leaves from the main line instead and is filed in the main-line conversation (#3013 decision 3).
   */
  noLongerInUse: string | null;
  /**
   * The number of the conversation the text would have continued, when that number is still in use (active) but cannot send
   * texts (texting off, or unknown to the phone system: a calls-only main line). The text leaves from the main line and is
   * filed in the main-line conversation, as for a number no longer in use (Ran, 2026-11-06).
   * For a text continuing no conversation when no number of the company can send texts, the main line: the send is refused
   * (409 NO_SMS_NUMBER) and the line says "(555) 010-0000 cannot send texts.", so the two agree (conductor, 2026-11-06).
   */
  cannotSendTexts: string | null;
}

/**
 * The number the text cannot leave from, for either reason: the text moves to the main line's conversation (for a text
 * continuing no conversation, it is the main line itself, and nothing can be sent).
 */
export function movedFrom(sending: SendingNumber): string | null {
  return sending.noLongerInUse ?? sending.cannotSendTexts;
}

/**
 * The number the delivery picks for a text that names no number of ours (resolveOutboundNumber): the sender's own number,
 * else the main line, else the company's oldest number that can text. Null when no number of the company can send texts.
 */
async function deliveryNumber(db: Db, orgId: string, userId?: string): Promise<string | null> {
  const resolved = await resolveOutboundNumber(db, { orgId, userId, requireSms: true });
  if (!resolved) return null;
  const row = await db.phoneNumber.findFirst({
    where: { id: resolved.phone_number_id, organization_id: orgId },
    select: { e164: true },
  });
  return row?.e164 ?? null;
}

/**
 * The number a text leaves from when it continues no conversation: the sender's own number, else the main line (#3013
 * decision 2, today's rule) - the number the delivery picks (resolveOutboundNumber). With no sender, the main line.
 * A company that cannot text from any number gets its main line, or no number at all.
 */
export async function ownNumberElseMainLine(db: Db, orgId: string, userId?: string): Promise<string | null> {
  return (await deliveryNumber(db, orgId, userId)) ?? mainLineE164(db, orgId);
}

/**
 * The number a person's text leaves from (#3023, #3013 decisions 2 and 3):
 *   - continuing a conversation: that conversation's number, whoever sends it, while a text can leave from it (the
 *     delivery's rule: active, known to the phone system, texting on); once it is released or inactive, or while it cannot
 *     send texts, the main line (or, when the main line cannot text either, the number the delivery falls back to);
 *   - continuing none: the sender's own number, else the main line (and, when no number can send texts, the main line as
 *     `cannotSendTexts`).
 * `conversationNumberE164` is our number in the conversation the text continues, or null when it continues none.
 */
export async function sendingNumber(
  db: Db,
  orgId: string,
  userId: string,
  conversationNumberE164: string | null,
): Promise<SendingNumber> {
  if (!conversationNumberE164) {
    const from = await deliveryNumber(db, orgId, userId);
    if (from) return { fromE164: from, noLongerInUse: null, cannotSendTexts: null };
    // No number of the company can send texts: the send is refused, and the line says the main line cannot send texts.
    const mainLine = await mainLineE164(db, orgId);
    return { fromE164: mainLine, noLongerInUse: null, cannotSendTexts: mainLine };
  }
  // The delivery's own rule (resolveOutboundNumber), so the line and the send always agree on the number.
  const usable = await db.phoneNumber.findFirst({
    where: { ...usableNumberWhere(orgId, { requireSms: true }), e164: conversationNumberE164 },
    select: { id: true },
  });
  if (usable) return { fromE164: conversationNumberE164, noLongerInUse: null, cannotSendTexts: null };
  const inUse = await db.phoneNumber.findFirst({
    where: { organization_id: orgId, e164: conversationNumberE164, status: 'active' },
    select: { id: true },
  });
  return {
    fromE164: await ownNumberElseMainLine(db, orgId),
    noLongerInUse: inUse ? null : conversationNumberE164,
    cannotSendTexts: inUse ? conversationNumberE164 : null,
  };
}

/**
 * Whether this number is one of the person's own (assigned to them), for the line's "from your number". Never the main line,
 * which takes the number-only wording even for a person it is assigned to (conductor, 2026-11-06).
 */
export async function isPersonsNumber(db: Db, orgId: string, userId: string, e164: string | null): Promise<boolean> {
  if (!e164 || e164 === (await mainLineE164(db, orgId))) return false;
  const link = await db.userPhoneNumber.findFirst({
    where: { user_id: userId, phone_number: { organization_id: orgId, e164 } },
    select: { phone_number_id: true },
  });
  return link != null;
}
