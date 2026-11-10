import type { Prisma, PrismaClient } from '@prisma/client';
import { normalizeNAPhone, type IdentityMatch } from '../comms-identity';
import { otherPartyE164 } from '../communication/otherPartyNumber';

/**
 * Who a number belongs to, for the door that is asking (re-audit NV-vp3-1). The webhook, with nobody signed in, passes the
 * company-wide resolver (`matchByPhone`); a signed-in person's compose passes `matchByPhoneInReach`, so a conversation it
 * makes for a number whose customer they cannot open is filed on nobody and never names that customer (which conversation
 * it may CONTINUE is the person's reach: PairReach, for latestPairConversationWith only; the pair's own conversation is joined
 * whoever can read it). Taken from the caller so this shared helper never decides reach itself (permission-phone-match-reach-guard.test.ts).
 */
export type IdentifyNumber = (rawNumber: string) => Promise<IdentityMatch | null>;

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
 * opt in, so that typing a raw number opens a conversation keyed by THAT
 * number rather than silently reopening the person's internal team thread. For
 * a staff number the two doors therefore DO diverge, and that is the intent -
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

/**
 * #3019 (Q38): an SMS conversation with a customer or an unknown number IS a pair of numbers - the other party's and ours,
 * both normalized E.164. `ourNumberE164` is null only for a company that has no number at all. Staff, vendor and group
 * conversations are not keyed by a pair; they keep their own keys below.
 */
export interface SmsPair {
  otherPartyE164: string;
  ourNumberE164: string | null;
}

/**
 * The statuses of an outbound text that did not go out (skipped, failed, or still queued). The send route stores the company
 * number only once a text goes out, so such a reply has none; it belongs to its conversation's own pair, never the main line
 * by itself (Ran's ruling, 2026-11-06). Shared with the split (scripts/sms-conversation-pair-split.ts), and with the reply
 * rule (lib/sms-reply-router.ts: such a text is not the latest text we sent, #3020).
 */
export const UNSENT_REPLY_STATUSES = ['queued', 'skipped', 'failed'] as const;

/**
 * The company's main line: its default number, else its oldest active number (the order the send path falls back
 * through, resolveOutboundNumber), else none. A text whose company number is unknown is on the main line (#3019).
 */
export async function mainLineE164(db: Db, orgId: string): Promise<string | null> {
  const byDefault = await db.phoneNumber.findFirst({
    where: { organization_id: orgId, is_org_default: true },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { e164: true },
  });
  if (byDefault?.e164) return byDefault.e164;
  const oldest = await db.phoneNumber.findFirst({
    where: { organization_id: orgId, status: 'active' },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { e164: true },
  });
  return oldest?.e164 ?? null;
}

/**
 * The conversations a pair can key: a customer's or an unknown number's. Never a vendor's, a member of staff's or a
 * group's (those keep their own keys), so a pair never reaches into one of them.
 */
const PAIR_KEYED_THREAD: Prisma.MessageThreadWhereInput = {
  channel: 'sms',
  vendor_id: null,
  user_id: null,
  OR: [{ kind: null }, { kind: 'customer' }],
};

/**
 * Which conversations with a number a signed-in door may CONTINUE (#3023; Ran, 2026-11-06, after spec r3): the ones the
 * person may continue (`textContinueScopeForReq`, per conversation, from the caller, so this shared helper never decides reach
 * itself). It narrows only latestPairConversationWith (#3013 decision 2). Joining the pair's conversation once our number is
 * known is never narrowed (#3019: one conversation per pair, the same one the webhook files the answer in). Left out (the
 * webhook, an automated text), every conversation of the company.
 */
export interface PairReach {
  within?: Prisma.MessageThreadWhereInput;
}

/** The `where` that keeps a find to the conversations of `reach`, beside the find's own keys. */
const inReach = (reach: PairReach): Prisma.MessageThreadWhereInput => (reach.within ? { AND: [reach.within] } : {});

/**
 * The conversation already keyed by this pair, or null. A customer's conversation comes before one filed on nobody, then
 * the oldest; the find-or-create below and the split script keep one per pair, so the order only settles a race. Never
 * narrowed by who is asking (#3023, Ran 2026-11-06): every door, signed in or not, finds the same one.
 */
