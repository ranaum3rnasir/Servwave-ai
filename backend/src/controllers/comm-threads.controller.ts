import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { matchByPhone, normalizeNAPhone } from '../lib/comms-identity';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import {
  commVisibilityWhere,
  commParentVisibilityWhere,
} from '../lib/permissions/anchorVisibility';
import { findOrCreateSmsThreadByNumber, smsThreadExistsForNumber } from '../lib/ctm/smsThread';
import { isCtmConfigured } from '../lib/ctm/client';
import {
  markMessageNotDelivered,
  precheckCtmSms,
  sendCtmSms,
  type CtmSmsFailureReason,
} from '../lib/ctm/sendSms';
import {
  resolveInboundSmsJob,
  SMS_ROUTER_RECENCY_WINDOW_DAYS,
  type JobTextCandidate,
} from '../lib/sms-reply-router';
import { recordLeadOutboundContact } from '../services/lead-contact.service';

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
  info: z.string().max(1000),
  body: z.string().min(1, 'Body is required'),
  defaultBody: z.string().optional(),
  fields: z.array(z.string()).optional(),
  audience: z.enum(['customer', 'team']),
  notifyToggle: z.boolean().optional(),
  notifyOn: z.boolean().optional(),
  kind: z.enum(['preset', 'custom']).optional(),
});

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  info: z.string().max(1000).optional(),
  body: z.string().min(1).optional(),
  defaultBody: z.string().optional(),
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

// ─── CTM outbound delivery (slice 6) ────────────────────

// Gate-failure reasons a connected org's user send surfaces as 409 { error,
// code } BEFORE the row is created. NOT_CONNECTED / CTM_ERROR are absent on
// purpose: they fall back to today's record-is-the-product behavior.
// NOT_ENTITLED is absent too — this route already runs requireFeature('phone')
// (comm-threads.routes.ts), so runGates' own entitlement check is defence in
// depth for the automation seam, not something a user send can normally reach.
const SMS_GATE_409: Partial<Record<CtmSmsFailureReason, string>> = {
  RECIPIENT_OPTED_OUT: 'This recipient has opted out of text messages',
  SMS_NOT_READY: 'Text messaging is not active yet — A2P registration is pending approval',
  ORG_SMS_DISABLED: 'Text messaging is turned off for this organization',
  NO_SMS_NUMBER: 'No SMS-capable phone number is available for this conversation',
  DUPLICATE_SEND: 'An identical text was just sent to this conversation',
  // Phase-0 test guard (slice H7 closes the gap): an allowlist-blocked send
  // now 409s with NO row, mirroring click-to-call — it used to fall through
  // and create a record-only row the user believed was delivered.
  NOT_IN_TEST_ALLOWLIST: 'Number is not on the outbound test allowlist',
};

/** Destination number for CTM delivery on a thread: the linked customer's
 * phone, else the vendor's contact phone, else the thread title (unmatched
 * inbound threads are keyed by title = the raw counterpart number). Returns
 * E.164 where normalizable, null when the thread has no textable number. */
async function resolveSmsDestination(
  req: Request,
  thread: { customer_id?: string | null; vendor_id?: string | null; title?: string | null },
): Promise<string | null> {
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
  };
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

/**
 * Anchor-inherited visibility for SMS (slice 8a), in the two halves it needs.
 *
 * The anchor lives on the MESSAGE (Message.job_id / Message.lead_id), not on the
 * thread, so one conversation can legitimately hold job-A and job-B messages at
 * once and the predicate is per-message. But Message has NO top-level read path
 * - it is only ever reached as a nested `messages` include - so scoping it means
 * two filters, both in SQL:
 *   - `messages` narrows the nested include, so the payload carries only the
 *     rows the caller may see (a filtered join, NOT response-level hiding);
 *   - `thread` drops any conversation with nothing visible in it, because the
 *     thread's existence and its customer linkage are themselves information.
 * Both collapse to {} for an org-wide requester, leaving those queries untouched.
 */
