/**
 * Why a received message is held in a mailbox's Needs review list instead of delivered (PRD 10, S10.18). Stored on the message
 * as `emails.review_reason`; the Email page names each in plain words.
 *
 *   failed_authentication  the sender's own authentication failed: a forged sender, kept off every customer and never rung for;
 *   automatic              an out-of-office reply, a bounce, bulk or list mail (see automatic-mail.ts);
 *   sender_mismatch        a reply on a live reply address from an address we did not send to: it joins no conversation;
 *   unknown_reply          a reply on a reply address that no longer resolves.
 */
import type { InboundAuthVerdict } from '@prisma/client';

export const REVIEW_REASONS = ['failed_authentication', 'automatic', 'sender_mismatch', 'unknown_reply'] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** What the reply address a message arrived on said about it, when it arrived on one. */
export type ReplyAddressOutcome = 'accepted' | 'sender_refused' | 'no_longer_resolves';

/**
 * The reason a message is held, or null when it is delivered. The order is the order of the doubt: a failed authentication
 * outranks everything (a forged sender must never ring a bell, whichever address it wrote to), then automatic mail, then what
 * the reply address said.
 */
export function reviewReasonOf(input: { auth: InboundAuthVerdict; automatic: boolean; replyAddress?: ReplyAddressOutcome }): ReviewReason | null {
  if (input.auth === 'FAIL') return 'failed_authentication';
  if (input.automatic) return 'automatic';
  if (input.replyAddress === 'sender_refused') return 'sender_mismatch';
  if (input.replyAddress === 'no_longer_resolves') return 'unknown_reply';
  return null;
}
