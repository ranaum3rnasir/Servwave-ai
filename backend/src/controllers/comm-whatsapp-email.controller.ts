import { Request, Response } from 'express';
import { z } from 'zod';
import { AttachmentEntity } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { tenantWhere } from '../lib/tenant';
import { matchByPhone } from '../lib/comms-identity';
// The Request-flavoured hasFeature (fails closed on a missing org_features),
// NOT lib/entitlements/resolve.ts's OrgEntitlementSource one - this reads the
// entitlements already resolved onto req.user by authenticate.
import { hasFeature } from '../middleware/requireFeature';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import {
  commVisibilityWhere,
  commParentVisibilityWhere,
} from '../lib/permissions/anchorVisibility';
import {
  textsInSectionScopeForReq,
  emailsInSectionWhereForReq,
  emailReadWhereForReq,
  emailThreadReadWhereForReq,
  emailThreadReachWhereForReq,
} from '../lib/communication/communicationScope';
import { needsReviewItemWhereForReq, needsReviewListWhereForReq } from '../lib/communication/needsReview';
import { unreadInboxWhere } from '../lib/communication/mailboxList';
import { recordLabelsFor } from '../lib/communication/recordConversations';
import {
  addressesIn, awaitingSeveralCustomers, awaitsCustomer, customerIdsWithAddress, customerOfRecipients, isUnverifiedSenderLink,
  senderAddressOfRow,
} from '../lib/communication/customerByAddress';
import { addAndClause, addOrFilter } from '../lib/permissions/whereCompose';
// #2049 - reused so the sms half of getUnreadCounts below computes THREADS
// unread the same way listThreads/getThread do, never a second derivation.
// Aliased: this module already has its own attachCallerUnread (the email
// per-row mirror, further down) - same name, different channel, no relation.
import { attachCallerUnread as attachCallerUnreadSms } from './comm-threads.controller';
import { sendComposedEmail, dispatchFailureStatus, orgSendingIdentity, EmailDispatchResult } from '../lib/email';
import { parseReplyAddress, prepareReplyToken, persistReplyToken, replyAddressFor, resolveReplyToken } from '../lib/reply-token';
import { startedConversationData, takeConversationOnFirstReply } from '../lib/mailbox/conversations';
import { ADDRESS_NEEDED_MESSAGE, NOT_YOUR_ADDRESS_MESSAGE, resolveHandSender } from '../lib/mailbox/hand-sender';
import { formatSizeLabel, sanitizeEmailHtml } from '../lib/email-html';
import { sniffMatchesDeclared } from '../lib/file-sniff';
import {
  ATTACHMENTS_BUCKET,
  buildAccessUrl,
  sanitizeAttachmentFilename,
} from '../lib/attachment-access';
// Reused as-is (email slice 7) - the compose window's multipart upload must
// never invent a parallel mime allowlist that can drift from the generic one.
// checkEntityAccess is reused too (attach-source, below) so a role's
// visibility into a job/estimate/invoice/customer can never drift between the
// generic Attachment surface and this one.
import { ALLOWED_MIME_TYPES, ALLOWED_TYPES_LABEL, checkEntityAccess } from './attachment.controller';
import { recordLeadOutboundContact } from '../services/lead-contact.service';
import { VERY_LONG_TEXT_MAX } from '../lib/text-limits';

// Guards a caller-supplied id before it reaches a `@db.Uuid` column. Prisma
// raises P2023 on a malformed UUID instead of matching nothing, so a lookup
// that is meant to MISS on a bad id throws a 500 unless it is screened first.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Zod Schemas ───────────────────────────────────────

export const sendWhatsAppSchema = z.object({
  chat_id: z.string().uuid('chat_id must be a valid id'),
  text: z.string().min(1, 'Message text is required'),
  // Attach-by-origin: a send composed from a job page stamps that job.
  job_id: z.string().uuid('job_id must be a valid id').optional(),
});

export const createWhatsAppChatSchema = z.object({
  name: z.string().min(1).max(200),
  org: z.string().min(1).max(200),
  phone: z.string().min(1).max(40),
  lead_id: z.string().uuid('lead_id must be a valid id').optional(),
});

export const sendEmailSchema = z.object({
  // `account` is deliberately NOT accepted here - it is server-owned. See
  // HUMAN_COMPOSED_ACCOUNT below for why a client must never be able to set it.
  // Zod strips unknown keys, so a client still posting one is ignored, not 400'd.
  to: z.string().min(1, 'Recipient is required'),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().max(998).optional(),
  // Email slice 7: the request is multipart/form-data now (files ride under a
  // `files` field), so every field arrives on req.body as a plain string -
  // multer never parses a nested array out of a form field the way a JSON body
  // would. The compose window already builds a paragraph array client-side
  // (bodyToParas) before this slice; rather than lose that boundary by
  // re-splitting a flattened string server-side, the client JSON-encodes the
  // SAME array into this one text field and this parses it back out, so the
  // wire shape stays string[] end-to-end, just re-encoded for a multipart
  // field. A non-JSON string is left as-is and fails the array check below
  // with a normal validation error, rather than silently becoming [string].
  body: z.preprocess((val) => {
    if (typeof val !== 'string') return val;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }, z.array(z.string()).refine(
    (paras) => paras.join('\n').length <= VERY_LONG_TEXT_MAX,
    { message: `Body is too long (maximum ${VERY_LONG_TEXT_MAX.toLocaleString('en-US')} characters)` },
  )).optional(),
  // Optional rich body - stored + dispatched verbatim when a compose surface
  // submits one. The plain-text `body` paragraphs above always drive the text
  // part of the send regardless of whether html is present.
  // Markup roughly quadruples the text, so the html allowance is four times the plain body's.
  body_html: z.string().max(VERY_LONG_TEXT_MAX * 4).optional(),
  thread_id: z.string().nullable().optional(),
  // PRD 10 (S10.11): there is NO From choice. A hand-written email goes out from the sender's own mailbox, always; this
  // field selects nothing. It exists only so a request that NAMES another mailbox (the main mailbox, a colleague's, a
  // handed-over one, another company's) is refused rather than quietly sent from somewhere else.
  from_mailbox_id: z.string().max(100).optional(),
  // Reply threading: the stored row being replied to. Accepted but NOT acted on
  // today - there is no thread (In-Reply-To/References) to build yet. A later
  // slice is what makes this field mean something.
  reply_to_email_id: z.string().uuid('reply_to_email_id must be a valid id').optional(),
  // Attach-by-origin: a send composed from a job page stamps that job.
  job_id: z.string().uuid('job_id must be a valid id').optional(),
  // Attach-by-origin: a send composed from a customer page stamps that customer.
  customer_id: z.string().uuid('customer_id must be a valid id').optional(),
  // Attach-by-origin: a send composed from a LEAD page stamps that lead. Added by spec #1751 D5
  // for the same reason the other two exist, and because without it the email channel of the
  // contact clock is unreachable: `Email.lead_id` had exactly two writers - the transactional
  // mirror and the manual re-link door - so a salesperson emailing a lead by hand left a row that
  // named no lead, and there was nothing for the clock to key on. Mirrors sendWhatsAppChatSchema's
  // own lead_id, and is org-validated in the handler like every other attach-by-origin id.
  lead_id: z.string().uuid('lead_id must be a valid id').optional(),
  // Traffic Cop (email slice 8b, Help Scout's pattern): the client's own
  // "I started composing at this instant" timestamp. Only meaningful on a
  // REPLY (thread_id also present) - the compose window stamps it when the
  // reply editor opens. Absent = the guard has nothing to compare against and
  // does not fire (see sendEmail's own comment for why that is a client
  // integration gap, not a policy toggle).
  composing_since: z.string().datetime({ offset: true }).optional(),
});

/**
 * The `emails.account` value for a message a PERSON composed in the app, as
 * opposed to one the app sent itself.
 *
 * The column carries meaning beyond a label: `'system'` marks app-generated
 * mail and is read by `lib/job-communications.ts` (renders the "auto ·
 * transactional" chip) and by two backfills in `job.controller.ts`. Anything
 * that is not `'system'` is treated as human-composed, so this constant only
 * has to be distinct from it.
 */
const HUMAN_COMPOSED_ACCOUNT = 'user';

// Shared across every `prisma.email` include that embeds attachments (list/get/
// reassign) so the ordering can never drift between them - mapEmail's `index`
// is a post-fetch array position, and GET .../attachments/:index relies on that
// position meaning the SAME thing everywhere it is computed.
const EMAIL_ATTACHMENTS_INCLUDE = {
  orderBy: [{ position: 'asc' as const }, { created_at: 'asc' as const }],
};

// Shared across every include that needs to render a message's thread
// (assignee, archive, snooze) - `assigned_to.is_active` is what
// effectiveThreadAssigneeId reads to apply auto-unassign, so it must always
// ride along, not just `assigned_to_user_id`.
const EMAIL_THREAD_INCLUDE = {
  select: {
    id: true,
    assigned_to_user_id: true,
    archived: true,
    snoozed_until: true,
    assigned_to: { select: { id: true, is_active: true } },
    // The record a record conversation is about, which names the job or lead on the Inbox row (S10.9).
    origin: true,
    record_type: true,
    record_id: true,
  },
};

export const markThreadReadSchema = z.object({
  thread_id: z.string().min(1, 'thread_id is required'),
});

// #2049 - the persisted "Mark as unread" path. Same shape as the read schema.
export const markThreadUnreadSchema = z.object({
  thread_id: z.string().min(1, 'thread_id is required'),
});

// Email slice 8b - conversation assignment. `null` clears (Unassigned).
export const assignEmailThreadSchema = z.object({
  user_id: z.string().uuid('user_id must be a valid id').nullable(),
});

// Shared (workflow) archive - one flag, visible to whoever can see the thread.
export const archiveEmailThreadSchema = z.object({
  archived: z.boolean(),
});

// Shared (workflow) snooze - `null` clears it.
export const snoozeEmailThreadSchema = z.object({
  snoozed_until: z.string().datetime({ offset: true }).nullable(),
});

// ─── Mappers (snake_case Prisma row → camelCase mock contract) ──

function mapWhatsAppMessage(m: any) {
  return {
    id: m.id,
    from: m.from,
    text: m.text,
    at: m.at,
    ...(m.status != null ? { status: m.status } : {}),
    ...(m.job_id != null ? { jobId: m.job_id } : {}),
    ...(m.job_label != null ? { jobLabel: m.job_label } : {}),
  };
}

function mapWhatsAppChat(c: any) {
  return {
    id: c.id,
    name: c.name,
    org: c.org,
    phone: c.phone,
    unread: c.unread,
    lastAt: c.last_at,
    messages: (c.messages ?? []).map(mapWhatsAppMessage),
    ...(c.customer != null && {
      linkedCustomer: { id: c.customer.id, name: c.customer.company_name ?? [c.customer.first_name, c.customer.last_name].filter(Boolean).join(' ') },
    }),
    ...(c.lead != null && { linkedLead: { id: c.lead.id, leadNumber: c.lead.lead_number } }),
    ...(c.vendor != null && { linkedVendor: { id: c.vendor.id, name: c.vendor.name } }),
    ...(c.lead_id != null && { leadId: c.lead_id }),
    ...(c.vendor_id != null && { vendorId: c.vendor_id }),
  };
}

