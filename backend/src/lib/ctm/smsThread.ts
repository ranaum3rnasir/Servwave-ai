import type { Prisma, PrismaClient } from '@prisma/client';
import { matchByPhone, normalizeNAPhone, type IdentityMatch } from '../comms-identity';

/**
 * The ONE SMS thread-identity rule (slice H7): given a counterpart phone
 * number, resolve the conversation it belongs to - shared by the CTM webhook
 * ingest (ingestSms) and the compose-to-number send path (sendMessage), so a
 * user-composed text and an inbound webhook text land in the SAME conversation.
 *
 * With ONE deliberate exception, added by Spec C slice 7: a number owned by an
 * ACTIVE MEMBER OF STAFF. Only ingest opts in (the `matchStaff` option), keying
 * onto that person's team thread so a technician replying to an automated text
 * stops surfacing as an unknown contact in the customer lane; compose does not
 * opt in, because a team thread has no destination the send path can resolve,
 * so keying the composer onto one would break a send that works today. For a
 * staff number the two doors therefore DO diverge, and that is the intent -
 * `matchStaff`'s own docblock below carries the full reasoning.
 *
 * Keying mirrors createThread's FULL linking (customer + lead + vendor) and
 * the FIND mirrors the CREATE for every match kind: customer matches (lead
 * matches carry customerId too) key by customer_id; vendor/vendor-contact
 * matches (customerId null) key by vendor_id; unmatched numbers key by
 * title = the E.164-normalized number (fallback raw) so bare vs +1 spellings
 * can never split a thread.
 *
 * Read-mostly: creates ONLY the thread row (never a Customer/Lead — DEC6's
 * "unmatched → offer create" stays a caller-side affordance).
 */

type Db = Prisma.TransactionClient | PrismaClient;

export interface SmsThreadResolution {
  thread: { id: string; customer_id: string | null; vendor_id: string | null; lead_id: string | null; title: string | null; kind?: string | null };
  /** The identity resolution used for the keying (null = unmatched). */
  match: IdentityMatch | null;
  /** True when this call created the thread (vs. found an existing one) — a
   *  caller that then hits a post-creation failure knows it's safe to roll
   *  the new thread back (s1d). */
  created: boolean;
}

export interface FindOrCreateSmsThreadOptions {
  /**
   * Resolve the number against the org's ACTIVE STAFF when no customer, lead or
   * vendor matched, and key the conversation onto that person's team thread
   * (Spec C slice 7). Defaults OFF: it is the INBOUND door that needs it.
   *
   * Why it is not simply always on. This helper is shared by two callers that
   * want opposite things from a staff number:
   *
   *   - INBOUND (ingestSms) wants the staff thread. Without it, the first
   *     technician who replies to an automated text lands in the CUSTOMER
   *     conversations lane as an unknown contact: the unmatched branch below
   *     writes campaign_type 'customer_care' and NO kind, and the inbox reads a
   *     null kind as `customer`.
   *   - COMPOSE-to-number (comm-threads.controller sendMessage) must NOT. A
   *     staff thread has no destination the send path can resolve -
   *     `resolveSmsDestination` goes customer -> vendor -> title-as-number and
   *     deliberately has no user branch - so keying the composer onto one would
   *     turn "text this technician's mobile", which works today, into a dead
   *     end.
   */
  matchStaff?: boolean;
}

export async function findOrCreateSmsThreadByNumber(
  db: Db,
  orgId: string,
  rawNumber: string,
  opts: FindOrCreateSmsThreadOptions = {},
): Promise<SmsThreadResolution> {
  const match = rawNumber ? await matchByPhone(db, orgId, rawNumber) : null;

  // Staff are resolved LAST and only on a total miss, so customer, lead and
  // vendor keying is reached exactly as it is today.
  if (!match && opts.matchStaff) {
    const staff = await matchActiveStaffByPhone(db, orgId, rawNumber);
    if (staff) return findOrCreateStaffThread(db, orgId, staff);
  }

  const titleKey = normalizeNAPhone(rawNumber) ?? (rawNumber || 'unknown');
  let thread = await db.messageThread.findFirst({
    where: match?.customerId
      ? { organization_id: orgId, channel: 'sms', customer_id: match.customerId }
      : match?.vendorId
        ? { organization_id: orgId, channel: 'sms', vendor_id: match.vendorId }
        : { organization_id: orgId, channel: 'sms', customer_id: null, vendor_id: null, title: titleKey },
  });
  let created = false;
  if (!thread) {
    thread = await db.messageThread.create({
      data: {
        channel: 'sms',
        campaign_type: 'customer_care',
        customer_id: match?.customerId ?? null,
        lead_id: match?.leadId ?? null,
        vendor_id: match?.vendorId ?? null,
        title: match ? null : titleKey,
        organization_id: orgId,
      },
    });
    created = true;
  }
  return { thread, match, created };
}

