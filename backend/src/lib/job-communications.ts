/**
 * Communication ↔ Jobs aggregator (spec: md_files/specs/communication/2026-06-10-communication-jobs-spec.md §4).
 * Unions the four comm channels (CallSession / Message / Email / WhatsAppMessage) into the
 * shared CommItem contract: job-scoped (per-record job_id attribution), lead-scoped
 * (per-record lead_id attribution — full job-parity ruling, 2026-07-22), or
 * customer-scoped (the canonical thread linkage). Every query is org-scoped.
 *
 * FIFTH SOURCE (manual communication log, 2026-08-27): ManualCommunicationLog rows — records a
 * human typed in about a conversation that happened OFF the platform. They join here, in the
 * chronology, alongside the four real channels, and carry `manuallyLogged` so the row component
 * can mark them. This module is the ONLY place they are read from: the Communication module's
 * surfaces query call_sessions, message_threads and emails, and a logged entry is none of those,
 * so its exclusion from the Calls view, the texts list, the inbox, Performance, agent metrics and
 * call reports costs no code and cannot be forgotten. That holds per CHANNEL as of slice 6, when
 * a logged entry stopped always being a call - a logged text is not a platform text, and each of
 * those lists is its own query against its own table.
 *
 * ALL THREE AGGREGATIONS READ IT as of slice 5. Lead- and job-scoped ask for the anchor column
 * directly; the customer roll-up has no column to ask for (an entry stores no customer) and
 * reaches the entry THROUGH the lead or job it names. Entries are never migrated between the
 * three: one logged on a lead that later became a job stays on the lead.
 *
 * The db client is injected (the narrow surface below) so unit tests can stub it.
 */

import { BUILT_IN_LOST_REASONS } from './lostReasonOptions';
import { COUNTED_PAYMENT_WHERE } from './payment-ledger';
import { DEPOSIT_CREDIT_REFERENCE } from './deposit-credit';
import { statusLabel } from '../services/payments-report';
import type { TiedConversations } from './communication/recordConversations';
import { isUnverifiedSenderLink } from './communication/customerByAddress';

// The narrow Prisma surface the aggregator needs (lets unit tests inject a stub).
interface CommDb {
  callSession: { findMany(args: any): Promise<any[]> };
  message: { findMany(args: any): Promise<any[]> };
  email: { findMany(args: any): Promise<any[]> };
  whatsAppMessage: { findMany(args: any): Promise<any[]> };
  manualCommunicationLog: { findMany(args: any): Promise<any[]> };
  // The customer's estimate decisions (S08.9): only asked when the caller hands in the per-source row filters.
  estimate: { findMany(args: any): Promise<any[]> };
  timelineEvent: { findMany(args: any): Promise<any[]> };
  // The payments received on the record's invoices and deposits (S08.10): same rule as the estimate decisions above.
  payment: { findMany(args: any): Promise<any[]> };
  lostReasonOption: { findMany(args: any): Promise<any[]> };
}

/**
 * The caller's anchor-inherited row filter (lib/permissions/anchorVisibility.ts),
 * spread into every channel query below. {} for an org-wide requester.
 *
 * Why the timelines need it even though they already gate on the ENTITY: a row
 * can carry this lead's lead_id AND a job the requester cannot see. `job > lead`
 * precedence means the job decides, so the entity gate alone (canAccessRow on
 * the Lead) would surface it. The job timeline is the degenerate case - every
 * row on it carries that job_id, so the filter agrees with the gate - but it
 * rides all three so there is one rule, not three.
 */
export type CommVisibility = Record<string, unknown>;

/*
 * Each aggregation below also takes `withCallSummary`: whether the person may read what was said on a call (View
 * transcript, which covers the call summary - Roles & Permissions S08.12). A call row's preview line IS its summary, so
 * without it that line is empty. The record-tab controllers always pass it from the request's ability; the default
 * (true) is for callers with no request, such as tests and scripts.
 */

/**
 * One row filter per source, for the caller whose sources do not share a shape: a text or a WhatsApp message keeps its
 * customer on its conversation, and a logged entry has no vendor tie, so the shared `CommVisibility` above cannot say
 * the same thing about all five. `perChannel` is what tells the two forms apart. The Communication scope module builds
 * it (`recordTabWhere`); the shared form stays for the callers and tests that hand every source the same filter.
 */
export interface ChannelVisibility {
  perChannel: true;
  calls: CommVisibility;
  messages: CommVisibility;
  emails: CommVisibility;
  whatsapps: CommVisibility;
  manuals: CommVisibility;
  /** The estimates whose portal decisions the person may see as entries: the ones they can open, on a record they can open. */
  estimates: CommVisibility;
  /** The payments whose entries the person may see: the ones on invoices they can open, on a record they can open. */
  payments: CommVisibility;
  /**
   * The company's Email plan feature is off (PRD 10, S10.6): the tab shows no email at all, sent or received. The email
   * source is not read; `emails` above is then a filter that matches nothing, for any reader that forgets to look here.
   */
  emailHidden?: true;
}

type ChannelKey = Exclude<keyof ChannelVisibility, 'perChannel' | 'emailHidden'>;

/** The filter for one source, whichever form the caller handed in. */
function visibilityFor(visibility: CommVisibility | ChannelVisibility, channel: ChannelKey): CommVisibility {
  return 'perChannel' in visibility ? (visibility as ChannelVisibility)[channel] : visibility;
}

/** Whether a record's tab must show no email, because the company's Email plan feature is off. */
export function emailHiddenFrom(visibility: CommVisibility | ChannelVisibility): boolean {
  return 'perChannel' in visibility && visibility.emailHidden === true;
}

export type CommChannel = 'call' | 'email' | 'sms' | 'whatsapp';

