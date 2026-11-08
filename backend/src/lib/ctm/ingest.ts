import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { matchByPhone, normalizeNAPhone } from '../comms-identity';
import { findBlockedNumber } from '../communication/blockedNumbers';
import { findOrCreateSmsThreadByNumber } from './smsThread';
import { lookupReceivingNumber } from './receivingNumbers';
import { resolveInboundSmsJob } from '../sms-reply-router';
import { emit } from '../../services/notifications/notificationService';
import { logger } from '../logger';
import { recordLeadOutboundContact } from '../../services/lead-contact.service';
import { INBOUND_CLAIM_WINDOW_MS } from '../call-tracking/process';

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
}

// CTM sometimes wraps the activity under a `call` key.
export function unwrapActivity(payload: Record<string, any>): Record<string, any> {
  if (payload && typeof payload.call === 'object' && payload.call !== null) return payload.call;
  return payload ?? {};
}

function callDirection(a: Record<string, any>): 'in' | 'out' {
  return String(a.direction ?? '').toLowerCase().includes('out') ? 'out' : 'in';
}

// Maps CTM dial/call statuses into the FE CallStatus union
// (ringing|active|completed|voicemail|missed — communication-shared/phone-calls.ts).
function callStatus(a: Record<string, any>, position: string): string {
  if (position === 'starts') return 'ringing';
  const raw = String(a.dial_status ?? a.call_status ?? '').toLowerCase();
  if (raw.includes('voicemail')) return 'voicemail';
  if (
    raw.includes('no-answer') || raw.includes('no_answer') || raw.includes('noanswer') ||
    raw.includes('busy') || raw.includes('missed') || raw.includes('abandon') || raw.includes('cancel')
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
  if (raw.includes('answer') || raw.includes('complete')) return 'completed';
  return 'completed';
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

// Marketing attribution: which campaign produced this call. Northwind Services runs
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
//  1. `summary` - plain prose, the most specific of the three ("Agent Art Nakamura
//     called the contact in PRINCETON NJ… the contact asked 'Who is this?'").
//  2. `activity_analysis.general` - the "General" tab of CTM's AskAI Summaries
//     panel, and the ONLY one of that object's 9 sections that is a real call
//     summary. The other eight (demo / sales / project_kick_off / …) are
//     B2B-SaaS template prose that reads as noise on a field-service call
//     ("No product or feature was demonstrated"), so they stay unread.
//  3. `notes` - the manual agent-typed note, empty on every stored Northwind Services
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
// stored `end` events for Northwind Services (500001) and NOT ONE is a voicemail —
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
  const sid = String(a.sid ?? '');
  if (!sid) {
    logger.warn('[ctm] call activity without sid — skipped');
    return null;
  }

  // Org assert: ctm_call_id is globally unique, so an upsert keyed on it could
  // otherwise UPDATE another org's row if a forged/misrouted payload reuses a
  // stored sid. A cross-org collision is warned + skipped, never written.
  const existingCall = await db.callSession.findFirst({
    where: { ctm_call_id: sid },
    select: { organization_id: true, job_id: true, call_tracking_provider: true, attribution: true },
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

  const match = customerSide ? await matchByPhone(db, orgId, customerSide) : null;

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
  // Outbound only; skipped once the row already carries a job.
  let pending: {
    id: string;
    job_id: string | null;
    job_label: string | null;
    lead_id: string | null;
    customer_id: string | null;
    requested_by: string | null;
  } | null = null;
  if (direction === 'out' && (!existingCall || existingCall.job_id == null)) {
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

  const createData = {
    ctm_call_id: sid,
    direction,
    status,
    from_number: fromNumber || 'unknown',
    to_number: toNumber || 'unknown',
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
    // Phone-match resolver WINS; the pending stash fills the nulls.
    customer_id: match?.customerId ?? pending?.customer_id ?? null,
    lead_id: match?.leadId ?? pending?.lead_id ?? null,
    vendor_id: match?.vendorId ?? null,
    job_id: pending?.job_id ?? null,
    job_label: pending?.job_label ?? null,
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
    // Resolver-vs-stash precedence mirrors createData; keys are only written
    // when a value exists (populated columns are never blanked out).
    const updCustomerId = match?.customerId ?? pending?.customer_id;
    const updLeadId = match?.leadId ?? pending?.lead_id;
    if (updCustomerId) updateData.customer_id = updCustomerId;
    if (updLeadId) updateData.lead_id = updLeadId;
    if (match?.vendorId) updateData.vendor_id = match.vendorId;
    // Pending is only ever claimed when the stored row has no job (or there is
    // no stored row), so this stamps a blank column — never a reassign.
    if (pending?.job_id) {
      updateData.job_id = pending.job_id;
      updateData.job_label = pending.job_label;
    }
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
  await recordLeadOutboundContact(db, {
    leadId: row.lead_id,
    orgId: row.organization_id,
    channel: 'call',
    direction: row.direction,
    automated: false,
    at: row.started_at,
  });

  // Bell notifications (verbs registered by the parity pack; emit() silently
  // skips unknown verbs until then and never throws). Backfill suppresses.
  // No call_incoming bell: inbound rings the forwarded cell, never the app
  // (ingest-only model, #870) — only the missed-call outcome is notified.
  const label = match?.label ?? caller ?? 'Unknown caller';
  // A blocked caller raises no bell - the row above is still written and tagged.
  // The ring itself cannot be stopped (lib/communication/blockedNumbers.ts).
  if (!opts.suppressNotifications && !blockedCaller && position !== 'starts' && direction === 'in' && (status === 'missed' || status === 'voicemail')) {
    void emit({
      verb: 'communication.call_missed',
      organizationId: orgId,
      actorId: null,
      object: { type: 'CALL', id: row.id, label },
      entity: {},
      data: { customer_name: match?.label ?? null, caller_number: caller, call_status: status },
      dedupKey: `ctm:${sid}:missed`,
    });
  }

  return { callSessionId: row.id, sid, status, direction, hasRecording: !!recUrl };
}

function smsBody(a: Record<string, any>): string {
  const base = String(a.message_body ?? a.msg ?? a.body ?? a.text ?? '');
  const media = Array.isArray(a.message_media) ? a.message_media : [];
  const urls = media
    .map((m: any) => (typeof m === 'string' ? m : m && typeof m === 'object' ? m.url : null))
    .filter((u: unknown): u is string => typeof u === 'string' && u.length > 0);
  return urls.length > 0 ? [base, ...urls].filter(Boolean).join('\n') : base;
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

  const direction: 'in' | 'out' = String(a.direction ?? '').toLowerCase().includes('out') ? 'out' : 'in';
  const caller = callerNumber(a);
  const counterpart = direction === 'in' ? caller : String(a.called_number ?? a.to ?? caller);
  const body = smsBody(a);

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
  // unknown contact. Compose-to-number deliberately does NOT pass it - see the
  // option's own note in smsThread.ts.
  const { thread, match } = await findOrCreateSmsThreadByNumber(db, orgId, counterpart, {
    matchStaff: true,
  });

  // Inbound job auto-route: most recent open job this thread was texted-from
  // within the recency window (lib/sms-reply-router.ts).
  let jobId: string | null = null;
  let jobLabel: string | null = null;
  if (direction === 'in') {
    const recent = await db.message.findMany({
      where: { organization_id: orgId, thread_id: thread.id, direction: 'out', job_id: { not: null } },
      orderBy: { ts: 'desc' },
      take: 20,
      select: { job_id: true, job_label: true, ts: true, job: { select: { status: true } } },
    });
    const routed = resolveInboundSmsJob({
      now: new Date(),
      recentJobTexts: recent
        .filter((m: any) => m.job_id && m.job)
        .map((m: any) => ({
          jobId: m.job_id as string,
          jobLabel: (m.job_label as string | null) ?? null,
          jobStatus: m.job.status as string,
          lastOutboundAt: m.ts as Date,
        })),
    });
    if (routed) {
      jobId = routed.jobId;
      jobLabel = routed.jobLabel;
    }
  }

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
      ? (await findBlockedNumber(db, orgId, counterpart)) !== null
      : false;

  let messageRow: { id: string; thread_id: string };
  if (existing) {
    // Delivery/failure updates only — never clobber the stored body.
    messageRow = await db.message.update({
      where: { id: existing.id },
      data: { status },
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
          data: { ctm_sms_id: sid, status },
          select: { id: true, thread_id: true },
        });
        return { messageId: messageRow.id, threadId: messageRow.thread_id, direction };
      }
    }
    messageRow = await db.message.create({
      data: {
        ctm_sms_id: sid,
        thread_id: thread.id,
        direction,
        body,
        ts: activityTime(a),
        status,
        automated: false,
        job_id: jobId,
        job_label: jobLabel,
        // Full job-parity ruling (2026-07-22): stamp the same phone-match
        // lead_id already used to key/create the thread (above) onto this
        // message row too — getLeadCommunications filters strictly on
        // Message.lead_id, so without this an inbound reply would never
        // surface on the lead's Communication tab.
        lead_id: match?.leadId ?? null,
        organization_id: orgId,
      },
      select: { id: true, thread_id: true },
    });

    // Spec #1751 D5: an outbound text ingested from the phone system - one a rep sent from the
    // vendor console or from their own handset - counts exactly as one composed in the app does.
    // Only on the CREATE branch: the update branch above is a delivery-status delta on a row whose
    // send was already accounted for, and the shell-reconcile branch returns early because the
    // composer door (comm-threads.controller.ts) already stamped that one.
    //
    // `automated: false` mirrors what the create above writes literally two statements up, rather
    // than re-reading the row: this path has no automated sender behind it at all - CTM does not
    // originate messages on its own - and the two must not be able to drift.
    await recordLeadOutboundContact(db, {
      leadId: match?.leadId ?? null,
      orgId,
      channel: 'text',
      direction,
      automated: false,
      at: activityTime(a),
    });

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
    void emit({
      verb: 'communication.sms_inbound',
      organizationId: orgId,
      actorId: null,
      object: { type: 'MESSAGE_THREAD', id: thread.id, label: match?.label ?? counterpart },
      entity: {},
      data: { customer_name: match?.label ?? null, preview: body.slice(0, 80) },
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