/**
 * Peek-only counterpart to findOrCreateSmsThreadByNumber (#2046 security round 1): resolves the
 * SAME identity + thread-find findOrCreateSmsThreadByNumber's compose caller would (no
 * `matchStaff` — the compose door never opts into it), but never creates a row. Lets a caller
 * gate ORIGINATING a brand-new thread BEFORE any write happens, instead of creating one and
 * rolling it back.
 */
export async function smsThreadExistsForNumber(
  db: Db,
  orgId: string,
  rawNumber: string,
): Promise<boolean> {
  const match = rawNumber ? await matchByPhone(db, orgId, rawNumber) : null;
  const titleKey = normalizeNAPhone(rawNumber) ?? (rawNumber || 'unknown');
  const thread = await db.messageThread.findFirst({
    where: match?.customerId
      ? { organization_id: orgId, channel: 'sms', customer_id: match.customerId }
      : match?.vendorId
        ? { organization_id: orgId, channel: 'sms', vendor_id: match.vendorId }
        : { organization_id: orgId, channel: 'sms', customer_id: null, vendor_id: null, title: titleKey },
  });
  return thread != null;
}

interface StaffMatch {
  id: string;
  first_name: string | null;
  last_name: string | null;
  /** Read for the thread title only, as the last-resort way to name someone -
   *  `users.email` is required and unique, so it is the one identifying string
   *  every staff row is guaranteed to carry. */
  email: string;
}

/**
 * The active staff member who owns `rawNumber`, or null.
 *
 * Both sides are normalized rather than compared as stored: `users.phone` is
 * free text (bare ten digits on some live rows, punctuated on others) while the
 * provider hands us E.164, so an `in: [...]` match on the column would miss the
 * punctuated spellings entirely. Staff lists are a handful of rows, so reading
 * the roster and matching in memory is the cheaper correctness - the same
 * trade-off `resolveExternalAnswerer` (lib/ctm/ingest.ts) already makes.
 *
 * `?? []` guards a caller whose Prisma surface is a stub rather than a client.
 */
async function matchActiveStaffByPhone(
  db: Db,
  orgId: string,
  rawNumber: string,
): Promise<StaffMatch | null> {
  const e164 = normalizeNAPhone(rawNumber);
  if (!e164) return null;
  const staff =
    (await db.user.findMany({
      where: { organization_id: orgId, is_active: true, phone: { not: null } },
      select: { id: true, first_name: true, last_name: true, email: true, phone: true },
      // Deterministic, so two people who somehow share a number always resolve
      // to the same one rather than to whichever the planner returned first.
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })) ?? [];
  return staff.find((u) => u.phone && normalizeNAPhone(u.phone) === e164) ?? null;
}

/**
 * The staff member's SMS conversation, keyed EXACTLY the way the automation
 * recorder keys it (user_id + channel + organization, and the same
 * kind/campaign_type/title stamps) - see services/automations/smsRecord.ts.
 * The two must agree, or an outbound automated text and the reply to it end up
 * in two different conversations.
 *
 * `match` is null: IdentityMatch spans customer / lead / vendor only, and a
 * staff member is none of those. The inbound writer reads it for `lead_id` and
 * for the notification label, both of which are correct to leave empty here -
 * a staff thread carries no lead, and this slice deliberately does not design
 * what a staff notification says.
 */
async function findOrCreateStaffThread(
  db: Db,
  orgId: string,
  staff: StaffMatch,
): Promise<SmsThreadResolution> {
  const existing = await db.messageThread.findFirst({
    where: { organization_id: orgId, channel: 'sms', user_id: staff.id },
  });
  if (existing) return { thread: existing, match: null, created: false };

  const thread = await db.messageThread.create({
    data: {
      channel: 'sms',
      // `kind` is the load-bearing stamp: the Communication module derives a
      // thread's lane from it and reads an absent kind as `customer`.
      kind: 'team',
      campaign_type: 'tech_ops',
      title: staffThreadTitle(staff),
      user_id: staff.id,
      organization_id: orgId,
    },
  });
  return { thread, match: null, created: true };
}

/**
 * What the inbox calls this person - never the empty string.
 *
 * A team thread's `title` is the ONLY display name it has: it carries no
 * customer row, and the inbox's `threadTitle` (SmsInboxView) tests the title
 * for TRUTHINESS before using it. So a blank title does not render as a blank
 * name - it falls through to the customer lookup, misses on a `user_id`
 * thread, and prints "Unknown" in the lane whose entire purpose is naming the
 * person. Writing a usable title here is cheaper than teaching every reader of
 * a thread to second-guess the one field that names it.
 *
 * Whitespace is the same defect in disguise, so the parts are trimmed before
 * they are judged: ' ' survives `filter(Boolean)` and is truthy, which would
 * clear the falsiness check above and still show an unnamed row.
 */
function staffThreadTitle(staff: StaffMatch): string {
  const name = [staff.first_name, staff.last_name]
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
  return name || staff.email;
}