/** What the customer did, or paid, as the entry on a record's tab says it (S08.9 estimate decisions, S08.10 payments). */
export type CustomerEntryKind = 'estimate_approved' | 'estimate_declined' | 'payment_received';

export interface CommItem {
  id: string;
  /** `portal` is an entry for something the customer did on their own link, not a conversation. */
  channel: CommChannel | 'portal';
  direction: 'in' | 'out';
  who: string;            // counterparty display name (customer name; phone/email fallback)
  title: string;          // call: "Inbound call · 4m 07s" / sms: "Text message" / whatsapp: "WhatsApp message" / email: subject or "(no subject)"
  preview: string;        // body/snippet/summary, truncated ~160 chars
  at: string;             // ISO timestamp
  jobId?: string;
  jobLabel?: string;      // omitted when null
  threadId?: string;      // sms only (#2046 R1) — the row's message_threads.id, so the record
                          // tabs' SMS drawer can re-source itself off the anchor-filtered
                          // `GET /communication/threads/:id` instead of the org-wide list.
  leadId?: string;        // lead linkage: call/email/sms lead_id (per-record); whatsapp chat.lead
  leadLabel?: string;     // joined lead's lead_number; omitted when unlinked
  answeredBy?: string;    // calls only: answered_by csr name → agent user name → 'Forwarded phone' (external)
  transactional?: boolean; // email rows with account === 'system'
  // A received message linked to its customer by the sender's address although the sender's domain could not prove who sent it
  // (PRD 10, S10.20); the row says "Unverified sender". Omitted otherwise, never `false`.
  unverifiedSender?: boolean;
  state?: string;          // reserved for business-state chip; NOT populated in v1
  meta?: string;           // call disposition etc.
  // Email delivery lifecycle (slice 5) - email channel only, omitted on every
  // other channel and on any email row nothing has reported on yet (Resend
  // webhook never fired, or the row predates it). NEVER a value meaning
  // "opened" - Apple Mail Privacy Protection prefetches images for roughly
  // half of recipients, making open-tracking meaningless as a signal, so the
  // backing enum (EmailDeliveryStatus) has no such value to forward.
  deliveryStatus?: string;
  deliveryStatusReason?: string;
  bounceKind?: string;
  // Hand-entered, not platform-recorded (manual communication log). Present ONLY on
  // ManualCommunicationLog rows and omitted (never `false`) everywhere else, same omit-if-absent
  // idiom as every optional above. This is what the timeline row renders the muted "Logged" chip
  // from, and marking these is safety-critical: a reader must never cite a typed note as though
  // it were a recorded call.
  manuallyLogged?: boolean;
  // Who TYPED the entry, and who HAD the conversation - as display names, because a reader of a
  // timeline resolves an id by making a second lookup they will never actually make. Both are
  // carried, and separately, precisely so the row can say which is which: an admin backfilling an
  // organisation's history is a second-hand witness to conversations colleagues had, and a
  // timeline that showed only one of the two would silently claim otherwise. Manual rows only.
  loggedByName?: string;
  performedByName?: string;
  // WHO TYPED IT, by id (slice 8) - what lets a client decide whether to offer an EDIT on this
  // row, which a display name cannot do because two colleagues can share one. It rides as a FACT
  // about the row; the policy ("the logger, or an organisation admin") is applied by whoever is
  // asking, and enforced for real on the write. The performer's id is deliberately NOT carried:
  // being credited with a conversation somebody else typed up does not make their record of it
  // yours to rewrite, so nothing needs it to answer that question. Manual rows only.
  loggedById?: string;
  // The customer's portal decisions on an estimate (S08.9) - `portal` rows only. An entry carries what the customer said
  // and nothing about the money: no total, no deposit.
  entry?: CustomerEntryKind;
  reason?: string;       // the decline reason the customer picked, as the organization words it
  reasonNote?: string;   // the customer's own words with it
  // A payment received (S08.10) - `payment_received` entries only. The amount follows the invoice it was paid on: anyone who
  // gets the entry can open that invoice, so its price is theirs to see.
  amount?: number;
  paidVia?: 'online' | 'office';
}

const PREVIEW_MAX = 160;

const CUSTOMER_SELECT = { select: { id: true, first_name: true, last_name: true, company_name: true } };
// Lean joins for the additive chip fields (slice E3/E6).
const LEAD_SELECT = { select: { lead_number: true } };
const AGENT_SELECT = { select: { first_name: true, last_name: true } };

// Per-channel includes, shared by all three aggregators. The job join is
// calls-only (job_number fallback for pre-job_label rows — message/email/
// whatsapp rows are stamped at write time); the lead join (lead chip) and the
// call's agent join (answeredBy fallback) ride every query, kept lean above.
const CALL_INCLUDE = {
  customer: CUSTOMER_SELECT,
  job: { select: { job_number: true } },
  lead: LEAD_SELECT,
  agent: AGENT_SELECT,
};
const MESSAGE_INCLUDE = {
  thread: { select: { title: true, customer: CUSTOMER_SELECT } },
  lead: LEAD_SELECT,
};
const EMAIL_INCLUDE = { customer: CUSTOMER_SELECT, lead: LEAD_SELECT };
const WHATSAPP_INCLUDE = {
  chat: { select: { name: true, phone: true, lead_id: true, lead: LEAD_SELECT, customer: CUSTOMER_SELECT } },
};
// A manual entry carries no counterparty of its own by design (the spec: "the lead or job already
// resolves to the customer"), so `who` comes from the anchor's customer. BOTH anchors are joined
// (slice 5) because exactly one of them is set on any given row, and each doubles as that row's
// chip label - the lead-chip's lead_number and the job-chip's job_number - exactly as they do on
// the four real channels.
const MANUAL_INCLUDE = {
  lead: { select: { lead_number: true, customer: CUSTOMER_SELECT } },
  job: { select: { job_number: true, customer: CUSTOMER_SELECT } },
  // The THIRD anchor (#2021), joined directly. A customer-anchored entry has no lead and no job
  // standing between it and its counterparty, so without this join `who` blanks on every one of
  // them - the same failure deleting the `job:` line above produces.
  customer: CUSTOMER_SELECT,
  // Both users, joined here rather than resolved by the reader: the row records who had the
  // conversation and who typed it up, and the timeline has to be able to say both.
  performer: { select: { first_name: true, last_name: true } },
  logger: { select: { first_name: true, last_name: true } },
};

