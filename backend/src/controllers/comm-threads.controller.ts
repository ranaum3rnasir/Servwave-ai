import { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { findCustomerToContact, leadReachWhere } from '../lib/permissions/targetReach';
import { normalizeNAPhone } from '../lib/comms-identity';
import { matchByPhoneInReach } from '../lib/communication/phoneMatchInReach';
import { otherPartyE164 } from '../lib/communication/otherPartyNumber';
import { NUMBER_NOT_ON_RECORD, recordTextDestination, type TextAnchor } from '../lib/communication/recordTextDestination';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import { textContinueScopeForReq, textReadScopeForReq, textsInSectionScopeForReq } from '../lib/communication/communicationScope';
import {
  existingPairConversation,
  existingSmsThreadForNumber,
  findOrCreatePairConversation,
  findOrCreateSmsThreadByNumber,
  latestPairConversationWith,
  mainLineE164,
  type PairReach,
} from '../lib/ctm/smsThread';
import { isPersonsNumber, movedFrom, sendingNumber } from '../lib/communication/sendingNumber';
import { type NumberCarrier } from '../lib/comms-identity';
import { carriersInReach, customersInReach } from '../lib/communication/numberCarriers';
import { attachTargets, textTieRule, tieAllowed } from '../lib/communication/attachTargets';
import { isCtmConfigured } from '../lib/ctm/client';
import {
  markMessageNotDelivered,
  precheckCtmSms,
  sendCtmSms,
  type CtmSmsFailureReason,
} from '../lib/ctm/sendSms';
import { tieIncomingText, UNTIED, type ReplyTie } from '../lib/sms-reply-router';
import {
  reconsiderLeadLeftBehind,
  recordLeadContactOnLink,
  recordLeadOutboundContact,
  TEXT_WENT_OUT,
} from '../services/lead-contact.service';
import { SMS_BODY_MAX, LONG_TEXT_MAX } from '../lib/text-limits';

// ─── Zod Schemas ───────────────────────────────────────

export const createThreadSchema = z.object({
  from_number: z.string().min(1).max(40),
  campaign_type: z.string().min(1).max(60),
  channel: z.string().max(20).optional(),
  title: z.string().max(200).optional(),
  subtitle: z.string().max(200).optional(),
  lead_id: z.string().uuid('lead_id must be a valid id').optional(),
});

export const sendMessageSchema = z.object({
  threadId: z.string().uuid('threadId must be a valid id').optional(),
  customerId: z.string().uuid('customerId must be a valid id').optional(),
  // Compose-to-number (slice H7): an arbitrary destination phone. Normalized +
  // validated in the controller (NA-only, human 400); length-fenced here.
  toNumber: z.string().min(7).max(40).optional(),
  // ≤1600: CTM auto-splits into 160-char segments up to 1600, then truncates
  // server-side (addendum §A.6) — reject anything longer here.
  body: z.string().min(1, 'Message body is required').max(1600),
  direction: z.enum(['in', 'out']).optional(),
  status: z.enum(['queued', 'sent', 'delivered', 'received']).optional(),
  automated: z.boolean().optional(),
  // Attach-by-origin: a send composed from a job page stamps that job.
  jobId: z.string().uuid('jobId must be a valid id').optional(),
  // Lead attribution (slice E4): a send composed from a Lead page stamps the
  // thread's lead link (create-with / backfill-if-lead-less; never overwrite).
  leadId: z.string().uuid('leadId must be a valid id').optional(),
}).refine((d) => d.threadId || d.customerId || d.toNumber, {
  message: 'threadId, customerId or toNumber is required',
  path: ['threadId'],
});

// One-click reassign of a message's job attribution; null clears it back to
// the per-customer Unrouted tray.
export const reassignSmsJobSchema = z.object({
  job_id: z.string().uuid('job_id must be a valid id').nullable(),
});

export const createTemplateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  info: z.string().max(LONG_TEXT_MAX),
  body: z.string().min(1, 'Body is required').max(SMS_BODY_MAX),
  defaultBody: z.string().max(SMS_BODY_MAX).optional(),
  fields: z.array(z.string()).optional(),
  audience: z.enum(['customer', 'team']),
  notifyToggle: z.boolean().optional(),
  notifyOn: z.boolean().optional(),
  kind: z.enum(['preset', 'custom']).optional(),
});

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  info: z.string().max(LONG_TEXT_MAX).optional(),
  body: z.string().min(1).max(SMS_BODY_MAX).optional(),
  defaultBody: z.string().max(SMS_BODY_MAX).optional(),
  fields: z.array(z.string()).optional(),
  audience: z.enum(['customer', 'team']).optional(),
  notifyToggle: z.boolean().optional(),
  notifyOn: z.boolean().optional(),
  kind: z.enum(['preset', 'custom']).optional(),
});

export const createAutomationSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  trigger: z.string().min(1, 'Trigger is required'),
  templateId: z.string().uuid('templateId must be a valid id'),
  timing: z.string().min(1, 'Timing is required'),
  audience: z.enum(['customer', 'team']),
  enabled: z.boolean().optional(),
});

export const updateAutomationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  trigger: z.string().min(1).optional(),
  templateId: z.string().uuid().optional(),
  timing: z.string().min(1).optional(),
  audience: z.enum(['customer', 'team']).optional(),
  enabled: z.boolean().optional(),
});

// ─── Communication ↔ Jobs: internal-lane rule (spec §7) ───
// A thread is job-attributable ONLY when it is customer-facing: kind NULL
// (legacy rows) or 'customer'. 'team' and 'group' are internal lanes and are
// NEVER job-attached. kind is nullable, so Prisma where clauses must use this
// explicit OR shape — a bare { kind: { not: 'team' } } would silently exclude
// kind-NULL (customer) rows too.
const JOB_ATTRIBUTABLE_THREAD_WHERE = { OR: [{ kind: null }, { kind: 'customer' }] };

function isJobAttributableThread(thread: { kind?: string | null }): boolean {
  return thread.kind == null || thread.kind === 'customer';
}

/** Threads the outbound CTM pipeline will try to deliver on.
 *
 * Customer-facing threads (kind null / 'customer'), exactly as before, PLUS a
 * staff thread that names a person: `user_id` IS the counterparty, and
 * resolveSmsDestination reads their mobile off it. Inbound staff replies
 * already land on this very thread - lib/ctm/ingest.ts opts into `matchStaff`
 * and keys a staff number onto it - so refusing to deliver here is what left
 * an admin looking at a reply they could not answer.
 *
 * Deliberately NOT the same predicate as isJobAttributableThread, and it must
 * not be collapsed into it: a staff thread is textable but still NEVER carries
 * a job id. The internal-lane rule above is unchanged.
 *
 * What stays undeliverable is what resolves to nobody: a 'group' thread (a
 * crew broadcast has no single counterparty) and a team thread with no
 * user_id. Those keep today's record-only behavior.
 */
function isDeliverableThread(thread: { kind?: string | null; user_id?: string | null }): boolean {
  return isJobAttributableThread(thread) || (thread.kind === 'team' && thread.user_id != null);
}

// ─── CTM outbound delivery (slice 6) ────────────────────

// Gate-failure reasons a connected org's user send surfaces as 409 { error,
// code } BEFORE the row is created. NOT_CONNECTED / CTM_ERROR are absent on
// purpose: they fall back to today's record-is-the-product behavior.
// NOT_ENTITLED is absent too — this route already runs requireFeature('phone')
// (comm-threads.routes.ts), so runGates' own entitlement check is defence in
// depth for the automation seam, not something a user send can normally reach.
const SMS_GATE_409: Partial<Record<CtmSmsFailureReason, string>> = {
  RECIPIENT_OPTED_OUT: 'This recipient has opted out of text messages',
  SMS_NOT_READY: 'Text messaging is not active yet — carrier approval is pending',
  ORG_SMS_DISABLED: 'Text messaging is turned off for this organization',
  NO_SMS_NUMBER: 'No SMS-capable phone number is available for this conversation',
  DUPLICATE_SEND: 'An identical text was just sent to this conversation',
  // Phase-0 test guard (slice H7 closes the gap): an allowlist-blocked send
  // now 409s with NO row, mirroring click-to-call — it used to fall through
  // and create a record-only row the user believed was delivered.
  NOT_IN_TEST_ALLOWLIST: 'Number is not on the outbound test allowlist',
};

/** Destination number for CTM delivery on a thread: the linked customer's
 * phone, else the vendor's contact phone, else the staff member's mobile, else
 * the thread title (unmatched inbound threads are keyed by title = the raw
 * counterpart number). Returns E.164 where normalizable, null when the thread
 * has no textable number.
 *
 * The staff branch reads `users.phone` - the mobile Spec C captures. It must
 * never read `users.phone_ext`, which is a desk extension and not dialable on
 * its own. It sits AHEAD of the title branch because a staff thread's title is
 * the person's NAME, so a name that happened to look like digits would
 * otherwise be texted instead of the person.
 */
async function resolveSmsDestination(
  req: Request,
  thread: { customer_id?: string | null; vendor_id?: string | null; user_id?: string | null; title?: string | null; other_party_e164?: string | null },
): Promise<string | null> {
  // #3019: a conversation keyed by its pair of numbers texts its other party's number, whichever customer it is filed on.
  if (thread.other_party_e164) return thread.other_party_e164;
  let raw: string | null = null;
  if (thread.customer_id) {
    const customer = await prisma.customer.findFirst({
      where: { id: thread.customer_id, ...tenantWhere(req) },
      select: { phone: true },
    });
    raw = customer?.phone ?? null;
  } else if (thread.vendor_id) {
    const vendor = await prisma.vendor.findFirst({
      where: { id: thread.vendor_id, ...tenantWhere(req) },
      select: { contact_phone: true },
    });
    raw = vendor?.contact_phone ?? null;
  } else if (thread.user_id) {
    const user = await prisma.user.findFirst({
      where: { id: thread.user_id, ...tenantWhere(req) },
      select: { phone: true },
    });
    raw = user?.phone ?? null;
  } else if (thread.title && /^\+?[\d\s().-]{7,20}$/.test(thread.title)) {
    raw = thread.title;
  }
  if (!raw) return null;
  return normalizeNAPhone(raw) ?? raw;
}