export async function findPairConversation(
  db: Db,
  orgId: string,
  pair: SmsPair,
) {
  return db.messageThread.findFirst({
    where: {
      organization_id: orgId,
      ...PAIR_KEYED_THREAD,
      other_party_e164: pair.otherPartyE164,
      // Never `undefined`, which Prisma reads as "any number of ours".
      our_number_e164: pair.ourNumberE164 ?? null,
    },
    orderBy: [{ customer_id: { sort: 'asc', nulls: 'last' } }, { created_at: 'asc' }, { id: 'asc' }],
  });
}

/**
 * The latest conversation with this number, whichever of our numbers it is on (#3013 decision 2): the conversation holding
 * the latest text to or from the number, when it is keyed by that number. Null otherwise: before the split script reaches
 * it, the customer's conversation is found the way it always was.
 * `within` (#3023): for a signed-in door, the latest of the conversations with the number the person may continue (PairReach).
 */
export async function latestPairConversationWith(db: Db, orgId: string, otherPartyE164: string, reach: PairReach = {}) {
  const latest = await db.message.findFirst({
    where: {
      organization_id: orgId,
      other_party_e164: otherPartyE164,
      thread: { ...PAIR_KEYED_THREAD, organization_id: orgId, ...inReach(reach) },
    },
    orderBy: [{ ts: 'desc' }, { id: 'desc' }],
    select: { thread: true },
  });
  return latest?.thread.other_party_e164 === otherPartyE164 ? latest.thread : null;
}

/** Who a pair's conversation is filed on when it is made, and how it was found before pairs existed. */
interface PairIdentity {
  customerId: string | null;
  leadId: string | null;
  /** The unknown number's title (its E.164), for a conversation filed on nobody. */
  title: string | null;
}

/**
 * A conversation from before pairs (not keyed yet: the split script has not reached it) that may take a text of this pair,
 * found among the ones filed as it always was (the customer's, or the unknown number's by its title). Only:
 *   - one that already holds a text of this very pair (its other party's number, and the company number it went through,
 *     the main line when it has none: the pair the split script gives that text), so the split later moves the new text
 *     with its pair. A reply that did not go out (UNSENT_REPLY_STATUSES, no company number stored) is the pair of the
 *     conversation's latest text with that other party that has a company number, so it holds no pair of its own then;
 *     when that other party has none, it takes the company number of the conversation's latest text that has one,
 *     whatever its other party; the main line only when no text in the conversation has one (Ran's rulings, 2026-11-06,
 *     the split's rule: scripts/sms-conversation-pair-split.ts); or
 *   - while the customer (or the unknown number) has no conversation keyed by this number yet, one none of whose texts
 *     names a number (the #3014 fill-in has not reached it), so a conversation keeps its next text before the fill-in runs.
 *     Once that text is in it, it holds that pair's text and takes no other pair's.
 * So a conversation from before pairs never takes the texts of two pairs: after the split, a conversation it left as it was
 * (no text with a number) takes no text while its customer has a conversation keyed by that number (#3019 acceptance 3).
 *
 * And only a text with the number such a conversation texts: a customer's conversation from before pairs texts the
 * customer's phone (resolveSmsDestination), so it never takes a text with another number the customer is found by (a
 * second phone, or a number only one of their leads or jobs carries as its own, #3015). That text gets its pair's own
 * conversation, and a reply in it goes to that number, never to the customer's phone.
 */
