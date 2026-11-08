import { Request, Response } from 'express';
import { JobStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { env } from '../config/env';
import { tenantWhere } from '../lib/tenant';
import { matchByPhone, normalizeNAPhone } from '../lib/comms-identity';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import { addOrFilter } from '../lib/permissions/whereCompose';
import { commVisibilityWhere } from '../lib/permissions/anchorVisibility';
import { phoneSearchClauses, phoneRelationSearchClauses } from '../lib/phone-search';
import type { Subject } from '../lib/permissions/catalog';
import { logAudit } from '../lib/audit';
import { CtmApiError, getCall as ctmGetCall, getCallTranscription as ctmGetCallTranscription, isCtmConfigured, isOutboundAllowed, placeCall } from '../lib/ctm/client';
import { summaryOf, transcriptOf, transcriptTurnsOf, unwrapActivity, TranscriptTurn } from '../lib/ctm/ingest';
import { resolveOutboundNumber } from '../lib/communication/resolveOutboundNumber';
import { buildBridgeLegs, maskLongDigitRuns, type BridgeLegs, type BridgeLegsRefusal } from '../lib/communication/bridgeLegs';
import { recordLeadOutboundContact } from '../services/lead-contact.service';

// Short-lived playback URLs on the private recordings bucket (plan §4/§10:
// 300s TTL, minted per play + audited; list payloads never carry URLs).
const RECORDING_URL_TTL_SECONDS = 300;

// ─── Mappers (snake_case Prisma row → camelCase mock contract) ─────────────

// CTM ingest stores direction as 'in'/'out' (lib/ctm/ingest.ts) while the
// frontend contract is CallDirection = 'inbound' | 'outbound' — normalize at
// this boundary so real webhook-created calls render with the right direction.
function toApiDirection(direction: string): string {
  if (direction === 'in') return 'inbound';
  if (direction === 'out') return 'outbound';
  return direction;
}

// The stored keys that may reach the browser. An explicit list, never a spread:
// the stored JSON also carries the phone service's own identifiers (the agent's
// id there, `ctm_agent_id`, and the forwarded destination's filter id,
// `receiving_number_id`). No frontend reads either, and a vendor identifier is
// never sent to the browser (CLAUDE.md boundary).
const ANSWERED_BY_PUBLIC_KEYS = ['kind', 'user_id', 'name', 'email', 'resolved_from'] as const;

/**
 * Who answered, in the one identity both sides can agree on.
 *
 * The stored `answered_by` JSON names the answerer differently depending on how
 * the call was taken: a softphone answer carries the vendor's `ctm_agent_id`, a
 * resolved forwarded answer carries `user_id`. The UI, meanwhile, has always
 * read `answeredBy.id` - to label the Calls table and to scope the per-agent
 * Performance drawer - and nothing ever wrote that key, so every per-agent
 * figure was zero regardless of what ingest resolved.
 *
 * `agent_id` is the column that already holds the ServWave user across all
 * three paths (agent-email match, claimed click-to-call stash, forwarded-answer
 * resolver), so that is what `id` means. It surfaces only when someone actually
 * answered: on an outbound leg `agent_id` is who PLACED the call, and stamping
 * that onto an unanswered row would credit it to them in every stat.
 */
export function mapAnsweredBy(row: {
  answered_by?: unknown;
  agent_id?: string | null;
}): Record<string, unknown> {
  // A Json column can hold a bare string, number or array on a malformed row.
  // `key in` throws on a primitive, so anything that is not a plain object
  // reads as no answeredBy at all, like a null does.
  const raw = row.answered_by;
  const stored: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : { kind: 'none' };
  const out: Record<string, unknown> = {};
  for (const key of ANSWERED_BY_PUBLIC_KEYS) {
    if (key in stored) out[key] = stored[key];
  }
  if (stored.kind === 'none') return out;
  const userId =
    (typeof stored.user_id === 'string' && stored.user_id) ||
    (typeof row.agent_id === 'string' && row.agent_id) ||
    null;
  return userId ? { ...out, id: userId } : out;
}

// CallSession → frontend `CallSession` (phone-calls.ts).
function mapCallSession(row: any) {
  const direction = toApiDirection(row.direction);
  return {
    id: row.id,
    direction,
    fromNumber: row.from_number,
    toNumber: row.to_number,
    // Ad source = which CTM tracking number a caller dialed (campaign
    // attribution) — an inbound-only concept. Outbound calls have no ad source
    // (CTM may still stamp a meaningless `source`), so never surface it there.
    ...(direction === 'inbound' && row.tracking_source != null && { trackingSource: row.tracking_source }),
    status: row.status,
    answeredBy: mapAnsweredBy(row),
    startedAt: (row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at),
    ...(row.duration_sec != null && { durationSec: row.duration_sec }),
    ...(row.customer_id != null && { customerId: row.customer_id }),
    ...(row.job_id != null && { jobId: row.job_id }),
    ...(row.job_label != null && { jobLabel: row.job_label }),
    ...(row.disposition != null && { disposition: row.disposition }),
    ...(row.sentiment != null && { sentiment: row.sentiment }),
    ...(row.summary != null && { summary: row.summary }),
    ...(row.transcript_preview != null && { transcriptPreview: row.transcript_preview }),
    ...(row.has_recording != null && { hasRecording: row.has_recording }),
    ...(row.qa_score != null && { qaScore: row.qa_score }),
    ...(row.review_flag != null && { reviewFlag: row.review_flag }),
    ...(row.call_flow != null && { callFlow: row.call_flow }),
    ...(row.tags != null && { tags: row.tags }),
    ...(row.revenue != null && { revenue: Number(row.revenue) }),
    ...(row.customer != null && {
      linkedCustomer: {
        id: row.customer.id,
        name: row.customer.company_name ?? [row.customer.first_name, row.customer.last_name].filter(Boolean).join(' '),
      },
    }),
    ...(row.lead != null && { linkedLead: { id: row.lead.id, leadNumber: row.lead.lead_number } }),
    ...(row.vendor != null && { linkedVendor: { id: row.vendor.id, name: row.vendor.name } }),
    ...(row.lead_id != null && { leadId: row.lead_id }),
    ...(row.vendor_id != null && { vendorId: row.vendor_id }),
    ...(row.agent != null && {
      linkedAgent: { id: row.agent.id, name: `${row.agent.first_name} ${row.agent.last_name}`.trim() },
    }),
  };
}

// ChannelIdentity → frontend `ChannelIdentity`.
function mapChannel(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    value: row.value,
    ...(row.label != null && { label: row.label }),
    ...(row.consented != null && { consented: row.consented }),
  };
}