// ─── Mapping helpers ────────────────────────────────────────────────────────

function truncate(text: string): string {
  if (text.length <= PREVIEW_MAX) return text;
  return `${text.slice(0, PREVIEW_MAX - 1)}…`;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// first_name/last_name/company_name convention (matches mapCallSession in comm-calls.controller).
function customerName(customer: any): string | null {
  if (customer == null) return null;
  const name = customer.company_name ?? [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  return name || null;
}

// A joined User as one display string. Same first/last convention as answeredByName's agent
// fallback below; null when the relation did not resolve or carries no name at all.
function userName(user: any): string | null {
  if (user == null) return null;
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || null;
}

function formatDuration(sec: number): string {
  const minutes = Math.floor(sec / 60);
  const seconds = String(sec % 60).padStart(2, '0');
  return `${minutes}m ${seconds}s`;
}

// Who answered a call, as one display string. Mirrors the answered_by JSON
// written by lib/ctm/ingest.ts (kinds: csr / external / voicemail / none): a
// csr with a name wins; a name-less csr row falls back to the joined agent
// user; an external answer (forwarded phone — the payload never carries the
// E.164) is labelled as such; a voicemail disposition (Task C4) is labelled
// "Voicemail" so this aggregated timeline reads the same as the Calls tab;
// everything else stays absent.
function answeredByName(row: any): string | undefined {
  const ab = row.answered_by && typeof row.answered_by === 'object' ? row.answered_by : null;
  if (ab?.kind === 'csr' && typeof ab.name === 'string' && ab.name) return ab.name;
  const agentName = [row.agent?.first_name, row.agent?.last_name].filter(Boolean).join(' ');
  if (agentName) return agentName;
  if (ab?.kind === 'external') return 'Forwarded phone';
  if (ab?.kind === 'voicemail') return 'Voicemail';
  return undefined;
}

// Shared lead-chip spread: leadId from the row/relation FK, leadLabel from the
// joined lead's lead_number (omit-if-null, same idiom as jobId/jobLabel).
function leadFields(leadId: unknown, lead: any): Partial<CommItem> {
  return {
    ...(leadId != null && { leadId: leadId as string }),
    ...(lead?.lead_number != null && { leadLabel: lead.lead_number }),
  };
}

// ─── Per-channel row → CommItem mappers (omit-if-null, mapCallSession style) ─

function mapCall(row: any, withCallSummary: boolean): CommItem {
  const direction = row.direction === 'out' ? 'out' : 'in';
  const fallback = direction === 'in' ? row.from_number : row.to_number;
  // CallSession rows created before job_label stamping have job_id but NULL
  // job_label — fall back to the joined job's job_number so the badge survives.
  const jobLabel = row.job_label ?? row.job?.job_number;
  const answeredBy = answeredByName(row);
  return {
    id: row.id,
    channel: 'call',
    direction,
    who: customerName(row.customer) ?? fallback ?? '',
    title: `${direction === 'in' ? 'Inbound' : 'Outbound'} call${row.duration_sec != null ? ` · ${formatDuration(row.duration_sec)}` : ''}`,
    // The call summary is what was said on the call, so it follows View transcript (S08.12): without it the row keeps
    // its title, who, when and chips, and the preview line is empty.
    preview: withCallSummary ? truncate(row.summary ?? '') : '',
    at: toIso(row.started_at),
    ...(row.job_id != null && { jobId: row.job_id }),
    ...(jobLabel != null && { jobLabel }),
    ...leadFields(row.lead_id, row.lead),
    ...(answeredBy != null && { answeredBy }),
    ...(row.disposition != null && { meta: row.disposition }),
  };
}

function mapMessage(row: any): CommItem {
  return {
    id: row.id,
    channel: 'sms',
    direction: row.direction === 'out' ? 'out' : 'in',
    who: customerName(row.thread?.customer) ?? row.thread?.title ?? '',
    title: 'Text message',
    preview: truncate(row.body ?? ''),
    at: toIso(row.ts),
    ...(row.job_id != null && { jobId: row.job_id }),
    ...(row.job_label != null && { jobLabel: row.job_label }),
    ...(row.thread_id != null && { threadId: row.thread_id }),
    ...leadFields(row.lead_id, row.lead),
  };
}

function mapEmail(row: any): CommItem {
  const direction = row.folder === 'sent' ? 'out' : 'in';
  const fromJson = row.from && typeof row.from === 'object' ? row.from : null;
  const fallback = direction === 'out'
    ? (typeof row.to === 'string' ? row.to : '')
    : (fromJson?.name ?? fromJson?.email ?? '');
  return {
    id: row.id,
    channel: 'email',
    direction,
    who: customerName(row.customer) ?? fallback ?? '',
    title: row.subject || '(no subject)',
    preview: truncate(row.snippet ?? ''),
    // `at` derives from created_at (a DateTime that is always right). NEVER use
    // row.ts here: it is a BigInt epoch-ms column (JS bigint on read — Date()/
    // JSON.stringify throw) and legacy mock rows hold small ints (1970 dates
    // that sort to the timeline's start).
    at: toIso(row.created_at),
    ...(row.job_id != null && { jobId: row.job_id }),
    ...(row.job_label != null && { jobLabel: row.job_label }),
    ...leadFields(row.lead_id, row.lead),
    ...(row.account === 'system' && { transactional: true }),
    // PRD 10, S10.20: linked to this customer by an address the sender's domain could not vouch for.
    ...(isUnverifiedSenderLink(row) && { unverifiedSender: true }),
    ...(row.delivery_status != null && { deliveryStatus: row.delivery_status }),
    ...(row.delivery_status_reason != null && { deliveryStatusReason: row.delivery_status_reason }),
    ...(row.bounce_kind != null && { bounceKind: row.bounce_kind }),
  };
}

function mapWhatsApp(row: any): CommItem {
  return {
    id: row.id,
    channel: 'whatsapp',
    direction: row.from === 'us' ? 'out' : 'in',
    who: customerName(row.chat?.customer) ?? row.chat?.name ?? row.chat?.phone ?? '',
    title: 'WhatsApp message',
    preview: truncate(row.text ?? ''),
    at: toIso(row.created_at),
    ...(row.job_id != null && { jobId: row.job_id }),
    ...(row.job_label != null && { jobLabel: row.job_label }),
    ...leadFields(row.chat?.lead_id, row.chat?.lead),
  };
}

/**
 * What the title CALLS a logged entry, per channel (slice 6).
 *
 * Until the channel picker shipped this was the literal string 'call', while the mapper read the
 * row's `channel` column two lines above - harmless only for as long as CALL was the only value
 * anything could write. A logged text titled "Outbound call" is not a cosmetic slip: it states
 * that a phone conversation happened when none did.
 *
 * "text", not "sms", because that is the word the product already uses for the channel
 * (frontend atoms.tsx's channelLabel, and mapMessage's own "Text message"). whatsapp is not
 * writable - the API's enum has three values - and is here so the table is total.
 */
const MANUAL_CHANNEL_NOUN: Record<CommChannel, string> = {
  call: 'call',
  sms: 'text',
  email: 'email',
  whatsapp: 'message',
};

// A hand-typed record of a conversation that happened off the platform. Same CommItem shape as
// every other source and the same omit-if-null idiom - it belongs IN the chronology, marked, not
// in a section of its own. The DB enums are upper-case; CommItem's vocabulary is lower-case.
function mapManual(row: any): CommItem {
  const direction = row.direction === 'OUT' ? 'out' : 'in';
  // Upper-case in the DB enum, lower-case in CommItem's vocabulary. Three values are writable as
  // of slice 6 (call / sms / email); a row that names none is a call, which is what every entry
  // logged before the picker existed is.
  const channel = String(row.channel ?? 'CALL').toLowerCase() as CommChannel;
  // THE TITLE IS THE CHANNEL, and nothing else qualifies the noun. An entry's `outcome` column
  // once made NO_ANSWER / VOICEMAIL read as "Outbound call attempt". That was retired: the
  // capture UI and every reader went first, then the column and the `ManualCommOutcome` enum
  // were dropped. Nothing qualifies the noun now, and no row can carry an outcome to qualify it
  // with.
  const noun = MANUAL_CHANNEL_NOUN[channel] ?? 'communication';
  // Whole minutes, in the same slot and the same shape a platform-recorded call already carries
  // its own duration (mapCall: "Inbound call · 4m 07s") - one reading for the column, not two.
  // `typeof`, not a truthiness check: zero minutes is a real answer to "how long?".
  //
  // PINNED TO THE CALL CHANNEL (slice 8, carry-forward C9), like the subject below. A duration is a fact about a telephone conversation; an email does not have
  // one, and a row carrying both rendered "Outbound email · 12m" - the exact string slice 6's
  // commit message cites as its reason for refusing the pairing at the API. That refusal is real
  // but it is the ONLY guard: no DB CHECK stands behind it, and slice 8 added a second endpoint
  // writing the same columns. The reader must not repeat a claim the writer merely promised not
  // to store.
  const duration =
    channel === 'call' && typeof row.duration_minutes === 'number'
      ? ` · ${row.duration_minutes}m`
      : '';
  // The subject of a logged email, in the SAME slot the duration above rides and the same slot
  // mapEmail puts a platform email's subject in - so a reader scanning the column reads one
  // shape. Deliberately NOT mapEmail's "(no subject)" fallback: that says a header was sent
  // empty, whereas an entry with no subject simply never recorded one, and an admin typing up
  // months of history will not remember every subject line.
  const subject = channel === 'email' && row.subject ? ` · ${row.subject}` : '';
  return {
    id: row.id,
    channel,
    direction,
    // Whichever anchor this entry names - exactly one is ever set. The entry stores no
    // counterparty of its own, so the anchor's customer IS the counterparty.
    who: customerName(row.lead?.customer ?? row.job?.customer ?? row.customer) ?? '',
    title: `${direction === 'in' ? 'Inbound' : 'Outbound'} ${noun}${duration}${subject}`,
    preview: truncate(row.notes ?? ''),
    at: toIso(row.occurred_at),
    // jobId rides the row's own column; jobLabel comes from the joined job, the same omit-if-null
    // idiom the four real channels use for their own job chip.
    ...(row.job_id != null && { jobId: row.job_id }),
    ...(row.job?.job_number != null && { jobLabel: row.job.job_number }),
    ...leadFields(row.lead_id, row.lead),
    manuallyLogged: true,
    // The logger's own id, from the row's column rather than from the join - it is what a client
    // compares against itself to decide whether to offer an edit. Not omit-if-absent like the
    // names below it: the column is NOT NULL, so an absent value here would mean the query
    // stopped selecting it, and a client that then hid every edit affordance would be failing
    // closed for the right reason.
    ...(row.logged_by != null && { loggedById: row.logged_by }),
    // Omit-if-absent, same idiom as every other optional: a join that did not resolve leaves the
    // field off rather than shipping an empty string the row would then render as a blank name.
    ...(userName(row.logger) && { loggedByName: userName(row.logger)! }),
    ...(userName(row.performer) && { performedByName: userName(row.performer)! }),
  };
}

// ─── The customer's estimate decisions (S08.9) ──────────────────────────────

/*
 * An estimate the customer approved or declined on their own link shows on the record's tab as an entry. Nothing new is
 * stored for it: the product already writes an APPROVED or DECLINED event on the estimate's history when the customer
 * decides, and none for the office's own decision from the app, which always has the signed-in person behind it. So an
 * event with nobody behind it is the customer's, and decisions from before this existed read the same way.
 *
 * The entry sits where the estimate sits - on its job when it has one, else on its lead; a lead-stage estimate that
 * converted sits on both - and only for a person who can open the estimate (the `estimates` row filter). It reads the
 * estimate for its number and ties and never its total: an entry says what the customer did, not what it was worth.
 */

const CUSTOMER_DECISION_EVENTS: Record<string, CustomerEntryKind> = {
  APPROVED: 'estimate_approved',
  DECLINED: 'estimate_declined',
};

// The built-in words, for an organization that never customised its list; the code itself reads as a last resort.
function humanizeReasonCode(code: string): string {
  const text = code.toLowerCase().replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The reason code a decline recorded and the customer's words with it, from the event or, for the oldest ones, the estimate. */
function declineAnswer(event: any, estimate: any): { code: string | null; note: string | null } {
  const meta = event.metadata && typeof event.metadata === 'object' ? event.metadata : null;
  if (meta && 'lost_reason' in meta) {
    return { code: meta.lost_reason ?? null, note: meta.lost_reason_note ?? null };
  }
  // A decline from before the event carried its answer: the estimate holds it for as long as it stays declined.
  return estimate.status === 'DECLINED'
    ? { code: estimate.lost_reason ?? null, note: estimate.lost_reason_note ?? null }
    : { code: null, note: null };
}

function mapCustomerDecision(event: any, estimate: any, reasonLabel: string | null, note: string | null): CommItem {
  const entry = CUSTOMER_DECISION_EVENTS[event.event_type];
  const spoken = [reasonLabel, note].filter(Boolean).join(' - ');
  return {
    id: event.id,
    channel: 'portal',
    direction: 'in',
    who: customerName(estimate.customer) ?? '',
    title: `Estimate ${estimate.estimate_number} ${entry === 'estimate_approved' ? 'approved' : 'declined'} by the customer`,
    preview: truncate(spoken),
    at: toIso(event.created_at),
    ...(estimate.job_id != null && { jobId: estimate.job_id }),
    ...(estimate.job_link?.job_number != null && { jobLabel: estimate.job_link.job_number }),
    ...leadFields(estimate.lead_id, estimate.lead),
    entry,
    ...(reasonLabel && { reason: reasonLabel }),
    ...(note && { reasonNote: note }),
  };
}

/**
 * The customer-decision entries for the estimates `tie` names (the record's own estimates), narrowed by the person's
 * `estimates` row filter. Only the per-source form of visibility carries that filter; a caller that hands in one shared
 * filter, which cannot say it, gets no entries.
 */
async function customerDecisionEntries(
  db: CommDb,
  args: { organizationId: string; tie: CommVisibility; visibility: CommVisibility | ChannelVisibility },
): Promise<CommItem[]> {
  const { organizationId, tie, visibility } = args;
  if (!('perChannel' in visibility)) return [];
  const reach = visibility.estimates;
  const estimates = await db.estimate.findMany({
    where: { organization_id: organizationId, AND: [tie, reach] },
    select: {
      id: true, estimate_number: true, job_id: true, lead_id: true, status: true, lost_reason: true, lost_reason_note: true,
      job_link: { select: { job_number: true } }, lead: LEAD_SELECT, customer: CUSTOMER_SELECT,
    },
  });
  if (estimates.length === 0) return [];
  const byId = new Map<string, any>(estimates.map((e) => [e.id, e]));
  const events = await db.timelineEvent.findMany({
    where: {
      organization_id: organizationId,
      entity_type: 'ESTIMATE',
      entity_id: { in: [...byId.keys()] },
      event_type: { in: Object.keys(CUSTOMER_DECISION_EVENTS) },
      created_by: null,
    },
    select: { id: true, entity_id: true, event_type: true, metadata: true, created_at: true },
  });
  const answers = new Map<string, { code: string | null; note: string | null }>();
  for (const event of events) {
    if (event.event_type === 'DECLINED') answers.set(event.id, declineAnswer(event, byId.get(event.entity_id)));
  }
  const codes = [...new Set([...answers.values()].map((a) => a.code).filter((c): c is string => !!c))];
  const labels = new Map<string, string>(BUILT_IN_LOST_REASONS.map((r) => [r.code, r.label]));
  if (codes.length > 0) {
    // The organization's own words win, including for a reason it has since switched off: the customer picked it then.
    const own = await db.lostReasonOption.findMany({ where: { organization_id: organizationId, code: { in: codes } }, select: { code: true, label: true } });
    for (const o of own) labels.set(o.code, o.label);
  }
  return events.map((event) => {
    const answer = answers.get(event.id);
    const reasonLabel = answer?.code ? labels.get(answer.code) ?? humanizeReasonCode(answer.code) : null;
    return mapCustomerDecision(event, byId.get(event.entity_id), reasonLabel, answer?.note ?? null);
  });
}

// ─── Payments received (S08.10) ─────────────────────────────────────────────

/*
 * A payment received on one of the record's invoices or deposits shows on the tab as an entry, read from the payment row
 * itself (past payments show; nothing is stored for it). Which rows are money received is the ledger's own rule
 * (COUNTED_PAYMENT_WHERE: it landed, and was not voided - a bank debit still clearing, a failed one, a chargeback or a
 * returned payment is not), less two more: the synthetic row that carries a deposit's credit onto the final invoice (the
 * same cash as the deposit's own payment, so counting it would show the money twice) and a payment given back whole (the
 * report's "Refunded"). One only partly refunded was still received in full and shows at its full amount.
 *
 * It sits where its invoice sits: on the invoice's job, or the job its estimate went on to have; a deposit that started on
 * a lead sits on the lead too, and an invoice with neither sits on the customer. Only a person who can open the invoice
 * gets it (the `payments` row filter), and its amount is that invoice's price, so it follows the
 * invoice's money rules: no cost or company-wide figure is in it. It says "paid online" when the customer paid on their own
 * link and "recorded by the office" otherwise, and never names the payment processor.
 */

const NOT_DEPOSIT_CREDIT = { OR: [{ reference_number: null }, { reference_number: { not: DEPOSIT_CREDIT_REFERENCE } }] };

/** The payments of a job, of a lead (its deposits, and any invoice with no job), or of a customer. */
const PAYMENT_TIES = {
  job: (jobId: string): CommVisibility => ({ invoice: { OR: [{ job_id: jobId }, { job_id: null, estimate: { job_id: jobId } }] } }),
  lead: (leadId: string): CommVisibility => ({
    invoice: {
      AND: [{ estimate: { lead_id: leadId } }, { OR: [{ kind: 'DEPOSIT' }, { job_id: null, estimate: { job_id: null } }] }],
    },
  }),
  customer: (customerId: string): CommVisibility => ({ invoice: { customer_id: customerId } }),
};

/**
 * The customer paid it themselves on their own link. Payments from before creators were tracked carry 'UNKNOWN' as their
 * creator, so a card or bank payment the processor took is told apart by the processor's id on the row.
 */
function paidOnline(row: any): boolean {
  return row.created_by_source === 'CLIENT'
    || row.stripe_payment_intent_id != null || row.stripe_charge_id != null || row.stripe_checkout_session_id != null;
}

function mapPayment(row: any): CommItem {
  const invoice = row.invoice;
  const estimate = invoice.estimate;
  const jobId = invoice.job_id ?? estimate?.job_id ?? null;
  const jobLabel = invoice.job?.job_number ?? estimate?.job_link?.job_number ?? null;
  const paidVia = paidOnline(row) ? 'online' : 'office';
  return {
    id: row.id,
    channel: 'portal',
    direction: 'in',
    who: customerName(invoice.customer) ?? '',
    title: `Payment received on ${invoice.kind === 'DEPOSIT' ? 'deposit' : 'invoice'} ${invoice.invoice_number}`,
    preview: paidVia === 'online' ? 'Paid online' : 'Recorded by the office',
    at: toIso(row.paid_at),
    ...(jobId != null && { jobId }),
    ...(jobLabel != null && { jobLabel }),
    ...leadFields(estimate?.lead_id, estimate?.lead),
    entry: 'payment_received',
    amount: Number(row.amount),
    paidVia,
  };
}

/** A payment given back whole is no longer money received. */
function givenBackWhole(row: any): boolean {
  return statusLabel({
    amount: Number(row.amount),
    refundedAt: row.refunded_at,
    refundedAmount: row.refunded_amount == null ? null : Number(row.refunded_amount),
    voidedAt: row.voided_at,
  }) === 'Refunded';
}

/**
 * The payment entries for the payments `tie` names, narrowed by the person's `payments` row filter. Only the per-source
 * form of visibility carries that filter; a caller that hands in one shared filter, which cannot say it, gets no entries.
 */
async function paymentEntries(
  db: CommDb,
  args: { organizationId: string; tie: CommVisibility; visibility: CommVisibility | ChannelVisibility },
): Promise<CommItem[]> {
  const { organizationId, tie, visibility } = args;
  if (!('perChannel' in visibility)) return [];
  const rows = await db.payment.findMany({
    where: {
      ...COUNTED_PAYMENT_WHERE,
      AND: [{ invoice: { organization_id: organizationId } }, tie, NOT_DEPOSIT_CREDIT, visibility.payments],
    },
    select: {
      id: true, amount: true, paid_at: true, created_by_source: true, refunded_at: true, refunded_amount: true, voided_at: true,
      stripe_payment_intent_id: true, stripe_charge_id: true, stripe_checkout_session_id: true,
      invoice: {
        select: {
          invoice_number: true, kind: true, job_id: true, job: { select: { job_number: true } }, customer: CUSTOMER_SELECT,
          estimate: { select: { job_id: true, lead_id: true, job_link: { select: { job_number: true } }, lead: LEAD_SELECT } },
        },
      },
    },
  });
  return rows.filter((row) => !givenBackWhole(row)).map(mapPayment);
}

// ─── Union + sort ───────────────────────────────────────────────────────────

// All five sources are required as of slice 5 - every aggregation below queries every one of
// them, so a call site that omitted one would be a source that was forgotten rather than a
// source that is deliberately empty.
function unionAscending(
  calls: any[],
  messages: any[],
  emails: any[],
  whatsapps: any[],
  manuals: any[],
  withCallSummary: boolean,
  customerEntries: CommItem[],
  tied?: TiedConversations,
): CommItem[] {
  return [
    ...calls.map((row) => mapCall(row, withCallSummary)),
    ...messages.map(mapMessage),
    ...emails.map((row) => mapEmail(tied ? tied.withTie(row) : row)),
    ...whatsapps.map(mapWhatsApp),
    ...manuals.map(mapManual),
    ...customerEntries,
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

// A tab that lists record conversations also reads which record each message's conversation is about (S10.5).
const TAB_EMAIL_INCLUDE = { ...EMAIL_INCLUDE, thread: { select: { origin: true, record_type: true, record_id: true } } };

/**
 * The email read of a job's or lead's tab. The messages stored on the record by their own job or lead column, as ever,
 * and (when the caller worked them out, S10.5) the record conversations tied to it with their customer replies. A
 * conversation about an estimate or an invoice comes only through the tied half, which holds it for the people who can
 * open that estimate or invoice, so those messages are dropped from the stored half. Without `tied` this is the plain
 * read. Two reads either way, whatever the number of conversations.
 */
async function tabEmails(
  db: CommDb,
  stored: CommVisibility,
  args: { organizationId: string; visibility: CommVisibility | ChannelVisibility; tied?: TiedConversations },
): Promise<any[]> {
  const { organizationId, visibility, tied } = args;
  if (emailHiddenFrom(visibility)) return [];
  const own = { ...stored, organization_id: organizationId, ...visibilityFor(visibility, 'emails') };
  if (!tied) return db.email.findMany({ where: own, include: EMAIL_INCLUDE });
  const [ownRows, tiedRows] = await Promise.all([
    db.email.findMany({ where: own, include: TAB_EMAIL_INCLUDE }),
    tied.tiedEmailWhere
      ? db.email.findMany({ where: { organization_id: organizationId, ...tied.tiedEmailWhere }, include: TAB_EMAIL_INCLUDE })
      : Promise.resolve([]),
  ]);
  const seen = new Set<string>();
  return [...ownRows.filter((row) => !tied.isAboutAnEstimateOrInvoice(row)), ...tiedRows].filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

/**
 * A message that reached several of the company's addresses is stored once per mailbox, each copy carrying the customer
 * (S10.20), and the copies share the provider's message id up to the `#<mailboxId>` suffix of every copy but the first. The
 * customer's tab lists that message once: the copy in a mailbox the person reads when there is one, else the first stored.
 * A row with no provider id (typed in by hand, or old) is its own message.
 */
function collapseMailboxCopies(rows: any[], readMailboxIds: readonly string[]): any[] {
  const reads = new Set(readMailboxIds);
  const kept = new Map<string, any>();
  const out: any[] = [];
  for (const row of rows) {
    const providerId: string | null = row.provider_message_id ?? null;
    if (providerId == null) { out.push(row); continue; }
    const key = providerId.split('#')[0]!;
    const held = kept.get(key);
    if (!held) { kept.set(key, row); out.push(row); continue; }
    const rowReadable = reads.has(row.thread?.mailbox_id);
    if (rowReadable && !reads.has(held.thread?.mailbox_id)) {
      out[out.indexOf(held)] = row;
      kept.set(key, row);
    }
  }
  return out;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function getJobCommunications(
  db: CommDb,
  args: { jobId: string; organizationId: string; visibility?: CommVisibility | ChannelVisibility; withCallSummary?: boolean; tied?: TiedConversations }
): Promise<CommItem[]> {
  const { jobId, organizationId, visibility = {}, withCallSummary = true, tied } = args;
  const [calls, messages, emails, whatsapps, manuals, ...entryLists] = await Promise.all([
    db.callSession.findMany({
      where: { job_id: jobId, organization_id: organizationId, ...visibilityFor(visibility, 'calls') },
      include: CALL_INCLUDE,
    }),
    db.message.findMany({
      where: { job_id: jobId, organization_id: organizationId, ...visibilityFor(visibility, 'messages') },
      include: MESSAGE_INCLUDE,
    }),
    tabEmails(db, { job_id: jobId }, { organizationId, visibility, tied }),
    db.whatsAppMessage.findMany({
      where: { job_id: jobId, organization_id: organizationId, ...visibilityFor(visibility, 'whatsapps') },
      include: WHATSAPP_INCLUDE,
    }),
    // The manual log rides the same job_id scoping and the same anchor-inherited visibility
    // filter as the four real channels above.
    //
    // ENTRIES STAY WHERE THEY WERE LOGGED. This asks for job_id and nothing else, so an entry
    // logged on the LEAD this job was converted from is absent here - it remains on the lead,
    // which is what makes the conversion history read truthfully. There is deliberately no
    // union through `job.lead_id`.
    db.manualCommunicationLog.findMany({
      where: { job_id: jobId, organization_id: organizationId, ...visibilityFor(visibility, 'manuals') },
      include: MANUAL_INCLUDE,
    }),
    customerDecisionEntries(db, { organizationId, tie: { job_id: jobId }, visibility }),
    paymentEntries(db, { organizationId, tie: PAYMENT_TIES.job(jobId), visibility }),
  ]);

  return unionAscending(calls, messages, emails, whatsapps, manuals, withCallSummary, entryLists.flat(), tied);
}

export async function getCustomerCommunications(
  db: CommDb,
  args: {
    customerId: string; organizationId: string; visibility?: CommVisibility | ChannelVisibility; withCallSummary?: boolean;
    /** The mailboxes the person reads: of one message that reached several, the tab lists the copy in one of these. */
    readMailboxIds?: readonly string[];
  }
): Promise<CommItem[]> {
  const { customerId, organizationId, visibility = {}, withCallSummary = true, readMailboxIds = [] } = args;
  const [calls, messages, emails, whatsapps, manuals, ...entryLists] = await Promise.all([
    db.callSession.findMany({
      where: { customer_id: customerId, organization_id: organizationId, ...visibilityFor(visibility, 'calls') },
      include: CALL_INCLUDE,
    }),
    db.message.findMany({
      where: { organization_id: organizationId, thread: { customer_id: customerId }, ...visibilityFor(visibility, 'messages') },
      include: MESSAGE_INCLUDE,
    }),
    emailHiddenFrom(visibility)
      ? Promise.resolve([])
      : db.email.findMany({
          where: { customer_id: customerId, organization_id: organizationId, ...visibilityFor(visibility, 'emails') },
          include: { ...EMAIL_INCLUDE, thread: { select: { mailbox_id: true } } },
          // Stored order, so the copy kept when the person reads none of them is the same one every time.
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        }),
    db.whatsAppMessage.findMany({
      where: { organization_id: organizationId, chat: { customer_id: customerId }, ...visibilityFor(visibility, 'whatsapps') },
      include: WHATSAPP_INCLUDE,
    }),
    // THREE ROUTES TO ONE CUSTOMER. An entry anchored on a LEAD or a JOB stores no customer of
    // its own (the spec: "the lead or job already resolves to the customer"), so the roll-up
    // reaches those THROUGH the anchor they name; an entry anchored on the CUSTOMER (#2021)
    // carries the column directly. Exactly one anchor is ever set - the
    // `manual_communication_logs_exactly_one_anchor` CHECK, now num_nonnulls of three - so the
    // disjunction can never return the same row twice.
    //
    // AND-NESTED, NOT A BARE `OR`, and the third disjunct joins the existing one rather than
    // sitting beside it. `visibility` is spread last and is itself `{ OR: [...] }` whenever the
    // requester is row-restricted; a top-level `OR` here would be overwritten by that spread,
    // silently discarding the customer filter and handing back every logged entry in the
    // organisation. Under AND all three survive and are all required.
    //
    // The customer-anchored row is the WORST case for getting that wrong: its lead_id and job_id
    // are both null, so it lands in anchorInheritedWhere's unconditional third branch and the
    // visibility filter excludes nothing. This clause is the only thing scoping it.
    db.manualCommunicationLog.findMany({
      where: {
        organization_id: organizationId,
        AND: [
          {
            OR: [
              { lead: { customer_id: customerId } },
              { job: { customer_id: customerId } },
              { customer_id: customerId },
            ],
          },
        ],
        ...visibilityFor(visibility, 'manuals'),
      },
      include: MANUAL_INCLUDE,
    }),
    customerDecisionEntries(db, { organizationId, tie: { customer_id: customerId }, visibility }),
    paymentEntries(db, { organizationId, tie: PAYMENT_TIES.customer(customerId), visibility }),
  ]);

  return unionAscending(calls, messages, collapseMailboxCopies(emails, readMailboxIds), whatsapps, manuals, withCallSummary, entryLists.flat());
}

// Lead-scoped roll-up (full job-parity ruling, 2026-07-22 — "leads should
// behave exactly like jobs"): strictly the rows attributed to THIS lead by
// lead_id, mirroring getJobCommunications' job_id scoping exactly. No
// customer-history union — a row phone-matched to the lead's customer but
// never explicitly attributed to this lead (lead_id NULL) does not appear,
// same as an un-job-tagged row never appearing on a job's timeline. Every
// channel carries a lead link: CallSession.lead_id / Message.lead_id /
// Email.lead_id directly, WhatsAppMessage via WhatsAppChat.lead_id (chat
// stays lead-scoped, same shape as its job_id counterpart).
export async function getLeadCommunications(
  db: CommDb,
  args: { leadId: string; organizationId: string; visibility?: CommVisibility | ChannelVisibility; withCallSummary?: boolean; tied?: TiedConversations }
): Promise<CommItem[]> {
  const { leadId, organizationId, visibility = {}, withCallSummary = true, tied } = args;
  const [calls, messages, emails, whatsapps, manuals, ...entryLists] = await Promise.all([
    db.callSession.findMany({
      where: { lead_id: leadId, organization_id: organizationId, ...visibilityFor(visibility, 'calls') },
      include: CALL_INCLUDE,
    }),
    db.message.findMany({
      where: { lead_id: leadId, organization_id: organizationId, ...visibilityFor(visibility, 'messages') },
      include: MESSAGE_INCLUDE,
    }),
    tabEmails(db, { lead_id: leadId }, { organizationId, visibility, tied }),
    // NOTE: still keyed on the CHAT's lead link, not WhatsAppMessage.lead_id.
    // Slice 8a added that column for scoping and backfilled it from here, so the
    // two agree; repointing this query is a separate, behaviour-changing call.
    db.whatsAppMessage.findMany({
      where: { organization_id: organizationId, chat: { lead_id: leadId }, ...visibilityFor(visibility, 'whatsapps') },
      include: WHATSAPP_INCLUDE,
    }),
    // The manual log rides the same lead_id scoping and the same anchor-inherited visibility
    // filter as the four real channels - it carries lead_id and job_id, so the filter's shape
    // applies to it unchanged.
    db.manualCommunicationLog.findMany({
      where: { lead_id: leadId, organization_id: organizationId, ...visibilityFor(visibility, 'manuals') },
      include: MANUAL_INCLUDE,
    }),
    customerDecisionEntries(db, { organizationId, tie: { lead_id: leadId }, visibility }),
    paymentEntries(db, { organizationId, tie: PAYMENT_TIES.lead(leadId), visibility }),
  ]);

  return unionAscending(calls, messages, emails, whatsapps, manuals, withCallSummary, entryLists.flat(), tied);
}
