import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { customerName, matchByPhone, matchCallerByPhone, normalizeNAPhone, type IdentityMatch, type OwnRecord } from '../comms-identity';
import { findBlockedNumber } from '../communication/blockedNumbers';
import { findOrCreateSmsThreadByNumber, mainLineE164 } from './smsThread';
import { resolveCompanyNumberId } from './companyNumber';
import { otherPartyE164 } from '../communication/otherPartyNumber';
import { lookupReceivingNumber } from './receivingNumbers';
import { tieIncomingText, UNTIED } from '../sms-reply-router';
import { emit } from '../../services/notifications/notificationService';
import { logger } from '../logger';
import { recordLeadOutboundContact, type LeadContactDb } from '../../services/lead-contact.service';
import { INBOUND_CLAIM_WINDOW_MS } from '../call-tracking/process';
import { textAlertPreview } from '../communication/textPreview';

/**
 * Pure-ish ingestion of CTM webhook activities into the Communication module.
 *
 * Every payload read is defensive: CTM's field names drift across triggers and
 * docs (see the v3.1 addendum §A) — a missing field degrades a row, never
 * throws. DB errors DO propagate (the webhook responds 500 so CTM's retry +
 * the backfill script re-deliver); notification emits are best-effort and
 * swallowed by the notification service itself.
 */

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Stamped on a CallSession whose caller is on the org's blocked list, so a
 * suppressed call stays visible and filterable in the Calls log rather than
 * silently going missing. Suppression is never destructive - see
 * lib/communication/blockedNumbers.ts for why the ring itself cannot be stopped.
 */
export const BLOCKED_CALL_TAG = 'Blocked caller';

export interface IngestOptions {
  /**
   * Historical backfill flag: a bulk import must not ring bells or mark
   * hundreds of threads unread — suppresses BOTH notification emits and
   * thread unread increments. The live webhook path never sets it.
   */
  suppressNotifications?: boolean;
  /**
   * The org's CTM sub-account id, used ONLY to resolve which phone a forwarded
   * call rang (see resolveExternalAnswerer). Optional on purpose: every caller
   * that omits it simply ingests forwarded answers unattributed, exactly as
   * before, and no caller has to acquire it to keep working.
   */
  ctmAccountId?: string;
  /**
   * True ONLY when the `db` handed to ingest is the PLAIN client rather than a transaction (the
   * historical backfill script). It tells the lead-contact writer to run its clock stamp and its
   * New -> Contacted move (#2618) in one transaction of their own on that client. Omitted, ingest
   * is inside the caller's transaction (the live webhook) and the writer runs in it, under a
   * savepoint. Stated by the caller rather than sniffed off `db` - see `LeadContactDb`. Getting it
   * wrong is not harmless: a plain client treated as a transaction cannot open the savepoint, so
   * the contact is logged as failed and not recorded.
   */
  plainClient?: boolean;
  /**
   * The live webhook's door for its bell alerts. Ingest runs inside the webhook's transaction, and the alert's access filter
   * reads the call or the text conversation that transaction creates (S08.21): raised from inside it, the alert would ask
   * other connections about a row they cannot see yet and find nobody to tell. So the webhook passes this, is handed each
   * alert as a function to run, and runs them once the transaction has committed and the webhook has answered. Omitted
   * (the backfill, which uses the plain client and suppresses alerts anyway, and direct calls in tests), the alert is raised
   * where it is written, as before. The function returns the alert's own promise (emit never rejects) so a caller that wants to
   * know the alert is written can wait for it; the webhook does not.
   */
  afterCommit?: (raise: () => Promise<unknown>) => void;
}

/** Raise a bell alert now, or, for the live webhook, hand it over to run after its transaction commits. Never throws. */
function raiseAlert(opts: IngestOptions, args: Parameters<typeof emit>[0]): void {
  const raise = () => emit(args);
  if (opts.afterCommit) opts.afterCommit(raise);
  else void raise();
}

/** Where the lead-contact writer runs: the caller's transaction, unless told it holds none. */
function leadContactDb(db: Db, opts: IngestOptions): LeadContactDb {
  // The cast is the caller's statement above, not a guess: `plainClient` says `db` is the client.
  return opts.plainClient ? { client: db as PrismaClient } : { tx: db };
}

// CTM sometimes wraps the activity under a `call` key.
export function unwrapActivity(payload: Record<string, any>): Record<string, any> {
  if (payload && typeof payload.call === 'object' && payload.call !== null) return payload.call;
  return payload ?? {};
}

/** The way an activity (a call or a text) says it went, or null when it names no direction at all. */
export function activityDirection(a: Record<string, any>): 'in' | 'out' | null {
  const raw = String(a.direction ?? '').trim().toLowerCase();
  if (!raw) return null;
  return raw.includes('out') ? 'out' : 'in';
}

/** The way a call went: anything the phone system marks outbound is ours; the rest (a direction-less call included) came in. */
function callDirection(a: Record<string, any>): 'in' | 'out' {
  return activityDirection(a) ?? 'in';
}

/** The way a text went, by the same rule: a text the phone system does not mark outbound came in. */
function textDirection(a: Record<string, any>): 'in' | 'out' {
  return activityDirection(a) ?? 'in';
}

// Maps CTM dial/call statuses into the FE CallStatus union
// (ringing|active|completed|voicemail|missed — communication-shared/phone-calls.ts).
// #3025: "no answer" also comes spelled with a space, and "failed" is a call that never connected: both are missed, never
// completed. An outbound end with zero talk time and no answered leg never reached anyone, whatever status it reports, so
// it is missed too (the call history reads it "Not connected"; an outbound call raises no missed-call alert).
function callStatus(a: Record<string, any>, position: string): string {
  if (position === 'starts') return 'ringing';
  const raw = String(a.dial_status ?? a.call_status ?? '').toLowerCase();
  // Separators dropped, so "no answer", "no-answer", "no_answer" and "noanswer" read alike.
  const word = raw.replace(/[\s_-]+/g, '');
  if (raw.includes('voicemail')) return 'voicemail';
  if (
    word.includes('noanswer') || raw.includes('busy') || raw.includes('missed') || raw.includes('abandon') ||
    raw.includes('cancel') || raw.includes('fail')
  ) {
    return 'missed';
  }
  // "hangup" (observed live 2026-07-21): a leg disconnected without a normal
  // answered/completed resolution. Zero talk time means nobody ever connected
  // (caller gave up in the queue/ring) — that is a missed call; with talk time
  // it was a real conversation that simply ended by hanging up.
  if (raw.includes('hangup')) {
    const talk = Number(a.talk_time ?? a.duration);
    return Number.isFinite(talk) && talk > 0 ? 'completed' : 'missed';
  }
  if (callDirection(a) === 'out' && !talkedOn(a) && !hasAnsweredLeg(a)) return 'missed';
  return 'completed';
}

/** Whether the call had a conversation: talk time above zero. `duration` is not talk: it counts the ringing too. */
function talkedOn(a: Record<string, any>): boolean {
  const talk = Number(a.talk_time);
  return Number.isFinite(talk) && talk > 0;
}

/** Whether a leg of the call was answered: the phone service names the agent who picked up (the agent leg). */
function hasAnsweredLeg(a: Record<string, any>): boolean {
  return a.agent !== null && typeof a.agent === 'object';
}