/**
 * Auto-unassign, read-time (email slice 8b). "Unreachable" is interpreted
 * minimally per the approved plan: the assignee's `is_active` is false. This
 * is never written anywhere - every read path re-derives it from the live
 * User row so a deactivated user's threads read as Unassigned everywhere
 * without a reconciliation job. Returns null (Unassigned) when there is no
 * assignee OR the assignee is no longer active; the raw id otherwise.
 *
 * `thread.assigned_to` must be included (`select: { is_active: true, ... }`)
 * wherever this is called - a thread fetched WITHOUT that relation would read
 * `assigned_to === undefined`, which this treats as "not inactive" (assumes
 * active) rather than silently mis-reporting Unassigned as assigned.
 */
function effectiveThreadAssigneeId(thread: { assigned_to_user_id: string | null; assigned_to?: { is_active: boolean } | null }): string | null {
  if (!thread.assigned_to_user_id) return null;
  if (thread.assigned_to && thread.assigned_to.is_active === false) return null;
  return thread.assigned_to_user_id;
}

function mapEmailThread(t: any) {
  return {
    id: t.id,
    assignedToUserId: effectiveThreadAssigneeId(t),
    archived: t.archived,
    snoozedUntil: t.snoozed_until,
  };
}

function mapEmail(e: any) {
  return {
    id: e.id,
    account: e.account,
    from: e.from,
    to: e.to,
    subject: e.subject,
    snippet: e.snippet,
    body: e.body,
    at: e.at,
    // Email.ts is a Prisma BigInt (epoch-ms) — reads return JS bigint, which
    // res.json cannot serialize. Number() is safe: epoch-ms < MAX_SAFE_INTEGER.
    ts: Number(e.ts),
    // Email slice 8c: THIS FIELD IS NOW COMPUTED PER-CALLER, not read off the
    // legacy `unread` column. Callers (listEmails/getEmail) must overwrite
    // `e.unread` with the per-caller EmailReadState-derived value BEFORE
    // calling this mapper - see attachCallerUnread. A caller that forgets to
    // do so falls back to the raw (now-dead) column, which is never updated
    // again after this slice, so it would read as permanently unread for
    // every row created since.
    unread: e.unread,
    starred: e.starred,
    folder: e.folder,
    ...(e.labels != null ? { labels: e.labels } : {}),
    ...(e.has_attachment != null ? { hasAttachment: e.has_attachment } : {}),
    // Real EmailAttachment rows (email slice 7) win over the legacy `attachments`
    // Json column, which only ever carried display-only {name,size} for
    // prototype/mock rows with nothing downloadable behind them. `index` is the
    // row's position among ITS OWN siblings post-fetch - callers must have
    // ordered by [position asc, created_at asc] (every include in this file
    // does), so it lines up with GET .../emails/:id/attachments/:index exactly.
    ...(e.email_attachments != null && e.email_attachments.length > 0
      ? {
          attachments: e.email_attachments.map((a: any, i: number) => ({
            name: a.file_name,
            size: formatSizeLabel(a.file_size),
            sizeBytes: a.file_size,
            mimeType: a.content_type,
            index: i,
          })),
        }
      : e.attachments != null
        ? { attachments: e.attachments }
        : {}),
    ...(e.thread_id != null ? { threadId: e.thread_id } : {}),
    // Email slice 8b: per-conversation workflow state, flattened onto the
    // message the same way every other anchor is (jobId, customerId, ...).
    // Absent when the row carries no thread (system/transactional rows -
    // persistTransactionalEmail never attaches one) OR the include was not
    // requested. `threadAssignedToUserId` already reflects auto-unassign
    // (effectiveThreadAssigneeId) - the frontend never has to re-derive it.
    ...(e.thread != null
      ? {
          threadAssignedToUserId: effectiveThreadAssigneeId(e.thread),
          threadArchived: e.thread.archived,
          threadSnoozedUntil: e.thread.snoozed_until,
        }
      : {}),
    ...(e.important != null ? { important: e.important } : {}),
    ...(e.snoozed_until !== undefined ? { snoozedUntil: e.snoozed_until } : {}),
    // Message metadata - absent on prototype/system rows.
    ...(e.direction != null ? { direction: e.direction } : {}),
    // Delivery lifecycle (email slice 4/5) - null on every row written before the
    // Resend webhook existed ("nothing has ever reported on this row"), so this
    // is omit-if-null like every other real-row field above, not defaulted.
    // Field names are the camelCase mirror of the Prisma columns; the frontend
    // Email type must match these exactly.
    ...(e.delivery_status != null ? { deliveryStatus: e.delivery_status } : {}),
    ...(e.delivery_status_reason != null ? { deliveryStatusReason: e.delivery_status_reason } : {}),
    ...(e.bounce_kind != null ? { bounceKind: e.bounce_kind } : {}),
    // Inbound attribution (email slice 6) - null on every outbound row, so
    // omit-if-null like the delivery fields above. Both are needed by the UI,
    // and needed SEPARATELY: inboundMatch says whether we attached the message,
    // inboundAuth says what the sender's address was worth. A MATCHED row with
    // inboundAuth 'NO_POLICY' or 'UNAVAILABLE' matched on an unverified string
    // compare and must not be badged the same as a DMARC-verified one.
    ...(e.inbound_match != null ? { inboundMatch: e.inbound_match } : {}),
    ...(e.inbound_auth != null ? { inboundAuth: e.inbound_auth } : {}),
    // Why the message is held in a Needs review list (S10.18); absent on every message that was delivered.
    // PRD 10, S10.20: a customer link made on a sender the domain could not vouch for, and a sender several customers share.
    ...(isUnverifiedSenderLink(e) ? { unverifiedSender: true } : {}),
    ...(e.matchesSeveralCustomers === true ? { matchesSeveralCustomers: true } : {}),
    ...(e.review_reason != null ? { reviewReason: e.review_reason } : {}),
    ...(e.review_mailbox_id != null ? { reviewMailboxId: e.review_mailbox_id } : {}),
    ...(e.cc != null ? { cc: e.cc } : {}),
    ...(e.bcc != null ? { bcc: e.bcc } : {}),
    ...(e.body_html != null ? { bodyHtml: e.body_html } : {}),
    ...(e.job_id != null ? { jobId: e.job_id } : {}),
    ...(e.job_label != null ? { jobLabel: e.job_label } : {}),
    // Email slice 8b: who sent it (immutable, stamped at send). Absent on
    // inbound/system rows, which have no ServWave sender.
    ...(e.sent_by_user_id != null ? { sentByUserId: e.sent_by_user_id } : {}),
    // The job or lead a record conversation is about (S10.9), when the person can open it.
    ...(e.recordTie != null ? { recordTie: e.recordTie } : {}),
    ...(e.customer != null && {
      linkedCustomer: { id: e.customer.id, name: e.customer.company_name ?? [e.customer.first_name, e.customer.last_name].filter(Boolean).join(' ') },
    }),
    ...(e.lead != null && { linkedLead: { id: e.lead.id, leadNumber: e.lead.lead_number } }),
    ...(e.vendor != null && { linkedVendor: { id: e.vendor.id, name: e.vendor.name } }),
    ...(e.customer_id != null && { customerId: e.customer_id }),
    ...(e.lead_id != null && { leadId: e.lead_id }),
    ...(e.vendor_id != null && { vendorId: e.vendor_id }),
  };
}

function mapEmailGroup(g: any) {
  return {
    id: g.id,
    name: g.name,
    memberIds: g.member_ids,
  };
}

// ─── WhatsApp Handlers ─────────────────────────────────

/**
 * Anchor-inherited visibility for WhatsApp (slice 8a). Structurally identical to
 * SMS - the anchor is per-MESSAGE and WhatsAppMessage has no top-level read
 * path - so it needs the same two halves: `messages` filters the nested include,
 * `chat` drops a conversation with nothing visible in it.
 *
 * This only works because 20260804200000 gave WhatsAppMessage its own `lead_id`.
 * Before that it had job_id and NOTHING else, so the shared fragment would have
 * matched nothing on this channel while looking perfectly correct.
 */
async function whatsAppVisibility(req: Request) {
  const [messages, chat] = await Promise.all([
    commVisibilityWhere(req),
    commParentVisibilityWhere(req, 'messages'),
  ]);
  return { messages, chat };
}

/**
 * WhatsApp chat per-caller unread (#2049 slice 2 - the WhatsApp mirror of
 * SMS's attachCallerUnread, comm-threads.controller.ts). Reviewer amendment
 * R10 is BINDING here and does NOT match the SMS predicate: WhatsAppMessage
 * has no `direction` column, so inbound is `from <> 'us'` (the send path
 * hard-codes `from: 'us'`, see sendWhatsApp below), and the recency
 * comparison uses `created_at` - `WhatsAppMessage.at` is a display STRING
 * ("9:32 AM"), never sortable/comparable. ONE whatsAppChatReadState.findMany
 * for the WHOLE page, never a per-chat query. Returns NEW objects with
 * `unread` overwritten, exactly like the SMS/email mirrors, so
 * mapWhatsAppChat's existing `unread: c.unread` passthrough needs no change.
 */
export async function attachCallerUnreadWhatsApp<
  T extends { id: string; messages?: { from?: string | null; created_at: Date | string }[] },
>(req: Request, chats: T[]): Promise<(T & { unread: number })[]> {
  if (chats.length === 0) return [];
  const markers = await prisma.whatsAppChatReadState.findMany({
    where: {
      user_id: req.user!.id,
      ...tenantWhere(req),
      chat_id: { in: chats.map((c) => c.id) },
    },
    select: { chat_id: true, read_at: true },
  });
  const readAtByChat = new Map(
    (markers ?? []).map((m: { chat_id: string; read_at: Date }) => [m.chat_id, m.read_at]),
  );
  return chats.map((c) => {
    const readAt = readAtByChat.get(c.id) ?? null;
    const unread = (c.messages ?? []).filter((m) => {
      if (m.from === 'us') return false;
      if (!readAt) return true;
      return new Date(m.created_at).getTime() > new Date(readAt).getTime();
    }).length;
    return { ...c, unread };
  });
}