async function smsVisibility(req: Request) {
  const [messages, thread] = await Promise.all([
    commVisibilityWhere(req),
    commParentVisibilityWhere(req, 'messages'),
  ]);
  return { messages, thread };
}

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
    const scope = await smsVisibility(req);
    const threads = await prisma.messageThread.findMany({
      where: { ...tenantWhere(req), ...scope.thread },
      orderBy: { updated_at: 'desc' },
      include: {
        messages: { where: scope.messages, orderBy: { ts: 'asc' } },
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        lead: { select: { id: true, lead_number: true } },
        vendor: { select: { id: true, name: true } },
        // Name fields only - a label is all the payload needs, and the User row
        // carries a password hash and an email that have no business on it.
        user: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    const withUnread = await attachCallerUnread(req, threads);
    res.json({ threads: withUnread.map(mapThread) });
  } catch (err) {
    logger.error('Failed to list threads:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getThread(req: Request, res: Response) {
  try {
    const scope = await smsVisibility(req);
    const thread = await prisma.messageThread.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...scope.thread },
      include: {
        messages: { where: scope.messages, orderBy: { ts: 'asc' } },
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
    res.json({ thread: mapThread(withUnread) });
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
  const scope = await smsVisibility(req);
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
        where: { id: req.body.lead_id, ...tenantWhere(req) },
      });
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      explicitLeadId = lead.id;
    }

    const match = await matchByPhone(prisma, orgId, req.body.from_number);

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
      lead = await prisma.lead.findFirst({
        where: { id: req.body.leadId, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Lead')) },
        select: { id: true, customer_id: true },
      });
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
    }

    // Compose-to-number (slice H7): resolved AFTER threadId and customerId —
    // an explicit thread/customer always wins over the raw number.
    let threadFromNumber = false;
    // s1d: whether THIS call created a brand-new thread — a 409 further down
    // must delete it (empty thread = phantom conversation on the next poll),
    // but must never touch a thread this send merely appended to.
    let threadCreated = false;

    let thread: { id: string } | null = null;
    if (req.body.threadId) {
      // Scoped like the read paths: a caller who cannot see a conversation must
      // not be able to append to it either. The resolve-or-create branches below
      // are deliberately NOT scoped - they key a thread by customer or by raw
      // destination number, which is a compose action, not access to a
      // restricted row.
      thread = await prisma.messageThread.findFirst({
        where: {
          id: req.body.threadId,
          ...tenantWhere(req),
          ...(await commParentVisibilityWhere(req, 'messages')),
        },
      });
      if (!thread) {
        res.status(404).json({ error: 'Thread not found' });
        return;
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
      // #2046 security round 1: this door can ORIGINATE a brand-new, org-wide
      // thread with no lead/job anchor — the same org-wide inbox surface
      // GET/POST /threads gate on `access_inbox`. Gate it the same way, but
      // ONLY when it would actually originate one: an unanchored compose
      // (no leadId/jobId) whose number has no thread yet. Checked BEFORE any
      // write — no create-then-rollback. A reply into a thread that already
      // exists for this number, or a lead/job-anchored compose, is a caller
      // acting on something already in their view and stays ungated.
      if (!req.body.leadId && !req.body.jobId) {
        const exists = await smsThreadExistsForNumber(prisma, orgId, String(req.body.toNumber));
        if (!exists && !req.ability?.can('access_inbox', 'Communication')) {
          res.status(403).json({
            error: 'Starting a new conversation from the inbox requires access to the Communication section.',
          });
          return;
        }
      }
      const resolution = await findOrCreateSmsThreadByNumber(prisma, orgId, String(req.body.toNumber));
      thread = resolution.thread;
      threadCreated = resolution.created;
      threadFromNumber = true;
    } else {
      const customer = await prisma.customer.findFirst({
        where: { id: req.body.customerId, ...tenantWhere(req) },
      });
      if (!customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
      }
      thread = await prisma.messageThread.findFirst({
        where: { customer_id: customer.id, channel: 'sms', ...tenantWhere(req) },
      });
      if (!thread) {
        thread = await prisma.messageThread.create({
          data: {
            channel: 'sms',
            campaign_type: 'customer_care',
            customer_id: customer.id,
            // Lead attribution (slice E4): a thread born from a Lead-page send
            // carries the lead link from creation — but ONLY when the lead
            // belongs to THIS customer; a mismatched leadId/customerId pair
            // (cross-entity) is silently dropped, same as the backfill gate
            // below never overwriting across customers.
            ...(lead != null && lead.customer_id === customer.id && { lead_id: lead.id }),
            organization_id: orgId,
          },
        });
        threadCreated = true;
      }
    }

    // Lead attribution (slice E4): stamp the resolved thread's lead link.
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

    // Communication ↔ Jobs (spec §7): stamp job attribution at origin. An
    // explicit jobId (composed from a job page) always wins; otherwise inbound
    // replies on customer/vendor threads get a best-effort recency-gated
    // auto-route ("act + cheap undo" — one-click reassign fixes a wrong
    // guess). Internal lanes (kind team/group) NEVER carry a job_id.
    const threadRow = thread as { id: string; customer_id?: string | null; vendor_id?: string | null; kind?: string | null; title?: string | null };

    // Lead attribution (message-level): the SAME same-customer gate as the
    // thread backfill above — a customer-owned thread only stamps that
    // customer's OWN lead onto the message; a mismatched leadId/customerId
    // pair (or a customer-less/vendor thread, which never carries a lead)
    // is silently dropped rather than leaking an unrelated lead's id.
    const leadId = lead != null && threadRow.customer_id === lead.customer_id ? lead.id : null;

    let jobStamp: { job_id: string; job_label: string | null } | null = null;
    if (req.body.jobId) {
      // Internal lanes are never job-attached — reject loudly rather than
      // silently dropping the attribution.
      if (!isJobAttributableThread(threadRow)) {
        res.status(400).json({ error: 'Internal threads cannot be job-tagged' });
        return;
      }
      // Under the caller's OWN Job row-scope - the same rule sendWhatsApp and
      // sendEmail already apply, and the one this composer was missing. Stamping
      // a send with a job the sender cannot see writes the message straight out
      // of their own view (job > lead > customer precedence) and INTO that job's
      // crew timeline.
      const job = await prisma.job.findUnique({
        where: { id: req.body.jobId, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Job')) },
        select: { id: true, job_number: true, customer_id: true },
      });
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      // Same-customer constraint: a customer-owned thread only accepts that
      // customer's jobs. Another customer's job is indistinguishable from a
      // nonexistent one → 404 'Job not found' (same as cross-org; no existence
      // oracle). Customer-less threads (vendor/lead) keep org-scope-only
      // validation.
      if (threadRow.customer_id && job.customer_id !== threadRow.customer_id) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      jobStamp = { job_id: job.id, job_label: job.job_number };
    } else if (
      (req.body.direction ?? 'out') === 'in' &&
      (threadRow.customer_id || threadRow.vendor_id) &&
      isJobAttributableThread(threadRow)
    ) {
      const now = new Date();
      const windowStart = new Date(now.getTime() - SMS_ROUTER_RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      // distinct(job_id) + ts-desc → the first (only) row per job is already
      // its latest outbound text, so a chatty job can't starve older live
      // jobs out of the take-N window.
      const recentJobTexts = await prisma.message.findMany({
        where: {
          thread_id: thread.id,
          ...tenantWhere(req),
          direction: 'out',
          job_id: { not: null },
          ts: { gte: windowStart },
        },
        orderBy: { ts: 'desc' },
        distinct: ['job_id'],
        take: 10,
        select: { job_id: true, job_label: true, ts: true, job: { select: { status: true } } },
      });
      const candidates: JobTextCandidate[] = [];
      for (const row of recentJobTexts) {
        if (row.job_id && row.job) {
          candidates.push({
            jobId: row.job_id,
            jobLabel: row.job_label,
            lastOutboundAt: row.ts,
            jobStatus: row.job.status,
          });
        }
      }
      const routed = resolveInboundSmsJob({ now, recentJobTexts: candidates });
      if (routed) jobStamp = { job_id: routed.jobId, job_label: routed.jobLabel };
    }

    // CTM outbound delivery (slice 6). Connected orgs run the compliance
    // precheck BEFORE the row exists so a blocked user send 409s with no side
    // effects; not-connected orgs keep exactly today's behavior (row created,
    // no delivery — the record is the product). Internal lanes (team/group)
    // and simulated-inbound writes never attempt delivery.
    const isOutboundSend = (req.body.direction ?? 'out') === 'out';
    let deliverTo: string | null = null;
    let shouldDeliver = false;
    // Why an outbound row will not be delivered, when it will not be. Drives the
    // row's `skipped` reason below so a suppressed send never reads as sent.
    // Null on an internal lane (team/group) or a simulated inbound write, where
    // "not delivered" is the point rather than a suppression.
    let blockedReason: CtmSmsFailureReason | null = null;
    if (isOutboundSend && isJobAttributableThread(threadRow)) blockedReason = 'NOT_CONNECTED';
    if (isCtmConfigured() && isOutboundSend && isJobAttributableThread(threadRow)) {
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { ctm_account_id: true },
      });
      if (org?.ctm_account_id) {
        deliverTo = await resolveSmsDestination(req, threadRow);
        const pre = await precheckCtmSms(prisma, {
          orgId,
          toE164: deliverTo,
          threadId: thread.id,
          body: req.body.body,
          userId: req.user!.id,
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
        // per-message. leadId is already same-customer-gated above.
        ...(leadId != null && { lead_id: leadId }),
        organization_id: orgId,
      },
    });

    // F3: surface an outbound SMS on the linked customer's central timeline.
    // thread may be a just-created thread (Phase 2 resolve-or-create) — its customer_id
    // is set on create, so this fires for both the found-thread and created-thread paths.
    // Phase 2 narrows thread's static type, so cast to read customer_id off it without a tsc error.
    const linkedCustomerId = (thread as { customer_id?: string | null }).customer_id ?? null;
    if (linkedCustomerId && isOutboundSend) {
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
    if (message.status === 'sent' || message.status === 'delivered') {
      await recordLeadOutboundContact(prisma, {
        leadId: message.lead_id,
        orgId: message.organization_id,
        channel: 'text',
        direction: message.direction,
        automated: message.automated,
        at: message.ts,
      });
    }

    // Compose-to-number returns the resolved thread id so the composer can
    // open/append the right conversation; existing paths keep their exact
    // response shape (the caller already knows its thread/customer).
    res.status(201).json({
      message: mapMessage(message),
      ...(threadFromNumber ? { threadId: thread.id } : {}),
      ...(delivery ? { delivery } : {}),
    });
  } catch (err) {
    logger.error('Failed to send message:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// One-click reassign (spec §7 "act + cheap undo"): a wrong auto-route guess
// costs one PATCH. job_id: null clears attribution (→ Unrouted tray).
export async function reassignMessageJob(req: Request, res: Response) {
  try {
    // One filter for the update AND the refetch (the refetch used to be weaker;
    // see reassignCallJob for why that stops being benign once the guard is a
    // visibility predicate).
    const visibility = await commVisibilityWhere(req);
    let data: { job_id: string | null; job_label: string | null };
    if (req.body.job_id != null) {
      // Resolve the message's thread (org-scoped, by membership) to enforce
      // the attribution rules: internal lanes (kind team/group) are invisible
      // to this endpoint → 404, and a customer-owned thread only accepts that
      // customer's jobs.
      const msgThread = await prisma.messageThread.findFirst({
        where: {
          messages: { some: { id: req.params.id as string, ...visibility } },
          ...tenantWhere(req),
        },
        select: { kind: true, customer_id: true },
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
        select: { id: true, job_number: true, customer_id: true },
      });
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      // Same-customer constraint (mirrors sendMessage): another customer's job
      // is indistinguishable from a nonexistent one → 404 'Job not found'.
      // Customer-less threads (vendor/lead) keep org-scope-only validation.
      if (msgThread.customer_id && job.customer_id !== msgThread.customer_id) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      data = { job_id: job.id, job_label: job.job_number };
    } else {
      data = { job_id: null, job_label: null };
    }

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

    const [message] = await prisma.message.findMany({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      take: 1,
    });

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
export const reassignMessageLeadSchema = z.object({
  lead_id: z.string().uuid('lead_id must be a valid id').nullable(),
});

export async function reassignMessageLead(req: Request, res: Response) {
  try {
    // See reassignMessageJob: one filter, applied to the pre-read, the update and
    // the refetch alike.
    const visibility = await commVisibilityWhere(req);
    let data: { lead_id: string | null };
    if (req.body.lead_id != null) {
      const msgThread = await prisma.messageThread.findFirst({
        where: {
          messages: { some: { id: req.params.id as string, ...visibility } },
          ...tenantWhere(req),
        },
        select: { kind: true, customer_id: true },
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
      // Same-customer constraint (mirrors reassignMessageJob): another
      // customer's lead is indistinguishable from a nonexistent one → 404
      // 'Lead not found'. Customer-less threads (vendor) keep org-scope-only
      // validation.
      if (msgThread.customer_id && lead.customer_id !== msgThread.customer_id) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      data = { lead_id: lead.id };
    } else {
      data = { lead_id: null };
    }

    const result = await prisma.message.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req), thread: JOB_ATTRIBUTABLE_THREAD_WHERE, ...visibility },
      data,
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    const [message] = await prisma.message.findMany({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      take: 1,
    });

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
