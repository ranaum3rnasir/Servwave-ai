/**
 * lead-contact.service.ts — the one rule that decides whether an outbound message counts as
 * "somebody reached out to this lead".
 *
 * Spec: GitHub issue #1751 ("Lead stage clocks"), decision D5.
 *
 * THE RULE, in the business owner's words: an outbound CALL, an outbound TEXT, or a HUMAN-WRITTEN
 * EMAIL marks the lead contacted, at the moment it happened. Automatic notifications the platform
 * sends on the company's behalf NEVER count — the response-time metric measures the owner's people,
 * not their software (user stories 12 and 13). An INBOUND call or text from the customer does not
 * mark the lead contacted by us either: the metric is our effort, not theirs (user story 15).
 * First qualifying event wins; a fifth follow-up does not keep resetting the clock (story 14).
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * Three unrelated controllers write the three channels, and the rule has to be identical in all
 * three or the metric is unreportable. The specific way it goes wrong is silent: a channel whose
 * filter is subtly wrong does not fail, it just reports a fleet of leads as contacted the instant
 * they were created, which reads as excellent response time. Nothing on any screen shows it.
 *
 * PROVENANCE IS READ, NEVER INFERRED
 *
 * Each channel states its provenance outright and this module reads it:
 *
 *   TEXT   `messages.automated`, which already existed — the automation SMS writer
 *          (services/automations/smsRecord.ts) sets it true, the composer sets it false.
 *   EMAIL  `emails.automated`, added by this spec. `persistTransactionalEmail` (every
 *          estimate/invoice/PO notice) writes true; the compose/reply door writes false.
 *   CALL   nothing to read: every outbound call in the product today is a person pressing dial.
 *          There is no automated dialer, so there is no flag, and inventing a column with one
 *          possible value would be a worse lie than the absence. WHOEVER BUILDS AN AUTODIALER OR A
 *          POWER DIALER MUST ADD THE FLAG AND PASS IT HERE — the call site names `automated`
 *          explicitly for exactly that reason, rather than letting the default carry it.
 *
 * The email channel had a tempting structural proxy and it is REJECTED, not merely unused:
 * transactional mirrors happen to be written with no `thread_id` while the compose path always
 * populates one. That is a consequence of which code path writes the row — documented as such on
 * `Email.thread_id` in schema.prisma — not a contract. `persistTransactionalEmail` already ACCEPTS
 * a `threadId`, so the first sender to pass one would silently mark every lead in the system
 * contacted, with no failure anywhere to notice it by.
 *
 * NEVER FAILS THE USER'S SEND
 *
 * Deep module, same discipline as lib/comm-persist.ts's `persistTransactionalEmail`: the message
 * has already left, so a bookkeeping failure must not turn a send that plainly happened into a 500.
 * It is nonetheless AWAITED at every call site and logs at error level — a swallowed failure that
 * also went unlogged would be the fire-and-forget shape that fakes a green result.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { stampLeadClock } from './lead-stage.service';

/** Accepts the request-scoped client or a transaction client, like lib/ctm/ingest.ts's own `Db`. */
type Db = Prisma.TransactionClient | PrismaClient;

export type LeadContactChannel = 'call' | 'text' | 'email';

export interface LeadOutboundTouch {
  /**
   * The lead this message is attributed to. Null/undefined on the overwhelming majority of sends
   * (a text to a customer about a job is not lead outreach) and handled as a no-op rather than a
   * caller-side `if` repeated three times.
   *
   * It must already be org-scoped by the caller. Every door that passes one resolved it under
   * `tenantWhere(req)` or through the org-scoped phone matcher.
   */
  leadId: string | null | undefined;
  /** The org the message was written in. Required by `stampLeadClock` — see its own note. */
  orgId: string;
  channel: LeadContactChannel;
  /**
   * The canonical comm vocabulary is `'in' | 'out'` — never `inbound`/`outbound`. Typed as a bare
   * string because that is what the three models store (`Message.direction`, `Email.direction`,
   * `CallSession.direction` are all `String`), and narrowing it here would only move the cast.
   */
  direction: string | null | undefined;
  /**
   * True when the platform generated this message on the company's behalf. Falsy — including the
   * null that historical rows carry — reads as human, matching the column defaults on both
   * `messages.automated` and `emails.automated`.
   */
  automated?: boolean | null;
  /** When the outreach happened. The row's own instant, never `new Date()` re-read downstream. */
  at: Date;
}

/**
 * Does this message count as us reaching out? Pure, and exported so a test can state the rule
 * as an invariant rather than re-deriving it from three separate doors.
 */
export function isHumanOutboundTouch(touch: {
  direction: string | null | undefined;
  automated?: boolean | null;
}): boolean {
  // `=== 'out'` rather than a truthiness or an `!== 'in'` test: a row whose direction was never
  // written (null, which every pre-slice-8b Email row carries) is of UNKNOWN direction, and an
  // unknown direction must not be read as outreach.
  if (touch.direction !== 'out') return false;
  return touch.automated !== true;
}

/**
 * Stamp `leads.contacted_at` if this message is human-originated outbound to a lead and the clock
 * has never been set. Returns true only when this call was the first touch.
 *
 * Never throws (see the module header). `contacted_set_by` is deliberately NOT written: it is the
 * marker for a HAND correction, so leaving it null here is what keeps the automatic stamp and the
 * human one distinguishable forever after.
 */
export async function recordLeadOutboundContact(
  db: Db,
  touch: LeadOutboundTouch,
): Promise<boolean> {
  if (!touch.leadId) return false;
  if (!isHumanOutboundTouch(touch)) return false;
  try {
    return await stampLeadClock(db, touch.leadId, touch.orgId, 'contacted_at', touch.at);
  } catch (err) {
    logger.error(
      `Failed to stamp lead contact clock (lead ${touch.leadId}, ${touch.channel}):`,
      err,
    );
    return false;
  }
}