// caller_number is not guaranteed E.164; caller_number_complete carries the
// +country form when present (CTM Data Dictionary).
function callerNumber(a: Record<string, any>): string {
  return String(a.caller_number_complete ?? a.caller_number ?? '');
}

// Recording presence across the four observed field spellings. The URL itself
// is NEVER fetched — recordings are fetched by sid (SSRF rule, client.ts).
export function recordingUrlOf(a: Record<string, any>): string | null {
  const candidate =
    a.audio ??
    a.recording_url ??
    a.audio_url ??
    (a.recording && typeof a.recording === 'object' ? a.recording.url : a.recording);
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

// Speaker-labelled transcript text (CTM Transcribe). CTM's `transcription` key
// is a URL PATH (/api/v1/…/transcription.json) — only *_text-style string
// fields qualify, and anything URL/path-shaped is rejected. Capped so a
// runaway payload can't bloat the row.
const TRANSCRIPT_MAX_CHARS = 20_000;
export function transcriptOf(a: Record<string, any>): string | null {
  const candidate = a.transcription_text ?? a.transcript_text ?? a.transcript;
  if (typeof candidate !== 'string') return null;
  const text = candidate.trim();
  if (!text || text.startsWith('/') || /^https?:\/\//i.test(text)) return null;
  return text.length > TRANSCRIPT_MAX_CHARS ? text.slice(0, TRANSCRIPT_MAX_CHARS) : text;
}

// Marketing attribution: which campaign produced this call. The pilot org runs
// campaign numbers that FORWARD to the office, so the only durable link between
// a conversation and the ad that paid for it is what CTM hands us here. Ingest
// used to keep `source` alone (as tracking_source) and drop the rest.
//
// `ga` is CTM's key for the Google click id; it is stored as `gclid` because
// that is what it is and what any downstream join to Google Ads will call it.
//
// Deliberately NOT captured: visitor_ip and the caller geo block (city/state/
// postal_code/lat/long). They ride the same payload but they describe the
// PERSON, not the campaign, and there is no reporting requirement for them yet
// - collecting personal data "in case" is how it ends up somewhere it should
// not be. They stay one line away in ctm_events if a real need appears.
const ATTRIBUTION_KEYS: Array<[payloadKey: string, storedKey: string]> = [
  ['source', 'source'],
  ['source_id', 'source_id'],
  ['medium', 'medium'],
  ['campaign', 'campaign'],
  ['campaign_id', 'campaign_id'],
  ['keyword', 'keyword'],
  ['referrer', 'referrer'],
  ['ad_network', 'ad_network'],
  ['ad_group_id', 'ad_group_id'],
  ['adgroup_id', 'adgroup_id'],
  ['creative_id', 'creative_id'],
  ['ad_content', 'ad_content'],
  ['ad_format', 'ad_format'],
  ['ad_match_type', 'ad_match_type'],
  ['ad_slot', 'ad_slot'],
  ['ad_targeting_type', 'ad_targeting_type'],
  ['tracking_label', 'tracking_label'],
  ['web_source', 'web_source'],
  ['last_touch', 'last_touch'],
  ['ga', 'gclid'],
];

/**
 * Build the attribution record, or null when CTM sent nothing usable.
 *
 * Absent keys are OMITTED rather than stored as null: a row full of nulls makes
 * "CTM had no campaign for this call" indistinguishable from "we never captured
 * campaign at all" for whoever reads this in six months. Empty/whitespace
 * strings are treated as absence too - CTM really does send `''` for unset
 * fields (observed on live tracking_label/referrer), and an empty bucket in a
 * GROUP BY is worse than no bucket.
 *
 * Returns null (SQL NULL), never `{}`, so the partial GIN index covers only
 * rows that genuinely carry attribution.
 */
function attributionOf(a: Record<string, any>): Prisma.InputJsonObject | null {
  const out: Record<string, string> = {};
  for (const [from, to] of ATTRIBUTION_KEYS) {
    const raw = a[from];
    if (raw === null || raw === undefined) continue;
    const value = String(raw).trim();
    if (!value) continue;
    out[to] = value;
  }
  return Object.keys(out).length > 0 ? (out as Prisma.InputJsonObject) : null;
}

export interface TranscriptTurn {
  speaker: string;
  text: string;
  channel: number | null;
  startSec: number | null;
  endSec: number | null;
}

// CTM's structured transcript (`GET .../transcription.json` -> `outline[]`),
// as opposed to transcriptOf()'s flat transcription_text: the same audio is
// split per speaker channel there and interleaved fragment-by-fragment, so a
// full sentence is unrecoverable once flattened. `outline[]` keeps each
// speaker's utterance whole with per-turn timing. channel 1 is always the
// external party, channel 2 is always our side — verified live across both
// inbound and outbound calls; the channel-2 *name* varies (a user or a call
// group), so sidedness must key off `channel`, never off matching a name.
const TRANSCRIPT_TURNS_MAX_CHARS = 20_000;
function numOrNull(x: unknown): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
export function transcriptTurnsOf(a: Record<string, any> | null | undefined): TranscriptTurn[] | null {
  const outline = a?.outline;
  if (!Array.isArray(outline) || outline.length === 0) return null;

  const turns: TranscriptTurn[] = [];
  let totalChars = 0;
  for (const entry of outline) {
    if (!entry || typeof entry !== 'object') continue;
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!text) continue;
    if (totalChars + text.length > TRANSCRIPT_TURNS_MAX_CHARS) break;
    totalChars += text.length;
    const trimmedSpeaker = typeof entry.speaker === 'string' ? entry.speaker.trim() : '';
    const speaker = trimmedSpeaker ? trimmedSpeaker.replace(/\s+/g, ' ') : 'Unknown';
    const channel = numOrNull(entry.channel);
    const startSec = numOrNull(entry.s);
    const endSec = numOrNull(entry.e);
    turns.push({ speaker, text, channel, startSec, endSec });
  }
  return turns.length > 0 ? turns : null;
}

// CTM's per-call AI insight, in precedence order:
//  1. `summary` - plain prose, the most specific of the three ("Agent Ran Roffe
//     called the contact in PRINCETON NJ… the contact asked 'Who is this?'").
//  2. `activity_analysis.general` - the "General" tab of CTM's AskAI Summaries
//     panel, and the ONLY one of that object's 9 sections that is a real call
//     summary. The other eight (demo / sales / project_kick_off / …) are
//     B2B-SaaS template prose that reads as noise on a field-service call
//     ("No product or feature was demonstrated"), so they stay unread.
//  3. `notes` - the manual agent-typed note, empty on every stored pilot org
//     payload, which is why reading it alone left the Insights column stuck on
//     its empty-state dash forever.
const SUMMARY_MAX_CHARS = 4_000;
function askAiGeneral(a: Record<string, any>): string | undefined {
  const analysis = a.activity_analysis;
  if (!analysis || typeof analysis !== 'object') return undefined;
  return typeof analysis.general === 'string' && analysis.general.trim()
    ? analysis.general
    : undefined;
}
export function summaryOf(a: Record<string, any>): string | null {
  const candidate =
    (typeof a.summary === 'string' && a.summary.trim() ? a.summary : undefined) ??
    askAiGeneral(a) ??
    a.notes;
  if (typeof candidate !== 'string') return null;
  const text = candidate.trim();
  if (!text) return null;
  return text.length > SUMMARY_MAX_CHARS ? text.slice(0, SUMMARY_MAX_CHARS) : text;
}

// Who answered: a CTM-app agent → 'csr'; a `status:'voicemail'` row (see
// isVoicemailByCallPath below — always agent-less by construction) →
// 'voicemail'; a completed inbound call with NO agent object was answered on
// an external forwarded phone (the payload only carries receiving_number_*
// ids, never the E.164) → 'external'. Everything else (missed / ringing /
// outbound legs) stays 'none'.
function answeredByOf(
  a: Record<string, any>,
  agent: Record<string, any> | null,
  direction: 'in' | 'out',
  status: string,
): Prisma.InputJsonObject {
  if (agent) {
    return {
      kind: 'csr',
      ctm_agent_id: agent.id ?? null,
      name: agent.name ?? null,
      email: agent.email ?? null,
    };
  }
  if (status === 'voicemail') {
    return { kind: 'voicemail', ctm_agent_id: null, name: null, email: null };
  }
  if (direction === 'in' && status === 'completed') {
    return {
      kind: 'external',
      receiving_number_id: a.receiving_number_id != null ? String(a.receiving_number_id) : null,
    };
  }
  return { kind: 'none', ctm_agent_id: null, name: null, email: null };
}

/**
 * Name whoever picked up a forwarded call.
 *
 * An 'external' answer is the common case at a contractor that forwards its
 * campaign numbers to staff mobiles and to the office, and it used to be a
 * dead end: the payload carries only `receiving_number_id`, so the row knew
 * that a human answered and never which one. That id is CTM's numeric
 * `filter_id`, and the receiving-numbers roster maps it to the E.164 that
 * actually rang - which is enough to find the ServWave user who owns it.
 *
 * `kind` deliberately stays 'external': answering a forwarded call on a mobile
 * is a different operational event from answering in the app, and the Calls
 * view labels them differently. What changes is that the answer now carries an
 * identity.
 *
 * The E.164 itself is NOT persisted. `answered_by` is serialised straight to
 * the API and rendered in the Calls list, so storing it would publish a staff
 * member's personal mobile to everyone in the org; `user_id` already carries
 * the identity, and the number was only ever the lookup key.
 */
export async function resolveExternalAnswerer(
  db: Db,
  orgId: string,
  answeredBy: Prisma.InputJsonObject,
  ctmAccountId: string,
): Promise<{ answeredBy: Prisma.InputJsonObject; agentId: string | null } | null> {
  const filterId = answeredBy.receiving_number_id;
  if (typeof filterId !== 'string' || !filterId) return null;

  // Cache-only, and never awaited on the network: this runs inside the
  // webhook's prisma.$transaction. See lib/ctm/receivingNumbers.ts.
  const receiving = lookupReceivingNumber(ctmAccountId, filterId);
  if (!receiving) return null;

  // `users.phone` is free text (bare 10 digits on the live rows, punctuated on
  // others) while CTM returns E.164, so both sides are normalised rather than
  // compared as stored. Staff lists are small - see the Roles section of
  // CLAUDE.md - so this is a handful of rows, not a scan.
  const staff = await db.user.findMany({
    where: { organization_id: orgId, phone: { not: null } },
    select: { id: true, first_name: true, last_name: true, email: true, phone: true },
  });
  const answerer = staff.find(
    (u) => u.phone && normalizeNAPhone(u.phone) === receiving.e164,
  );

  if (answerer) {
    const fullName = [answerer.first_name, answerer.last_name].filter(Boolean).join(' ').trim();
    return {
      answeredBy: {
        kind: 'external',
        receiving_number_id: filterId,
        user_id: answerer.id,
        // ServWave is the system of record for staff names; CTM's copy of the
        // same person is hand-typed there and drifts.
        name: fullName || receiving.name,
        email: answerer.email ?? null,
      },
      agentId: answerer.id,
    };
  }

  // No user owns that number. A named one is still worth surfacing (the office
  // line is a place, not a person), but agent_id stays null rather than
  // inventing an owner. An unnamed, unmatched number adds nothing at all.
  if (receiving.name) {
    return {
      answeredBy: { kind: 'external', receiving_number_id: filterId, name: receiving.name },
      agentId: null,
    };
  }
  return null;
}

/**
 * Attribute a forwarded call to the person the dialed number is assigned to.
 *
 * `resolveExternalAnswerer` above observes who picked up, by mapping the
 * payload's `receiving_number_id` to an E.164 and matching it against
 * `users.phone`. That is the better signal when it fires - and on the live
 * account it fires for nobody: every user has `phone: null`, the receiving
 * number is unnamed, and five of the forwarded calls in staging carry no
 * `receiving_number_id` at all (#1387).
 *
 * Assignment answers the same question without any of those dependencies. A
 * number is bought with a forward destination and assigned to whoever is
 * responsible for the calls it takes; that person is who answered. The dialed
 * number is on the payload itself, so this needs no roster, no staff phone
 * number, and no `receiving_number_id`.
 *
 * Resolved HERE, at ingest, and stored on the row - never derived at read time
 * from the current assignment, or reassigning a number in October would
 * silently rewrite who answered in September.
 *
 * A number with several assignees resolves to nobody: "the assigned user
 * answered" stops being a fact the moment there are two of them, and naming one
 * at random is worse than leaving the call unattributed.
 */
export async function resolveAssignedAnswerer(
  db: Db,
  orgId: string,
  dialedE164: string,
): Promise<{ answeredBy: Prisma.InputJsonObject; agentId: string } | null> {
  const e164 = normalizeNAPhone(dialedE164) ?? dialedE164;
  if (!e164) return null;

  const number = await db.phoneNumber.findFirst({
    where: { organization_id: orgId, e164 },
    select: {
      user_links: {
        select: {
          user_id: true,
          user: { select: { id: true, first_name: true, last_name: true, email: true } },
        },
      },
    },
  });
  if (!number || number.user_links.length !== 1) return null;

  const assignee = number.user_links[0].user;
  if (!assignee) return null;
  const fullName = [assignee.first_name, assignee.last_name].filter(Boolean).join(' ').trim();

  return {
    answeredBy: {
      kind: 'external',
      user_id: assignee.id,
      name: fullName || null,
      email: assignee.email ?? null,
      // Distinguishes "we assumed the person responsible for this number" from
      // the observed case, where CTM told us which destination answered.
      resolved_from: 'assignment',
    },
    agentId: assignee.id,
  };
}

// Voicemail disposition (Phase C, Task C4 — resolves plan open item #3).
// RESEARCHED (Supabase MCP, 2026-07-16): the live ctm_events table holds 15
// stored `end` events for the pilot org (596375) and NOT ONE is a voicemail —
// every row is either agent-answered or forwarded to an external phone, and
// `dial_status`/`call_status` are never literally "voicemail" in any of them
// (there's also no dedicated `voicemail` key in the payload at all). So this
// detector is built from the BEST-AVAILABLE signal, not an observed one:
//  1. dial_status/call_status literally reads "voicemail" — already folded
//     into callStatus() above (CTM's documented dial-status enum covers it).
//  2. Fallback for the shape voicemail calls will likely actually arrive in:
//     a call answered by CTM's Voice Menu message box is still "answered" from
//     CTM's own point of view (the IVR DID pick up) — dial_status/call_status
//     will probably read "completed"/"answered", NOT "voicemail" — with no
//     `agent` object. The tell is the LAST `call_path` hop being the
//     Voicemail Voice Menu that routing.ts (Task C3, `ensureVoicemailMenu`)
//     provisions. Every OTHER observed hop's `route_type` is a PascalCase CTM
//     routing-object class name (PhysicalPhoneNumber / ConditionalRouter /
//     RoutingRule / CallQueue), so a Voice Menu hop is expected to surface the
//     same way ("VoiceMenu"). Re-verify against a real payload once one lands
//     (Phase E live QA) and tighten/loosen this match then.
function isVoicemailByCallPath(a: Record<string, any>, direction: 'in' | 'out'): boolean {
  if (direction !== 'in') return false;
  const path = Array.isArray(a.call_path) ? a.call_path : [];
  const lastHop = path[path.length - 1];
  const routeType =
    lastHop && typeof lastHop === 'object' && typeof lastHop.route_type === 'string'
      ? lastHop.route_type
      : '';
  return /voice[\s_-]?menu|voicemail/i.test(routeType);
}

function activityTime(a: Record<string, any>): Date {
  const unix = Number(a.unix_time);
  if (Number.isFinite(unix) && unix > 0) return new Date(unix * 1000);
  if (a.called_at) {
    const d = new Date(String(a.called_at));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/**
 * Whether the event that filed a stored call knew nobody placed it (#3015), read from what that event stored. Claiming a
 * click-to-call stash names the placer: the agent leg, or the stash's requester when the leg is missing, lands in `agent_id`
 * and makes `answered_by` a csr. A row with neither was filed before any stash or agent leg was seen, so its placer's stash
 * may still turn up at a later event; a row with a placer already ran both stash tiers when it was filed.
 */
function filedWithoutPlacer(row: { agent_id: string | null; answered_by: Prisma.JsonValue }): boolean {
  const answeredBy = row.answered_by && typeof row.answered_by === 'object' && !Array.isArray(row.answered_by)
    ? (row.answered_by as Record<string, unknown>)
    : null;
  return row.agent_id == null && answeredBy?.kind !== 'csr';
}

/**
 * Takes one call's lock (#3015) until the transaction `db` runs in ends: the call ingest takes it for each event of the
 * call, and the phone-history repair (scripts/phone-history-repair.ts, #3028) for each call it re-files or deletes, so the
 * two never write the same call at once. The ONE place the lock's key is spelled.
 */
export async function lockCallEvents(db: Db, sid: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ctm-call:${sid}`}, 0))`;
}

export type CallFiling = { customer_id: string | null; lead_id: string | null; job_id: string | null; job_label: string | null };

/**
 * Where the fixed order files a call on its number (#3015), when nobody placed it from a record: the number's customer, and
 * the one lead or job carrying the number as its own when that record decided the pick. The call ingest files a new call
 * by it; the phone-history repair (scripts/phone-history-repair.ts, #3028) re-files an old one by the same rule.
 */
export function callFilingByFixedOrder({ match, ownRecord }: { match: IdentityMatch | null; ownRecord: OwnRecord | null }): CallFiling {
  return {
    customer_id: match?.customerId ?? null,
    lead_id: ownRecord?.kind === 'lead' ? ownRecord.id : null,
    job_id: ownRecord?.kind === 'job' ? ownRecord.id : null,
    job_label: ownRecord?.kind === 'job' ? ownRecord.jobNumber : null,
  };
}

/**
 * What a later event of a call may write to where the call is filed (#3015). A call is filed once, by the event that
 * creates its row: on the record it was placed from (the click-to-call stash), else by the number's fixed order. A later
 * event never moves it to another customer, lead or job, whatever the data says by then; it only fills what is empty:
 *  - a row filed on nothing yet takes this event's filing in full (a caller nobody carried when the call rang);
 *  - a row on a customer alone takes the lead or job of a stash claimed now for that same customer (the placer's stash,
 *    found only once the agent leg named the placer);
 *  - anything else keeps its filing. A person's re-tie is kept the same way.
 * Only keys with a value are written, so a populated column is never blanked out. With no stored row (a `starts`/`end`
 * race), the update gets the full filing, as the create does.
 */
function fillEmptyFiling(
  row: { customer_id: string | null; lead_id: string | null; job_id: string | null; vendor_id: string | null } | null,
  filing: CallFiling,
  fromStash: boolean,
  vendorId: string | null,
): Record<string, unknown> {
  const filled: Record<string, unknown> = {};
  const unfiled = !row || (!row.customer_id && !row.lead_id && !row.job_id && !row.vendor_id);
  const sameCustomerStash = fromStash && row != null && row.customer_id != null && row.customer_id === filing.customer_id
    && row.lead_id == null && row.job_id == null;
  if (unfiled) {
    if (filing.customer_id) filled.customer_id = filing.customer_id;
    if (vendorId) filled.vendor_id = vendorId;
  }
  if (unfiled || sameCustomerStash) {
    if (filing.lead_id) filled.lead_id = filing.lead_id;
    if (filing.job_id) {
      filled.job_id = filing.job_id;
      filled.job_label = filing.job_label;
    }
  }
  return filled;
}

/** The name of the customer a call is filed on, as the identity match labels a customer. */
async function filedCustomerName(db: Db, orgId: string, customerId: string): Promise<string | null> {
  const filed = await db.customer.findFirst({
    where: { id: customerId, organization_id: orgId },
    select: { first_name: true, last_name: true, company_name: true },
  });
  return filed ? customerName(filed) : null;
}

export interface IngestCallResult {
  callSessionId: string;
  sid: string;
  status: string;
  direction: 'in' | 'out';
  hasRecording: boolean;
}

// Click-to-call attribution stash: how long a pending_call_attributions row
// (written by POST /calls right before the CTM bridge) stays claimable here.
// Generous enough for slow agent-leg pickup + webhook latency, short enough
// that an abandoned stash can't mislabel tomorrow's call to the same number.
const PENDING_ATTRIBUTION_WINDOW_MS = 30 * 60_000;

export async function ingestCall(
  db: Db,
  orgId: string,
  payload: Record<string, any>,
  position: string,
  opts: IngestOptions = {},
): Promise<IngestCallResult | null> {
  const a = unwrapActivity(payload);
  // A text reported on a call hook is not a call (#3025): it would leave a "ringing" call behind. Texts are ingested by the
  // text hooks.
  if (isTextActivity(a)) return null;
  const sid = String(a.sid ?? '');
  if (!sid) {
    logger.warn('[ctm] call activity without sid — skipped');
    return null;
  }

  // One call's events one at a time (#3015). The phone service can deliver a call's `starts` and `end` together; in two
  // parallel transactions both would read "no stored row" below, and the `end` would file over what the `starts` just
  // created (the stash's record replaced by the fixed order). A transaction lock on the sid makes the second event wait
  // for the first to commit, so `existingCall` is current. The webhook passes its transaction, which holds no provider HTTP
  // call (the receiving-number roster is warmed before it opens). On a plain client (the backfill, one call at a time)
  // the lock ends with its own statement and changes nothing.
  await lockCallEvents(db, sid);

  // Org assert: ctm_call_id is globally unique, so an upsert keyed on it could
  // otherwise UPDATE another org's row if a forged/misrouted payload reuses a
  // stored sid. A cross-org collision is warned + skipped, never written.
  const existingCall = await db.callSession.findFirst({
    where: { ctm_call_id: sid },
    select: {
      organization_id: true, customer_id: true, lead_id: true, job_id: true, vendor_id: true, agent_id: true, answered_by: true,
      call_tracking_provider: true, attribution: true,
    },
  });
  if (existingCall && existingCall.organization_id !== orgId) {
    logger.warn(`[ctm] call sid already stored for a different organization — skipped (sid=${sid})`);
    return null;
  }

  const direction = callDirection(a);
  let status = callStatus(a, position);
  const caller = callerNumber(a);
  const tracking = String(a.tracking_number ?? '');
  const fromNumber = direction === 'in' ? caller : tracking;
  const toNumber = direction === 'in' ? tracking : String(a.called_number ?? a.call_number ?? caller);
  const customerSide = direction === 'in' ? caller : toNumber;

  const { match, ownRecord } = customerSide
    ? await matchCallerByPhone(db, orgId, customerSide)
    : { match: null, ownRecord: null };
  // The company number the call went through (S08.1), as a link to the org's own number.
  const companyNumberId = await resolveCompanyNumberId(db, orgId, tracking);

  // Resolve the placing agent up front (softphone: the answering agent leg IS
  // the ServWave user who placed the call). Attribution follows the PLACER, so
  // the consume below needs this BEFORE it runs — not after.
  const agent = a.agent && typeof a.agent === 'object' ? a.agent : null;
  let agentId: string | null = null;
  if (agent?.email) {
    const user = await db.user.findFirst({
      where: { organization_id: orgId, email: String(agent.email).toLowerCase() },
      select: { id: true },
    });
    agentId = user?.id ?? null;
  }

  // Voicemail override (Task C4) — only reachable on a settled `end` payload
  // with no agent; see isVoicemailByCallPath's header comment for why this
  // exists alongside callStatus()'s literal "voicemail" check.
  if (position !== 'starts' && !agent && isVoicemailByCallPath(a, direction)) {
    status = 'voicemail';
  }

  // Click-to-call attribution consume (slice E1 + placer match): POST /calls (or
  // the softphone stash) recorded the job/lead/customer context because THIS
  // webhook — not the API call — creates the CallSession. Attribution follows the
  // PLACER, not the dialed number: a call launched from a job keeps that job even
  // when the number is edited to reach a cell. Two tiers, each windowed and
  // atomically claimed (updateMany on consumed_at: null, so a starts/end race
  // never applies one stash twice):
  //   1. the newest stash for THIS destination number — the unedited path, and
  //      it disambiguates when the placer has several open stashes; else
  //   2. the placer's newest stash regardless of number — the edited-number path.
  // Outbound only. Skipped when this event cannot use the stash (#3015): a row already on a lead or a job keeps it; a late
  // `starts` never writes the filing; and a row filed with its placer known already ran both tiers when it was filed. In
  // each case claiming here would only take the stash of the NEXT call placed to the number.
  let pending: {
    id: string;
    job_id: string | null;
    job_label: string | null;
    lead_id: string | null;
    customer_id: string | null;
    requested_by: string | null;
  } | null = null;
  const stashUsable = !existingCall
    || (position !== 'starts' && existingCall.lead_id == null && existingCall.job_id == null && filedWithoutPlacer(existingCall));
  if (direction === 'out' && stashUsable) {
    const windowStart = new Date(Date.now() - PENDING_ATTRIBUTION_WINDOW_MS);
    const claimStash = async (
      selector: { to_number: string } | { requested_by: string },
    ) => {
      const candidate = await db.pendingCallAttribution.findFirst({
        where: { organization_id: orgId, consumed_at: null, created_at: { gte: windowStart }, ...selector },
        orderBy: { created_at: 'desc' },
      });
      if (!candidate) return null;
      const claimed = await db.pendingCallAttribution.updateMany({
        where: { id: candidate.id, consumed_at: null },
        data: { consumed_at: new Date() },
      });
      return claimed.count === 1 ? candidate : null;
    };
    const normalizedTo = normalizeNAPhone(customerSide) ?? customerSide;
    if (normalizedTo) pending = await claimStash({ to_number: normalizedTo });
    if (!pending && agentId) pending = await claimStash({ requested_by: agentId });
  }

  // External call-tracking join (plan: md_files/plans/communication/
  // 2026-09-10-external-call-tracking-webhook-receiver.md §4d). A vendor's
  // pre-call webhook stashed the marketing session keyed on the CALLER before
  // this call reached us; claim it by caller within a window around the call's
  // own start time (not the wall clock, so a late `end` after a long call still
  // finds the stash written when it began). Inbound only, and only while the
  // row carries no vendor join yet; the claim is the same atomic
  // consumed_at-null update as click-to-call, so a starts/end race applies one
  // stash once.
  let tracked: {
    tracking_source: string | null;
    attribution: unknown;
    provider: 'callrail' | 'whatconverts' | null;
    vendor_call_id: string | null;
  } | null = null;
  if (direction === 'in' && (!existingCall || existingCall.call_tracking_provider == null)) {
    const normalizedCaller = caller ? normalizeNAPhone(caller) ?? caller : '';
    if (normalizedCaller) {
      const startedAt = activityTime(a);
      const candidate = await db.pendingCallAttribution.findFirst({
        where: {
          organization_id: orgId,
          consumed_at: null,
          provider: { not: null },
          from_number: normalizedCaller,
          created_at: {
            gte: new Date(startedAt.getTime() - INBOUND_CLAIM_WINDOW_MS),
            lte: new Date(startedAt.getTime() + INBOUND_CLAIM_WINDOW_MS),
          },
        },
        orderBy: { created_at: 'desc' },
        select: { id: true, tracking_source: true, attribution: true, provider: true, vendor_call_id: true },
      });
      if (candidate) {
        const claimed = await db.pendingCallAttribution.updateMany({
          where: { id: candidate.id, consumed_at: null },
          data: { consumed_at: new Date() },
        });
        if (claimed.count === 1) tracked = candidate;
      }
    }
  }
  const trackedAttribution =
    tracked?.attribution && typeof tracked.attribution === 'object' && !Array.isArray(tracked.attribution)
      ? (tracked.attribution as Record<string, unknown>)
      : null;

  const recUrl = recordingUrlOf(a);
  const durationRaw = Number(a.talk_time ?? a.duration);
  const durationSec = Number.isFinite(durationRaw) ? Math.round(durationRaw) : null;
  // Two different clocks, and they are NOT interchangeable. `talk_time` is the
  // conversation and belongs in the Calls list; `duration` is the connected
  // time CTM actually invoices, and is what the plan allowance meters (see
  // lib/comm-usage.ts billableSecondsOf). Storing only talk_time under-counted
  // billed minutes by 13.6% and missed rang-unanswered calls entirely.
  const connectedRaw = Number(a.duration);
  const connectedSec = Number.isFinite(connectedRaw) ? Math.round(connectedRaw) : null;
  const transcript = transcriptOf(a);
  const summary = summaryOf(a);
  const turns = transcriptTurnsOf(a);
  let answeredBy: Prisma.InputJsonObject = answeredByOf(a, agent, direction, status);

  // Who placed it: agent-less outbound payloads ingest as answered_by 'none',
  // but a claimed stash knows the requesting user — attribute the call to them
  // as a csr. A CTM agent payload always wins over this fallback.
  let requesterAnswered = false;
  if (!agent && pending?.requested_by) {
    const requester = await db.user.findFirst({
      where: { id: pending.requested_by, organization_id: orgId },
      select: { id: true, first_name: true, last_name: true, email: true },
    });
    if (requester) {
      agentId = requester.id;
      requesterAnswered = true;
      answeredBy = {
        kind: 'csr',
        ctm_agent_id: null,
        name: [requester.first_name, requester.last_name].filter(Boolean).join(' ') || null,
        email: requester.email ?? null,
      };
    }
  }

  // Who picked up a forwarded call. Runs only for an agent-less external
  // answer, so a CTM agent payload is never second-guessed.
  if (answeredBy.kind === 'external' && opts.ctmAccountId) {
    const resolved = await resolveExternalAnswerer(db, orgId, answeredBy, opts.ctmAccountId);
    if (resolved) {
      answeredBy = resolved.answeredBy;
      if (resolved.agentId) agentId = resolved.agentId;
    }
  }

  // Still nobody: fall back to whoever the dialed number is assigned to. This
  // is the path that actually resolves on the live account, where no user has
  // a phone number on file for the observation above to match against.
  if (answeredBy.kind === 'external' && !answeredBy.user_id && toNumber) {
    const assigned = await resolveAssignedAnswerer(db, orgId, toNumber);
    if (assigned) {
      answeredBy = assigned.answeredBy;
      agentId = assigned.agentId;
    }
  }

  // Blocked-list probe. Inbound only (blocking has no meaning for a call the
  // org placed), and skipped entirely on the backfill path - scripts/
  // ctm-backfill.ts already suppresses every bell, so the lookup could only
  // retro-tag history with a block that did not exist at the time, at one
  // uncapped query per imported row.
  const blockedCaller =
    direction === 'in' && !opts.suppressNotifications
      ? (await findBlockedNumber(db, orgId, caller)) !== null
      : false;
  // CTM's own tag list, with the block marker folded in. `[]` and undefined are
  // indistinguishable downstream (neither renders a chip nor mints a filter
  // facet), so an empty result still writes undefined, exactly as before.
  const ctmTags: Prisma.InputJsonValue[] = Array.isArray(a.tag_list) ? a.tag_list : [];
  const tagsWithMarker = [...new Set([...ctmTags, ...(blockedCaller ? [BLOCKED_CALL_TAG] : [])])];

  // Where the call is filed (#3015). A call placed from a lead, a job or a customer (the click-to-call stash) stays
  // ENTIRELY on that record and its customer. Otherwise the number decides, by the fixed order: its customer, and the one
  // lead or job carrying the number as its own when that record decided the pick. The event that creates the row files it;
  // a later event of the same call only fills what is still empty (`fillEmptyFiling`).
  const filedOn: CallFiling = pending
    ? { customer_id: pending.customer_id, lead_id: pending.lead_id, job_id: pending.job_id, job_label: pending.job_label }
    : callFilingByFixedOrder({ match, ownRecord });

  const createData = {
    ctm_call_id: sid,
    direction,
    status,
    from_number: fromNumber || 'unknown',
    to_number: toNumber || 'unknown',
    phone_number_id: companyNumberId,
    // The vendor's marketing source wins over the phone system's own tracking-
    // source label; that label is the fallback when the vendor said nothing.
    tracking_source: tracked?.tracking_source ?? (a.source ? String(a.source) : null),
    attribution: trackedAttribution
      ? ({ ...(attributionOf(a) ?? {}), ...trackedAttribution } as Prisma.InputJsonObject)
      : attributionOf(a) ?? Prisma.DbNull,
    call_tracking_provider: tracked?.provider ?? null,
    vendor_call_id: tracked?.vendor_call_id ?? null,
    answered_by: answeredBy,
    agent_id: agentId,
    started_at: activityTime(a),
    duration_sec: durationSec,
    connected_sec: connectedSec,
    ...filedOn,
    vendor_id: match?.vendorId ?? null,
    has_recording: recUrl ? true : null,
    summary,
    transcript_preview: transcript,
    transcript_turns: (turns ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
    tags: tagsWithMarker.length > 0 ? tagsWithMarker : undefined,
    organization_id: orgId,
  };

  // Out-of-order tolerance: only `end` updates an existing row (a late `starts`
  // must never downgrade a completed call back to ringing or blank out fields).
  // Populated values are never overwritten with empties.
  const updateData: Record<string, unknown> = {};
  // Whatever the position: the line a call went through never changes, and a number added to the
  // organization after the call started still gets linked by the settled `end`.
  if (companyNumberId) updateData.phone_number_id = companyNumberId;
  if (position !== 'starts') {
    updateData.status = status;
    if (durationSec !== null) updateData.duration_sec = durationSec;
    if (connectedSec !== null) updateData.connected_sec = connectedSec;
    if (recUrl) updateData.has_recording = true;
    // An agent-answered end always wins; an external-forward answer, a
    // voicemail disposition, or a claimed requested_by fallback upgrades a
    // ringing/none row (webhook dedupe guarantees a single `end` per sid, so
    // this can never downgrade a stored csr attribution).
    if (agent || answeredBy.kind === 'external' || answeredBy.kind === 'voicemail' || requesterAnswered) {
      updateData.answered_by = answeredBy;
      if (agentId) updateData.agent_id = agentId;
    }
    if (transcript) updateData.transcript_preview = transcript;
    if (turns) updateData.transcript_turns = turns;
    if (summary) updateData.summary = summary;
    // Same write condition as before (so a populated tags column still can't be
    // blanked by a late `end`, and a tag CTM removed still disappears - tags do
    // NOT become monotonic); the marker is only re-appended so a CTM tag write
    // on `end` cannot erase it.
    if (ctmTags.length > 0) updateData.tags = tagsWithMarker;
    Object.assign(updateData, fillEmptyFiling(existingCall, filedOn, pending !== null, match?.vendorId ?? null));
  }

  // A stash claimed on the update path (the row was created before the vendor
  // event landed) is written whatever the position: it fills a vendor join the
  // row does not have, never a downgrade.
  if (tracked) {
    if (tracked.tracking_source) updateData.tracking_source = tracked.tracking_source;
    if (trackedAttribution) {
      const existingAttribution =
        existingCall?.attribution && typeof existingCall.attribution === 'object' && !Array.isArray(existingCall.attribution)
          ? (existingCall.attribution as Record<string, unknown>)
          : {};
      updateData.attribution = { ...existingAttribution, ...trackedAttribution };
    }
    updateData.call_tracking_provider = tracked.provider;
    updateData.vendor_call_id = tracked.vendor_call_id;
  }

  const row = await db.callSession.upsert({
    where: { ctm_call_id: sid },
    create: createData,
    update: updateData,
  });

  // Spec #1751 D5: this is where a call PLACED through the product actually lands. Click-to-call
  // and the softphone answer 202 with no local row (comm-calls.controller.ts) - the row is created
  // here, off the webhook, with the lead the dialer stashed. Stamping only at the manual call-log
  // door would therefore miss every call the product itself placed.
  //
  // Fires on both `starts` and `end` for one call; first-touch-wins makes the second a no-op, and
  // taking `started_at` off the row rather than `new Date()` means the late `end` webhook cannot
  // record a contact time minutes after the phone actually rang.
  //
  // #2618: on a NEW lead this also moves it to Contacted. The actor is the placing agent when one
  // was resolved above (the agent email, or the claimed dial stash's requester); otherwise none.
  await recordLeadOutboundContact(leadContactDb(db, opts), {
    leadId: row.lead_id,
    orgId: row.organization_id,
    channel: 'call',
    direction: row.direction,
    automated: false,
    at: row.started_at,
    actorId: row.agent_id,
  });

  // Bell notifications (verbs registered by the parity pack; emit() silently
  // skips unknown verbs until then and never throws). Backfill suppresses.
  // No call_incoming bell: inbound rings the forwarded cell, never the app
  // (ingest-only model, #870) — only the missed-call outcome is notified.
  // A blocked caller raises no bell - the row above is still written and tagged.
  // The ring itself cannot be stopped (lib/communication/blockedNumbers.ts).
  if (!opts.suppressNotifications && !blockedCaller && position !== 'starts' && direction === 'in' && (status === 'missed' || status === 'voicemail')) {
    // The alert names the customer the call is filed on (#3015), which this event's match may no longer be.
    const filedName = row.customer_id && row.customer_id !== match?.customerId
      ? await filedCustomerName(db, orgId, row.customer_id)
      : match?.label ?? null;
    const label = filedName ?? caller ?? 'Unknown caller';
    raiseAlert(opts, {
      verb: 'communication.call_missed',
      organizationId: orgId,
      actorId: null,
      object: { type: 'CALL', id: row.id, label },
      entity: {},
      data: { customer_name: filedName, caller_number: caller, call_status: status },
      dedupKey: `ctm:${sid}:missed`,
    });
  }

  return { callSessionId: row.id, sid, status, direction, hasRecording: !!recUrl };
}

function smsWords(a: Record<string, any>): string {
  return String(a.message_body ?? a.msg ?? a.body ?? a.text ?? '');
}

function smsBody(a: Record<string, any>): string {
  const base = smsWords(a);
  const media = Array.isArray(a.message_media) ? a.message_media : [];
  const urls = media
    .map((m: any) => (typeof m === 'string' ? m : m && typeof m === 'object' ? m.url : null))
    .filter((u: unknown): u is string => typeof u === 'string' && u.length > 0);
  return urls.length > 0 ? [base, ...urls].filter(Boolean).join('\n') : base;
}

/**
 * Is this activity a text rather than a call (#3025)? A text carries a message id, or a message direction
 * (`msg_inbound` / `msg_outbound`); a call carries neither. Call ingest skips every such activity, whatever hook it came
 * on, so a text never makes a call.
 */
export function isTextActivity(a: Record<string, any>): boolean {
  const messageId = a?.message_id;
  if (messageId !== undefined && messageId !== null && String(messageId).length > 0) return true;
  return String(a?.direction ?? '').trim().toLowerCase().startsWith('msg');
}

/**
 * Is this activity a full OUTBOUND TEXT rather than a call or an inbound delta?
 *
 * `message_id` discriminates text from call, verified against every stored
 * event on staging (2026-08-01): present on 18/18 text activities
 * (`inbound_text` + `status_change`), absent on all 36 call activities.
 * `direction` then narrows to outbound - all 12 stored `status_change` events
 * are `msg_outbound`.
 *
 * Deliberately outbound-only. An inbound text is already ingested by the
 * `inbound_text` hook, which fires reliably; putting an inbound status delta
 * through the full ingest would risk a second unread bump / notification for a
 * message the user has already seen. Outbound is the direction with no working
 * hook, and therefore the one that needs this.
 */
export function isOutboundTextActivity(a: Record<string, any>): boolean {
  const sid = a?.message_id;
  if (sid === undefined || sid === null || String(sid).length === 0) return false;
  return String(a?.direction ?? '').toLowerCase().includes('out');
}

/**
 * Carrier delivery state for an outbound text, across the field spellings CTM
 * uses. Live `status_change` payloads set `status`, `call_status` AND
 * `dial_status` to the same value ('sent' | 'delivered'); older docs mention
 * `sms_status` / `message_status`. Returns null when nothing recognizable is
 * present, so callers can fall back to their own default.
 */
export function smsDeliveryStatus(a: Record<string, any>): 'sent' | 'delivered' | 'failed' | null {
  if (a.sms_error_code) return 'failed';
  const raw = String(
    a.status ?? a.sms_status ?? a.message_status ?? a.call_status ?? a.dial_status ?? '',
  ).toLowerCase();
  if (!raw) return null;
  if (raw.includes('fail') || raw.includes('undeliver') || raw.includes('error')) return 'failed';
  if (raw.includes('deliver')) return 'delivered';
  if (raw.includes('sent') || raw.includes('queue')) return 'sent';
  return null;
}

/**
 * The OTHER party's number on a text activity, as the phone system spells it: the sender of an inbound text, the
 * destination of an outbound one. It is what a text row stores as its other party (#3014), and nothing else: the
 * conversation a text joins is keyed by ingestSms's own reading. The one reading of the payload for both the live ingest
 * below and the fill-in of older texts from their stored events (scripts/text-other-party-number-fill-in.ts), so the two
 * never disagree. The fill-in passes the direction of the stored text itself; the live ingest the activity's.
 */
export function smsOtherPartyNumber(a: Record<string, any>, direction: 'in' | 'out'): string {
  const caller = callerNumber(a);
  if (direction === 'in') return caller;
  // An outbound report names the customer as its CONTACT. On the live outbound report (measured 2026-08-01, the fixture
  // in ctm-webhook.test.ts) the caller and the contact are both the customer texted and the called number is another
  // party, so the contact comes first; reports without one keep the older reading.
  const named = [a.contact_number, a.called_number, a.to].find((v) => v != null && String(v).trim() !== '');
  return named == null ? caller : String(named);
}

export interface IngestSmsResult {
  messageId: string;
  threadId: string;
  direction: 'in' | 'out';
}

export async function ingestSms(
  db: Db,
  orgId: string,
  payload: Record<string, any>,
  opts: IngestOptions = {},
): Promise<IngestSmsResult | null> {
  const a = unwrapActivity(payload);
  const sid = String(a.message_id ?? a.sid ?? '');
  if (!sid) {
    logger.warn('[ctm] sms activity without message id — skipped');
    return null;
  }

  const direction = textDirection(a);
  // The number as it has always been read: the sender of an inbound text, the called number of an outbound one. #3019
  // keys the conversation (and its customer) by the stored other party below instead; this stays only for a report whose
  // other party is one of our own numbers, the blocked-number check and the alert's label.
  const conversationNumber = direction === 'in' ? callerNumber(a) : String(a.called_number ?? a.to ?? callerNumber(a));
  // The other party the text row stores (#3014), which on an outbound report is the contact the phone system names.
  const otherParty = smsOtherPartyNumber(a, direction);
  const body = smsBody(a);
  // The company number the text went through (S08.1): the number the customer texted, or the
  // number the text was sent from.
  const companyNumberId = await resolveCompanyNumberId(db, orgId, a.tracking_number);
  const companyNumberData = companyNumberId ? { phone_number_id: companyNumberId } : {};

  // Thread find-or-create — the shared SMS thread-identity rule (smsThread.ts,
  // extracted for slice H7 so compose-to-number keys threads identically):
  // customer matches key by customer_id, vendor matches by vendor_id, unmatched
  // numbers by title = the E.164-normalized number, so caller_number vs
  // caller_number_complete spelling differences can't split a thread.
  //
  // `matchStaff` is the INBOUND door's addition (Spec C slice 7): a number that
  // matched no customer, lead or vendor is checked against active staff before
  // it falls through to a title-keyed thread. Without it, a technician replying
  // to an automated text surfaces in the CUSTOMER conversations lane as an
  // unknown contact. The admin can answer that reply in place: a team thread
  // naming a person is a deliverable destination (comm-threads.controller's
  // isDeliverableThread + resolveSmsDestination's user branch).
  // Compose-to-number deliberately does NOT pass it - see the option's own
  // note in smsThread.ts.
  // Nobody is signed in here: the number resolves for the whole company.
  //
  // #3019: a customer's or an unknown number's conversation is the pair of numbers - the other party's number this text
  // stores (below; on an outbound report, the contact the phone system names) and ours, the company number it went
  // through, else the main line. The conversation's customer is the one carrying that very number, so the conversation
  // and its default customer never disagree; a report naming only our own numbers keeps today's keying.
  const storedOtherParty = await otherPartyE164(db, orgId, otherParty);
  const ourNumber = companyNumberId ? (normalizeNAPhone(String(a.tracking_number)) ?? String(a.tracking_number)) : await mainLineE164(db, orgId);
  const { thread, match } = await findOrCreateSmsThreadByNumber(db, orgId, storedOtherParty ?? conversationNumber, ourNumber, (n) => matchByPhone(db, orgId, n), {
    matchStaff: true,
    otherPartyE164: storedOtherParty,
  });

  // Outbound honours the carrier state the payload actually carries - a
  // `status_change` saying "delivered" must land as delivered, not be flattened
  // back to 'sent'. 'sent' stays the fallback for a payload that names no state.
  const status =
    direction === 'in'
      ? a.sms_error_code
        ? 'failed'
        : 'received'
      : (smsDeliveryStatus(a) ?? 'sent');

  const existing = await db.message.findFirst({
    where: { ctm_sms_id: sid, organization_id: orgId },
    select: { id: true, thread_id: true },
  });

  // Blocked-list probe, same rules as ingestCall: inbound only, skipped on the
  // backfill path, and only ever consumed below when this is a new message -
  // a redelivered/duplicate webhook for an existing row never reads it.
  const blockedCaller =
    direction === 'in' && !existing && !opts.suppressNotifications
      ? (await findBlockedNumber(db, orgId, conversationNumber)) !== null
      : false;

  let messageRow: { id: string; thread_id: string };
  if (existing) {
    // Delivery/failure updates only — never clobber the stored body.
    messageRow = await db.message.update({
      where: { id: existing.id },
      data: { status, ...companyNumberData },
      select: { id: true, thread_id: true },
    });
  } else {
    if (direction === 'out') {
      // Fallback reconcile: sendCtmSms may have created this outbound row
      // WITHOUT a sid (CTM's POST response carried none). Match it by
      // org+thread+direction+body with a ts within ±60s and stamp the sid on
      // it instead of duplicating the message.
      const ts = activityTime(a);
      const shell = await db.message.findFirst({
        where: {
          organization_id: orgId,
          thread_id: thread.id,
          direction: 'out',
          ctm_sms_id: null,
          body,
          ts: { gte: new Date(ts.getTime() - 60_000), lte: new Date(ts.getTime() + 60_000) },
        },
        select: { id: true },
      });
      if (shell) {
        messageRow = await db.message.update({
          where: { id: shell.id },
          data: { ctm_sms_id: sid, status, ...companyNumberData },
          select: { id: true, thread_id: true },
        });
        return { messageId: messageRow.id, threadId: messageRow.thread_id, direction };
      }
    }
    // #3020: an incoming text takes the lead or job of the latest text we sent in its conversation (lib/sms-reply-router.ts,
    // the one rule). A text the phone system reports sending is ours, not a reply, and is tied to nothing here.
    const tie = direction === 'in' ? await tieIncomingText(db, orgId, { threadId: thread.id, at: new Date(), from: storedOtherParty }) : UNTIED;
    messageRow = await db.message.create({
      data: {
        ctm_sms_id: sid,
        thread_id: thread.id,
        direction,
        body,
        ts: activityTime(a),
        status,
        automated: false,
        job_id: tie.jobId,
        job_label: tie.jobLabel,
        lead_id: tie.leadId,
        phone_number_id: companyNumberId,
        // #3014: the sender of an inbound text, the destination of an outbound one; normalized E.164, never one of
        // our own numbers, or none.
        other_party_e164: storedOtherParty,
        organization_id: orgId,
      },
      select: { id: true, thread_id: true },
    });

    // No lead moves New -> Contacted here (#2618 moves one on OUR outbound contact only): an incoming text is the
    // customer's, even when it is tied to a lead (#3020), and a text the phone system reports sending is tied to no lead.
    // (A customer match never carried a lead, so the move this place used to ask for could never happen.)

    // A blocked sender never marks the thread unread (blockedNumbers.ts).
    if (direction === 'in' && !opts.suppressNotifications && !blockedCaller) {
      await db.messageThread.update({
        where: { id: thread.id },
        data: { unread: { increment: 1 } },
      });
    }
  }

  // A blocked sender raises no bell - the message row above is still stored.
  if (direction === 'in' && !existing && !opts.suppressNotifications && !blockedCaller) {
    raiseAlert(opts, {
      verb: 'communication.sms_inbound',
      organizationId: orgId,
      actorId: null,
      object: { type: 'MESSAGE_THREAD', id: thread.id, label: match?.label ?? conversationNumber },
      // The alert's people are found from this text (its record, its company number, who it answers): S08.23.
      entity: { message_id: messageRow.id },
      // The first 80 characters of what the customer WROTE (a picture's link is no preview). The alert row stores it, and the
      // alert goes only to people who may read this conversation, so the preview reaches no one else.
      data: { customer_name: match?.label ?? null, preview: textAlertPreview(smsWords(a)) },
      dedupKey: `ctm:${sid}:inbound`,
    });
  }

  return { messageId: messageRow.id, threadId: messageRow.thread_id, direction };
}

/**
 * Lean status-delta path - a payload that names a delivery state but carries no
 * text activity to ingest. The controller routes text-shaped `status_change`
 * payloads through `ingestSms` instead (they are full activities, and only that
 * path can reconcile a sid-less local row), so this is the fallback for the
 * `sms_status` position and for any future lean delta CTM starts sending.
 */
export async function ingestSmsStatus(
  db: Db,
  orgId: string,
  payload: Record<string, any>,
): Promise<{ messageId: string; status: string } | null> {
  const a = unwrapActivity(payload);
  const sid = String(a.message_id ?? a.sid ?? '');
  if (!sid) return null;

  const status = smsDeliveryStatus(a);
  if (!status) return null;

  const existing = await db.message.findFirst({
    where: { ctm_sms_id: sid, organization_id: orgId },
    select: { id: true },
  });
  if (!existing) {
    // Status for a text we never stored — the backfill will reconcile it.
    logger.warn('[ctm] status_change for unknown message — skipped');
    return null;
  }
  await db.message.update({ where: { id: existing.id }, data: { status } });
  return { messageId: existing.id, status };
}