export async function listWhatsAppChats(req: Request, res: Response) {
  try {
    const scope = await whatsAppVisibility(req);
    const chats = await prisma.whatsAppChat.findMany({
      where: { ...tenantWhere(req), ...scope.chat },
      orderBy: { updated_at: 'desc' },
      include: {
        messages: { where: scope.messages, orderBy: { created_at: 'asc' } },
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        lead: { select: { id: true, lead_number: true } },
        vendor: { select: { id: true, name: true } },
      },
    });

    const withUnread = await attachCallerUnreadWhatsApp(req, chats);
    res.json({ chats: withUnread.map(mapWhatsAppChat) });
  } catch (err) {
    logger.error('Failed to list WhatsApp chats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getWhatsAppChat(req: Request, res: Response) {
  try {
    const scope = await whatsAppVisibility(req);
    const chat = await prisma.whatsAppChat.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...scope.chat },
      include: {
        messages: { where: scope.messages, orderBy: { created_at: 'asc' } },
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        lead: { select: { id: true, lead_number: true } },
        vendor: { select: { id: true, name: true } },
      },
    });

    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }

    const [withUnread] = await attachCallerUnreadWhatsApp(req, [chat]);
    res.json({ chat: mapWhatsAppChat(withUnread) });
  } catch (err) {
    logger.error('Failed to get WhatsApp chat:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Read-state routes (#2049 slice 2): PATCH /whatsapp/:id/read and
 * /whatsapp/:id/unread. Mirrors comm-threads.controller.ts::markThreadRead/
 * markThreadUnread exactly - read-side rights only (never `update`), the
 * same anchor-filtered lookup getWhatsAppChat uses, 404
 * `{"error":"Chat not found"}` for wrong-org/invisible/missing alike, caller
 * id from `req.user!.id` only (R8 - never `user_id` from the body/query/path).
 */
async function resolveVisibleChat(req: Request): Promise<{ id: string } | null> {
  const scope = await whatsAppVisibility(req);
  return prisma.whatsAppChat.findFirst({
    where: { id: req.params.id as string, ...tenantWhere(req), ...scope.chat },
    select: { id: true },
  });
}

export async function markWhatsAppChatRead(req: Request, res: Response) {
  try {
    const chat = await resolveVisibleChat(req);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    const now = new Date();
    await prisma.whatsAppChatReadState.upsert({
      where: { chat_id_user_id: { chat_id: chat.id, user_id: req.user!.id } },
      create: {
        chat_id: chat.id,
        user_id: req.user!.id,
        read_at: now,
        organization_id: req.user!.organization_id,
      },
      update: { read_at: now },
    });
    res.json({ updated: 1 });
  } catch (err) {
    logger.error('Failed to mark WhatsApp chat read:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function markWhatsAppChatUnread(req: Request, res: Response) {
  try {
    const chat = await resolveVisibleChat(req);
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }
    // A delete, never a `read_at: null`/flag flip - the same "exactly one way
    // for the table to disagree with itself" rule the SMS/email marker
    // models carry.
    await prisma.whatsAppChatReadState.deleteMany({
      where: { chat_id: chat.id, user_id: req.user!.id, ...tenantWhere(req) },
    });
    res.json({ updated: 1 });
  } catch (err) {
    logger.error('Failed to mark WhatsApp chat unread:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Internal create path for a WhatsApp chat (live Meta inbound is Plan W).
// Resolves the customer/lead/vendor from `phone` (DEC6); never auto-creates a
// Lead (P1 org-validates an explicit lead_id, which overrides the resolver lead).
export async function createWhatsAppChat(req: Request, res: Response) {
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

    const match = await matchByPhone(prisma, orgId, req.body.phone);

    const chat = await prisma.whatsAppChat.create({
      data: {
        name: req.body.name,
        org: req.body.org,
        phone: req.body.phone,
        last_at: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        customer_id: match?.customerId ?? null,
        lead_id: explicitLeadId ?? match?.leadId ?? null,
        vendor_id: match?.vendorId ?? null,
        organization_id: orgId,
      },
      include: { messages: { orderBy: { created_at: 'asc' } } },
    });

    logger.info(
      `WhatsApp chat created${match ? ` linked to ${match.kind} ${match.id}` : ' (unmatched)'}`,
    );
    res.status(201).json({ chat: mapWhatsAppChat(chat) });
  } catch (err) {
    logger.error('Failed to create WhatsApp chat:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function sendWhatsApp(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    // Scoped like the read paths: a caller who cannot see a conversation must
    // not be able to append to it either.
    const chat = await prisma.whatsAppChat.findFirst({
      where: {
        id: req.body.chat_id,
        ...tenantWhere(req),
        ...(await commParentVisibilityWhere(req, 'messages')),
      },
    });
    if (!chat) {
      res.status(404).json({ error: 'Chat not found' });
      return;
    }

    // Communication ↔ Jobs (spec §7): stamp job attribution at origin, under the
    // caller's own Job scope so a send cannot be attributed to a job they cannot
    // see (which would post the message straight out of their own view).
    let jobStamp: { job_id: string; job_label: string | null } | null = null;
    if (req.body.job_id) {
      const job = await prisma.job.findUnique({
        where: { id: req.body.job_id, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Job')) },
        select: { id: true, job_number: true },
      });
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      jobStamp = { job_id: job.id, job_label: job.job_number };
    }

    // No WhatsApp Business account exists for any org (there is no connection
    // model in schema.prisma): the demo org keeps the record-only showcase
    // branch, real orgs get an honest 409 - the same shape as the 501
    // EMAIL_SEND_NOT_CONFIGURED email branch below. Nothing pretends a message
    // was transmitted.
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { is_demo: true },
    });
    if (!org?.is_demo) {
      res.status(409).json({
        error: 'No WhatsApp Business account is connected for this organization',
        code: 'WHATSAPP_NOT_CONNECTED',
      });
      return;
    }

    const message = await prisma.whatsAppMessage.create({
      data: {
        chat_id: req.body.chat_id,
        from: 'us',
        text: req.body.text,
        at: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        status: 'sent',
        ...(jobStamp != null && { job_id: jobStamp.job_id, job_label: jobStamp.job_label }),
        // Inherit the chat's lead link onto the row itself. The visibility
        // filter reads WhatsAppMessage.lead_id directly (all four channels scope
        // on the same two columns now), so a message that only ever carried the
        // linkage on its parent chat would read as unanchored - i.e. org-wide.
        // The migration backfilled existing rows the same way.
        ...(chat.lead_id != null && { lead_id: chat.lead_id }),
        organization_id: orgId,
      },
    });

    // Touch the chat so it sorts to the top of the list.
    await prisma.whatsAppChat.updateMany({
      where: { id: req.body.chat_id, ...tenantWhere(req) },
      data: { last_at: message.at },
    });

    res.status(201).json({ message: mapWhatsAppMessage(message) });
  } catch (err) {
    logger.error('Failed to send WhatsApp message:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Email Handlers ────────────────────────────────────

/**
 * Email slice 8c: per-caller unread, computed from EmailReadState (the real
 * source of truth going forward) rather than the legacy shared `unread`
 * column. ONE extra query for the whole batch - never N+1 per row. Returns
 * NEW objects with `unread` overwritten so mapEmail's plain `e.unread`
 * passthrough needs no further changes.
 */
async function attachCallerUnread(req: Request, emails: any[]): Promise<any[]> {
  if (emails.length === 0) return emails;
  const readStates = await prisma.emailReadState.findMany({
    where: {
      user_id: req.user!.id,
      ...tenantWhere(req),
      email_id: { in: emails.map((e) => e.id) },
    },
    select: { email_id: true },
  });
  const readIds = new Set(readStates.map((r: { email_id: string }) => r.email_id));
  return emails.map((e) => ({ ...e, unread: !readIds.has(e.id) }));
}

/**
 * The job or lead a record conversation is about, on each row that sits in one (S10.9): `recordTie` carries the number to
 * show and the record to link to. ONE call for the whole page (`recordLabelsFor`), and only for a person's own reach: a job
 * or lead they cannot open is not named.
 */
async function attachRecordTie(req: Request, emails: any[]): Promise<any[]> {
  const threads = emails.map((e) => e.thread).filter((t) => t && t.origin === 'record');
  if (threads.length === 0) return emails;
  const [job, lead] = await Promise.all([scopeWhereForReq(req, 'Job'), scopeWhereForReq(req, 'Lead')]);
  const labels = await recordLabelsFor(prisma, { organizationId: req.user!.organization_id, threads, reach: { job, lead } });
  return emails.map((e) => (e.thread && labels.has(e.thread.id) ? { ...e, recordTie: labels.get(e.thread.id) } : e));
}

/**
 * "Matches several customers" (PRD 10, S10.20) on each received message that is waiting for a customer and comes from an address
 * several customers share: the flag a screen reads to offer the picker. ONE read for the whole page (`awaitingSeveralCustomers`),
 * and none when no message on the page is waiting for one.
 */
async function attachSeveralMatches(req: Request, emails: any[]): Promise<any[]> {
  const several = await awaitingSeveralCustomers(prisma, req.user!.organization_id, emails);
  return several.size === 0 ? emails : emails.map((e) => (several.has(e.id) ? { ...e, matchesSeveralCustomers: true } : e));
}

/**
 * Email slice 8b - Unassigned / Mine / All views. Assignment NEVER narrows
 * anchor-inherited visibility (Missive rule: "assigned to one, visible to
 * all") - this is an ADDITIONAL filter layered on top of the Email page's
 * Communication scope filter, never a replacement for it, and it rides the SAME
 * `thread` relation every read path already includes rather than a second,
 * competing scope.
 *
 * 'unassigned' folds in auto-unassign at query time (no reconciliation job):
 * a row with no thread at all, a thread with no assignee, and a thread whose
 * assignee has since gone `is_active: false` all count as Unassigned.
 *
 * MUTATES `where` in place rather than returning a fragment to spread: the
 * 'unassigned' branch is itself an `OR`, and a section filter can be an `OR`
 * too. Two top-level `OR` keys on the same plain-object spread collide - the
 * second silently overwrites the first - which would let
 * `?assignment=unassigned` replace the Communication scope instead of
 * narrowing it. `addOrFilter` (whereCompose.ts) demotes both disjunctions to
 * peers under `AND` instead, the anti-leak pattern `addOrFilter` exists for.
 * 'mine' filters on `thread`, a key the section filter owns, so it goes under
 * AND as well.
 */
function applyAssignmentFilter(where: Record<string, unknown>, req: Request, view: unknown): void {
  if (view === 'mine') {
    // Under AND, not `where.thread = ...`: the section filter already owns the `thread` key.
    addAndClause(where, { thread: { assigned_to_user_id: req.user!.id } });
    return;
  }
  if (view === 'unassigned') {
    addOrFilter(where, [
      { thread_id: null },
      { thread: { assigned_to_user_id: null } },
      { thread: { assigned_to: { is_active: false } } },
    ]);
  }
}

export async function listEmails(req: Request, res: Response) {
  try {
    // The Email page follows Communication scope (M11): "All" lists every email conversation, "Linked to me" the
    // ones in a mailbox the person holds. A job, lead or customer tie plays no part here; it only decides whether
    // a single message opens (getEmail).
    const where: any = {
      ...tenantWhere(req),
      ...(await emailsInSectionWhereForReq(req, req.query.mailbox)),
      // A message held in a Needs review list (S10.18) is not mail of the inbox: it has its own list (listUnmatchedEmails).
      review_reason: null,
    };
    applyAssignmentFilter(where, req, req.query.assignment);

    if (req.query.folder) {
      where.folder = typeof req.query.folder === 'string' ? req.query.folder : '';
    }
    if (req.query.account) {
      where.account = typeof req.query.account === 'string' ? req.query.account : '';
    }

    const emails = await prisma.email.findMany({
      where,
      orderBy: { ts: 'desc' },
      include: {
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        lead: { select: { id: true, lead_number: true } },
        vendor: { select: { id: true, name: true } },
        email_attachments: EMAIL_ATTACHMENTS_INCLUDE,
        thread: EMAIL_THREAD_INCLUDE,
      },
    });

    const withUnread = await attachSeveralMatches(req, await attachRecordTie(req, await attachCallerUnread(req, emails)));
    res.json({ emails: withUnread.map(mapEmail) });
  } catch (err) {
    logger.error('Failed to list emails:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** The Needs review list's page size: a page at a time, so a long list costs one bounded read. */
const REVIEW_PAGE_SIZE = 50;
const REVIEW_MAX_PAGE_SIZE = 100;

/**
 * The Needs review list (PRD 10, S10.18; the unmatched queue of email slice 6, grown into a per-mailbox list): inbound mail the
 * router held instead of delivering. It is an OPERATOR WORKLIST rather than a slice of the inbox: a held message carries no
 * conversation, so it belongs to no conversation view, and mixing it into the inbox is exactly how a forged message gets read as
 * a genuine one.
 *
 * `?mailbox=` picks the list (mine, a mailbox id, or on All, all); what the person sees follows the mailboxes they can see, and a
 * held reply to a record follows who can reach that record (lib/communication/needsReview.ts). Each item carries `linkTo`, the
 * conversation it was a reply to when the person can reach that conversation: the one-click answer to "Link to a conversation".
 */
export async function listUnmatchedEmails(req: Request, res: Response) {
  try {
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || REVIEW_PAGE_SIZE, 1), REVIEW_MAX_PAGE_SIZE);
    const offset = Math.max(Math.trunc(Number(req.query.offset)) || 0, 0);
    const { where, selection } = await needsReviewListWhereForReq(req, req.query.mailbox);

    const [emails, total] = await Promise.all([
      prisma.email.findMany({
        where,
        orderBy: [{ ts: 'desc' }, { id: 'asc' }],
        skip: offset,
        take: limit,
        include: { email_attachments: EMAIL_ATTACHMENTS_INCLUDE },
      }),
      prisma.email.count({ where }),
    ]);

    const held = await withHeldContext(req, emails);

    res.json({
      emails: held.map(mapHeldEmail),
      total,
      limit,
      offset,
      selected: selection.kind === 'mailbox' ? selection.id : selection.kind,
    });
  } catch (err) {
    logger.error('Failed to list unmatched emails:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** What a held message's list row and its item both carry: the job or lead its conversation is about, and the conversation to link to. */
async function withHeldContext(req: Request, emails: any[]): Promise<any[]> {
  // The conversation each reply belongs to, for the ones the person can link to: one read of the page's conversations.
  const threadIds = [...new Set(emails.flatMap((e) => (e.review_thread_id ? [e.review_thread_id] : [])))];
  if (threadIds.length === 0) return emails.map((e) => ({ ...e, linkTo: null }));
  const reach = await emailThreadReachWhereForReq(req, threadIds);
  const threads = await prisma.emailThread.findMany({
    where: { AND: [{ id: { in: threadIds } }, tenantWhere(req), reach] },
    select: {
      id: true, origin: true, record_type: true, record_id: true,
      emails: { orderBy: { ts: 'desc' }, take: 1, select: { subject: true } },
    },
  });
  const byId = new Map(threads.map((t) => [t.id, t]));
  // The job or lead the conversation is about, named for a person who can open it (the same call the Email list makes).
  const [job, lead] = await Promise.all([scopeWhereForReq(req, 'Job'), scopeWhereForReq(req, 'Lead')]);
  const labels = await recordLabelsFor(prisma, { organizationId: req.user!.organization_id, threads, reach: { job, lead } });
  return emails.map((e) => {
    const thread = e.review_thread_id ? byId.get(e.review_thread_id) : undefined;
    return {
      ...e,
      ...(thread && labels.has(thread.id) ? { recordTie: labels.get(thread.id) } : {}),
      linkTo: thread ? { threadId: thread.id, subject: thread.emails[0]?.subject ?? null } : null,
    };
  });
}

// A held reply was sent to one of our reply addresses, whose local part is a random token: the flag lets the screen say what the
// address is rather than print noise. The token itself is never needed by the screen.
const mapHeldEmail = (e: any) => ({
  ...mapEmail(e),
  ...(parseReplyAddress(e.to ?? '') !== null ? { toReplyAddress: true } : {}),
  linkTo: e.linkTo,
});

/**
 * One held message by id: the Needs review item a bell opens (PRD 10, S10.19). Anyone who can see it in a list sees it here, and a
 * reply from an address we did not send to also opens for anyone who can reach the conversation it replied to, whichever mailbox it
 * is filed under (lib/communication/needsReview.ts). Anyone else gets a 404, as for a message that is not there.
 */
export async function getUnmatchedEmail(req: Request, res: Response) {
  try {
    const email = await prisma.email.findFirst({
      where: await needsReviewItemWhereForReq(req, req.params.id as string),
      include: { email_attachments: EMAIL_ATTACHMENTS_INCLUDE },
    });
    if (!email) {
      res.status(404).json({ error: 'Email not found' });
      return;
    }
    const [item] = await withHeldContext(req, [email]);
    res.json({ email: mapHeldEmail(item) });
  } catch (err) {
    logger.error('Failed to get unmatched email:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export const linkInboundEmailSchema = z.object({
  // Optional: omitted means "the conversation this message was a reply to", which is the one-click case the retained reply
  // address exists to serve.
  thread_id: z.string().uuid('thread_id must be a valid id').optional(),
});

/**
 * Link a held message to a conversation by hand (email slice 6; PRD 10, S10.18).
 *
 * This is a HUMAN DECISION to trust a message the automatic checks would not, so it is scoped like any other write and never
 * inferred. It keeps PRD 8's filing rule (the route needs Edit communication records) and needs the person to see the held
 * message AND to reach the conversation they link it to: a conversation they cannot open is not theirs to file mail into.
 * Two things it deliberately does not do:
 *
 *  - It does not clear `inbound_auth`. A person linking a message does not retroactively make a sender check pass, and the
 *    conversation must still be able to show what was and was not proven about the sender.
 *  - It does not widen `expected_from` on the reply address. Linking this message says nothing about the next one from the same
 *    address, and quietly enrolling a new sender would turn one judgement call into a standing rule.
 */
export async function linkInboundEmail(req: Request, res: Response) {
  try {
    const email = await prisma.email.findFirst({
      where: await needsReviewItemWhereForReq(req, req.params.id as string),
      select: { id: true, reply_token: true, review_thread_id: true },
    });
    if (!email) {
      res.status(404).json({ error: 'Email not found' });
      return;
    }

    let targetId: string;
    if (req.body.thread_id) {
      targetId = req.body.thread_id;
    } else if (email.review_thread_id) {
      targetId = email.review_thread_id;
    } else {
      if (!email.reply_token) {
        res.status(400).json({
          error: 'This message was not a reply to one of your emails - choose a conversation to link it to.',
          code: 'NO_REPLY_TOKEN',
        });
        return;
      }
      const token = await resolveReplyToken(prisma, email.reply_token);
      if (!token?.thread_id) {
        res.status(400).json({
          error: 'The conversation this was a reply to is gone - choose one to link it to.',
          code: 'TOKEN_THREAD_GONE',
        });
        return;
      }
      targetId = token.thread_id;
    }

    // Resolved inside the tenant AND under the person's reach, never trusted from the body: linking a reply into another
    // company's conversation would be a cross-tenant write and a disclosure of the message, and into a conversation the person
    // cannot open a way to read it through the back door.
    const thread = await prisma.emailThread.findFirst({
      where: { AND: [{ id: targetId }, tenantWhere(req), await emailThreadReachWhereForReq(req, [targetId])] },
      select: { id: true },
    });
    if (!thread) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // Still held when this write lands, or somebody linked it first.
    const linked = await prisma.email.updateMany({
      where: { id: email.id, ...tenantWhere(req), review_reason: { not: null } },
      data: {
        thread_id: thread.id, inbound_match: 'MATCHED', folder: 'inbox',
        review_reason: null, review_mailbox_id: null, review_thread_id: null,
      },
    });
    if (linked.count === 0) {
      res.status(409).json({ error: 'This message has already been linked.', code: 'ALREADY_LINKED' });
      return;
    }

    const refetched = await prisma.email.findFirst({
      where: { id: email.id, ...tenantWhere(req) },
      include: {
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        lead: { select: { id: true, lead_number: true } },
        vendor: { select: { id: true, name: true } },
        email_attachments: EMAIL_ATTACHMENTS_INCLUDE,
        thread: EMAIL_THREAD_INCLUDE,
      },
    });
    if (!refetched) {
      res.status(404).json({ error: 'Email not found' });
      return;
    }
    const [withUnread] = await attachCallerUnread(req, [refetched]);
    res.json({ email: mapEmail(withUnread) });
  } catch (err) {
    logger.error('Failed to link inbound email:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getEmail(req: Request, res: Response) {
  try {
    const email = await prisma.email.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...(await emailReadWhereForReq(req, { emailId: req.params.id as string })) },
      include: {
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        lead: { select: { id: true, lead_number: true } },
        vendor: { select: { id: true, name: true } },
        email_attachments: EMAIL_ATTACHMENTS_INCLUDE,
        thread: EMAIL_THREAD_INCLUDE,
      },
    });

    if (!email) {
      res.status(404).json({ error: 'Email not found' });
      return;
    }

    const [withUnread] = await attachSeveralMatches(req, await attachRecordTie(req, await attachCallerUnread(req, [email])));
    res.json({ email: mapEmail(withUnread) });
  } catch (err) {
    logger.error('Failed to get email:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Compose-send failure wording (email slice 7). Same 409-vs-502 classification
// as the PO/stage-pickup senders (shared via dispatchFailureStatus so this and
// they can never disagree about whether an org-disabled skip is a 409 or a
// 502); wording is local to what a compose-window user actually did.
function mapComposeEmailFailure(
  result: Exclude<EmailDispatchResult, { status: 'sent' }>,
): { status: number; error: string; code: string } {
  const status = dispatchFailureStatus(result);
  if (result.status === 'skipped' && result.reason === 'org_disabled') {
    return { status, error: 'Email sending is turned off for this organization.', code: 'EMAIL_SENDING_DISABLED' };
  }
  if (result.status === 'skipped' && result.reason === 'address_needed') {
    return { status, error: ADDRESS_NEEDED_MESSAGE, code: 'ADDRESS_NEEDED' };
  }
  if (result.status === 'skipped' && result.reason === 'foreign_mailbox') {
    return { status, error: NOT_YOUR_ADDRESS_MESSAGE, code: 'MAILBOX_NOT_YOURS' };
  }
  if (result.status === 'skipped') {
    return { status, error: 'Email is not configured for this organization.', code: 'EMAIL_SEND_NOT_CONFIGURED' };
  }
  return { status, error: result.error, code: 'EMAIL_SEND_FAILED' };
}

/**
 * Email slice 8b - resolve a REPLY's claimed `thread_id` to the real
 * EmailThread it belongs to, under the caller's OWN visibility (mirrors the
 * job/customer anchor resolution just above: a caller must not be able to
 * attach a reply to a conversation they cannot see, which would both post the
 * message out of their own view and INTO whoever else's).
 *
 * Deliberately lenient on a miss: a `thread_id` that does not resolve to any
 * VISIBLE email (stale client state, a wrong id, or the still-supported old
 * frontend convention of sending the replied-to message's own id before it had
 * a real thread) falls back to `null` rather than 404ing the whole send - the
 * caller ends up starting a fresh thread, never blocked outright over a
 * client/server id mismatch on what is otherwise a routine reply.
 *
 * A non-UUID id is that same miss, and has to be screened BEFORE the query:
 * `Email.thread_id` is `@db.Uuid`, so Prisma raises P2023 rather than matching
 * nothing, and the lenient fallback above never gets to run. Not hypothetical -
 * the compose window mints a local `t_<epoch>` placeholder for its optimistic
 * row when there is no thread to reply to and submits it, so every fresh
 * compose 500'd in production while every reply (a real UUID) worked.
 */
async function resolveVisibleThreadId(req: Request, claimedThreadId: string): Promise<string | null> {
  if (!UUID_RE.test(claimedThreadId)) return null;

  const visible = await prisma.email.findFirst({
    where: { thread_id: claimedThreadId, ...tenantWhere(req), ...(await emailReadWhereForReq(req, { threadId: claimedThreadId })) },
    select: { thread_id: true },
  });
  return visible?.thread_id ?? null;
}

/**
 * Traffic Cop (email slice 8b, Help Scout's pattern): block a reply send if
 * the thread it targets picked up a newer message while the reply was being
 * composed, so two people never silently talk past each other. Read-only -
 * runs BEFORE sendComposedEmail is ever called, so a stale compose costs
 * nothing (no Resend call, no row). Returns the newer messages (oldest first)
 * when the guard trips, `null` when it is clear to proceed.
 *
 * Only fires when BOTH a resolved existing thread AND `composing_since` are
 * present - there is nothing to compare a brand-new thread against, and an
 * absent `composing_since` means the caller gave the guard no baseline (a
 * client-integration gap, not a policy toggle: this is always-on, but it
 * cannot compare against a timestamp it was never given).
 */
async function threadChangedSince(req: Request, threadId: string, composingSince: string): Promise<any[] | null> {
  const since = new Date(composingSince);
  // Only the messages the caller can read count: a conversation reached through a record is read message by message, so
  // a newer message on a record they cannot open neither trips the guard nor comes back in the 409.
  const readable = { thread_id: threadId, ...tenantWhere(req), ...(await emailReadWhereForReq(req, { threadId })) };
  const latest = await prisma.email.findFirst({
    where: readable,
    orderBy: { created_at: 'desc' },
    select: { created_at: true },
  });
  if (!latest || latest.created_at <= since) return null;

  return prisma.email.findMany({
    where: { ...readable, created_at: { gt: since } },
    orderBy: { created_at: 'asc' },
    include: {
      customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
      lead: { select: { id: true, lead_number: true } },
      vendor: { select: { id: true, name: true } },
      email_attachments: EMAIL_ATTACHMENTS_INCLUDE,
    },
  });
}

export async function sendEmail(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const now = new Date();

    // PRD 10 (S10.7): composing and replying on the Email page are mailbox actions, so they need Access Communication like
    // the list does. The route cannot say so (it also serves the job, lead and customer tabs' compose, which need no
    // section), so the line is drawn here: a reply, or a send that names no job, lead or customer, is the Email page's.
    const fromARecordTab = Boolean(req.body.job_id || req.body.lead_id || req.body.customer_id);
    if ((req.body.thread_id || !fromARecordTab) && !req.ability?.can('access_inbox', 'Communication')) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // PRD 10 (S10.11): a hand-written email goes out from the SENDER'S OWN mailbox, found by who they are and never by
    // anything the request says. A request that names another mailbox as the one to send from is refused (the main
    // mailbox, a colleague's, a handed-over one and another company's all alike, for a person on All too), and a person
    // with no address of their own yet is refused with the address-needed message. Both before anything is looked up.
    const sender = await resolveHandSender(prisma, { organizationId: orgId, userId: req.user!.id });
    if (req.body.from_mailbox_id && (!sender.ok || sender.sender.mailboxId !== req.body.from_mailbox_id)) {
      res.status(403).json({ error: NOT_YOUR_ADDRESS_MESSAGE, code: 'MAILBOX_NOT_YOURS' });
      return;
    }
    if (!sender.ok) {
      res.status(409).json({ error: ADDRESS_NEEDED_MESSAGE, code: 'ADDRESS_NEEDED' });
      return;
    }

    // Communication ↔ Jobs (spec §7): stamp job attribution at origin, under the
    // caller's own Job scope (see sendWhatsApp for the reasoning).
    let jobStamp: { job_id: string; job_label: string | null } | null = null;
    // The customer of the job or lead the email is written on (see `customerId` below).
    let recordCustomerId: string | null = null;
    if (req.body.job_id) {
      const job = await prisma.job.findUnique({
        where: { id: req.body.job_id, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Job')) },
        select: { id: true, job_number: true, customer_id: true },
      });
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      jobStamp = { job_id: job.id, job_label: job.job_number };
      recordCustomerId = job.customer_id;
    }

    // Attach-by-origin: a send composed from a customer page stamps that customer.
    if (req.body.customer_id) {
      const customer = await prisma.customer.findUnique({
        where: { id: req.body.customer_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
      }
    }

    // Attach-by-origin: a send composed from a lead page stamps that lead (spec #1751 D5).
    // Resolved before anything is dispatched, so a bad id 404s having sent nothing - the same
    // order the job and customer resolves above keep.
    //
    // Under the caller's OWN Lead row-scope as well as the tenant predicate, matching the SMS
    // composer (comm-threads.controller.ts sendMessage) and the job resolve directly above: a
    // sender must not be able to attach a message to a lead they cannot see. Unconditional-read
    // roles get `{}` here, so dispatcher/admin are unaffected.
    //
    // The tenant predicate alone was not enough, and the consequence was not merely cosmetic. The
    // attach ALSO stamps `leads.contacted_at`, which is first-touch-wins and therefore permanent,
    // so a SALES user whose Lead grants are conditioned on OWN_LEAD could credit a colleague's
    // lead with outreach that never happened - and no later, real outreach could correct it.
    // A lead out of scope is indistinguishable from one that does not exist (404, never 403), the
    // same no-existence-oracle rule the job resolve keeps.
    let leadStamp: string | null = null;
    if (req.body.lead_id) {
      const lead = await prisma.lead.findUnique({
        where: { id: req.body.lead_id, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Lead')) },
        select: { id: true, customer_id: true },
      });
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      leadStamp = lead.id;
      recordCustomerId ??= lead.customer_id;
    }

    // A job's or lead's email belongs to its customer, so it shows on that customer's Communication tab the way the
    // record's system emails do (persistTransactionalEmail stamps all three). The composer posts only the id of the
    // tab it was opened on, so the customer is read off the record here; a customer the composer did post wins.
    //
    // With neither, a hand-written email still belongs to the customer its recipient is (PRD 10, S10.20): linked on the recipient's
    // address when exactly one customer has it, so the customer's tab lists it with no linking by hand. Never a job or a lead.
    // A reply that none of these places takes the customer its conversation is already linked to (below, once the conversation is resolved).
    const placedCustomerId: string | null = req.body.customer_id ?? recordCustomerId ?? await customerOfRecipients(prisma, orgId, req.body.to);

    // Multipart attachments (multer.array('files', ...), comm-email.routes.ts).
    // Sniffed BEFORE the send so a bad file 400s without ever calling Resend or
    // creating any row - a rejected attachment must leave no trace at all.
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    for (const file of files) {
      if (
        !ALLOWED_MIME_TYPES.includes(file.mimetype) ||
        !sniffMatchesDeclared(file.buffer, file.mimetype, ALLOWED_MIME_TYPES)
      ) {
        res.status(400).json({
          error: `File type not allowed: ${file.originalname}. Accepted: ${ALLOWED_TYPES_LABEL}`,
        });
        return;
      }
    }

    const bodyParas: string[] = req.body.body ?? [];
    const subject = req.body.subject ?? '';
    // Paragraphs rejoin into one plain-text body for the actual send - Resend
    // takes a flat string, not an array. The array form is what gets persisted
    // (mirrors every reader that renders Email.body as one <p> per element).
    const text = bodyParas.join('\n\n');
    // SECURITY: this HTML is later rendered verbatim (dangerouslySetInnerHTML,
    // InboxPage.tsx) to every org member who can see the thread, not just the
    // sender - a client-supplied <script>/onerror etc. must never reach
    // storage unsanitized. Sanitize once, up front, and reuse the SAME value
    // for the outbound dispatch and the persisted row so what actually went
    // out matches what the Sent view renders back.
    const bodyHtml = req.body.body_html ? sanitizeEmailHtml(req.body.body_html) : undefined;

    // Email slice 8b: a REPLY (thread_id present) resolves and REUSES the
    // existing EmailThread rather than writing the raw client string through -
    // resolvedThreadId is null for a fresh compose (no thread_id at all) OR an
    // unresolvable one (see resolveVisibleThreadId), both of which mint a new
    // thread further down. Resolution + the Traffic Cop check are read-only
    // and run BEFORE dispatch; creating a NEW thread is a write and stays
    // deferred to after a successful send, same as the Email row itself.
    const resolvedThreadId = req.body.thread_id
      ? await resolveVisibleThreadId(req, req.body.thread_id)
      : null;

    // The conversation's customer is the one customer its messages name (none, or several, decide nothing). The thread was resolved
    // under the caller's own reach just above, so this reads nothing the caller could not already open.
    const threadCustomers = placedCustomerId || !resolvedThreadId ? [] : await prisma.email.findMany({
      where: { thread_id: resolvedThreadId, ...tenantWhere(req), customer_id: { not: null } },
      select: { customer_id: true },
      distinct: ['customer_id'],
      take: 2,
    });
    const customerId: string | null = placedCustomerId ?? (threadCustomers.length === 1 ? threadCustomers[0]!.customer_id : null);

    if (resolvedThreadId && req.body.composing_since) {
      const newerMessages = await threadChangedSince(req, resolvedThreadId, req.body.composing_since);
      if (newerMessages) {
        // Per mapEmail's own contract, `unread` must be caller-computed via
        // attachCallerUnread before mapping - skipping it here would fall back
        // to the dead `Email.unread` column, which nothing writes anymore.
        const newerWithUnread = await attachCallerUnread(req, newerMessages);
        res.status(409).json({
          error: 'This conversation has new messages - refresh before sending.',
          code: 'THREAD_CHANGED',
          messages: newerWithUnread.map(mapEmail),
        });
        return;
      }
    }

    // Email slice 6: PHASE 1 of the reply token - resolve an existing address
    // for this conversation, or generate a candidate. Read-only on purpose: the
    // thread this token will hang off does not exist yet (it is created below,
    // only after a successful dispatch), and writing a token row for a send that
    // may never leave would break the same invariant the Email row keeps. The
    // header, however, has to be built now, before we know the outcome.
    const replyToken = await prepareReplyToken(prisma, {
      organization_id: orgId,
      thread_id: resolvedThreadId,
      customer_id: customerId,
      expected_from: req.body.to,
      created_by_user_id: req.user!.id,
    });

    const result = await sendComposedEmail({
      organizationId: orgId,
      to: req.body.to,
      cc: req.body.cc,
      bcc: req.body.bcc,
      subject,
      text,
      html: bodyHtml,
      replyTo: replyAddressFor(replyToken.token),
      handSender: { mailboxId: sender.sender.mailboxId, userId: req.user!.id },
      attachments: files.map((file) => ({
        filename: file.originalname,
        content: file.buffer,
        contentType: file.mimetype,
      })),
    });

    if (result.status !== 'sent') {
      // A dispatch that never left persists NOTHING - no row, no upload, no
      // attachment rows. Persisting a "sent" mirror of a message nobody
      // received would be a lie the inbox has no way to detect.
      const failure = mapComposeEmailFailure(result);
      res.status(failure.status).json({ error: failure.error, code: failure.code });
      return;
    }

    // Thread reuse (reply) or creation (fresh compose / unresolvable reply) -
    // deferred until AFTER a successful dispatch, so a send that never left
    // never leaves an orphan EmailThread behind either (same invariant as the
    // Email row itself, just above). Missive/Front-style default: you sent it,
    // you own it until reassigned - a fresh thread starts assigned to the sender, in the sender's own mailbox
    // (the mailbox the message went out from, S10.11).
    const threadId = resolvedThreadId
      ?? (await prisma.emailThread.create({
        data: await startedConversationData(prisma, orgId, req.user!.id, sender.sender.mailboxId),
      })).id;

    // Email slice 6: PHASE 2 - the send left, so the address we advertised in
    // Reply-To is now real and has to resolve. `persist` is false when phase 1
    // reused a live token, in which case a second row would just be a duplicate
    // address for the same conversation. The thread id is attached HERE because
    // this is the first moment it exists for a fresh compose.
    //
    // Best-effort, like the attachment uploads below: the message has already
    // reached the customer, so failing the whole request now would report a
    // send that plainly happened as a failure. The cost of the catch is that a
    // reply to this particular message routes to the unmatched queue instead of
    // the thread - visible and recoverable, which is the right trade against
    // lying about the send.
    if (replyToken.persist) {
      try {
        await persistReplyToken(prisma, {
          token: replyToken.token,
          organization_id: orgId,
          thread_id: threadId,
          customer_id: customerId,
          expected_from: req.body.to,
          created_by_user_id: req.user!.id,
        });
      } catch (err) {
        logger.error(`Failed to persist reply token for thread ${threadId}:`, err);
      }
    }

    const email = await prisma.email.create({
      data: {
        // Server-owned, never from the request body. 'system' is a load-bearing
        // marker meaning "sent automatically by the app": job-communications.ts
        // sets `transactional: true` from `account === 'system'`, and two
        // backfills in job.controller.ts updateMany on it. A client able to set
        // this field could mislabel its own mail as app-generated, so the value
        // is fixed here and `account` is absent from sendEmailSchema.
        account: HUMAN_COMPOSED_ACCOUNT,
        // fromAddress/fromName come off the dispatch result, never re-derived -
        // the same discipline persistTransactionalEmail documents (BUG B drift).
        from: { name: result.fromName ?? result.fromAddress, email: result.fromAddress },
        provider_message_id: result.providerMessageId,
        delivery_status: 'SENT',
        delivery_status_at: now,
        to: req.body.to,
        // Treat an empty string the same as absent - a blank Cc/Bcc field the
        // client still submits should not persist as `""` while an omitted one
        // persists as `null`, which would make mapEmail expose one and hide the
        // other for no real difference in meaning.
        cc: req.body.cc || null,
        bcc: req.body.bcc || null,
        subject,
        snippet: bodyParas[0] ?? '',
        body: bodyParas,
        body_html: bodyHtml ?? null,
        at: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        ts: now.getTime(),
        unread: false,
        starred: false,
        folder: 'sent',
        direction: 'out',
        thread_id: threadId,
        // Email slice 8b: who sent it, immutable. Always the authenticated
        // caller - never trusted from the request body.
        sent_by_user_id: req.user!.id,
        has_attachment: files.length > 0,
        // Spec #1751 D5 - PROVENANCE. A person opened a compose window and typed this, which is
        // precisely what the lead contact clock is meant to count. Stated outright rather than
        // left to the column default, so the two email writers each declare what they are and
        // neither can be read by accident of which one happened to run.
        automated: false,
        ...(jobStamp != null && { job_id: jobStamp.job_id, job_label: jobStamp.job_label }),
        ...(customerId != null && { customer_id: customerId }),
        ...(leadStamp != null && { lead_id: leadStamp }),
        organization_id: orgId,
      },
    });

    // PRD 10 (S10.11): the first person to reply in a main-mailbox conversation with no assignee takes it. One
    // conditional write after the reply is stored, so two people replying at once cannot both win and the loser's
    // reply is still sent and stored. Best-effort like the bookkeeping below: the reply has already reached the customer.
    if (resolvedThreadId) {
      try {
        await takeConversationOnFirstReply(prisma, { organizationId: orgId, threadId: resolvedThreadId, userId: req.user!.id });
      } catch (err) {
        logger.error(`Failed to assign thread ${resolvedThreadId} to its first replier:`, err);
      }
    }

    // Spec #1751 D5: a human-written outbound email to a lead marks it contacted. Read off the
    // ROW, so the filter tests what was persisted rather than re-deriving it from the request.
    //
    // Awaited and unable to throw (lead-contact.service.ts). The message has already reached the
    // customer by this point, exactly like the attachment uploads below, so failing the request
    // over the bookkeeping would report a send that plainly happened as a failure.
    // `{ client }`: the clock stamp and the New -> Contacted move (#2618) run in one transaction of
    // their own. The sender is the authenticated caller.
    await recordLeadOutboundContact({ client: prisma }, {
      leadId: email.lead_id,
      orgId: email.organization_id,
      channel: 'email',
      direction: email.direction,
      automated: email.automated,
      at: now,
      actorId: req.user!.id,
    });

    // Email slice 8c: the sender has, by definition, already read their own
    // sent message - stamp their OWN read state rather than leave the row
    // reading as unread-for-everyone (including themselves) the moment
    // per-caller unread starts being computed off EmailReadState. Nobody
    // else's read state is touched.
    await prisma.emailReadState.create({
      data: { email_id: email.id, user_id: req.user!.id, read_at: now, organization_id: orgId },
    });

    // Upload + persist attachments AFTER the row exists - storage_path is keyed
    // on the email's own id. Best-effort: the email already sent, so a storage
    // hiccup here must not fail the whole request (persistTransactionalEmail's
    // same "never throws" discipline) - that file is just missing from the
    // response's attachment list, logged rather than thrown.
    const createdAttachments: { file_name: string; file_size: number; content_type: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const storagePath = `${orgId}/email/${email.id}/${Date.now()}-${sanitizeAttachmentFilename(file.originalname)}`;

      const { error: uploadError } = await supabaseAdmin.storage
        .from(ATTACHMENTS_BUCKET)
        .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });

      if (uploadError) {
        logger.error(`Failed to upload email attachment ${file.originalname} for email ${email.id}:`, uploadError);
        continue;
      }

      const created = await prisma.emailAttachment.create({
        data: {
          email_id: email.id,
          file_name: file.originalname,
          content_type: file.mimetype,
          file_size: file.size,
          storage_path: storagePath,
          position: i,
          organization_id: orgId,
        },
      });
      createdAttachments.push(created);
    }

    res.status(201).json({ email: mapEmail({ ...email, email_attachments: createdAttachments }) });
  } catch (err) {
    logger.error('Failed to send email:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/communication/emails/:id/attachments/:index - mint a fresh signed
// URL for one attachment (email slice 7). Mirrors
// GET /api/communication/calls/:id/recording's { url } contract exactly: same
// response shape, same "never 500 on a missing/out-of-range target" contract.
//
// The visibility filter is NOT optional here: this mints a signed URL into the
// PRIVATE attachments bucket, so a scoped list beside an unscoped sub-resource
// would be the classic hole (same reasoning as getCallRecording).
export async function getEmailAttachmentUrl(req: Request, res: Response) {
  try {
    const email = await prisma.email.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...(await emailReadWhereForReq(req, { emailId: req.params.id as string })) },
      select: { id: true },
    });
    if (!email) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }

    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }

    // Same [position asc, created_at asc] ordering as every include of this
    // relation - the requested index must mean the same thing everywhere.
    // organization_id is spread here too (defense-in-depth, not load-bearing -
    // email_id already came off a tenant+visibility-checked findFirst above,
    // and email_id is a unique per-row FK, so it cannot straddle two orgs) to
    // match the stamping convention every other EmailAttachment query in this
    // file follows.
    const attachments = await prisma.emailAttachment.findMany({
      where: { email_id: email.id, ...tenantWhere(req) },
      orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
    });
    const attachment = attachments[index];
    if (!attachment) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }

    const url = await buildAccessUrl(attachment.storage_path, '');
    res.json({ url });
  } catch (err) {
    logger.error('Failed to get email attachment url:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/communication/emails/attach-source?job_id=...|customer_id=...|estimate_id=...|invoice_id=...
// "Attach from this record" (email slice 7) - a read-only lookup of an entity's
// EXISTING generic Attachment rows (photos/docs already uploaded elsewhere) so
// a compose window can pull one in without re-uploading. Reuses
// attachment.controller.ts's own signed-url minting (lib/attachment-access.ts)
// rather than a parallel copy.
const ATTACH_SOURCE_PARAMS: [AttachmentEntity, string][] = [
  ['JOB', 'job_id'],
  ['CUSTOMER', 'customer_id'],
  ['ESTIMATE', 'estimate_id'],
  ['INVOICE', 'invoice_id'],
];

export async function listAttachSources(req: Request, res: Response) {
  try {
    const match = ATTACH_SOURCE_PARAMS.find(([, param]) => typeof req.query[param] === 'string');
    if (!match) {
      res.status(400).json({ error: 'One of job_id, customer_id, estimate_id, invoice_id is required' });
      return;
    }
    const [entityType, param] = match;
    const entityId = req.query[param] as string;

    // SECURITY: `read Communication` is an unconditional grant for every role
    // (including TECHNICIAN), so the route-level canDo gate is a no-op here -
    // without this check, any in-org caller could pull freshly-signed
    // download URLs for attachments on a job/estimate/invoice they have no
    // right to see anywhere else in the app just by guessing its id. Reuse
    // attachment.controller.ts's own per-role/per-entity access check rather
    // than a second hand-rolled scope that could drift from it.
    if (!(await checkEntityAccess(entityType, entityId, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const rows = await prisma.attachment.findMany({
      where: { entity_type: entityType, entity_id: entityId, ...tenantWhere(req) },
      select: {
        id: true,
        file_name: true,
        file_url: true,
        storage_path: true,
        file_type: true,
        file_size: true,
        display_name: true,
        created_at: true,
      },
      orderBy: { created_at: 'desc' },
    });

    const signed = await Promise.all(
      rows.map(async (row) => {
        const { storage_path, ...rest } = row;
        return { ...rest, file_url: await buildAccessUrl(storage_path, row.file_url) };
      }),
    );

    res.json({ attachments: signed });
  } catch (err) {
    logger.error('Failed to list attach-source attachments:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Picking the customer of a message that matches several (PRD 10, S10.20) ─────────────────────────────────────────────

const CUSTOMER_MATCHES_PAGE = 50;
const CUSTOMER_MATCHES_MAX_PAGE = 100;

/** The columns the picker needs of a message: whether it is waiting for a customer, where it came from, and where it sits. */
const WAITING_SELECT = {
  id: true, from: true, direction: true, customer_id: true, reply_token: true, review_reason: true, job_id: true, lead_id: true,
  vendor_id: true, thread_id: true,
} as const;

/** The message a picker call is about: one the person can read, in their company, that is waiting for a customer; or the answer to send. */
async function waitingEmailFor(req: Request, res: Response) {
  const id = req.params.id as string;
  if (!UUID_RE.test(id)) {
    res.status(404).json({ error: 'Email not found' });
    return null;
  }
  const email = await prisma.email.findFirst({
    where: { id, ...tenantWhere(req), ...(await emailReadWhereForReq(req, { emailId: id })) },
    select: WAITING_SELECT,
  });
  if (!email) {
    res.status(404).json({ error: 'Email not found' });
    return null;
  }
  if (!awaitsCustomer(email)) {
    res.status(409).json({ error: 'This message is not waiting for a customer.', code: 'NOT_WAITING_FOR_CUSTOMER' });
    return null;
  }
  return { email, address: senderAddressOfRow(email) };
}

const customerNameOf = (c: { company_name: string | null; first_name: string | null; last_name: string | null }) =>
  c.company_name ?? [c.first_name, c.last_name].filter(Boolean).join(' ');

/**
 * GET /emails/:id/customer-candidates - the customers a received message could belong to: those that have its sender's address,
 * limited to the ones the person can open, a page at a time and searchable by name or number (an address can be shared by a
 * whole franchise). Needs the attach switch like the pick itself: it is the first half of it.
 */
export async function listCustomerMatches(req: Request, res: Response) {
  try {
    const waiting = await waitingEmailFor(req, res);
    if (!waiting) return;
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || CUSTOMER_MATCHES_PAGE, 1), CUSTOMER_MATCHES_MAX_PAGE);
    const words = (typeof req.query.search === 'string' ? req.query.search : '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
    const ids = waiting.address ? await customerIdsWithAddress(prisma, req.user!.organization_id, waiting.address) : [];
    const where = {
      id: { in: ids }, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Customer')),
      AND: words.map((w) => ({
        OR: ['first_name', 'last_name', 'company_name', 'customer_number'].map((f) => ({ [f]: { contains: w, mode: 'insensitive' as const } })),
      })),
    };
    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where, orderBy: [{ created_at: 'desc' }, { id: 'asc' }], take: limit,
        select: { id: true, customer_number: true, first_name: true, last_name: true, company_name: true },
      }),
      prisma.customer.count({ where }),
    ]);
    res.json({ customers: customers.map((c) => ({ id: c.id, name: customerNameOf(c), number: c.customer_number })), total });
  } catch (err) {
    logger.error('Failed to list customer matches for an email:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export const pickEmailCustomerSchema = z.object({
  customer_id: z.string().uuid('customer_id must be a valid id'),
});

/**
 * PATCH /emails/:id/customer - a person picks which of the customers that share a sender's address a message belongs to. It keeps
 * PRD 8's attach rule (the route needs the attach switch) and needs the person to read the message and to open the customer they
 * pick, who must be one of the matches: a pick is a choice among the offered, never a way to link mail to any customer.
 *
 * The conversation's own replies follow: what the person sent back to that address, and any other message from it, that still
 * name no customer. Linking is to the CUSTOMER only; it never attaches the message to a job or a lead.
 */
export async function pickEmailCustomer(req: Request, res: Response) {
  try {
    const waiting = await waitingEmailFor(req, res);
    if (!waiting) return;
    const orgId = req.user!.organization_id;
    const ids = waiting.address ? await customerIdsWithAddress(prisma, orgId, waiting.address) : [];
    const customer = ids.includes(req.body.customer_id)
      ? await prisma.customer.findFirst({
          where: { id: req.body.customer_id, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Customer')) },
          select: { id: true },
        })
      : null;
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // The message itself, still waiting when this write lands (somebody may have picked first), then its conversation's replies.
    const linked = await prisma.email.updateMany({
      where: { id: waiting.email.id, ...tenantWhere(req), customer_id: null, job_id: null, lead_id: null, vendor_id: null },
      data: { customer_id: customer.id },
    });
    if (linked.count === 0) {
      res.status(409).json({ error: 'This message already has a customer.', code: 'NOT_WAITING_FOR_CUSTOMER' });
      return;
    }
    if (waiting.email.thread_id) {
      // The reply address made for the picked address before the pick carries the customer too, so the customer's answer to a
      // reply sent earlier lands on the same customer's tab.
      await prisma.replyToken.updateMany({
        where: { thread_id: waiting.email.thread_id, organization_id: orgId, expected_from: waiting.address!, customer_id: null },
        data: { customer_id: customer.id },
      });
      const siblings = await prisma.email.findMany({
        where: {
          thread_id: waiting.email.thread_id, ...tenantWhere(req), customer_id: null, job_id: null, lead_id: null, vendor_id: null,
          review_reason: null, reply_token: null,
        },
        select: { id: true, from: true, to: true, direction: true },
      });
      const same = siblings.filter((e) => (e.direction === 'out' ? addressesIn(e.to).includes(waiting.address!) : senderAddressOfRow(e) === waiting.address));
      if (same.length > 0) {
        await prisma.email.updateMany({ where: { id: { in: same.map((e) => e.id) }, ...tenantWhere(req), customer_id: null }, data: { customer_id: customer.id } });
      }
    }

    const refetched = await prisma.email.findFirst({
      where: { id: waiting.email.id, ...tenantWhere(req) },
      include: {
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
        lead: { select: { id: true, lead_number: true } },
        vendor: { select: { id: true, name: true } },
        email_attachments: EMAIL_ATTACHMENTS_INCLUDE,
        thread: EMAIL_THREAD_INCLUDE,
      },
    });
    if (!refetched) {
      res.status(404).json({ error: 'Email not found' });
      return;
    }
    const [withUnread] = await attachCallerUnread(req, [refetched]);
    res.json({ email: mapEmail(withUnread) });
  } catch (err) {
    logger.error('Failed to pick the customer of an email:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// One-click reassign of an email's job attribution - the email mirror of
// comm-threads.controller's reassignMessageJob (job_id: null clears). Without
// it an email could only ever be attributed at send time, so a miss (or a
// transactional send that guessed wrong) was uncorrectable from the UI, while
// the SMS beside it in the same roll-up was one click away.
// What a reassigned email is read back with.
const REASSIGNED_EMAIL_INCLUDE = {
  customer: { select: { id: true, first_name: true, last_name: true, company_name: true } },
  lead: { select: { id: true, lead_number: true } },
  vendor: { select: { id: true, name: true } },
  email_attachments: EMAIL_ATTACHMENTS_INCLUDE,
} as const;

export const reassignEmailJobSchema = z.object({
  job_id: z.string().uuid('job_id must be a valid id').nullable(),
});

export async function reassignEmailJob(req: Request, res: Response) {
  try {
    // Resolved once and applied to the pre-read, the updateMany AND the refetch,
    // exactly as the call/SMS mirrors do (comm-calls.controller's reassignCallJob
    // carries the reasoning). The refetch matters most here: it renders back
    // through mapEmail, which carries `body`/`bodyHtml`, so an unscoped one hands
    // over the message content rather than merely confirming a row exists - and
    // the clear path (`job_id: null`) reaches it with no pre-check at all.
    const visibility = await emailReadWhereForReq(req, { emailId: req.params.id as string });
    let data: { job_id: string | null; job_label: string | null };
    if (req.body.job_id != null) {
      // Emails carry no MessageThread, so there is no internal-lane (kind)
      // guard to apply. What the email row DOES carry is customer_id, which
      // plays the part the thread's customer_id plays for SMS.
      const email = await prisma.email.findFirst({
        where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
        select: { id: true, customer_id: true },
      });
      if (!email) {
        res.status(404).json({ error: 'Email not found' });
        return;
      }
      // Resolved under the caller's OWN Job row-scope, not tenancy alone: a
      // caller must not be able to attribute an email to a job they cannot see
      // (that would both hide the row from themselves and surface it to that
      // job's crew). It is also what keeps the refetch below non-empty, since
      // the row stays inside their scope after the write. Unconditional-read
      // roles get {} here, so nothing changes for dispatcher/admin.
      const job = await prisma.job.findUnique({
        where: { id: req.body.job_id, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Job')) },
        select: { id: true, job_number: true, customer_id: true },
      });
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      // Same-customer constraint (mirrors the SMS reassign): another customer's
      // job is indistinguishable from a nonexistent one → 404 'Job not found'.
      // Customer-less emails (vendor/unanchored) keep org-scope-only validation.
      if (email.customer_id && job.customer_id !== email.customer_id) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }
      data = { job_id: job.id, job_label: job.job_number };
    } else {
      data = { job_id: null, job_label: null };
    }

    // updateMany with id+org filter is atomic - no TOCTOU window.
    const result = await prisma.email.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      data,
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Email not found' });
      return;
    }

    // Same filter as the update. An attach or a move cannot empty it: the target job above is resolved under the
    // caller's own Job scope, so the row they just wrote is still reachable through it. A detach can: an email that
    // was readable only through the record it was taken off is no longer theirs to read. The change is done, so the
    // answer is a success that says the row left, not a 404 or a crash.
    const updated = await prisma.email.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      include: REASSIGNED_EMAIL_INCLUDE,
    });
    if (!updated) {
      res.json({ email: null, left: true });
      return;
    }

    res.json({ email: mapEmail(updated) });
  } catch (err) {
    logger.error('Failed to reassign email job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// The lead mirror of reassignEmailJob (lead_id: null clears), the email counterpart of reassignMessageLead. A job and
// a lead stay independent on an email, as they do on a text.
export const reassignEmailLeadSchema = z.object({
  lead_id: z.string().uuid('lead_id must be a valid id').nullable(),
});

export async function reassignEmailLead(req: Request, res: Response) {
  try {
    // One filter for the pre-read, the update and the refetch, as reassignEmailJob does.
    const visibility = await emailReadWhereForReq(req, { emailId: req.params.id as string });
    let data: { lead_id: string | null };
    if (req.body.lead_id != null) {
      const email = await prisma.email.findFirst({
        where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
        select: { id: true, customer_id: true },
      });
      if (!email) {
        res.status(404).json({ error: 'Email not found' });
        return;
      }
      // Under the caller's OWN Lead row-scope, not tenancy alone: a caller must not attribute an email to a lead they
      // cannot open. It also keeps the refetch below non-empty, since the row stays reachable through that lead.
      const lead = await prisma.lead.findUnique({
        where: { id: req.body.lead_id, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Lead')) },
        select: { id: true, customer_id: true },
      });
      if (!lead) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      // Same-customer constraint (mirrors reassignEmailJob): another customer's lead is indistinguishable from a
      // nonexistent one. Customer-less emails keep org-scope-only validation.
      if (email.customer_id && lead.customer_id !== email.customer_id) {
        res.status(404).json({ error: 'Lead not found' });
        return;
      }
      data = { lead_id: lead.id };
    } else {
      data = { lead_id: null };
    }

    const result = await prisma.email.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      data,
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Email not found' });
      return;
    }

    const updated = await prisma.email.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...visibility },
      include: REASSIGNED_EMAIL_INCLUDE,
    });
    if (!updated) {
      res.json({ email: null, left: true });
      return;
    }

    res.json({ email: mapEmail(updated) });
  } catch (err) {
    logger.error('Failed to reassign email lead:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Opening a thread in the inbox marks every message in it read - FOR THE
 * CALLING USER ONLY (email slice 8c). This is the exact fix for the bug this
 * endpoint used to have: it wrote the shared `Email.unread` column, so one
 * person opening a thread marked it read for the entire org. Now it upserts
 * one EmailReadState row per (email, req.user!.id) - every OTHER user's read
 * state is untouched, because there is no other user's state to touch here.
 *
 * Row-scoped too: the set of rows this can mark read is the set the caller can
 * read (`emailReadWhereForReq`: their mailboxes' conversations, and the rows
 * they reach through a record they can open), so a caller cannot use this as a
 * write-side visibility bypass to learn about (or affect) rows they cannot
 * otherwise see.
 *
 * `createMany({ skipDuplicates: true })` rather than N per-row upserts: one
 * write for the whole thread, and a message the caller already read is simply
 * skipped (its `read_at` is not bumped) rather than erroring on the unique
 * constraint. `updated` now means "newly marked read for me" - re-opening an
 * already-read thread reports 0, not the thread's total size.
 *
 * A non-UUID thread id reports that same 0 (see resolveVisibleThreadId for the
 * P2023 this screens out). The inbox can hold a thread that exists only on the
 * client - an optimistic row for a compose still in flight - and opening it
 * must not 500; there is simply nothing stored to mark read yet.
 */
export async function markThreadRead(req: Request, res: Response) {
  try {
    if (!UUID_RE.test(req.body.thread_id)) {
      res.json({ updated: 0 });
      return;
    }

    const visibleEmails = await prisma.email.findMany({
      where: {
        ...tenantWhere(req),
        ...(await emailReadWhereForReq(req, { threadId: req.body.thread_id })),
        thread_id: req.body.thread_id,
      },
      select: { id: true },
    });

    if (visibleEmails.length === 0) {
      res.json({ updated: 0 });
      return;
    }

    const now = new Date();
    const result = await prisma.emailReadState.createMany({
      data: visibleEmails.map((e: { id: string }) => ({
        email_id: e.id,
        user_id: req.user!.id,
        read_at: now,
        organization_id: req.user!.organization_id,
      })),
      skipDuplicates: true,
    });
    res.json({ updated: result.count });
  } catch (err) {
    logger.error('Failed to mark thread read:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * #2049 - the persisted half of "Mark as unread" (previously React-state-only
 * in InboxPage's `updateEmail`). Deletes THIS caller's `EmailReadState` rows
 * for the thread's visible emails - a delete, never a `read: false` column,
 * the same "exactly one way for the table to disagree with itself" rule
 * `markThreadRead` above already follows. Row-scoped and non-UUID-safe for the
 * same reasons as `markThreadRead`.
 */
export async function markThreadUnread(req: Request, res: Response) {
  try {
    if (!UUID_RE.test(req.body.thread_id)) {
      res.json({ updated: 0 });
      return;
    }

    const visibleEmails = await prisma.email.findMany({
      where: {
        ...tenantWhere(req),
        ...(await emailReadWhereForReq(req, { threadId: req.body.thread_id })),
        thread_id: req.body.thread_id,
      },
      select: { id: true },
    });

    if (visibleEmails.length === 0) {
      res.json({ updated: 0 });
      return;
    }

    const result = await prisma.emailReadState.deleteMany({
      where: {
        email_id: { in: visibleEmails.map((e: { id: string }) => e.id) },
        user_id: req.user!.id,
        ...tenantWhere(req),
      },
    });
    res.json({ updated: result.count });
  } catch (err) {
    logger.error('Failed to mark thread unread:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Email slice 8b - conversation assignment + archive/snooze. All three share
 * the exact same scoping shape: EmailThread carries no job_id/lead_id/
 * customer_id of its own, so visibility rides `emailThreadReadWhereForReq` -
 * the to-many "at least one child email is readable" filter built from the
 * same Communication scope rule as every other email read (communicationScope.ts),
 * not a second, competing gate. `updateMany` + refetch (rather
 * than a bare `.update`) mirrors reassignEmailJob just above: atomic, and the
 * refetch can never be broader than the write that preceded it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function updateEmailThread(req: Request, res: Response, data: any): Promise<void> {
  // A thread id that is not a UUID is the same 404 as one that does not exist -
  // screened here because `EmailThread.id` is `@db.Uuid` and Prisma would raise
  // P2023 instead (see resolveVisibleThreadId). Reachable from the inbox: a
  // compose still in its undo window shows an optimistic row whose thread only
  // exists client-side, and assigning it must not 500.
  if (!UUID_RE.test(req.params.id as string)) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }

  const scope = { ...tenantWhere(req), ...(await emailThreadReadWhereForReq(req, req.params.id as string)) };
  const result = await prisma.emailThread.updateMany({
    where: { id: req.params.id as string, ...scope },
    data,
  });
  if (result.count === 0) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }
  const updated = await prisma.emailThread.findFirst({
    where: { id: req.params.id as string, ...tenantWhere(req) },
    include: { assigned_to: { select: { id: true, is_active: true } } },
  });
  res.json({ thread: mapEmailThread(updated) });
}

export async function assignEmailThread(req: Request, res: Response) {
  try {
    if (req.body.user_id != null) {
      const assignee = await prisma.user.findFirst({
        where: { id: req.body.user_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!assignee) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
    }
    await updateEmailThread(req, res, { assigned_to_user_id: req.body.user_id });
  } catch (err) {
    logger.error('Failed to assign email thread:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function archiveEmailThread(req: Request, res: Response) {
  try {
    await updateEmailThread(req, res, { archived: req.body.archived });
  } catch (err) {
    logger.error('Failed to archive email thread:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function snoozeEmailThread(req: Request, res: Response) {
  try {
    await updateEmailThread(req, res, {
      snoozed_until: req.body.snoozed_until ? new Date(req.body.snoozed_until) : null,
    });
  } catch (err) {
    logger.error('Failed to snooze email thread:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// The attachment download endpoint was deleted with the Gmail mirror: it only
// ever streamed bytes from the Gmail API, so it could never serve anything
// again. Attachments get rebuilt on the new provider in a later slice.

// ─── Email Group Handlers ──────────────────────────────

export async function listEmailGroups(req: Request, res: Response) {
  try {
    const groups = await prisma.emailGroup.findMany({
      where: tenantWhere(req),
      orderBy: { created_at: 'asc' },
    });

    res.json({ groups: groups.map(mapEmailGroup) });
  } catch (err) {
    logger.error('Failed to list email groups:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Unread Counts ─────────────────────────────────────

/**
 * One payload, three channels, two entitlements - which is exactly why the route
 * itself carries no requireFeature (see comm-unread.routes.ts). The plan axis is
 * resolved per channel here instead: a channel the org does not have reports 0
 * and its query is never issued, so an email-only org pays for one COUNT rather
 * than three. WhatsApp additionally reports 0 for a non-demo org, mirroring the
 * requireDemoOrg lock on the WhatsApp routes - the badge must not advertise a
 * surface that answers 404.
 */
export async function getUnreadCounts(req: Request, res: Response) {
  try {
    const where = tenantWhere(req);
    // Header badges are a read path like any other - an unscoped count leaks the
    // VOLUME of conversations a caller cannot open. SMS and WhatsApp (#2049)
    // both count per-user unread CONVERSATIONS now (see below), so both take
    // the parent AND row filter. WhatsApp keeps the anchor filter below; texts
    // and email follow Communication scope instead (see the two further down).
    const [rowScope, parentScope] = await Promise.all([
      commVisibilityWhere(req),
      commParentVisibilityWhere(req, 'messages'),
    ]);

    const wantsSms = hasFeature(req, 'phone');
    const wantsWhatsApp = hasFeature(req, 'phone') && req.user?.org_is_demo === true;
    const wantsEmail = hasFeature(req, 'email');
    // Email unread follows Communication scope like the Email page it badges, so it counts what that page lists.
    const emailScope = wantsEmail ? await emailsInSectionWhereForReq(req) : {};
    // The same goes for texts: the Text page's unread count is the conversations holding an unread message of the person's.
    const smsScope = wantsSms ? await textsInSectionScopeForReq(req) : { messages: {}, thread: {} };

    const [smsThreads, waChats, emailCount] = await Promise.all([
      // #2049: PER-USER, not the shared `messageThread.unread` column any
      // more - counts THREADS unread for THIS caller (attachCallerUnread, the
      // same predicate listThreads/getThread use), never messages. The badge
      // semantics change from "unread messages" to "unread conversations" for
      // sms - call this out in the PR body, per the spec.
      wantsSms
        ? prisma.messageThread.findMany({
            where: { ...where, ...smsScope.thread },
            select: { id: true, messages: { where: smsScope.messages, select: { direction: true, ts: true } } },
          })
        : null,
      // #2049 slice 2: the same move for WhatsApp - counts CHATS unread for
      // THIS caller (attachCallerUnreadWhatsApp), never the retired
      // `whatsapp_chats.unread` aggregate.
      wantsWhatsApp
        ? prisma.whatsAppChat.findMany({
            where: { ...where, ...parentScope },
            select: { id: true, messages: { where: rowScope, select: { from: true, created_at: true } } },
          })
        : null,
      // Email slice 8c: PER-USER, not the shared `unread` column - counts rows
      // with no EmailReadState for THIS caller, scoped exactly as before
      // (tenant + anchor visibility). `email_read_states: { none: {...} }`
      // compiles to a NOT EXISTS, so this stays one query, not N+1.
      wantsEmail
        ? prisma.email.count({
            where: {
              ...where,
              ...emailScope,
              ...unreadInboxWhere(req.user!.id),
            },
          })
        : null,
    ]);

    const smsUnreadThreadCount = smsThreads
      ? (await attachCallerUnreadSms(req, smsThreads)).filter((t) => t.unread > 0).length
      : 0;
    const whatsappUnreadChatCount = waChats
      ? (await attachCallerUnreadWhatsApp(req, waChats)).filter((c) => c.unread > 0).length
      : 0;

    res.json({
      sms: smsUnreadThreadCount,
      whatsapp: whatsappUnreadChatCount,
      email: emailCount ?? 0,
    });
  } catch (err) {
    logger.error('Failed to get unread counts:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * The identity a hand-written email from the signed-in person would carry, so a compose surface can name it instead of
 * guessing (PRD 10, S10.11): their own address and display name, from the same register lookup the dispatch resolves the
 * From header with, or "address needed" with neither when they have no address yet. `sendingEnabled` is the company's
 * "Send emails to customers and staff" switch: an address that exists is still no use while it is off.
 *
 * Person and org come from the token, never the request - accepting either would let a caller preview someone else's
 * sending setup. Read-only and derived, so it needs no capability beyond the `read Communication` the compose surfaces
 * already hold (including the job, lead and customer tabs, which have no Email page access of their own).
 */
export async function getSendingIdentity(req: Request, res: Response) {
  try {
    const [company, sender] = await Promise.all([
      orgSendingIdentity(req.user!.organization_id),
      resolveHandSender(prisma, { organizationId: req.user!.organization_id, userId: req.user!.id }),
    ]);
    res.json({
      status: sender.ok ? 'active' : 'address_needed',
      address: sender.ok ? sender.sender.address : null,
      name: sender.ok ? sender.sender.displayName || null : null,
      sendingEnabled: company.sendingEnabled,
    });
  } catch (err) {
    logger.error('Failed to resolve sending identity:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