// Contact (+ channels) → frontend `Contact`.
function mapContact(row: any) {
  return {
    id: row.id,
    name: row.name,
    ...(row.role != null && { role: row.role }),
    preferredLang: row.preferred_lang,
    channels: (row.channels ?? []).map(mapChannel),
  };
}

// Customer (+ contacts, service_locations, jobs) → frontend `PhoneCustomer`.
function mapPhoneCustomer(row: any) {
  const name = row.company_name ?? [row.first_name, row.last_name].filter(Boolean).join(' ') ?? '';
  const primaryLocation = (row.service_locations ?? []).find((l: any) => l.is_primary) ?? (row.service_locations ?? [])[0];
  const site = primaryLocation
    ? [primaryLocation.address_line1, primaryLocation.city, primaryLocation.state].filter(Boolean).join(', ')
    : '';
  // n-search: real numbers live on the customer row (phone/secondary_phone)
  // and the customer_phones[] relation, NOT contacts[].channels[] (nothing
  // writes those) — de-duped, falsy-filtered, passed through unformatted.
  const phones = [...new Set(
    [row.phone, row.secondary_phone, ...(row.phones ?? []).map((p: any) => p.phone)].filter(Boolean),
  )];
  return {
    id: row.id,
    name,
    type: row.company_name ? 'commercial' : 'residential',
    site,
    ...(row.membership_tier != null && { membershipTier: row.membership_tier }),
    ...(row.sla_profile != null && { slaProfile: row.sla_profile }),
    contacts: (row.contacts ?? []).map(mapContact),
    phones,
    ...(row.jobs != null && { linkedJobIds: (row.jobs ?? []).map((j: any) => j.id) }),
  };
}

// ─── Handlers ──────────────────────────────────────────────────────────────