// ─── Mappers (snake_case Prisma row → camelCase mock shape) ───

/** A message's stored `status_reason` as the browser gets it. The stored value
 *  for a send the phone service rejected names the integration ('CTM_ERROR');
 *  the API sends ServWave's own code for it. Every other reason is already
 *  neutral and passes through. */
function presentStatusReason(reason: string): string {
  return reason === 'CTM_ERROR' ? 'PROVIDER_ERROR' : reason;
}

function mapMessage(m: any) {
  return {
    id: m.id,
    direction: m.direction,
    body: m.body,
    ts: m.ts instanceof Date ? m.ts.toISOString() : m.ts,
    status: m.status ?? undefined,
    ...(m.status_reason != null && { statusReason: presentStatusReason(m.status_reason) }),
    automated: m.automated ?? undefined,
    ...(m.job_id != null && { jobId: m.job_id }),
    ...(m.job_label != null && { jobLabel: m.job_label }),
    ...(m.lead_id != null && { leadId: m.lead_id }),
    // #3024: the lead's number, for the inbox's grey text on a text tied to a lead only (read where the thread reads include it).
    ...(m.lead_id != null && m.lead?.lead_number != null && { leadLabel: m.lead.lead_number }),
  };
}

function mapThread(t: any) {
  return {
    id: t.id,
    customerId: t.customer_id ?? '',
    channel: t.channel,
    campaignType: t.campaign_type,
    unread: t.unread,
    messages: (t.messages ?? []).map(mapMessage),
    kind: t.kind ?? undefined,
    archived: t.archived ?? undefined,
    title: t.title ?? undefined,
    subtitle: t.subtitle ?? undefined,
    ...(t.customer != null && {
      linkedCustomer: { id: t.customer.id, name: t.customer.company_name ?? [t.customer.first_name, t.customer.last_name].filter(Boolean).join(' ') },
    }),
    ...(t.lead != null && { linkedLead: { id: t.lead.id, leadNumber: t.lead.lead_number } }),
    ...(t.vendor != null && { linkedVendor: { id: t.vendor.id, name: t.vendor.name } }),
    // Spec C: the staff counterparty. Conditionally spread like the two above, so a
    // customer/lead/vendor thread gains no key at all and its payload is unchanged.
    // `userId` is a REAL id, unlike `customerId` above, whose `?? ''` sentinel exists
    // only because the field predates any other counterparty being expressible.
    ...(t.user != null && {
      linkedUser: { id: t.user.id, name: [t.user.first_name, t.user.last_name].filter(Boolean).join(' ') },
    }),
    ...(t.user_id != null && { userId: t.user_id }),
    ...(t.lead_id != null && { leadId: t.lead_id }),
    ...(t.vendor_id != null && { vendorId: t.vendor_id }),
    // #3019: a conversation keyed by its pair of numbers names both: the other party's, and whose our number is.
    // #3021: and every customer carrying the other party's number, in the fixed order (#3015), worked out at this read.
    ...(t.other_party_e164 != null && {
      pair: {
        otherPartyE164: t.other_party_e164, ourNumberE164: t.our_number_e164 ?? null, ourLine: t.ourLine ?? null,
        customers: t.carriers ?? [],
      },
    }),
  };
}

/** Whose our number is, as the inbox names it (#3019): the main line, or the person it belongs to. */
type OurLine = { kind: 'main_line' } | { kind: 'person'; name: string };

/**
 * Names our number on every pair-keyed conversation of a page (#3019), in one read of the company's numbers: the main line
 * (the company's default number, or the number a text with no company number is filed under), else the active person the
 * number is assigned to (their default number first, then the earliest assignment), else nothing. Only names are read.
 */
async function attachOurLines<T extends { other_party_e164?: string | null; our_number_e164?: string | null }>(
  req: Request,
  threads: T[],
): Promise<(T & { ourLine?: OurLine | null })[]> {
  const keyed = threads.filter((t) => t.other_party_e164 != null);
  if (keyed.length === 0) return threads;
  const orgId = req.user!.organization_id;
  const e164s = [...new Set(keyed.map((t) => t.our_number_e164).filter((n): n is string => n != null))];
  const numbers = e164s.length
    ? await prisma.phoneNumber.findMany({
        where: { organization_id: orgId, e164: { in: e164s } },
        select: {
          e164: true,
          is_org_default: true,
          user_links: {
            where: { user: { is_active: true } },
            orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
            select: { user: { select: { first_name: true, last_name: true } } },
          },
        },
      })
    : [];
  const mainLine = await mainLineE164(prisma, orgId);
  const lineOf = (e164: string | null | undefined): OurLine | null => {
    if (e164 == null || e164 === mainLine) return { kind: 'main_line' };
    const row = numbers.find((n) => n.e164 === e164);
    if (!row) return null;
    if (row.is_org_default) return { kind: 'main_line' };
    for (const link of row.user_links) {
      const name = [link.user.first_name, link.user.last_name].map((p) => p?.trim() ?? '').filter(Boolean).join(' ');
      if (name) return { kind: 'person', name };
    }
    return null;
  };
  return threads.map((t) => (t.other_party_e164 != null ? { ...t, ourLine: lineOf(t.our_number_e164) } : t));
}

/**
 * The customers carrying the other party's number on every pair-keyed conversation of a page (#3021, #3013 decision 5), the
 * ones the person can open: ONE read of the carriers for the whole page, however many conversations and customers, and one
 * of the person's reach over them (`carriersInReach`). Nothing is stored, so a number taken off a customer's record takes
 * that customer off the conversation on the next read.
 *
 * A pair-keyed conversation is read through any customer carrying its number, so the person may not be able to open the
 * customer it happens to be filed on. Then it is sent to them as filed on nobody: no id or name of that customer, and not
 * the lead it is filed on (that customer's); the screen names the conversation by its carriers alone (ruling on #3021: names
 * only customers the viewer can open; re-audit P2-1). One more read for the page, only for a scope that does not reach every
 * customer (`customersInReach`).
 */
async function attachCarriers<
  T extends { other_party_e164?: string | null; customer_id?: string | null },
>(
  req: Request,
  threads: T[],
): Promise<(T & { carriers?: NumberCarrier[] })[]> {
  const keyed = threads.filter((t) => t.other_party_e164 != null);
  if (keyed.length === 0) return threads;
  const orgId = req.user!.organization_id;
  const customerScope = await scopeWhereForReq(req, 'Customer');
  const numbers = [...new Set(keyed.map((t) => t.other_party_e164!))];
  const carriers = await carriersInReach(prisma, orgId, numbers, customerScope);
  const filedOn = keyed.map((t) => t.customer_id).filter((id): id is string => id != null);
  const opens = await customersInReach(prisma, orgId, filedOn, customerScope);
  return threads.map((t) => {
    if (t.other_party_e164 == null) return t;
    const named = { ...t, carriers: carriers.get(t.other_party_e164) ?? [] };
    return t.customer_id != null && !opens.has(t.customer_id)
      ? { ...named, customer_id: null, customer: null, lead_id: null, lead: null }
      : named;
  });
}

/**
 * The one customer a conversation is named by for this person (whole-diff ruling, Ran 2026-11-07, #3013 decision 5): for a
 * conversation keyed by its pair, the first customer carrying its number in the fixed order (#3015) that they can open - the
 * customer the inbox names it by first (`attachCarriers`), worked out now, so the customer it happens to be stored on decides
 * nothing; none when no customer they can open carries the number. A conversation from before pairs is its own customer's.
 */
async function conversationCustomerFor(
  req: Request,
  thread: { other_party_e164?: string | null; customer_id?: string | null },
): Promise<string | null> {
  if (thread.other_party_e164 == null) return thread.customer_id ?? null;
  const [named] = await attachCarriers(req, [thread]);
  return named?.carriers?.[0]?.id ?? null;
}

function mapTemplate(t: any) {
  return {
    id: t.id,
    name: t.name,
    info: t.info,
    body: t.body,
    defaultBody: t.default_body,
    fields: Array.isArray(t.fields) ? t.fields : [],
    audience: t.audience,
    notifyToggle: t.notify_toggle ?? undefined,
    notifyOn: t.notify_on ?? undefined,
    kind: t.kind,
  };
}

function mapAutomation(a: any) {
  return {
    id: a.id,
    name: a.name,
    trigger: a.trigger,
    templateId: a.template_id,
    timing: a.timing,
    audience: a.audience,
    enabled: a.enabled,
  };
}

// ─── Thread Handlers ───────────────────────────────────

/*
 * Text visibility follows Communication scope (M11, Roles & Permissions S08.5), in the two halves it needs. The nested
 * messages are filtered in SQL (a filtered join, NOT response-level hiding), and the conversation drops out when it
 * holds nothing readable, because its existence and its customer link are themselves information. Both collapse to {}
 * for a person on "All".
 *   - `textsInSectionScopeForReq`: the inbox list and its unread count. A conversation is listed when it holds one of
 *     the person's own messages (a linked number, a text they sent, their staff conversation), and returns only those.
 *   - `textReadScopeForReq`: opening one conversation or message (detail, mark read, reply, reassign). Each message
 *     returns when it is the person's or reachable through the job, lead, customer or vendor it hangs off.
 */

/**
 * SMS thread per-caller unread (#2049 - the SMS mirror of email's
 * attachCallerUnread, comm-whatsapp-email.controller.ts). Reviewer amendments
 * R1 + R2 are BINDING here:
 *   - `unread` is a NUMBER (R1): the count of INCLUDED messages that are not
 *     outbound (`direction != 'out'`, not `=== 'in'` - the frozen test's
 *     mocked message carries no `direction` key at all) whose `ts` is newer
 *     than the caller's own read marker; every visible inbound message counts
 *     when no marker row exists yet.
 *   - ONE `messageThreadReadState.findMany` for the WHOLE page (R2), never a
 *     per-thread query - the predicate compares `read_at` against the latest
 *     inbound `ts`, which Prisma cannot express as a relation filter.
 * Returns NEW objects with `unread` overwritten, exactly like email's
 * attachCallerUnread, so mapThread's existing `unread: t.unread` passthrough
 * needs no further changes.
 */