async function findConversationFromBeforePairs(db: Db, orgId: string, pair: SmsPair, identity: PairIdentity) {
  if (identity.customerId) {
    const customer = await db.customer.findFirst({
      where: { id: identity.customerId, organization_id: orgId },
      select: { phone: true },
    });
    if (!customer?.phone || normalizeNAPhone(customer.phone) !== pair.otherPartyE164) return null;
  }
  const filedAsBefore: Prisma.MessageThreadWhereInput = {
    organization_id: orgId,
    channel: 'sms',
    other_party_e164: null,
    ...(identity.customerId
      ? { customer_id: identity.customerId }
      : { customer_id: null, vendor_id: null, title: identity.title ?? pair.otherPartyE164 }),
  };
  const oldestFirst: Prisma.MessageThreadOrderByWithRelationInput[] = [{ created_at: 'asc' }, { id: 'asc' }];

  const ourNumber = pair.ourNumberE164 ?? null;
  const ofThisNumber = { organization_id: orgId, other_party_e164: pair.otherPartyE164 };
  const withACompanyNumber = { organization_id: orgId, phone_number_id: { not: null } };
  const unsentReply = { ...ofThisNumber, phone_number_id: null, direction: 'out', status: { in: [...UNSENT_REPLY_STATUSES] } };
  const onTheMainLine = ourNumber === (await mainLineE164(db, orgId));
  // A reply that did not go out, to this number, which has no text with a company number in its conversation: it takes the
  // company number of the conversation's latest text that has one, whatever its other party. The conversations where that
  // number is ours hold this pair.
  const takingTheLatestNumber = ourNumber
    ? (
        await db.messageThread.findMany({
          where: {
            ...filedAsBefore,
            AND: [
              { messages: { some: unsentReply } },
              { messages: { none: { ...ofThisNumber, phone_number_id: { not: null } } } },
              { messages: { some: withACompanyNumber } },
            ],
          },
          select: {
            id: true,
            messages: {
              where: withACompanyNumber,
              orderBy: [{ ts: 'desc' }, { id: 'desc' }],
              take: 1,
              select: { phone_number: { select: { e164: true } } },
            },
          },
        })
      )
        .filter((t) => t.messages[0]?.phone_number?.e164 === ourNumber)
        .map((t) => t.id)
    : [];
  const holding: Prisma.MessageThreadWhereInput[] = [
    // A text that went through our number.
    ...(ourNumber ? [{ messages: { some: { ...ofThisNumber, phone_number: { e164: ourNumber } } } }] : []),
    ...(takingTheLatestNumber.length > 0 ? [{ id: { in: takingTheLatestNumber } }] : []),
    ...(onTheMainLine
      ? [
          // A text with no company number is on the main line, unless it is a reply that did not go out...
          { messages: { some: { ...ofThisNumber, phone_number_id: null, OR: [{ direction: { not: 'out' } }, { status: null }, { status: { notIn: [...UNSENT_REPLY_STATUSES] } }] } } },
          // ...which is on the main line only when no text in the conversation has a company number.
          { AND: [{ messages: { some: unsentReply } }, { messages: { none: withACompanyNumber } }] },
        ]
      : []),
  ];
  if (holding.length > 0) {
    const holdingThisPair = await db.messageThread.findFirst({ where: { ...filedAsBefore, OR: holding }, orderBy: oldestFirst });
    if (holdingThisPair) return holdingThisPair;
  }

  const keyed = await db.messageThread.findFirst({
    where: {
      organization_id: orgId,
      ...PAIR_KEYED_THREAD,
      customer_id: identity.customerId,
      other_party_e164: pair.otherPartyE164,
    },
    select: { id: true },
  });
  if (keyed) return null;
  return db.messageThread.findFirst({
    where: { ...filedAsBefore, messages: { none: { other_party_e164: { not: null } } } },
    orderBy: oldestFirst,
  });
}

/**
 * The conversation findOrCreatePairConversation files a text of this pair in, when it exists already (steps 1 and 2 below):
 * the one keyed by the pair, else one from before pairs that may take the pair's text. Makes nothing; null when the text
 * would start a new conversation.
 */
export async function existingPairConversation(
  db: Db,
  orgId: string,
  pair: SmsPair,
  identity: PairIdentity,
) {
  return (await findPairConversation(db, orgId, pair)) ?? findConversationFromBeforePairs(db, orgId, pair, identity);
}

/**
 * The ONE find-or-create of a pair's conversation (#3019), shared by every door that files a text with a customer or an
 * unknown number: incoming texts, sends from the inbox, a customer, a lead or a job, and automated texts.
 *
 *   1. The conversation keyed by the pair.
 *   2. Else a conversation from before pairs that may take this pair's text (findConversationFromBeforePairs): one already
 *      holding a text of this pair, or, before the customer has any keyed conversation, one whose texts name no number yet.
 *      A text keeps landing where people see it until the split runs; the split then moves it with its pair.
 *   3. Else a new conversation keyed by the pair, filed on the customer the caller names (its default customer).
 */
export async function findOrCreatePairConversation(
  db: Db,
  orgId: string,
  pair: SmsPair,
  identity: PairIdentity,
): Promise<{ thread: SmsThreadResolution['thread']; created: boolean }> {
  const found = await existingPairConversation(db, orgId, pair, identity);
  if (found) return { thread: found, created: false };
  const thread = await db.messageThread.create({
    data: {
      channel: 'sms',
      campaign_type: 'customer_care',
      customer_id: identity.customerId,
      lead_id: identity.leadId,
      vendor_id: null,
      title: identity.customerId ? null : (identity.title ?? pair.otherPartyE164),
      other_party_e164: pair.otherPartyE164,
      our_number_e164: pair.ourNumberE164 ?? null,
      organization_id: orgId,
    },
  });
  return { thread, created: true };
}