export async function listCalls(req: Request, res: Response) {
  try {
    // Anchor-inherited row scope (slice 8a). This was a TENANT-ONLY findMany:
    // the Communication module had no row scoping at all, so every role that
    // could reach it saw every call in the org. See lib/permissions/anchorVisibility.
    const rows = await prisma.callSession.findMany({
      where: { ...tenantWhere(req), ...(await commVisibilityWhere(req)) },
      orderBy: { started_at: 'desc' },
      include: {
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        lead: { select: { id: true, lead_number: true } },
        vendor: { select: { id: true, name: true } },
        agent: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    res.json({ calls: rows.map(mapCallSession) });
  } catch (err) {
    logger.error('Failed to list calls:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /calls/outcome?to_number=<e164>&since=<iso> - did the call we just placed
 * land yet?
 *
 * The click-to-call bridge rings the agent's phone and then dials the customer,
 * so the browser is never on the call and has no way to learn it ended. The
 * 'end' webhook is the only thing that knows, and it writes the CallSession
 * roughly 30-40s after hangup. Without this the dialer sits on a terminal "Call
 * placed" forever - a real conversation happens and the screen never moves
 * (reported live 2026-08-06).
 *
 * Deliberately NOT a second list endpoint. The dialer already knows the
 * destination and the moment it dialled, so it asks the narrow question "did an
 * outbound call to THIS number land since THEN" and gets back one row or null.
 * Polling `listCalls` instead would ship the org's entire call history every
 * few seconds.
 *
 * The `since` floor is load-bearing, not a nicety: without it the very first
 * poll matches the PREVIOUS call to the same customer and reports its duration
 * as this call's. Both params are therefore required and validated here rather
 * than defaulted.
 */
const OUTCOME_E164 = /^\+[1-9]\d{6,14}$/;

export async function getCallOutcome(req: Request, res: Response) {
  try {
    const toNumber = typeof req.query.to_number === 'string' ? req.query.to_number : '';
    if (!OUTCOME_E164.test(toNumber)) {
      res.status(400).json({ error: 'A destination number in E.164 form is required' });
      return;
    }

    const sinceRaw = typeof req.query.since === 'string' ? req.query.since : '';
    const since = new Date(sinceRaw);
    if (!sinceRaw || Number.isNaN(since.getTime())) {
      res.status(400).json({ error: 'A valid ISO `since` timestamp is required' });
      return;
    }

    // Same row scoping as listCalls - this returns a call, so it must not be a
    // side door around the visibility rules that endpoint enforces.
    const row = await prisma.callSession.findFirst({
      where: {
        ...tenantWhere(req),
        ...(await commVisibilityWhere(req)),
        // Stored vocabulary is 'in'/'out' (lib/ctm/ingest.ts), not the API's
        // long form - see toApiDirection above.
        direction: 'out',
        to_number: toNumber,
        started_at: { gte: since },
      },
      orderBy: { started_at: 'desc' },
    });

    res.json({ call: row ? mapCallSession(row) : null });
  } catch (err) {
    logger.error('Failed to look up call outcome:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getCall(req: Request, res: Response) {
  try {
    const row = await prisma.callSession.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...(await commVisibilityWhere(req)) },
      include: {
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        lead: { select: { id: true, lead_number: true } },
        vendor: { select: { id: true, name: true } },
        agent: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    if (!row) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }

    res.json({ call: mapCallSession(row) });
  } catch (err) {
    logger.error('Failed to get call:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /calls/:id/recording — mint a fresh 300s signed URL for a stored
 * recording. tenantWhere + anchor-visibility scoping mirrors getCall above; a
 * missing row, a row outside the caller's scope, and a not-(yet)-ingested
 * recording are all indistinguishable to the caller (404, never 500 - the player
 * shows a quiet "Processing…" state on 404).
 *
 * The visibility filter is NOT optional here: this route mints a signed URL into
 * the PRIVATE recordings bucket. A scoped list beside an unscoped sub-resource
 * is the classic hole.
 */
export async function getCallRecording(req: Request, res: Response) {
  try {
    const row = await prisma.callSession.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...(await commVisibilityWhere(req)) },
      select: { id: true, recording_key: true },
    });

    if (!row?.recording_key) {
      res.status(404).json({ error: 'Recording not available' });
      return;
    }

    const { data, error } = await supabaseAdmin.storage
      .from(env.CTM_RECORDINGS_BUCKET)
      .createSignedUrl(row.recording_key, RECORDING_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      // Mint failure is still "not available", never a 500 — the object may
      // simply not exist yet (upload raced) and the player retries on demand.
      logger.warn(`Failed to mint signed recording URL for call ${row.id}`);
      res.status(404).json({ error: 'Recording not available' });
      return;
    }

    void logAudit({
      req,
      action: 'recording.played',
      resourceType: 'CallSession',
      resourceId: row.id,
    });

    res.json({ url: data.signedUrl });
  } catch (err) {
    logger.error('Failed to get call recording:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Lazy transcript + insight hydration: CTM finalizes both after the `end`
// webhook - it derives the AI summary FROM the transcript, so the two land on
// the same async schedule and share one re-pull. Stored text is returned
// as-is; whenever EITHER field is still missing, ONE user-triggered CTM fetch
// (by sid) persists whatever has since landed. A call whose transcript stored
// early must not short-circuit the fetch while its summary is outstanding, or
// the Insights column stays blank forever. Every miss/failure is a quiet null
// on both keys - the drawer treats null as "nothing available", never an error.
export async function getCallTranscript(req: Request, res: Response) {
  try {
    // Same reasoning as /recording above: this returns transcript CONTENT, so it
    // carries the row scope, not just tenancy.
    const visibility = await commVisibilityWhere(req);
    const row = await prisma.callSession.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      select: { id: true, ctm_call_id: true, transcript_preview: true, summary: true, transcript_turns: true },
    });
    if (!row) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }

    let transcript: string | null = row.transcript_preview ?? null;
    let summary: string | null = row.summary ?? null;
    let turns: TranscriptTurn[] | null = (row.transcript_turns as TranscriptTurn[] | null) ?? null;
    const respond = () => res.json({ transcript, summary, turns });

    if (transcript && summary && turns) return respond();
    if (!row.ctm_call_id || !isCtmConfigured()) return respond();
    const org = await prisma.organization.findUnique({
      where: { id: req.user!.organization_id },
      select: { ctm_account_id: true },
    });
    if (!org?.ctm_account_id) return respond();

    try {
      const activity = unwrapActivity(await ctmGetCall(org.ctm_account_id, row.ctm_call_id));
      if (!transcript) transcript = transcriptOf(activity);
      if (!summary) summary = summaryOf(activity);
      // The flat text and the structured turns both live behind the same
      // transcription.json resource — fetch it whenever turns are still
      // missing, even if the flat transcript already arrived inline, since
      // that flat text is unrecoverable shrapnel and turns are the only
      // clean source.
      if ((!transcript || !turns) && typeof activity.transcription === 'string' && activity.transcription) {
        const doc = await ctmGetCallTranscription(activity.transcription);
        if (!transcript) transcript = transcriptOf(doc);
        if (!turns) turns = transcriptTurnsOf(doc);
      }
    } catch (err) {
      logger.warn(`[ctm] transcript fetch failed for call ${row.id}:`, err);
    }

    // Only newly-found values are written - a field already stored is never
    // rewritten, mirroring the ingest rule that populated columns stay put.
    const data: { transcript_preview?: string; summary?: string; transcript_turns?: Prisma.InputJsonValue } = {};
    if (transcript && !row.transcript_preview) data.transcript_preview = transcript;
    if (summary && !row.summary) data.summary = summary;
    if (turns && !row.transcript_turns) data.transcript_turns = turns as unknown as Prisma.InputJsonValue;
    if (Object.keys(data).length > 0) {
      await prisma.callSession.updateMany({
        where: { id: row.id, ...tenantWhere(req), ...visibility },
        data,
      });
    }
    respond();
  } catch (err) {
    logger.error('Failed to get call transcript:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Dialer search ──────────────────────────────────────────────────────────
//
// The dialer's canonical search (#666/#357): customers by name / customer
// number / phone (scalar + phones[] relation via the shared phone-search
// clauses) with their open jobs embedded, jobs by job number / customer name
// under the caller's Job grant scope, and identity resolution for phone-shaped
// queries via matchByPhone. LIMIT 5 per group mirrors /api/search.

export const dialerSearchQuerySchema = z.object({ q: z.string().trim().min(2).max(80) });

const DIALER_LIMIT = 5;
const OPEN_JOB_STATUS = { notIn: [JobStatus.COMPLETED, JobStatus.CANCELLED] };

function dialerContains(term: string) {
  return { contains: term, mode: 'insensitive' as const };
}

function dialerNameOr(term: string) {
  return [
    { first_name: dialerContains(term) },
    { last_name: dialerContains(term) },
    { company_name: dialerContains(term) },
  ];
}

function dialerCustomerName(c: { first_name: string | null; last_name: string | null; company_name: string | null }): string {
  return c.company_name ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer');
}

function dialerLocationLine(loc: { address_line1: string | null; city: string | null } | null | undefined): string | null {
  if (!loc) return null;
  const line = [loc.address_line1, loc.city].filter(Boolean).join(', ');
  return line || null;
}

export async function dialerSearch(req: Request, res: Response) {
  try {
    const parsed = dialerSearchQuerySchema.safeParse({ q: req.query.q });
    if (!parsed.success) {
      res.status(400).json({ error: 'Search term must be 2-80 characters' });
      return;
    }
    const q = parsed.data.q;
    const e164 = normalizeNAPhone(q);
    const orgWhere = tenantWhere(req);

    // #2041 — Customer read is fail-closed at the SUBJECT level like /api/search (a requester
    // without the grant AT ALL gets no customer group — unlike /contacts this degrades rather
    // than 403s, because the jobs + identity groups are still legitimately the caller's), AND
    // now row-scoped via `custScope` for a conditioned reader (SALES).
    const customersReadable = canReadCustomers(req);
    const [jobScope, custScope] = await Promise.all([
      scopeWhereForReq(req, 'Job'),
      scopeWhereForReq(req, 'Customer'),
    ]);

    const jobSearchWhere: Record<string, unknown> = { ...orgWhere, ...jobScope };
    addOrFilter(jobSearchWhere, [
      { job_number: dialerContains(q) },
      { customer: { OR: dialerNameOr(q) } },
    ]);
    // custScope is spread FIRST (its own top-level key may be `OR`), then the search terms are
    // composed with `addOrFilter` — same clobber-safe idiom `jobSearchWhere` above already uses.
    const customerSearchWhere: Record<string, unknown> = { ...orgWhere, ...custScope };
    addOrFilter(customerSearchWhere, [
      ...dialerNameOr(q),
      { customer_number: dialerContains(q) },
      ...phoneSearchClauses(q),
      ...phoneRelationSearchClauses(q),
    ]);

    const [customers, jobs, identity] = await Promise.all([
      customersReadable
        ? prisma.customer.findMany({
            where: customerSearchWhere,
            take: DIALER_LIMIT,
            orderBy: { created_at: 'desc' },
            select: {
              id: true,
              first_name: true,
              last_name: true,
              company_name: true,
              phone: true,
              secondary_phone: true,
              phones: { take: 1, orderBy: { is_primary: 'desc' }, select: { phone: true } },
              service_locations: { take: 1, orderBy: { is_primary: 'desc' }, select: { address_line1: true, city: true } },
              jobs: {
                where: { status: OPEN_JOB_STATUS },
                take: DIALER_LIMIT,
                orderBy: { created_at: 'desc' },
                select: {
                  id: true,
                  job_number: true,
                  status: true,
                  service_location: { select: { address_line1: true, city: true } },
                },
              },
            },
          })
        : Promise.resolve([] as any[]),
      prisma.job.findMany({
        // addOrFilter, NOT a literal `OR:` beside the spread. `jobScope` is itself `{ OR: [...] }`
        // for any multi-read or union-scoped requester - since the technician-ownership spec (Part
        // C) that includes every TECHNICIAN, whose `read Job` is assigned-OR-created - and two `OR`
        // keys in one object literal means the LAST one wins, silently deleting the row scope and
        // returning every job in the org. addOrFilter demotes both disjunctions under AND so each
        // stays REQUIRED (a search narrows an already-scoped set). Same fix search.controller.ts
        // already uses; see lib/permissions/whereCompose.ts.
        where: jobSearchWhere,
        take: DIALER_LIMIT,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          job_number: true,
          status: true,
          customer: { select: { id: true, first_name: true, last_name: true, company_name: true, phone: true } },
          service_location: { select: { address_line1: true, city: true } },
        },
      }),
      e164 ? matchByPhone(prisma, req.user!.organization_id, q) : Promise.resolve(null),
    ]);

    res.json({
      query: { isPhone: !!e164, e164 },
      customers: (customers as any[]).map((c) => ({
        id: c.id,
        name: dialerCustomerName(c),
        phone: c.phone ?? c.phones?.[0]?.phone ?? c.secondary_phone ?? null,
        site: dialerLocationLine(c.service_locations?.[0]),
        openJobs: (c.jobs ?? []).map((j: any) => ({
          id: j.id,
          number: j.job_number,
          status: j.status,
          location: dialerLocationLine(j.service_location),
        })),
      })),
      jobs: (jobs as any[]).map((j) => ({
        id: j.id,
        number: j.job_number,
        status: j.status,
        location: dialerLocationLine(j.service_location),
        customer: j.customer
          ? { id: j.customer.id, name: dialerCustomerName(j.customer), phone: j.customer.phone ?? null }
          : null,
      })),
      identity: identity
        ? {
            kind: identity.kind,
            id: identity.id,
            label: identity.label,
            customerId: identity.customerId,
            leadId: identity.leadId,
            vendorId: identity.vendorId,
          }
        : null,
    });
  } catch (err) {
    logger.error('Failed dialer search:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export const createCallSchema = z.object({
  direction: z.enum(['in', 'out']),
  from_number: z.string().min(1).max(40),
  to_number: z.string().min(1).max(40),
  status: z.string().min(1).max(40),
  tracking_source: z.string().max(120).optional(),
  lead_id: z.string().uuid('lead_id must be a valid id').optional(),
  job_id: z.string().uuid('job_id must be a valid id').optional(),
  customer_id: z.string().uuid('customer_id must be a valid id').optional(),
  // Optional explicit caller-ID pick (from-number picker, slice 5). Honored only
  // when it is a number assigned to the caller; otherwise resolution falls through.
  from_number_id: z.string().uuid('from_number_id must be a valid id').optional(),
});

// Softphone stash (POST /calls/attribution): the WebRTC softphone dials CTM from
// the browser, so it POSTs its dialer context here — same shape as the click-to-
// call body, minus from_number/status (no bridge, no local row).
export const stashAttributionSchema = z.object({
  to_number: z.string().min(3, 'to_number is required'),
  lead_id: z.string().uuid('lead_id must be a valid id').optional(),
  job_id: z.string().uuid('job_id must be a valid id').optional(),
  customer_id: z.string().uuid('customer_id must be a valid id').optional(),
});

/** The dialer's entity context, resolved + tenant-validated. */
interface AttributionContext {
  job: { id: string; job_number: string | null; customer_id: string | null } | null;
  lead: { id: string; customer_id: string | null } | null;
  customer: { id: string } | null;
}

/** A provided attribution id didn't resolve in the caller's org (→ 404). */
class AttributionContextError extends Error {
  constructor(public entity: 'Job' | 'Lead' | 'Customer') {
    super(`${entity} not found`);
    this.name = 'AttributionContextError';
  }
}

/** Resolve the dialer's job/lead/customer ids tenant-scoped. Each is optional; a
 *  provided-but-unresolvable id throws AttributionContextError (cross-org /
 *  unknown). No ids → all-null context, zero queries. Shared by the click-to-call
 *  bridge (createCall) and the softphone stash (createCallAttribution). */
async function resolveAttributionContext(
  req: Request,
  body: { job_id?: string; lead_id?: string; customer_id?: string },
): Promise<AttributionContext> {
  let job: AttributionContext['job'] = null;
  if (body.job_id) {
    job = await prisma.job.findUnique({
      where: { id: body.job_id, ...tenantWhere(req) },
      select: { id: true, job_number: true, customer_id: true },
    });
    if (!job) throw new AttributionContextError('Job');
  }
  let lead: AttributionContext['lead'] = null;
  if (body.lead_id) {
    lead = await prisma.lead.findFirst({
      where: { id: body.lead_id, ...tenantWhere(req) },
      select: { id: true, customer_id: true },
    });
    if (!lead) throw new AttributionContextError('Lead');
  }
  let customer: AttributionContext['customer'] = null;
  if (body.customer_id) {
    customer = await prisma.customer.findFirst({
      where: { id: body.customer_id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!customer) throw new AttributionContextError('Customer');
  }
  return { job, lead, customer };
}

/** Stash the resolved context keyed by destination number for ingestCall to
 *  consume, and opportunistically sweep this org's dead (>24h) rows. Returns the
 *  new pending id, or null when there is no context to attribute. */
async function stashAttribution(
  orgId: string,
  toE164: string,
  ctx: AttributionContext,
  requestedBy: string,
): Promise<string | null> {
  if (!ctx.job && !ctx.lead && !ctx.customer) return null;
  const pending = await prisma.pendingCallAttribution.create({
    data: {
      to_number: toE164,
      job_id: ctx.job?.id ?? null,
      job_label: ctx.job?.job_number ?? null,
      lead_id: ctx.lead?.id ?? null,
      customer_id: ctx.customer?.id ?? ctx.job?.customer_id ?? ctx.lead?.customer_id ?? null,
      requested_by: requestedBy,
      organization_id: orgId,
    },
  });
  // Opportunistic hygiene: unclaimed stash rows are dead after the 30-min window
  // — sweep this org's >24h leftovers while we're here.
  await prisma.pendingCallAttribution.deleteMany({
    where: { organization_id: orgId, created_at: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  return pending.id;
}

/**
 * POST /calls/attribution — softphone stash (no bridge).
 *
 * The WebRTC softphone dials CTM directly from the browser, so it never hits the
 * click-to-call bridge (createCall) that writes the PendingCallAttribution stash.
 * Without this, a call placed from a job/lead lands as a bare CallSession (only
 * the destination customer matched by number) and the job/lead context is lost.
 * This writes the SAME stash the bridge does, keyed by destination number, for
 * ingestCall to consume when the webhook fires. It places NO call.
 */
export async function createCallAttribution(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const toE164 = normalizeNAPhone(req.body.to_number) ?? req.body.to_number;

    // Phase-0 test guard (S1 fix): the WebRTC softphone dials CTM directly from
    // the browser, bypassing the createCall bridge — so this stash path must
    // enforce the SAME allowlist BEFORE recording any context, or a
    // non-allowlisted destination could still get its job/lead/customer
    // attribution stashed server-side. Inert when CTM_OUTBOUND_ALLOWLIST is unset.
    if (!isOutboundAllowed(toE164)) {
      res.status(409).json({
        error: 'Number is not on the outbound test allowlist',
        code: 'NOT_IN_TEST_ALLOWLIST',
      });
      return;
    }

    let ctx: AttributionContext;
    try {
      ctx = await resolveAttributionContext(req, req.body);
    } catch (err) {
      if (err instanceof AttributionContextError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }

    const pendingId = await stashAttribution(orgId, toE164, ctx, req.user!.id);
    res.status(202).json({ queued: pendingId !== null });
  } catch (err) {
    logger.error('[comm] createCallAttribution failed:', err);
    res.status(500).json({ error: 'Failed to record call attribution' });
  }
}

/**
 * The bridge ring-first refusals (mobile slice 21). Plain ServWave copy: these
 * reach the UI, so no vendor names and no identifiers. `PROFILE_PHONE_REQUIRED`
 * is what the dialer keys its "go to My Profile" link on; `reason` tells the
 * no-phone case from the extension case.
 */
const BRIDGE_REFUSALS: Record<BridgeLegsRefusal, { code: string; reason?: string; error: string }> = {
  missing: {
    code: 'PROFILE_PHONE_REQUIRED',
    reason: 'missing',
    error: 'Add your phone number to your profile to place calls from your phone',
  },
  invalid: {
    code: 'PROFILE_PHONE_REQUIRED',
    reason: 'invalid',
    error:
      "Your profile phone isn't a number we can ring. Update it in your profile to place calls from your phone",
  },
  extension: {
    code: 'PROFILE_PHONE_REQUIRED',
    reason: 'extension',
    error:
      "Your profile phone has an extension, which can't ring first. Add a direct number to your profile to place calls from your phone",
  },
  caller_is_customer: {
    code: 'CALLER_IS_CUSTOMER',
    error: "You can't call your own profile phone",
  },
  agent_missing: {
    code: 'PHONE_CALLING_NOT_SET_UP',
    error: "Calling from your phone isn't set up for your account yet. Contact ServWave support",
  },
};

/**
 * How far before the dial second the outcome floor reaches. Covers drift
 * between our server clock and the phone service's clock; kept small so a
 * quick redial does not match the PREVIOUS call to the same customer. Mirrored
 * by OUTCOME_FLOOR_DRIFT_MS in the frontend Softphone (its fallback floor).
 */
const OUTCOME_FLOOR_DRIFT_MS = 2_000;

/**
 * The `since` the bridge dialer should poll GET /calls/outcome with. CTM stamps
 * a call's start (`unix_time` -> started_at) in WHOLE SECONDS on its own clock,
 * so a millisecond-precise floor taken at dial time sits AFTER the row's
 * started_at roughly half the time (22:03:36.800 vs 22:03:36) and the poll
 * never matches - the dialer read "Call placed" forever (staging, 2026-10-03).
 * The dialer used to stamp the floor on the phone's own clock, which can also
 * run ahead; the server clock is the one we control. Round down to the second,
 * then pad for drift.
 */
export function bridgeOutcomeFloor(now: Date): string {
  const second = Math.floor(now.getTime() / 1000) * 1000;
  return new Date(second - OUTCOME_FLOOR_DRIFT_MS).toISOString();
}

// Internal create path for a CallSession (live CTM inbound is Plan C).
// Resolves the caller to a Customer/Lead/Vendor by phone (DEC6: match → link;
// no match → all FKs null so the UI can offer "create Lead"). Never auto-creates
// a Lead — lead_id is only set when explicitly passed and org-validated, which
// overrides the resolver's lead (P1).
export async function createCall(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    // Click-to-call (slice 8): on a CTM-connected org, an outbound "call" is a
    // REAL bridge — CTM rings the agent leg first, then dials the customer.
    // The 'starts'/'end' webhooks are the single source of truth for the
    // CallSession row (plan §2: no optimistic local row — fuzzy-merging a
    // local row with the webhook's would be a correctness minefield), so this
    // branch never writes. Not-connected orgs fall through to the mock path.
    if (req.body.direction === 'out' && isCtmConfigured()) {
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ctm_account_id: true },
      });
      if (org?.ctm_account_id) {
        // From-number caller ID (resolveOutboundNumber, slice 2): the caller's
        // per-user default → the org default → legacy oldest-active. `from_number_id`
        // is an optional explicit pick (from-number picker, slice 5), honored only
        // when assigned to the caller. `from_number` here is the CTM "TPN…" id,
        // never an E.164 string.
        const resolved = await resolveOutboundNumber(prisma, {
          orgId,
          userId: req.user!.id,
          explicitNumberId: req.body.from_number_id,
        });
        if (!resolved) {
          res.status(409).json({
            error: 'No phone number available to place calls from',
            code: 'NO_PHONE_NUMBER',
          });
          return;
        }

        const toE164 = normalizeNAPhone(req.body.to_number) ?? req.body.to_number;

        // Phase-0 test guard: refuse any destination not on the CTM allowlist
        // BEFORE bridging the call. Inert when CTM_OUTBOUND_ALLOWLIST is unset.
        if (!isOutboundAllowed(toE164)) {
          res.status(409).json({
            error: 'Number is not on the outbound test allowlist',
            code: 'NOT_IN_TEST_ALLOWLIST',
          });
          return;
        }

        // Ring-first leg (mobile slice 21): which shape makes the bridge ring the
        // CALLER's own profile phone first is chosen by CTM_BRIDGE_RING_CALLER
        // (config/bridgeRingCaller.ts). The proven shape (call_number_caller,
        // live on staging 2026-10-03) puts the caller's phone in call_number and
        // the customer in to_number. 'off' (the default) adds nothing and never
        // reads the profile phone, so the body stays byte-for-byte today's. Any
        // other mode reads the profile phone FRESH (the cached req.user can be up
        // to 60s stale right after the user adds a number) and refuses here,
        // before the stash below is written and before CTM is asked for anything.
        // Role-agnostic on purpose. The allowlist above keeps guarding only the
        // customer number (toE164), even when the caller's phone is call_number.
        // Never log the caller's phone or the agent map.
        const ringMode = env.CTM_BRIDGE_RING_CALLER;
        let legs: BridgeLegs = {};
        if (ringMode !== 'off') {
          const me = await prisma.user.findFirst({
            where: { id: req.user!.id, organization_id: orgId },
            select: { phone: true, phone_ext: true },
          });
          const built = buildBridgeLegs(
            ringMode,
            { id: req.user!.id, phone: me?.phone, phone_ext: me?.phone_ext },
            env.CTM_BRIDGE_AGENT_IDS,
            toE164,
          );
          if (!built.ok) {
            res.status(409).json(BRIDGE_REFUSALS[built.reason]);
            return;
          }
          legs = built.legs;
        }

        // Pending attribution stash (slice E1): the webhook — not this request —
        // creates the CallSession row, so any job/lead/customer context the dialer
        // picked would otherwise be dropped on the floor. Resolve each provided id
        // tenant-scoped, stash the context keyed by the CUSTOMER number (toE164,
        // never legs.call_number, which is the caller's phone in
        // call_number_caller mode), and let
        // ingestCall consume it (30-min window, atomic claim). No context ids →
        // byte-identical legacy behavior (no resolves, no row). The softphone path
        // reaches this SAME stash via POST /calls/attribution — it bypasses this
        // bridge, dialing CTM directly from the browser.
        let ctx: AttributionContext;
        try {
          ctx = await resolveAttributionContext(req, req.body);
        } catch (err) {
          if (err instanceof AttributionContextError) {
            res.status(404).json({ error: err.message });
            return;
          }
          throw err;
        }
        const pendingId = await stashAttribution(orgId, toE164, ctx, req.user!.id);

        // call_number is the leg CTM rings FIRST: the customer by default, the
        // caller's own phone when the legs say so (call_number_caller). With no
        // legs ('off') the body is exactly { from_number, call_number: customer }.
        const { call_number: firstLeg, ...extraLegs } = legs;
        // Floor for the dialer's GET /calls/outcome poll, stamped on the SERVER
        // clock just before the phone service is asked to dial. See
        // bridgeOutcomeFloor for why it is rounded down and padded.
        const outcomeSince = bridgeOutcomeFloor(new Date());
        try {
          await placeCall(org.ctm_account_id, {
            from_number: resolved.ctm_number_id,
            call_number: firstLeg ?? toE164,
            ...extraLegs,
          });
        } catch (err) {
          // Any placeCall failure is an upstream (CTM) failure — typed 502,
          // never a row. `reason` is CTM's text, safe to log (client.ts) —
          // except that once a ring-first mode is on, the body may carry the
          // caller's own phone (call_number or to_number) and CTM may echo it
          // back, so phone-like runs are masked. 'off' logs exactly as before.
          const masking = ringMode !== 'off';
          const scrub = masking ? maskLongDigitRuns : (t: string) => t;
          if (err instanceof CtmApiError) {
            logger.warn(`[ctm] click-to-call failed (${err.httpStatus}): ${scrub(err.reason)}`);
          } else if (masking) {
            logger.warn(`[ctm] click-to-call failed: ${scrub(err instanceof Error ? err.message : String(err))}`);
          } else {
            logger.warn('[ctm] click-to-call failed:', err);
          }
          // The call never happened — the stash must not linger for the next
          // (unrelated) call to the same number to pick up.
          if (pendingId) {
            await prisma.pendingCallAttribution.deleteMany({ where: { id: pendingId } });
          }
          res.status(502).json({ error: 'The phone system could not place the call' });
          return;
        }

        void logAudit({
          req,
          action: 'call.placed',
          resourceType: 'CallSession',
          metadata: { to_number: toE164, from_tpn: resolved.ctm_number_id },
        });

        res.status(202).json({ queued: true, outcome_since: outcomeSince });
        return;
      }
    }

    let explicitLeadId: string | null = null;
    if (req.body.lead_id) {
      const lead = await prisma.lead.findFirst({
        where: { id: req.body.lead_id, ...tenantWhere(req) },
      });
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      explicitLeadId = lead.id;
    }

    // Communication ↔ Jobs (spec §7): attach-by-origin. An explicit job_id is
    // resolved tenant-scoped and stamps job_id + job_label (the human J-number)
    // so call rows never surface raw UUIDs.
    let jobStamp: { job_id: string; job_label: string | null } | null = null;
    if (req.body.job_id) {
      const job = await prisma.job.findUnique({
        where: { id: req.body.job_id, ...tenantWhere(req) },
        select: { id: true, job_number: true, customer_id: true },
      });
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      jobStamp = { job_id: job.id, job_label: job.job_number };
    }

    // Explicit customer context (parity with the CTM branch's pending stash):
    // org-validated, and it wins over the phone-match resolver's customer.
    let explicitCustomerId: string | null = null;
    if (req.body.customer_id) {
      const customer = await prisma.customer.findFirst({
        where: { id: req.body.customer_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
      }
      explicitCustomerId = customer.id;
    }

    const match = await matchByPhone(prisma, orgId, req.body.from_number);

    const row = await prisma.callSession.create({
      data: {
        direction: req.body.direction,
        from_number: req.body.from_number,
        to_number: req.body.to_number,
        status: req.body.status,
        tracking_source: req.body.tracking_source ?? null,
        answered_by: { kind: 'none' },
        started_at: new Date(),
        customer_id: explicitCustomerId ?? match?.customerId ?? null,
        lead_id: explicitLeadId ?? match?.leadId ?? null,
        vendor_id: match?.vendorId ?? null,
        job_id: jobStamp?.job_id ?? null,
        job_label: jobStamp?.job_label ?? null,
        organization_id: orgId,
      },
    });

    // Spec #1751 D5: an outbound call marks the lead contacted. `automated: false` is stated
    // outright rather than omitted — outbound calls are human by nature TODAY because a person
    // presses dial, and there is no column to read. Naming it here is the hook the first
    // autodialer has to change, instead of silently inheriting a default that was only ever true
    // by accident of what had been built.
    //
    // An INBOUND call is filtered out inside the helper: the customer ringing us is not us
    // reaching out (user story 15), and this same door records both directions.
    await recordLeadOutboundContact(prisma, {
      leadId: row.lead_id,
      orgId: row.organization_id,
      channel: 'call',
      direction: row.direction,
      automated: false,
      at: row.started_at,
    });

    logger.info(
      `Call created${match ? ` linked to ${match.kind} ${match.id}` : ' (unmatched caller)'}`,
    );
    res.status(201).json({ call: mapCallSession(row) });
  } catch (err) {
    logger.error('Failed to create call:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Manual attach of a call to a job from the call log (spec §7, story 21);
// job_id: null clears the attribution back to "no job".
export const reassignCallJobSchema = z.object({
  job_id: z.string().uuid('job_id must be a valid id').nullable(),
});

// Mirrors the SMS one-click reassign (comm-threads.controller.ts): tenant-scoped
// job resolve → atomic updateMany → refetch. Extra rule for calls: a
// customer-linked call may only attach to that customer's jobs; unknown-caller
// calls (customer_id null) accept any org job.
//
// A call is "about" one thing, and a job and its originating lead are two ends of
// that same thing - so one attach stamps the whole customer/job/lead triple and
// one detach clears it. The lead is reached through the job's estimate
// (Job.estimate -> Estimate.lead_id, the idiom in job.controller/attachment.controller);
// there is no Job.lead_id column, and a from-scratch job has no estimate and so
// no lead. Stamping lead_id here cannot affect this row's own visibility:
// anchorInheritedWhere resolves job_id FIRST, and job_id is non-null on this path.
export async function reassignCallJob(req: Request, res: Response) {
  try {
    // Resolved once and applied to the pre-read, the updateMany AND the refetch.
    // The refetch used to carry a WEAKER filter than the update it follows -
    // benign while the guard was pure tenancy (the updateMany already 404'd),
    // NOT benign now that the guard is a visibility predicate and the refetch is
    // what renders back to the caller.
    const visibility = await commVisibilityWhere(req);
    let data: {
      job_id: string | null;
      job_label: string | null;
      lead_id: string | null;
    };
    if (req.body.job_id != null) {
      // Pre-read the call for the same-customer constraint (findMany take 1 —
      // the house pattern for models without a findFirst mock surface).
      const [call] = await prisma.callSession.findMany({
        where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
        take: 1,
      });
      if (!call) {
        res.status(404).json({ error: 'Call not found' });
        return;
      }
      // Resolved under the caller's OWN Job row-scope, not tenancy alone: a
      // caller must not be able to attribute a call to a job they cannot see
      // (that would both hide the row from themselves and surface it to that
      // job's crew). Unconditional-read roles get {} here, so nothing changes
      // for dispatcher/admin.
      const job = await prisma.job.findUnique({
        where: { id: req.body.job_id, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Job')) },
        select: {
          id: true,
          job_number: true,
          estimate: { select: { lead_id: true } },
        },
      });
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      // job/lead ONLY, and deliberately unconstrained by call.customer_id in
      // BOTH directions. There is no phone matching behind a job or a lead, so
      // the customer the ingest resolved has no claim on which anchor is valid:
      //  - it is not written here (that would be a guess from one click), and
      //  - it does not gate the pick (the picker searches the whole org, so a
      //    same-customer guard would offer results it then 404s).
      // The two stay independent - the call still shows whoever the phone
      // matched, while the anchor is whatever a human chose.
      data = {
        job_id: job.id,
        job_label: job.job_number,
        lead_id: job.estimate?.lead_id ?? null,
      };
    } else {
      // Detach drops both ends; the lead was only ever the job's companion.
      data = { job_id: null, job_label: null, lead_id: null };
    }

    // updateMany with id+org filter is atomic — no TOCTOU window.
    const result = await prisma.callSession.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      data,
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }

    // Same filter as the update. This is only sound because the target job above
    // is resolved under the caller's OWN Job scope: a caller can never move a row
    // to a job they cannot see, so the row they just wrote is still visible to
    // them here and the refetch can never come back empty.
    const [updated] = await prisma.callSession.findMany({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      take: 1,
    });

    res.json({ call: mapCallSession(updated) });
  } catch (err) {
    logger.error('Failed to reassign call job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Manual attach of a call to a lead — the lead mirror of reassignCallJob.
// lead_id is otherwise only ever stamped at ingest (stash / phone match), so
// without this a call that missed its lead attribution could never be
// corrected (live QA 2026-07-21). lead_id: null clears.
export const reassignCallLeadSchema = z.object({
  lead_id: z.string().uuid('lead_id must be a valid id').nullable(),
});

export async function reassignCallLead(req: Request, res: Response) {
  try {
    // See reassignCallJob: one filter, applied to the pre-read, the update and
    // the refetch alike.
    const visibility = await commVisibilityWhere(req);
    let data: {
      lead_id: string | null;
      job_id: string | null;
      job_label: string | null;
    };
    if (req.body.lead_id != null) {
      const [call] = await prisma.callSession.findMany({
        where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
        take: 1,
      });
      if (!call) {
        res.status(404).json({ error: 'Call not found' });
        return;
      }
      // Under the caller's own Lead row-scope - the lead mirror of the job
      // resolve in reassignCallJob, and what keeps the refetch below non-empty.
      const lead = await prisma.lead.findUnique({
        where: { id: req.body.lead_id, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Lead')) },
        select: { id: true },
      });
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      // The companion job - the mirror of reassignCallJob stamping the lead.
      // Resolved back through the estimate (no Job.lead_id column), newest first
      // because R6 made Lead->Estimate 1:N, so a lead can front several jobs.
      //
      // Scoped to the caller's OWN Job row-scope, and that is load-bearing rather
      // than decorative: anchorInheritedWhere resolves job_id BEFORE lead_id, so
      // stamping a job the caller cannot see would move this row out of the lead
      // branch and into a job branch that excludes them - hiding the call from the
      // very person who just attached it, and emptying the refetch below. Out of
      // scope therefore means "leave job_id null", not 404: the lead attach itself
      // is legitimate and still succeeds.
      const job = await prisma.job.findFirst({
        where: {
          ...tenantWhere(req),
          ...(await scopeWhereForReq(req, 'Job')),
          estimate: { lead_id: lead.id },
        },
        orderBy: { created_at: 'desc' },
        select: { id: true, job_number: true },
      });
      // lead/job ONLY, unconstrained by call.customer_id - see reassignCallJob.
      data = {
        lead_id: lead.id,
        job_id: job?.id ?? null,
        job_label: job?.job_number ?? null,
      };
    } else {
      // Symmetric with the job endpoint: one link, so detaching clears both ends.
      data = { lead_id: null, job_id: null, job_label: null };
    }

    const result = await prisma.callSession.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      data,
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Call not found' });
      return;
    }

    const [updated] = await prisma.callSession.findMany({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      take: 1,
    });

    res.json({ call: mapCallSession(updated) });
  } catch (err) {
    logger.error('Failed to reassign call lead:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * The comm module's customer directory. These two handlers return CUSTOMER
 * records (contacts, service locations, every phone number on file), not comm
 * rows, and their only route guard is `read Communication`.
 *
 * That was harmless while `read Communication` implied a role that also held
 * `read Customer` (SALES/DISPATCHER/ADMIN). Slice 8a gives TECHNICIAN
 * `read Communication` and TECHNICIAN has NO `read Customer`, so without this
 * gate the grant would hand every technician the org's whole customer list.
 * Mirrors dialerSearch's existing subject-level check just below.
 *
 * #2041: Customer IS now a ScopeResource for a conditioned reader (SALES). This subject-level
 * probe stays — it is still the correct "may you read customers AT ALL" fail-closed gate for a
 * role (like TECHNICIAN) with no grant whatsoever — but both handlers below ALSO compose the
 * row-scope (`scopeWhereForReq(req,'Customer')`) into their `where`, so a conditioned reader sees
 * only their associated customers, not the whole org.
 */
function canReadCustomers(req: Request): boolean {
  return !!req.ability?.can('read', 'Customer' as Subject);
}

export async function listPhoneCustomers(req: Request, res: Response) {
  try {
    if (!canReadCustomers(req)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    const custScope = await scopeWhereForReq(req, 'Customer');
    const rows = await prisma.customer.findMany({
      where: { ...tenantWhere(req), ...custScope },
      orderBy: { created_at: 'desc' },
      include: {
        contacts: { include: { channels: true } },
        service_locations: true,
        jobs: { select: { id: true } },
        phones: true,
      },
    });

    res.json({ contacts: rows.map(mapPhoneCustomer) });
  } catch (err) {
    logger.error('Failed to list phone customers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getPhoneCustomer(req: Request, res: Response) {
  try {
    if (!canReadCustomers(req)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    // #2041 — row-scoped: an in-org, existing customer the requester is not associated with
    // keeps the SAME 404 body an out-of-org/nonexistent id already gets.
    const custScope = await scopeWhereForReq(req, 'Customer');
    const row = await prisma.customer.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...custScope },
      include: {
        contacts: { include: { channels: true } },
        service_locations: true,
        jobs: { select: { id: true } },
        phones: true,
      },
    });

    if (!row) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    res.json({ contact: mapPhoneCustomer(row) });
  } catch (err) {
    logger.error('Failed to get phone customer:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