export async function attachCallerUnread<
  T extends { id: string; messages?: { direction?: string | null; ts: Date | string }[] },
>(req: Request, threads: T[]): Promise<(T & { unread: number })[]> {
  if (threads.length === 0) return [];
  const markers = await prisma.messageThreadReadState.findMany({
    where: {
      user_id: req.user!.id,
      ...tenantWhere(req),
      thread_id: { in: threads.map((t) => t.id) },
    },
    select: { thread_id: true, read_at: true },
  });
  const readAtByThread = new Map(
    (markers ?? []).map((m: { thread_id: string; read_at: Date }) => [m.thread_id, m.read_at]),
  );
  return threads.map((t) => {
    const readAt = readAtByThread.get(t.id) ?? null;
    const unread = (t.messages ?? []).filter((m) => {
      if (m.direction === 'out') return false;
      if (!readAt) return true;
      return new Date(m.ts).getTime() > new Date(readAt).getTime();
    }).length;
    return { ...t, unread };
  });
}

export async function listThreads(req: Request, res: Response) {
  try {
    const scope = await textsInSectionScopeForReq(req);
    const threads = await prisma.messageThread.findMany({
      where: { ...tenantWhere(req), ...scope.thread },
      orderBy: { updated_at: 'desc' },
      include: {
        messages: { where: scope.messages, orderBy: { ts: 'asc' }, include: { lead: { select: { lead_number: true } } } },
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        lead: { select: { id: true, lead_number: true } },
        vendor: { select: { id: true, name: true } },
        // Name fields only - a label is all the payload needs, and the User row
        // carries a password hash and an email that have no business on it.
        user: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    const withUnread = await attachCallerUnread(req, threads);
    res.json({ threads: (await attachCarriers(req, await attachOurLines(req, withUnread))).map(mapThread) });
  } catch (err) {
    logger.error('Failed to list threads:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getThread(req: Request, res: Response) {
  try {
    const scope = await textReadScopeForReq(req, { threadId: req.params.id as string });
    const thread = await prisma.messageThread.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...scope.thread },
      include: {
        messages: { where: scope.messages, orderBy: { ts: 'asc' }, include: { lead: { select: { lead_number: true } } } },
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        lead: { select: { id: true, lead_number: true } },
        vendor: { select: { id: true, name: true } },
        // Name fields only - a label is all the payload needs, and the User row
        // carries a password hash and an email that have no business on it.
        user: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const [withUnread] = await attachCallerUnread(req, [thread]);
    const [named] = await attachCarriers(req, await attachOurLines(req, [withUnread]));
    res.json({ thread: mapThread(named) });
  } catch (err) {
    logger.error('Failed to get thread:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Read-state routes (#2049): PATCH /threads/:id/read and /threads/:id/unread.
 * Read-side rights only (`read Communication` + the SAME anchor-filtered
 * lookup getThread uses, R8) - never `update`, mirroring the email
 * thread-read re-gate. 404 `{"error":"Thread not found"}` for wrong-org,
 * invisible or missing alike - one body, no enumeration oracle
 * (`requireUuidParam` screens a malformed `:id` the same way before this
 * handler is ever reached). Caller id is `req.user!.id`, full stop - never
 * `user_id` from the body, the query or the path (R8).
 */
async function resolveVisibleThread(req: Request): Promise<{ id: string } | null> {
  const scope = await textReadScopeForReq(req, { threadId: req.params.id as string });
  return prisma.messageThread.findFirst({
    where: { id: req.params.id as string, ...tenantWhere(req), ...scope.thread },
    select: { id: true },
  });
}

export async function markThreadRead(req: Request, res: Response) {
  try {
    const thread = await resolveVisibleThread(req);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }
    const now = new Date();
    await prisma.messageThreadReadState.upsert({
      where: { thread_id_user_id: { thread_id: thread.id, user_id: req.user!.id } },
      create: {
        thread_id: thread.id,
        user_id: req.user!.id,
        read_at: now,
        organization_id: req.user!.organization_id,
      },
      update: { read_at: now },
    });
    res.json({ updated: 1 });
  } catch (err) {
    logger.error('Failed to mark thread read:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function markThreadUnread(req: Request, res: Response) {
  try {
    const thread = await resolveVisibleThread(req);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }
    // A delete, never a `read_at: null`/flag flip - the "exactly one way for
    // the table to disagree with itself" rule the email model comment states
    // (its absence IS unread; there is no second representation of that).
    await prisma.messageThreadReadState.deleteMany({
      where: { thread_id: thread.id, user_id: req.user!.id, ...tenantWhere(req) },
    });
    res.json({ updated: 1 });
  } catch (err) {
    logger.error('Failed to mark thread unread:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Internal create path for an SMS thread (live CTM inbound is Plan C). Resolves
// the customer/lead/vendor from the inbound number (DEC6); never auto-creates a
// Lead (P1 org-validates an explicit lead_id, which overrides the resolver lead).
export async function createThread(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    let explicitLeadId: string | null = null;
    if (req.body.lead_id) {
      const lead = await prisma.lead.findFirst({
        where: await leadReachWhere(req, req.body.lead_id),
      });
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      explicitLeadId = lead.id;
    }

    // Re-audit P2-1: the number's customer only when the person can open it; otherwise the thread is filed on nobody.
    const match = await matchByPhoneInReach(req, req.body.from_number);

    const thread = await prisma.messageThread.create({
      data: {
        channel: req.body.channel ?? 'sms',
        campaign_type: req.body.campaign_type,
        customer_id: match?.customerId ?? null,
        lead_id: explicitLeadId ?? match?.leadId ?? null,
        vendor_id: match?.vendorId ?? null,
        title: req.body.title ?? null,
        subtitle: req.body.subtitle ?? null,
        organization_id: orgId,
      },
      include: { messages: { orderBy: { ts: 'asc' } } },
    });

    logger.info(
      `Thread created${match ? ` linked to ${match.kind} ${match.id}` : ' (unmatched)'}`,
    );
    res.status(201).json({ thread: mapThread(thread) });
  } catch (err) {
    logger.error('Failed to create thread:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * A lead the sender may see, for a send (slice E4) and for its line: under the sender's OWN Lead row-scope, matching
 * reassignMessageLead and the WhatsApp/email composers, so a text is never attributed to a lead they cannot see.
 */
async function findLeadInReach(req: Request, leadId: string) {
  return prisma.lead.findFirst({
    where: { id: leadId, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Lead')) },
    select: { id: true, customer_id: true },
  });
}

/** A job the sender may see (re-audit NV-v3b-1, GitHub #2906), under their OWN Job row-scope, as sendWhatsApp and sendEmail. */
async function findJobInReach(req: Request, jobId: string) {
  return prisma.job.findUnique({
    where: { id: jobId, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Job')) },
    select: { id: true, job_number: true, customer_id: true },
  });
}

/**
 * The ONE reach rule for continuing a conversation with this number (E.164) (#3023; Ran, 2026-11-06, after spec r3):
 * `textContinueScopeForReq`, decided per conversation - a customer the person can open carries the number, or they can read
 * any text in the conversation - never text by text, and never "filed on nobody" as a stand-in. It decides only which
 * conversation a text CONTINUES (#3013 decision 2) and whether a send by number starts a new one (the Access Communication
 * gate); once the number a text leaves from is known, the text joins that pair's one conversation whoever can read it
 * (#3019: never a second conversation for a pair). A reply in a conversation asks the same rule about that conversation.
 */
async function conversationsTheyMayContinue(req: Request, otherParty: string): Promise<PairReach> {
  const within = await textContinueScopeForReq(req, { otherPartyE164: otherParty });
  // {} for a person who reads every conversation (Communication "All"): nothing to narrow.
  return Object.keys(within).length > 0 ? { within: within as Prisma.MessageThreadWhereInput } : {};
}

/**
 * A send from a customer (with the customer's own lead or job): the number it goes to, and the latest conversation with
 * that number it continues (#3013 decision 2), whichever of our numbers it is on, among the ones the sender may continue.
 *   - #3016: the record decides the number - its changed number for the customer's primary - else the customer's phone.
 *   - The other party is decided by the one own-number rule (#3014): a customer whose phone is one of our own numbers has
 *     no pair (trap 8), so no conversation to continue.
 */
async function customerDoorTarget(req: Request, customerId: string, anchor: TextAnchor | null) {
  const orgId = req.user!.organization_id;
  let anchoredTo: string | null | undefined;
  if (anchor) {
    const recordNumber = await recordTextDestination(prisma, orgId, anchor);
    if (recordNumber.ok) anchoredTo = recordNumber.to;
  }
  const destination = anchoredTo !== undefined ? anchoredTo : await resolveSmsDestination(req, { customer_id: customerId });
  const otherParty = await otherPartyE164(prisma, orgId, destination);
  const reach = otherParty ? await conversationsTheyMayContinue(req, otherParty) : {};
  const latest = otherParty ? await latestPairConversationWith(prisma, orgId, otherParty, reach) : null;
  return { anchoredTo, destination, otherParty, latest };
}

/**
 * The latest conversation with a number a send by number may continue (#3023, #3013 decision 2), among the ones the sender
 * may continue (conversationsTheyMayContinue), and that reach, for whether the conversation the text joins when it continues
 * none is one they may continue (the Access Communication gate).
 * A vendor's number keeps the vendor's own conversation, as findOrCreateSmsThreadByNumber keys it.
 */
async function latestConversationByNumber(req: Request, toNumber: string, match: Awaited<ReturnType<typeof matchByPhoneInReach>>) {
  if (match && !match.customerId && match.vendorId) return { latest: null, reach: {} };
  const orgId = req.user!.organization_id;
  const otherParty = await otherPartyE164(prisma, orgId, toNumber);
  if (!otherParty) return { latest: null, reach: {} };
  const reach = await conversationsTheyMayContinue(req, otherParty);
  return { latest: await latestPairConversationWith(prisma, orgId, otherParty, reach), reach };
}

/** Whether the person may continue this conversation (`reach`: conversationsTheyMayContinue for its number). */
async function mayContinue(conversation: { id: string } | null, reach: PairReach): Promise<boolean> {
  if (!conversation) return false;
  if (!reach.within) return true;
  return (await prisma.messageThread.findFirst({ where: { id: conversation.id, AND: [reach.within] }, select: { id: true } })) != null;
}

/**
 * The conversation, when the person can read it (#3021's read rule), else null. Text on a customer opens the conversation
 * the customer's text box continues only when the person can read it; one they may continue but hold no readable text in
 * (or one from before pairs they cannot read) opens New message to the customer, whose send continues it, rather than a
 * conversation the inbox would refuse.
 */
async function readableConversation(req: Request, conversation: { id: string } | null) {
  if (!conversation) return null;
  return prisma.messageThread.findFirst({
    where: { id: conversation.id, ...tenantWhere(req), ...(await textReadScopeForReq(req, { threadId: conversation.id })).thread },
    select: { id: true },
  });
}

/** GET /api/communication/sms/numbers: what the line above a text box names (#3023), for the same target a send names. */
export const sendingNumbersQuerySchema = z.object({
  threadId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  toNumber: z.string().min(7).max(40).optional(),
  jobId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
}).refine((d) => d.threadId || d.customerId || d.toNumber);

/**
 * The line above a text box (#3023): the number a text sent with these fields would go to, and the number of ours it would
 * leave from (sendingNumber, the same answer the send uses), whether that number is the person's own, and the conversation's
 * number when it is no longer in use or cannot send texts. Read only: nothing is made. Refused as the send would refuse it, in the same words.
 * `conversationId`: the conversation the text box continues - the one named; else the latest with the number the person may
 * continue (#3013 decision 2; when its number can no longer send, a reply in it moves to the main line); else the one the
 * text would join (the pair's own, or one from before pairs) - or null when the text would start one. Text on a customer
 * opens it, so the inbox and the record's own text box continue the same conversation.
 */
export async function getSendingNumbers(req: Request, res: Response) {
  try {
    const parsed = sendingNumbersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'threadId, customerId or toNumber is required' });
      return;
    }
    const q = parsed.data;
    const orgId = req.user!.organization_id;
    const lead = q.leadId ? await findLeadInReach(req, q.leadId) : null;
    if (q.leadId && !lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    const job = q.jobId && !q.threadId ? await findJobInReach(req, q.jobId) : null;
    if (q.jobId && !q.threadId && !job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    let to: string | null;
    let continued: { other_party_e164?: string | null; our_number_e164?: string | null } | null;
    // The conversation the text box continues, once the number it leaves from is known.
    let continues: (from: string | null) => Promise<{ id: string } | null>;
    if (q.threadId) {
      // A reply in a conversation: its number, for a person who may continue it, or refused like the reply itself.
      const thread = await prisma.messageThread.findFirst({
        where: { id: q.threadId, ...tenantWhere(req), ...(await textContinueScopeForReq(req, { threadId: q.threadId })) },
      });
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }
      to = await resolveSmsDestination(req, thread);
      continued = thread;
      continues = async () => thread;
    } else if (!q.customerId) {
      // A number tapped or typed: the record's number for a number the record carries (#3016), else the number itself.
      if (!normalizeNAPhone(String(q.toNumber))) {
        res.status(400).json({ error: 'Enter a valid North American phone number' });
        return;
      }
      const anchor = job ? { kind: 'job' as const, id: job.id } : lead ? { kind: 'lead' as const, id: lead.id } : null;
      let anchoredTo: string | null | undefined;
      if (anchor) {
        const destination = await recordTextDestination(prisma, orgId, anchor, String(q.toNumber));
        if (!destination.ok) {
          res.status(404).json({ error: NUMBER_NOT_ON_RECORD[anchor.kind] });
          return;
        }
        anchoredTo = destination.to;
      }
      const toNumber = anchoredTo ?? String(q.toNumber);
      to = toNumber;
      const match = await matchByPhoneInReach(req, toNumber);
      const { latest } = await latestConversationByNumber(req, toNumber, match);
      continued = latest;
      continues = async (from) => latest ?? existingSmsThreadForNumber(prisma, orgId, toNumber, from, async () => match);
    } else {
      // A customer, with its own lead or job.
      const customer = await findCustomerToContact(req, q.customerId);
      if (!customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
      }
      if (job && job.customer_id !== customer.id) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      const anchor = job ? { kind: 'job' as const, id: job.id } : lead?.customer_id === customer.id ? { kind: 'lead' as const, id: lead.id } : null;
      const target = await customerDoorTarget(req, customer.id, anchor);
      to = target.destination;
      continued = target.latest;
      const identity = { customerId: customer.id, leadId: anchor?.kind === 'lead' ? anchor.id : null, title: null };
      continues = async (from) => target.latest ?? (target.otherParty
        ? existingPairConversation(prisma, orgId, { otherPartyE164: target.otherParty, ourNumberE164: from }, identity)
        : null);
    }
    const conversationNumber = continued ? keyedConversationNumber(continued) : null;
    const sending = await sendingNumber(prisma, orgId, req.user!.id, conversationNumber);
    res.json({
      to: to ? (normalizeNAPhone(to) ?? to) : null,
      from: sending.fromE164,
      fromIsYours: await isPersonsNumber(prisma, orgId, req.user!.id, sending.fromE164),
      noLongerInUse: sending.noLongerInUse,
      cannotSendTexts: sending.cannotSendTexts,
      conversationId: (await readableConversation(req, await continues(sending.fromE164)))?.id ?? null,
    });
  } catch (err) {
    logger.error('Failed to read the sending numbers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Whether a lead or a job carries the number of the conversation a reply is sent in (#3023; Ran, 2026-11-06: a text from a
 * lead or a job keeps it, so #3020 ties the answer to it): the record's own number, or one of its customer's as the record
 * shows it (#3016's rule, `recordTextDestination`). So a reply sent from Pat's lead in a shared conversation filed on Jordan
 * keeps Pat's lead; a record that does not carry the number is still not stamped (or, for a job, answers "Job not found").
 */
async function recordCarriesConversationNumber(orgId: string, anchor: TextAnchor, thread: { other_party_e164?: string | null }) {
  const number = thread.other_party_e164;
  if (!number) return false;
  const destination = await recordTextDestination(prisma, orgId, anchor, number);
  return destination.ok && destination.to === number;
}

/** Our number in a conversation keyed by its pair of numbers (#3019), or null for any other conversation. */
function keyedConversationNumber(thread: { other_party_e164?: string | null; our_number_e164?: string | null }): string | null {
  return thread.other_party_e164 && thread.our_number_e164 ? thread.our_number_e164 : null;
}

// Append a Message to a thread (the "send SMS" action). The seam posts to
// /api/communication/sms with the new message; the thread is resolved from
// `threadId` and scoped to the requesting org.
export async function sendMessage(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    // Lead attribution (slice E4): resolve an explicit leadId up front (tenant-
    // scoped) so a cross-org/unknown lead 404s BEFORE any thread/message write.
    // Omitted leadId skips this entirely — behavior is unchanged.
    let lead: { id: string; customer_id: string } | null = null;
    if (req.body.leadId) {
      // Under the caller's OWN Lead row-scope, matching reassignMessageLead and
      // the WhatsApp/email composers: a sender must not be able to attribute a
      // message to a lead they cannot see. Unconditional-read roles get {} here,
      // so dispatcher/admin are unaffected.
      lead = await findLeadInReach(req, req.body.leadId);
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
    }

    // Re-audit NV-v3b-1 (GitHub #2906): the job is resolved up front too, under the caller's OWN Job row-scope (the same rule
    // sendWhatsApp and sendEmail apply), so a made-up, hidden or another company's job is refused BEFORE any conversation
    // exists. Refusing it after a number's thread was made left an empty conversation behind, and the next plain send to that
    // number then counted as a reply to an existing conversation and skipped the Access Communication gate below. A send into
    // an existing conversation (threadId) makes no thread, and keeps its order: the internal-lane refusal comes first, below.
    let job: Awaited<ReturnType<typeof findJobInReach>> = null;
    if (req.body.jobId && !req.body.threadId) {
      job = await findJobInReach(req, req.body.jobId);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
    }

    // Compose-to-number (slice H7): resolved AFTER threadId and customerId —
    // an explicit thread/customer always wins over the raw number.
    // s1d: whether THIS call created a brand-new thread — a 409 further down
    // must delete it (empty thread = phantom conversation on the next poll),
    // but must never touch a thread this send merely appended to.
    let threadCreated = false;

    // #3016 (closes #2952's anchored path): a new text sent from a lead or a job goes where the record says, never to a
    // number the browser chose (lib/communication/recordTextDestination.ts). Undefined while the send is not anchored;
    // a send into an existing conversation (threadId) keeps that conversation's own number.
    let anchoredTo: string | null | undefined;
    // #3016: the number named with this lead or job was checked to be the record's or its customer's, so the text stays tied
    // to that record whichever conversation the number keys to (one with nobody, or another customer carrying it too).
    let numberCheckedOn: TextAnchor['kind'] | null = null;

    let thread: { id: string } | null = null;
    // #3023: the number the text leaves from when its conversation's number is no longer in use (the main line). Otherwise
    // the number of the conversation the text is in decides it (below).
    let leaveFrom: string | null = null;
    // The customer the sender is texting (#3019): the one they picked, else the one the number named in their reach, else the
    // conversation's own. A conversation keyed by a shared number is filed on ONE default customer, which need not be the
    // one the sender is working on; the same-customer rules for a lead or job follow the sender's.
    let anchorCustomerId: string | null = null;
    // The customer whose history the "SMS sent to customer" line goes on: the one the sender picked, or, in a conversation from
    // before pairs, the one the number they typed names in their reach; otherwise (undefined) the conversation's own customer as it is now
    // (conversationCustomerFor), never the one it happens to be stored on (whole-diff ruling, Ran 2026-11-07).
    let historyCustomerId: string | undefined;
    if (req.body.threadId) {
      // Scoped like the read paths: a caller who cannot see a conversation must
      // not be able to append to it either. The resolve-or-create branches below
      // are not scoped by the thread's read rule - they key a thread by customer
      // or by raw destination number, which is a compose action. The number's
      // customer is still resolved within the sender's customer reach
      // (re-audit NV-vp3-1), and the customer path asks findCustomerToContact.
      thread = await prisma.messageThread.findFirst({
        where: {
          id: req.body.threadId,
          ...tenantWhere(req),
          // #3023 (Ran, 2026-11-06): whoever may continue the conversation (textContinueScopeForReq, per conversation).
          ...(await textContinueScopeForReq(req, { threadId: req.body.threadId })),
        },
      });
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
      }
      // #3023 (#3013 decision 3): a reply in a conversation whose number is no longer in use, or still in use but unable to
      // send texts (Ran, 2026-11-06), leaves from the main line, and is filed in the main-line conversation with the same
      // number - that pair's one conversation, whoever can read it (#3019), else a new one - which the answer names so the
      // screen opens it. The old conversation stays as history (Q38).
      const keyed = thread as { other_party_e164?: string | null; our_number_e164?: string | null; customer_id?: string | null; title?: string | null };
      const ours = keyedConversationNumber(keyed);
      if (ours) {
        const sending = await sendingNumber(prisma, orgId, req.user!.id, ours);
        if (movedFrom(sending)) {
          // The person is still texting the customer of the conversation they replied in, whichever customer's main-line
          // conversation the reply is filed in (the same-customer rules for a lead or job).
          anchorCustomerId = keyed.customer_id ?? null;
          const mainLine = await findOrCreatePairConversation(
            prisma,
            orgId,
            { otherPartyE164: keyed.other_party_e164!, ourNumberE164: sending.fromE164 },
            { customerId: keyed.customer_id ?? null, leadId: null, title: keyed.title ?? null },
          );
          thread = mainLine.thread;
          threadCreated = mainLine.created;
          leaveFrom = sending.fromE164;
        }
      }
    } else if (!req.body.customerId) {
      // toNumber path: key the thread with the same helper the CTM webhook
      // ingest uses (lib/ctm/smsThread.ts) so a composed text and an inbound
      // text from the same number share ONE conversation. Only the thread row is
      // created here — every CTM compliance gate still runs BEFORE any
      // Message row exists, further down the shared pipeline.
      //
      // With one exception, and it is this path that declines it: a number
      // owned by ACTIVE STAFF. Ingest opts into `matchStaff` and keys those
      // onto the person's team thread; composing must not, because a team
      // thread has no destination resolveSmsDestination can resolve, so
      // texting a technician's mobile would stop working.
      if (!normalizeNAPhone(String(req.body.toNumber))) {
        res.status(400).json({ error: 'Enter a valid North American phone number' });
        return;
      }
      // #3016: a number tapped on a lead or a job must be one that record or its customer carries; the record decides what
      // it stands for (its changed number for a customer phone it changed). Any other number is refused before anything is
      // made, in words that say nothing about who else might carry it.
      const anchor = job ? { kind: 'job' as const, id: job.id } : lead ? { kind: 'lead' as const, id: lead.id } : null;
      if (anchor) {
        const destination = await recordTextDestination(prisma, orgId, anchor, String(req.body.toNumber));
        if (!destination.ok) {
          res.status(404).json({ error: NUMBER_NOT_ON_RECORD[anchor.kind] });
          return;
        }
        anchoredTo = destination.to;
        numberCheckedOn = anchor.kind;
      }
      const toNumber = anchoredTo ?? String(req.body.toNumber);
      // #2046 security round 1: this door can ORIGINATE a brand-new, org-wide
      // thread with no lead/job anchor — the same org-wide inbox surface
      // GET/POST /threads gate on `access_inbox`. Gate it the same way, but
      // ONLY when it would actually originate one: an unanchored compose
      // (no leadId/jobId) whose number has no thread yet. Checked BEFORE any
      // write — no create-then-rollback. A reply into a thread that already
      // exists for this number, or a lead/job-anchored compose, is a caller
      // acting on something already in their view and stays ungated.
      // Re-audit NV-vp3-1: the number's customer only within the sender's customer reach, resolved once for the gate, the
      // job check and the keying below.
      const match = await matchByPhoneInReach(req, toNumber);
      const identify = async () => match;
      // #3019: the conversation is the number plus ours - the number this text will leave from. #3023 (decision 2): the latest
      // conversation with the number this door may continue decides it, while a text can leave from its number; else the
      // sender's own number, else the main line (and the main line, filed in its conversation, once that number is gone or
      // cannot send texts: decision 3).
      const { latest, reach } = await latestConversationByNumber(req, toNumber, match);
      const latestNumber = latest ? keyedConversationNumber(latest) : null;
      const sending = await sendingNumber(prisma, orgId, req.user!.id, latestNumber);
      const continues = latest && latestNumber && !movedFrom(sending) ? latest : null;
      const ourNumber = sending.fromE164;
      if (movedFrom(sending)) leaveFrom = sending.fromE164;
      // No same-customer check for a job here (NV-v3b-1 is the customer and existing-conversation doors'): a job on this
      // door is the anchor, so its number was checked above, and a number the job carries is texted from the job even when
      // the number's customer is another one who carries it too (#3016).
      if (!req.body.leadId && !req.body.jobId) {
        // Re-audit NV-vp3-1, #3023: a conversation the text joins counts only when the sender may continue it
        // (conversationsTheyMayContinue), so whether someone else has a conversation they cannot read never changes this answer.
        const exists = continues != null || (await mayContinue(await existingSmsThreadForNumber(prisma, orgId, toNumber, ourNumber, identify), reach));
        if (!exists && !req.ability?.can('access_inbox', 'Communication')) {
          res.status(403).json({
            error: 'Starting a new conversation from the inbox requires access to the Communication section.',
          });
          return;
        }
      }
      // Re-audit NV-vp3-1: the number's customer only when the sender can open it. Otherwise a conversation this text makes is
      // filed on nobody and never names the customer. Once the number it leaves from is known, it joins that pair's one
      // conversation whoever can read it (#3019, Ran 2026-11-06: never a second conversation for a pair).
      if (continues) {
        thread = continues;
        anchorCustomerId = match?.customerId ?? continues.customer_id;
      } else {
        const resolution = await findOrCreateSmsThreadByNumber(prisma, orgId, toNumber, ourNumber, identify);
        thread = resolution.thread;
        anchorCustomerId = match?.customerId ?? resolution.thread.customer_id;
        threadCreated = resolution.created;
      }
      // A conversation keyed by its pair is logged on its one customer as it is now (conversationCustomerFor), never on the
      // customer the number's match picked (it can match a phone stored in a spelling the carriers do not count). One from
      // before pairs keeps the number's customer in the sender's reach.
      if ((thread as { other_party_e164?: string | null }).other_party_e164 == null) historyCustomerId = match?.customerId ?? undefined;
    } else {
      const customer = await findCustomerToContact(req, req.body.customerId);
      if (!customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
      }
      // NV-v3b-1: another customer's job answers like a missing one, before the customer's conversation is made.
      if (job && job.customer_id !== customer.id) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      anchorCustomerId = customer.id;
      historyCustomerId = customer.id;
      // #3019: the text continues the latest conversation with the customer's number, whichever of our numbers it is on
      // (#3013 decision 2). With none, the conversation is the number plus the sender's own number, else the main line.
      // A conversation from before pairs (not keyed yet by the split script) takes it only when it holds this pair's texts
      // (findOrCreatePairConversation). The other party is decided by the one own-number rule (#3014): a customer whose
      // phone is one of our own numbers has no pair (trap 8).
      // #3016: the customer's own lead or job decides the number (another customer's lead is not stamped, see below).
      const anchor = job ? { kind: 'job' as const, id: job.id } : lead?.customer_id === customer.id ? { kind: 'lead' as const, id: lead.id } : null;
      // The pair is keyed by the number this text goes to: the record's number for a lead's or job's send (#3016), else
      // the customer's. The conversation's other party is then the number texted, and a reply in it texts that number.
      const target = await customerDoorTarget(req, customer.id, anchor);
      anchoredTo = target.anchoredTo;
      const { otherParty, latest } = target;
      // #3023: the latest conversation's number, while a text can leave from it; once it is gone or cannot send texts, the
      // main line and its conversation (decision 3). With no conversation, the sender's own number, else the main line.
      const latestNumber = latest ? keyedConversationNumber(latest) : null;
      const sending = await sendingNumber(prisma, orgId, req.user!.id, latestNumber);
      if (movedFrom(sending)) leaveFrom = sending.fromE164;
      if (latest && latestNumber && !movedFrom(sending)) {
        thread = latest;
      } else if (otherParty) {
        const resolution = await findOrCreatePairConversation(
          prisma,
          orgId,
          { otherPartyE164: otherParty, ourNumberE164: sending.fromE164 },
          {
            customerId: customer.id,
            // Lead attribution (slice E4): a conversation born from a Lead-page send carries the lead link from creation,
            // but ONLY when the lead belongs to THIS customer.
            leadId: lead != null && lead.customer_id === customer.id ? lead.id : null,
            title: null,
          },
        );
        thread = resolution.thread;
        threadCreated = resolution.created;
      } else {
        // A customer with no number to text, or whose number is one of our own, keeps the conversation it always had, never
        // one keyed by a pair, which would text that pair's number.
        thread = await prisma.messageThread.findFirst({
          where: { customer_id: customer.id, channel: 'sms', other_party_e164: null, ...tenantWhere(req) },
        });
        if (!thread) {
          thread = await prisma.messageThread.create({
            data: {
              channel: 'sms',
              campaign_type: 'customer_care',
              customer_id: customer.id,
              ...(lead != null && lead.customer_id === customer.id && { lead_id: lead.id }),
              organization_id: orgId,
            },
          });
          threadCreated = true;
        }
      }
    }

    // Communication ↔ Jobs (spec §7): stamp job attribution at origin. An
    // explicit jobId (composed from a job page) always wins; otherwise inbound
    // replies on customer/vendor threads get a best-effort recency-gated
    // auto-route ("act + cheap undo" — one-click reassign fixes a wrong
    // guess). Internal lanes (kind team/group) NEVER carry a job_id.
    const threadRow = thread as {
      id: string; customer_id?: string | null; vendor_id?: string | null; user_id?: string | null; kind?: string | null; title?: string | null;
      other_party_e164?: string | null; our_number_e164?: string | null;
    };
    anchorCustomerId ??= threadRow.customer_id ?? null;
    // #3023: a reply sent from a lead in a conversation whose number the lead carries keeps the lead, whichever customer the
    // conversation is filed on (a shared number's conversation is filed on one of them).
    if (req.body.threadId && lead && (await recordCarriesConversationNumber(orgId, { kind: 'lead', id: lead.id }, threadRow))) {
      numberCheckedOn = 'lead';
    }
    // #3019: a text in a conversation keyed by its pair leaves from that conversation's number, whoever sends it.
    // #3023: once that number is no longer in use, the main line (leaveFrom).
    const conversationNumber = leaveFrom ?? keyedConversationNumber(threadRow);
    const fromConversation = conversationNumber ? { conversationNumberE164: conversationNumber } : {};

    // Lead attribution (message-level): the SAME same-customer gate as the
    // thread backfill above — a customer-owned thread only stamps that
    // customer's OWN lead onto the message; a mismatched leadId/customerId
    // pair (or a customer-less/vendor thread, which never carries a lead)
    // is silently dropped rather than leaking an unrelated lead's id. A text
    // sent to a number checked against the lead (#3016, above) keeps the lead.
    const leadId = lead != null && (numberCheckedOn === 'lead' || anchorCustomerId === lead.customer_id) ? lead.id : null;

    // NV-v3b-1: a refusal from here on that follows a thread THIS call made takes the thread back with it, guarded on it
    // still being empty (see the s1d note at the delivery precheck below), so a refused send never leaves a conversation.
    const refuseAfterThread = async (status: number, body: object) => {
      if (threadCreated) {
        await prisma.messageThread.deleteMany({ where: { id: thread!.id, ...tenantWhere(req), messages: { none: {} } } });
      }
      res.status(status).json(body);
    };

    let jobStamp: { job_id: string; job_label: string | null } | null = null;
    let replyTie: ReplyTie = UNTIED;
    if (req.body.jobId) {
      // Internal lanes are never job-attached — reject loudly rather than
      // silently dropping the attribution.
      if (!isJobAttributableThread(threadRow)) {
        await refuseAfterThread(400, { error: 'Internal threads cannot be job-tagged' });
        return;
      }
      // The existing-conversation path resolves its job here, after the internal-lane rule, as it always has.
      job ??= await findJobInReach(req, req.body.jobId);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      // #3023: the same for a reply sent from a job.
      if (req.body.threadId && (await recordCarriesConversationNumber(orgId, { kind: 'job', id: job.id }, threadRow))) {
        numberCheckedOn = 'job';
      }
      // The job is resolved under the caller's own Job row-scope (up front for a new conversation, NV-v3b-1). Stamping a send with a job
      // the sender cannot see writes the message straight out of their own view (job > lead > customer precedence) and INTO
      // that job's crew timeline.
      // Same-customer constraint: a customer-owned thread only accepts that
      // customer's jobs. Another customer's job is indistinguishable from a
      // nonexistent one → 404 'Job not found' (same as cross-org; no existence
      // oracle). Customer-less threads (vendor/lead) keep org-scope-only
      // validation. The customer path already checked this before making a
      // thread; this is the existing-thread path's check. A number checked
      // against the job (#3016, the number path) keeps the job whichever
      // customer's conversation the number keys to.
      if (numberCheckedOn !== 'job' && anchorCustomerId && job.customer_id !== anchorCustomerId) {
        await refuseAfterThread(404, { error: 'Job not found' });
        return;
      }
      jobStamp = { job_id: job.id, job_label: job.job_number };
    } else if (
      (req.body.direction ?? 'out') === 'in' &&
      (threadRow.customer_id || threadRow.vendor_id) &&
      isJobAttributableThread(threadRow)
    ) {
      // A text recorded as received is tied by the same rule as one the phone system delivers (#3020,
      // lib/sms-reply-router.ts): the lead or job of the latest text we sent in the conversation. A lead named on the
      // request keeps its own stamp above. No number is passed, so the rule's own-number step (a company-wide lookup) never
      // runs for a signed-in person (re-audit P2-1): without a recent text, the text stays untied.
      replyTie = await tieIncomingText(prisma, orgId, { threadId: thread.id, at: new Date(), from: null });
      if (replyTie.jobId) jobStamp = { job_id: replyTie.jobId, job_label: replyTie.jobLabel };
    }

    // Lead attribution (slice E4): stamp the resolved thread's lead link.
    // After every job refusal above (NV-v3b-1), so a refused send writes nothing on an existing thread either.
    // Backfill ONLY a lead-less thread belonging to the lead's OWN customer —
    // NEVER overwrite an existing (different) lead link. A thread just created
    // above already carries lead_id, so this no-ops on that path.
    if (lead) {
      const t = thread as { id: string; customer_id?: string | null; lead_id?: string | null };
      if (t.lead_id == null && t.customer_id === lead.customer_id) {
        await prisma.messageThread.update({
          where: { id: thread.id },
          data: { lead_id: lead.id },
        });
      }
    }

    // CTM outbound delivery (slice 6). Connected orgs run the compliance
    // precheck BEFORE the row exists so a blocked user send 409s with no side
    // effects; not-connected orgs keep exactly today's behavior: the row is
    // created and nothing is delivered, because the record is the product.
    // A staff (team) thread naming a person delivers too, to their
    // `users.phone` - see isDeliverableThread.
    // A group thread, a team thread with no user_id, and simulated-inbound
    // writes never attempt delivery.
    const isOutboundSend = (req.body.direction ?? 'out') === 'out';
    let deliverTo: string | null = null;
    // The number the text goes to, read once when first needed: the delivery below and the stored row (#3014) use the same.
    // A send anchored on a lead or a job goes where the record says (#3016, resolved above).
    let destination: Promise<string | null> | undefined;
    const sendingTo = () =>
      (destination ??= anchoredTo !== undefined ? Promise.resolve(anchoredTo) : resolveSmsDestination(req, threadRow));
    let shouldDeliver = false;
    // Why an outbound row will not be delivered, when it will not be. Drives the
    // row's `skipped` reason below so a suppressed send never reads as sent.
    // Null on a thread with no counterparty to address (a group thread, or a
    // team thread carrying no user_id) or a simulated inbound write, where
    // "not delivered" is the point rather than a suppression.
    let blockedReason: CtmSmsFailureReason | null = null;
    if (isOutboundSend && isDeliverableThread(threadRow)) blockedReason = 'NOT_CONNECTED';
    if (isCtmConfigured() && isOutboundSend && isDeliverableThread(threadRow)) {
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ctm_account_id: true },
      });
      if (org?.ctm_account_id) {
        deliverTo = await sendingTo();
        const pre = await precheckCtmSms(prisma, {
          orgId,
          toE164: deliverTo,
          threadId: thread.id,
          body: req.body.body,
          userId: req.user!.id,
          ...fromConversation,
        });
        if (!pre.ok && SMS_GATE_409[pre.reason]) {
          // s1d: the message never gets written on this path — a thread
          // freshly created THIS call would otherwise persist empty and
          // surface as a phantom conversation on the next poll. Guard with
          // messages: { none: {} } — threadCreated only proves THIS request
          // created the row, not that it's still empty right now: the same
          // thread-keying (findOrCreateSmsThreadByNumber) is also used by the
          // CTM webhook ingest path, so a real inbound message can land here
          // during the DB round-trips (and, for some gate reasons, a real
          // CTM HTTP call) precheckCtmSms makes above. Message.thread is
          // onDelete: Cascade, so an unguarded delete would take a
          // legitimate concurrently-arrived message with it.
          if (threadCreated) {
            await prisma.messageThread.deleteMany({
              where: { id: thread.id, ...tenantWhere(req), messages: { none: {} } },
            });
          }
          res.status(409).json({ error: SMS_GATE_409[pre.reason], code: pre.reason });
          return;
        }
        shouldDeliver = pre.ok;
        blockedReason = pre.ok ? null : pre.reason;
      }
    }

    const message = await prisma.message.create({
      data: {
        thread_id: thread.id,
        direction: req.body.direction ?? 'out',
        body: req.body.body,
        ts: new Date(),
        // An outbound row starts `queued` - nothing has attempted delivery yet.
        // sendCtmSms settles it (sent / skipped+reason / failed+reason); the
        // no-delivery paths are settled explicitly below. Writing `sent` here
        // was the false-success bug: a row read as sent whether or not anything
        // ever left. Simulated-inbound writes keep their existing default.
        status: req.body.status ?? (isOutboundSend ? 'queued' : 'sent'),
        automated: req.body.automated ?? false,
        ...(jobStamp != null && { job_id: jobStamp.job_id, job_label: jobStamp.job_label }),
        // Full job-parity ruling (2026-07-22): stamp the Message row itself
        // with lead_id, mirroring job_id above — the thread-level lead_id
        // set/backfilled up top is not enough now that lead scoping reads
        // per-message. leadId is already gated above (same customer, or #3016's checked number).
        ...((leadId ?? replyTie.leadId) != null && { lead_id: leadId ?? replyTie.leadId }),
        // The person who sent it from the app (S08.1). A simulated inbound write has no sender.
        ...(isOutboundSend && { sent_by_user_id: req.user!.id }),
        // #3014: the other party's number - the destination the text is sent to (the one the delivery above uses), stored
        // even when nothing is delivered; none on a thread with no single counterparty (a group thread), and never one of our
        // own numbers.
        other_party_e164: await otherPartyE164(prisma, orgId, isDeliverableThread(threadRow) ? await sendingTo() : null),
        organization_id: orgId,
      },
    });

    // F3: surface an outbound SMS on the customer's central timeline: the customer the sender picked or typed the number
    // of, else the conversation's one customer as it is now (historyCustomerId, above).
    const linkedCustomerId = isOutboundSend ? historyCustomerId ?? (await conversationCustomerFor(req, threadRow)) : null;
    if (linkedCustomerId) {
      await prisma.timelineEvent.create({
        data: {
          organization_id: orgId,
          entity_type: 'CUSTOMER', entity_id: linkedCustomerId,
          event_type: 'SMS_SENT',
          description: 'SMS sent to customer',
          metadata: { thread_id: thread.id, message_id: message.id },
          created_by: req.user!.id,
        },
      });
    }

    // Deliver through CTM (the row already exists — sendCtmSms never throws).
    // A post-creation failure keeps the 201 (the record stands) and reports
    // { delivery: 'failed' }; sendCtmSms settles the row on every outcome.
    let delivery: 'sent' | 'failed' | 'skipped' | undefined;
    if (shouldDeliver && deliverTo) {
      const result = await sendCtmSms(prisma, {
        orgId,
        toE164: deliverTo,
        body: req.body.body,
        threadId: thread.id,
        messageId: message.id,
        userId: req.user!.id,
        ...fromConversation,
      });
      if (result.delivered) {
        delivery = 'sent';
        message.status = 'sent';
      } else {
        delivery = result.reason === 'CTM_ERROR' ? 'failed' : 'skipped';
        message.status = result.reason === 'CTM_ERROR' ? 'failed' : 'skipped';
        message.status_reason = result.reason;
      }
    } else if (blockedReason) {
      // Never reached sendCtmSms (platform unconfigured, org not connected, or a
      // non-409 gate reason). The row would otherwise sit at `queued` forever,
      // reading as a send still in flight.
      await markMessageNotDelivered(prisma, message.id, 'skipped', blockedReason);
      message.status = 'skipped';
      message.status_reason = blockedReason;
      delivery = 'skipped';
    }

    // Spec #1751 D5: an outbound text a person wrote is one of the three things that mark a lead
    // contacted. Read off the ROW rather than off `req.body`, so the filter tests exactly what was
    // persisted — `automated` and `direction` both have defaults applied at the create above, and a
    // second derivation from the request is a second place for the two to disagree.
    //
    // The automation SMS writer (services/automations/smsRecord.ts) writes `automated: true` and
    // does not stamp a lead at all, so an appointment confirmation cannot reach this. An inbound
    // simulated write (`direction: 'in'`) cannot either: the customer texting us is not us
    // reaching out (user story 15).
    //
    // AFTER the delivery block, never before it, and gated on the SETTLED status. THE STAMP HAS TO
    // FOLLOW THE OUTCOME, NOT THE INTENT — the same rule lead.controller.ts states about
    // `customer_email_sent_at`, and the rule the email arm of this feature already keeps (its row
    // is created only once the provider has accepted). Stamping at row-creation time marked the
    // lead contacted on every org where delivery is not configured, where the row settles
    // `skipped` and nothing ever left the building; first-touch-wins then makes that permanent, so
    // the real outreach that follows can never correct it.
    //
    // `sent` and `delivered` are the two statuses that mean it went out: sendCtmSms settles an
    // accepted send to `sent`, and the carrier's own confirmation later promotes that row to
    // `delivered` (lib/ctm/ingest.ts). Everything else here is `queued` (nothing attempted),
    // `skipped` (a gate refused it) or `failed`.
    //
    // Awaited, and never able to throw — see lead-contact.service.ts. The text has already gone
    // out by this point; a bookkeeping failure must not turn that into a 500.
    if (TEXT_WENT_OUT.includes(message.status ?? '')) {
      // `{ client }`: the clock stamp and the New -> Contacted move (#2618) run in one transaction
      // of their own. The sender is the authenticated caller.
      await recordLeadOutboundContact({ client: prisma }, {
        leadId: message.lead_id,
        orgId: message.organization_id,
        channel: 'text',
        direction: message.direction,
        automated: message.automated,
        at: message.ts,
        actorId: req.user!.id,
      });
    }

    // The resolved thread id lets the composer open/append the right conversation (compose-to-number, slice H7).
    // #3023: every send names the conversation the text was filed in (a reply from a number no longer in use is filed in the
    // main-line conversation, which the screen then opens) and the number it went to (the record's number on a lead or a
    // job, #3016), so the screen names the number actually texted.
    res.status(201).json({
      message: mapMessage(message),
      threadId: thread.id,
      ...(isDeliverableThread(threadRow) ? { to: await sendingTo() } : {}),
      ...(delivery ? { delivery } : {}),
    });
  } catch (err) {
    logger.error('Failed to send message:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** #3024: which customers' leads and jobs a text in this conversation may be tied to by the person (lib/communication/attachTargets.ts). */
function textTieRuleForReq(req: Request, thread: { other_party_e164: string | null; customer_id: string | null }) {
  return textTieRule(prisma, req.user!.organization_id, thread);
}

/**
 * #3024: what "Attach to a lead or job" offers for this text: the leads and jobs the person can open of every customer carrying
 * its conversation's number, grouped by customer (`rule: 'carriers'`), or `rule: 'any'` when no customer carries it (the
 * screen then searches every lead and job, as before). A text the person cannot read, or one in an internal lane, is 404.
 */
export async function messageAttachTargets(req: Request, res: Response) {
  try {
    const visibility = (await textReadScopeForReq(req, { messageId: req.params.id as string })).messages;
    const msgThread = await prisma.messageThread.findFirst({
      where: { messages: { some: { id: req.params.id as string, ...visibility } }, ...tenantWhere(req) },
      select: { kind: true, customer_id: true, other_party_e164: true },
    });
    if (!msgThread || !isJobAttributableThread(msgThread)) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    const rule = await textTieRuleForReq(req, msgThread);
    res.json(await attachTargets(prisma, req.user!.organization_id, rule, {
      job: await scopeWhereForReq(req, 'Job'), lead: await scopeWhereForReq(req, 'Lead'),
    }));
  } catch (err) {
    logger.error('Failed to read attach targets for a text:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** The stored text before a re-tie, under the same filter as the write: D7 needs its lead, direction, provenance and status. */
function readTextBeforeRetie(req: Request, visibility: Prisma.MessageWhereInput) {
  return prisma.message.findMany({
    where: { id: req.params.id as string, ...tenantWhere(req), thread: JOB_ATTRIBUTABLE_THREAD_WHERE, ...visibility },
    select: { lead_id: true, direction: true, automated: true, status: true, ts: true, sent_by_user_id: true, organization_id: true },
    take: 1,
  }).then(([row]) => row);
}

/** D7 after a re-tie: the lead the text left, if it held one (after the write, plain client, never throws). */
async function reconsiderLeadTextLeft(
  req: Request,
  before: { lead_id: string | null; direction: string; automated: boolean | null; status: string | null; organization_id: string },
  leadIdAfter: string | null,
) {
  const row = { direction: before.direction, automated: before.automated, deliveryStatus: before.status };
  await reconsiderLeadLeftBehind({ client: prisma }, {
    source: 'text',
    before: { leadId: before.lead_id, ...row },
    after: { leadId: leadIdAfter, ...row },
  }, { orgId: before.organization_id, actorId: req.user!.id, entryId: req.params.id as string });
}

// One-click reassign (spec §7 "act + cheap undo"): a wrong auto-route guess
// costs one PATCH. job_id: null clears attribution (→ Unrouted tray).
//
// #3024 (Ran, 2026-11-06): one pick, one record, as a call's job does (reassignCallJob). Attaching a text to a job sets its
// lead to the job's own lead (Job.estimate -> Estimate.lead_id; a job made from scratch has none), so a text is never left
// on another customer's lead; the lead it leaves is reconsidered (SPEC-4 D7). Filing a text on a job is not an attach to that
// lead (SPEC-4 §5): nothing is recorded as contact. job_id: null clears both ends.
export async function reassignMessageJob(req: Request, res: Response) {
  try {
    // One filter for the update AND the refetch (the refetch used to be weaker;
    // see reassignCallJob for why that stops being benign once the guard is a
    // visibility predicate).
    const visibility = (await textReadScopeForReq(req, { messageId: req.params.id as string })).messages;
    let data: { job_id: string | null; job_label: string | null; lead_id: string | null };
    if (req.body.job_id != null) {
      // Resolve the message's thread (org-scoped, by membership) to enforce
      // the attribution rules: internal lanes (kind team/group) are invisible
      // to this endpoint → 404, and the job must be one the conversation's
      // number allows (#3024, textTieRule).
      const msgThread = await prisma.messageThread.findFirst({
        where: {
          messages: { some: { id: req.params.id as string, ...visibility } },
          ...tenantWhere(req),
        },
        select: { kind: true, customer_id: true, other_party_e164: true },
      });
      if (!msgThread || !isJobAttributableThread(msgThread)) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      // Under the caller's own Job scope: they must not attribute a message to a
      // job they cannot see. This is also what keeps the refetch below non-empty
      // (the row stays inside their scope after the write).
      const job = await prisma.job.findUnique({
        where: { id: req.body.job_id, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Job')) },
        select: { id: true, job_number: true, customer_id: true, estimate: { select: { lead_id: true } } },
      });
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      // #3024: a job of a customer carrying the conversation's number that the person can open (a conversation from before
      // pairs: of the customer it is filed on; a number nobody carries: any job). Any other is indistinguishable from a
      // nonexistent one → 404 'Job not found'.
      if (!tieAllowed(await textTieRuleForReq(req, msgThread), job.customer_id)) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      data = { job_id: job.id, job_label: job.job_number, lead_id: job.estimate?.lead_id ?? null };
    } else {
      data = { job_id: null, job_label: null, lead_id: null };
    }
    // A row the person cannot reach reads nothing here; the update below answers the 404.
    const before = await readTextBeforeRetie(req, visibility);

    // updateMany with id+org filter is atomic — no TOCTOU window. The
    // internal-lane guard rides along so team/group messages 404 on BOTH the
    // assign and clear paths, even if the pre-check above raced.
    const result = await prisma.message.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req), thread: JOB_ATTRIBUTABLE_THREAD_WHERE, ...visibility },
      data,
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (before) await reconsiderLeadTextLeft(req, before, data.lead_id);

    const [message] = await prisma.message.findMany({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      include: { lead: { select: { lead_number: true } } },
      take: 1,
    });
    // A detach can take the message out of the person's reach (it was readable only through the record it was taken
    // off). The change is done; answer with a success that says the row left, not a 404 or a crash.
    if (!message) {
      res.json({ message: null, left: true });
      return;
    }

    res.json({ message: mapMessage(message) });
  } catch (err) {
    logger.error('Failed to reassign message job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Manual attach of a message to a lead — the lead mirror of reassignMessageJob
// (full job-parity ruling, 2026-07-22). lead_id is otherwise only ever stamped
// at send time (sendMessage's explicit leadId), so without this a message
// that missed its lead attribution could never be corrected. lead_id: null
// clears.
//
// Attaching an outbound text that went out to a lead is reaching out to that
// lead (SPEC-4 D1): it is recorded through the shared link rule
// (recordLeadContactOnLink), dated at the text's own time and credited to its
// sender. Taking a text that held a lead off it (a detach, or a move to another
// lead) reconsiders the lead it left (SPEC-4 D7): a Contacted lead with no
// outbound contact left goes back to New, credited to the person who moved it.
//
// #3024: one pick, one record. Attaching a text to a lead takes it off the job it was on, in the same write, so the text ends
// on the record picked; lead_id: null clears both ends, as the job door does.
export const reassignMessageLeadSchema = z.object({
  lead_id: z.string().uuid('lead_id must be a valid id').nullable(),
});

export async function reassignMessageLead(req: Request, res: Response) {
  try {
    // See reassignMessageJob: one filter, applied to the pre-read, the update and
    // the refetch alike.
    const visibility = (await textReadScopeForReq(req, { messageId: req.params.id as string })).messages;
    let data: { lead_id: string | null; job_id: null; job_label: null };
    // The stored row before this write, read on an attach and a detach alike, under the same filter
    // as the update below, so the row read is the row written: the link rule (and D7) need its lead,
    // direction, provenance, status, time and sender.
    let before: Awaited<ReturnType<typeof readTextBeforeRetie>>;
    const readBefore = () => readTextBeforeRetie(req, visibility);
    if (req.body.lead_id != null) {
      const msgThread = await prisma.messageThread.findFirst({
        where: {
          messages: { some: { id: req.params.id as string, ...visibility } },
          ...tenantWhere(req),
        },
        select: { kind: true, customer_id: true, other_party_e164: true },
      });
      if (!msgThread || !isJobAttributableThread(msgThread)) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      // Under the caller's own Lead scope - the lead mirror of the job resolve.
      const lead = await prisma.lead.findUnique({
        where: { id: req.body.lead_id, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Lead')) },
        select: { id: true, customer_id: true },
      });
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      // #3024, the lead mirror of reassignMessageJob: a lead the conversation's number allows, else 404 'Lead not found'.
      if (!tieAllowed(await textTieRuleForReq(req, msgThread), lead.customer_id)) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      before = await readBefore();
      if (!before) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      data = { lead_id: lead.id, job_id: null, job_label: null };
    } else {
      // A row the person cannot reach reads nothing here; the update below answers the 404, as before.
      before = await readBefore();
      data = { lead_id: null, job_id: null, job_label: null };
    }

    const result = await prisma.message.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req), thread: JOB_ATTRIBUTABLE_THREAD_WHERE, ...visibility },
      data,
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    // After the write, with the plain client, as the send door does: the link is done, and a
    // bookkeeping failure is logged by the service and never fails it. Awaited, never throws.
    if (before && data.lead_id) {
      await recordLeadContactOnLink({ client: prisma }, {
        source: 'text',
        channel: 'text',
        orgId: before.organization_id,
        leadIdBefore: before.lead_id,
        leadIdAfter: data.lead_id,
        directionBefore: before.direction,
        directionAfter: before.direction,
        automated: before.automated,
        deliveryStatus: before.status,
        at: before.ts,
        actorId: before.sent_by_user_id,
      });
    }
    // D7: the lead the text left, if it held it. Also after the write and with the plain client;
    // never throws, so a failed move back leaves the detach or move standing.
    if (before) await reconsiderLeadTextLeft(req, before, data.lead_id);

    const [message] = await prisma.message.findMany({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      include: { lead: { select: { lead_number: true } } },
      take: 1,
    });
    // A detach can take the message out of the person's reach (it was readable only through the record it was taken
    // off). The change is done; answer with a success that says the row left, not a 404 or a crash.
    if (!message) {
      res.json({ message: null, left: true });
      return;
    }

    res.json({ message: mapMessage(message) });
  } catch (err) {
    logger.error('Failed to reassign message lead:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Template Handlers ─────────────────────────────────

export async function listTemplates(req: Request, res: Response) {
  try {
    const templates = await prisma.textTemplate.findMany({
      where: tenantWhere(req),
      orderBy: { created_at: 'asc' },
    });

    res.json({ templates: templates.map(mapTemplate) });
  } catch (err) {
    logger.error('Failed to list templates:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getTemplate(req: Request, res: Response) {
  try {
    const template = await prisma.textTemplate.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json({ template: mapTemplate(template) });
  } catch (err) {
    logger.error('Failed to get template:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createTemplate(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    const template = await prisma.textTemplate.create({
      data: {
        name: req.body.name,
        info: req.body.info,
        body: req.body.body,
        default_body: req.body.defaultBody ?? req.body.body,
        fields: req.body.fields ?? [],
        audience: req.body.audience,
        notify_toggle: req.body.notifyToggle ?? false,
        notify_on: req.body.notifyOn ?? false,
        kind: req.body.kind ?? 'custom',
        organization_id: orgId,
      },
    });

    res.status(201).json({ template: mapTemplate(template) });
  } catch (err) {
    logger.error('Failed to create template:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateTemplate(req: Request, res: Response) {
  try {
    const data: any = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.info !== undefined) data.info = req.body.info;
    if (req.body.body !== undefined) data.body = req.body.body;
    if (req.body.defaultBody !== undefined) data.default_body = req.body.defaultBody;
    if (req.body.fields !== undefined) data.fields = req.body.fields;
    if (req.body.audience !== undefined) data.audience = req.body.audience;
    if (req.body.notifyToggle !== undefined) data.notify_toggle = req.body.notifyToggle;
    if (req.body.notifyOn !== undefined) data.notify_on = req.body.notifyOn;
    if (req.body.kind !== undefined) data.kind = req.body.kind;

    // updateMany with id+org filter is atomic — no TOCTOU window.
    const updateResult = await prisma.textTemplate.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      data,
    });
    if (updateResult.count === 0) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }
    const template = await prisma.textTemplate.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    res.json({ template: mapTemplate(template) });
  } catch (err) {
    logger.error('Failed to update template:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteTemplate(req: Request, res: Response) {
  try {
    const inUse = await prisma.textAutomation.count({
      where: { template_id: req.params.id as string, ...tenantWhere(req) },
    });
    if (inUse > 0) {
      res.status(400).json({ error: 'Cannot delete template in use by an automation' });
      return;
    }

    // deleteMany with id+org filter is atomic — no TOCTOU window.
    const result = await prisma.textTemplate.deleteMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json({ message: 'Template deleted' });
  } catch (err) {
    logger.error('Failed to delete template:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Automation Handlers ───────────────────────────────

export async function listAutomations(req: Request, res: Response) {
  try {
    const automations = await prisma.textAutomation.findMany({
      where: tenantWhere(req),
      orderBy: { created_at: 'asc' },
    });

    res.json({ automations: automations.map(mapAutomation) });
  } catch (err) {
    logger.error('Failed to list automations:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getAutomation(req: Request, res: Response) {
  try {
    const automation = await prisma.textAutomation.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    if (!automation) {
      res.status(404).json({ error: 'Automation not found' });
      return;
    }

    res.json({ automation: mapAutomation(automation) });
  } catch (err) {
    logger.error('Failed to get automation:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createAutomation(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    const template = await prisma.textTemplate.findFirst({
      where: { id: req.body.templateId, ...tenantWhere(req) },
    });
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    const automation = await prisma.textAutomation.create({
      data: {
        name: req.body.name,
        trigger: req.body.trigger,
        template_id: req.body.templateId,
        timing: req.body.timing,
        audience: req.body.audience,
        enabled: req.body.enabled ?? false,
        organization_id: orgId,
      },
    });

    res.status(201).json({ automation: mapAutomation(automation) });
  } catch (err) {
    logger.error('Failed to create automation:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateAutomation(req: Request, res: Response) {
  try {
    if (req.body.templateId) {
      const template = await prisma.textTemplate.findFirst({
        where: { id: req.body.templateId, ...tenantWhere(req) },
      });
      if (!template) {
        res.status(404).json({ error: 'Template not found' });
        return;
      }
    }

    const data: any = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.trigger !== undefined) data.trigger = req.body.trigger;
    if (req.body.templateId !== undefined) data.template_id = req.body.templateId;
    if (req.body.timing !== undefined) data.timing = req.body.timing;
    if (req.body.audience !== undefined) data.audience = req.body.audience;
    if (req.body.enabled !== undefined) data.enabled = req.body.enabled;

    // updateMany with id+org filter is atomic — no TOCTOU window.
    const updateResult = await prisma.textAutomation.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      data,
    });
    if (updateResult.count === 0) {
      res.status(404).json({ error: 'Automation not found' });
      return;
    }
    const automation = await prisma.textAutomation.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    res.json({ automation: mapAutomation(automation) });
  } catch (err) {
    logger.error('Failed to update automation:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteAutomation(req: Request, res: Response) {
  try {
    // deleteMany with id+org filter is atomic — no TOCTOU window.
    const result = await prisma.textAutomation.deleteMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Automation not found' });
      return;
    }

    res.json({ message: 'Automation deleted' });
  } catch (err) {
    logger.error('Failed to delete automation:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