export interface SmsThreadResolution {
  thread: {
    id: string; customer_id: string | null; vendor_id: string | null; lead_id: string | null; title: string | null; kind?: string | null;
    other_party_e164?: string | null; our_number_e164?: string | null;
  };
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
   *   - COMPOSE-to-number (comm-threads.controller sendMessage) must NOT. The
   *     two doors mean different things by the same digits: ingest is FILING a
   *     message that arose from that person, while compose is an operator
   *     naming a destination. Keying compose onto the team thread would
   *     silently redirect "text this number" into an existing internal
   *     conversation the sender never picked.
   *
   *     NOT because the send path cannot address a person - it can, since the
   *     staff-reply fix. `resolveSmsDestination` grew a `user_id` branch that
   *     reads `users.phone`, and the delivery gate admits a team thread that
   *     names someone (`isDeliverableThread`). A staff thread is a two-way
   *     conversation now, so do not restore the old reasoning here.
   */
  matchStaff?: boolean;
  /**
   * The other party's number as the caller stores it on the text (#3014), when the caller has already decided it: the
   * webhook passes it, null when the report names only one of our own numbers (such a text keeps today's keying). Left
   * out, it is the normalized number itself.
   */
  otherPartyE164?: string | null;
}

/** An unknown number's conversation title (and its key before pairs): the number as E.164, else as typed. */
const titleKeyOf = (rawNumber: string) => normalizeNAPhone(rawNumber) ?? (rawNumber || 'unknown');

export async function findOrCreateSmsThreadByNumber(
  db: Db,
  orgId: string,
  rawNumber: string,
  ourNumberE164: string | null,
  identify: IdentifyNumber,
  opts: FindOrCreateSmsThreadOptions = {},
): Promise<SmsThreadResolution> {
  const match = rawNumber ? await identify(rawNumber) : null;

  // Staff are resolved LAST and only on a total miss, so customer, lead and
  // vendor keying is reached exactly as it is today.
  if (!match && opts.matchStaff) {
    const staff = await matchActiveStaffByPhone(db, orgId, rawNumber);
    if (staff) return findOrCreateStaffThread(db, orgId, staff);
  }

  const titleKey = titleKeyOf(rawNumber);
  const otherParty = opts.otherPartyE164 !== undefined ? opts.otherPartyE164 : await otherPartyE164(db, orgId, rawNumber);
  // #3019: a customer's or an unknown number's conversation is the pair of numbers. A vendor's keeps its own key, and so
  // does a number that is no phone number at all, or is one of our own (it cannot be the other side of a pair; trap 8).
  if (otherParty && !(match && !match.customerId && match.vendorId)) {
    const { thread, created } = await findOrCreatePairConversation(
      db,
      orgId,
      { otherPartyE164: otherParty, ourNumberE164 },
      { customerId: match?.customerId ?? null, leadId: match?.leadId ?? null, title: titleKey },
    );
    return { thread, match, created };
  }

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
 * `matchStaff` — the compose door never opts into it), but never creates a row: the conversation
 * the text would join, or null when it would start one. Lets a caller gate ORIGINATING a brand-new
 * thread BEFORE any write happens, instead of creating one and rolling it back, and name the
 * conversation a text would join (#3023): the pair's own, whoever can read it.
 */
export async function existingSmsThreadForNumber(
  db: Db,
  orgId: string,
  rawNumber: string,
  ourNumberE164: string | null,
  identify: IdentifyNumber,
): Promise<{ id: string } | null> {
  const match = rawNumber ? await identify(rawNumber) : null;
  const titleKey = titleKeyOf(rawNumber);
  const otherParty = await otherPartyE164(db, orgId, rawNumber);
  // #3019: the same pair the compose door keys by, then a conversation from before pairs that may take this pair's text,
  // found as findOrCreatePairConversation finds one.
  if (otherParty && !(match && !match.customerId && match.vendorId)) {
    return existingPairConversation(
      db, orgId, { otherPartyE164: otherParty, ourNumberE164 }, { customerId: match?.customerId ?? null, leadId: null, title: titleKey },
    );
  }
  return db.messageThread.findFirst({
    where: match?.customerId
      ? { organization_id: orgId, channel: 'sms', customer_id: match.customerId }
      : match?.vendorId
        ? { organization_id: orgId, channel: 'sms', vendor_id: match.vendorId }
        : { organization_id: orgId, channel: 'sms', customer_id: null, vendor_id: null, title: titleKey },
    select: { id: true },
  });
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
