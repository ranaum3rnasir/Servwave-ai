import type { PrismaClient, InboundMatchState, InboundAuthVerdict } from '@prisma/client';
import { parseReplyAddress, resolveReplyToken, type ReplyTokenRow } from './reply-token';
import type { InboundRoute, RoutedToken } from './mailbox/inbound-router';
import { Resend } from 'resend';
import { parseDmarcVerdict } from './inbound-auth';
import { mainMailboxIdOf, recordConversationData, startedConversationData } from './mailbox/conversations';
import { isAutomaticMail } from './mailbox/automatic-mail';
import { reviewReasonOf, type ReviewReason } from './mailbox/review-reason';
import { env } from '../config/env';
import { sanitizeEmailHtml } from './email-html';
import { customerOfSender } from './communication/customerByAddress';

/**
 * Own client instance rather than lib/email.ts's `resend`, following
 * resend-webhook.controller.ts's precedent: inbound retrieval and the send path
 * are unrelated concerns that merely share a constructor. Keeping them separate
 * also means the send path's module-level mock in tests does not silently
 * disable inbound fetching.
 */
const resendInbound = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

/**
 * Email slice 6 (inbound reply capture) - turning a received message into an
 * attribution decision.
 *
 * TWO RULES GOVERN EVERYTHING HERE.
 *
 * 1. THE TOKEN AUTHENTICATES THE THREAD, NOT THE PERSON. Anyone who can read
 *    the email can reply to it, and mail is forwarded all the time, so holding
 *    a valid token is necessary but never sufficient. The sender check is what
 *    turns possession into attribution, and it fails toward the unmatched queue
 *    rather than toward the wrong thread.
 *
 * 2. NEVER GUESS AN ORG, AND NEVER LOSE A MESSAGE SILENTLY. Every row we can
 *    write is tenant-scoped, so a message we cannot attribute has nowhere to
 *    live - picking an org would be a cross-tenant write. Those are dropped
 *    with a log by the caller rather than filed somewhere plausible.
 *
 * WHERE A MESSAGE GOES is decided first, from the event's recipients alone, by the inbound router
 * (mailbox/inbound-router.ts, PRD 10 M11b): a live reply token, else an issued mailbox address on this environment's
 * mailbox domain, else dropped before the body is fetched. This file fetches the body and stores the message where the
 * router planned it.
 *
 * NOT IMPLEMENTED HERE: the In-Reply-To/References fallback the plan lists as
 * the second resolution step. It cannot work yet, and not for want of effort -
 * an inbound reply's In-Reply-To carries the RFC 5322 Message-ID of our sent
 * message, and we do not persist that anywhere. `emails.provider_message_id`
 * holds Resend's own id (`re_...`), which is a different identifier in a
 * different namespace. Wiring the fallback means first persisting the outbound
 * Message-ID, which needs the still-open outbound header experiment (research
 * §3.17) to establish what Resend actually stamps. Until then the token is the
 * only resolution path, and a reply with a stripped token is unattributable.
 */

type Db = Pick<PrismaClient, 'replyToken'>;

/** One attachment the provider reports on a received message (metadata only: the bytes are fetched later). */
export interface ReceivedAttachmentMeta {
  /** The provider's id for this attachment; the idempotency key of its stored copy. */
  id: string;
  filename: string | null;
  content_type: string;
  /** What the provider says it weighs, in bytes. */
  size: number;
}

/** One attachment with the short-lived address its bytes can be read from. */
export interface ReceivedAttachmentRef extends ReceivedAttachmentMeta {
  downloadUrl: string;
}

/** A received message, flattened out of Resend's Received Emails API. */
export interface InboundMessage {
  /** Resend's id for the RECEIVED message - not one of our provider_message_ids. */
  providerId: string;
  /** The raw From header, display name and all. */
  from: string;
  /**
   * Envelope recipients (SMTP RCPT TO). Preferred over `to` for finding our
   * token: this is what the message was actually delivered to, whereas the To
   * header is author-supplied and need not mention us at all.
   */
  receivedFor: string[];
  to: string[];
  subject: string;
  messageId: string;
  receivedAt: Date;
  text: string | null;
  html: string | null;
  headers: Record<string, string> | null;
  /** The attachments the message carries, as reported with it. Absent or empty: none. */
  attachments?: ReceivedAttachmentMeta[];
}

export interface InboundResolution {
  organization_id: string;
  thread_id: string | null;
  reply_token: string;
  customer_id: string | null;
  inbound_match: InboundMatchState;
  inbound_auth: InboundAuthVerdict;
}

/**
 * Pulls the bare address out of a From header, or null if there is not one.
 *
 * `Name <addr>` and a bare `addr` are both accepted, since which arrives
 * depends entirely on the sending client. Lowercased for comparison: RFC 5321
 * makes the local part case-sensitive in principle, but no mainstream provider
 * treats it that way and a customer must not be demoted to the unmatched queue
 * because their client capitalised their own address.
 */
function senderAddressOf(from: string): string | null {
  if (!from) return null;
  const angled = from.match(/<([^>]*)>/);
  const address = (angled ? angled[1] : from).trim().toLowerCase();
  // Cheap structural check only. This is a comparison key, not a validator -
  // the address it is compared against was already validated at send time.
  if (!address || !address.includes('@') || /\s/.test(address)) return null;
  return address;
}

/** The first recipient that is one of our reply addresses, envelope first. */
function tokenFromRecipients(message: InboundMessage): string | null {
  for (const recipient of [...message.receivedFor, ...message.to]) {
    const token = parseReplyAddress(recipient);
    if (token) return token;
  }
  return null;
}

/**
 * Resolves a received message to an org, a thread and a match state, or null
 * when it cannot be attributed at all.
 *
 * Null is NOT an error and must never bounce at the customer - the caller
 * acknowledges the webhook and logs. A bounce would punish someone who replied
 * in good faith to an address we handed them.
 */
export async function resolveInboundMessage(
  db: Db,
  message: InboundMessage,
): Promise<InboundResolution | null> {
  const token = tokenFromRecipients(message);
  if (!token) return null;

  const row = await resolveReplyToken(db, token);
  if (!row) return null;

  return resolveReplyOnToken(row, message);
}

/**
 * The attribution decision for a reply on a token that already resolved: pure, so the router (which looked the token up from
 * the event's recipients, before the body was fetched) never reads it a second time.
 */
export function resolveReplyOnToken(row: ReplyTokenRow, message: InboundMessage): InboundResolution {
  const auth = parseDmarcVerdict(message.headers);
  const sender = senderAddressOf(message.from);

  // DMARC FAIL is an active forgery signal and outranks the string compare: a
  // forged From that names exactly the right person is the case a string
  // compare cannot catch and DMARC can. PASS/NO_POLICY/UNAVAILABLE all fall
  // through to the address comparison - the verdict is recorded either way so
  // the UI can decline to call an unverified match "verified".
  const senderTrusted = auth !== 'FAIL' && sender !== null && sender === row.expected_from;

  return {
    organization_id: row.organization_id,
    // Withheld on a sender mismatch. The token still resolved a thread; we are
    // deliberately refusing to attach the message to it.
    thread_id: senderTrusted ? row.thread_id : null,
    // Kept in BOTH cases - on an unmatched row it is what makes an operator's
    // manual link one click instead of a search.
    reply_token: row.token,
    customer_id: senderTrusted ? row.customer_id : null,
    inbound_match: senderTrusted ? 'MATCHED' : 'UNMATCHED_SENDER',
    inbound_auth: auth,
  };
}

/**
 * Fetches the full received message from Resend's Received Emails API.
 *
 * REQUIRED, not an optimisation. The `email.received` webhook payload is
 * metadata only - Resend states plainly that webhooks exclude the body, the
 * headers and the attachment content - so the DMARC verdict and the message
 * itself only exist on the other side of this call.
 *
 * THROWS on any failure, so the caller 500s and Resend redelivers. That is the
 * whole reason this runs BEFORE the idempotency claim: a claim written first
 * would survive the failure, dedupe the retry, and lose the customer's message
 * permanently.
 *
 * `raw.download_url` is deliberately unused - it expires about an hour after
 * receipt, and the `headers` object carries everything the sender check needs.
 */
export async function fetchReceivedEmail(id: string): Promise<InboundMessage> {
  if (!resendInbound) throw new Error('RESEND_API_KEY is not configured - cannot fetch received email');

  const { data, error } = await resendInbound.emails.receiving.get(id);
  if (error || !data) {
    throw new Error(`Received Emails API failed for ${id}: ${error?.message ?? 'no data returned'}`);
  }

  return {
    providerId: data.id,
    from: data.from,
    receivedFor: data.received_for ?? [],
    to: data.to ?? [],
    subject: data.subject,
    messageId: data.message_id,
    receivedAt: new Date(data.created_at),
    text: data.text,
    html: data.html,
    headers: data.headers,
    attachments: (data.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, content_type: a.content_type, size: a.size })),
  };
}

/**
 * The received message's attachments with the addresses their bytes can be read from (one call to the provider, whatever the
 * count). The addresses expire, so this is asked for at the moment the bytes are wanted and never stored. THROWS on any failure:
 * the caller records the attempt and tries again later.
 */
export async function listReceivedAttachments(receivedId: string): Promise<ReceivedAttachmentRef[]> {
  if (!resendInbound) throw new Error('RESEND_API_KEY is not configured - cannot list received attachments');

  const { data, error } = await resendInbound.emails.receiving.attachments.list({ emailId: receivedId });
  if (error || !data) {
    throw new Error(`Received attachments API failed for ${receivedId}: ${error?.message ?? 'no data returned'}`);
  }
  return data.data.map((a) => ({ id: a.id, filename: a.filename ?? null, content_type: a.content_type, size: a.size, downloadUrl: a.download_url }));
}

/** How long one attachment's bytes may take to arrive. */
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 60_000;

/** The bytes of one received attachment. THROWS on any failure, and on a body that outgrows the size the provider reported. */
export async function downloadReceivedAttachment(ref: ReceivedAttachmentRef, maxBytes: number): Promise<Buffer> {
  const response = await fetch(ref.downloadUrl, { signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Received attachment ${ref.id} could not be downloaded (status ${response.status})`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Received attachment ${ref.id} is larger than the allowed size`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`Received attachment ${ref.id} is larger than the allowed size`);
  return bytes;
}

/** `Name <addr>` -> `{ name: 'Name', email: 'addr' }`, for the `from` Json column. */
function senderIdentityOf(from: string): { name: string | null; email: string } {
  const angled = from.match(/^(.*)<([^>]*)>\s*$/);
  if (!angled) return { name: null, email: from.trim() };
  const name = angled[1].trim().replace(/^"(.*)"$/, '$1');
  return { name: name || null, email: angled[2].trim() };
}

/**
 * Blank-line-delimited paragraphs, mirroring how the compose path flattens its
 * paragraph array back into text. Readers render `Email.body` as one <p> per
 * element, so a single blob would collapse the customer's formatting.
 */
function paragraphsOf(text: string | null): string[] {
  if (!text) return [];
  return text.split(/\r?\n\s*\r?\n/).map((para) => para.trim()).filter(Boolean);
}

type PersistDb = Pick<PrismaClient, 'replyToken' | 'email' | 'emailThread' | 'mailbox' | '$queryRaw'>;

/**
 * The conversation minted for a message whose token lost its thread, placed in the company's main
 * mailbox like every conversation (PRD 10, S10.4): a record conversation again when the token names a
 * record, else one started here. Unassigned either way: there is no sender to inherit ownership from.
 */
async function replacementConversationData(db: PersistDb, row: ReplyTokenRow) {
  return row.entity_type && row.entity_id
    ? recordConversationData(db, row.organization_id, { type: row.entity_type, id: row.entity_id })
    : startedConversationData(db, row.organization_id, null);
}

/** Where one stored copy of a received message went, and how it was taken. */
export interface InboundPlacement {
  /** The stored email row. */
  id: string;
  /** The provider-side id the row was stored under (the alert's dedup key); a copy beyond the first carries its mailbox id. */
  providerMessageId: string;
  organizationId: string;
  /** The mailbox it landed in; for a held message, the mailbox whose Needs review list it is filed under. */
  mailboxId: string | null;
  /** The conversation it landed on; null when held (a held message has no conversation of its own). */
  threadId: string | null;
  /** delivered: in its conversation; needs_review: held in a mailbox's Needs review list for a person (PRD 10, S10.18). */
  state: 'delivered' | 'needs_review';
  auth: InboundAuthVerdict;
  /** Set on a held message: why it is held, and the conversation its reply address belongs to (what a reply from an address we did not send to rings the people of). */
  review?: { reason: ReviewReason; threadId: string | null };
}

/** The fields every received row shares, whichever way it arrived. */
function receivedRowBase(message: InboundMessage) {
  const paragraphs = paragraphsOf(message.text);
  return {
    // Not 'system': that marker means "the app sent this by itself" and is
    // read by the transactional chip. A customer's reply is human-written.
    account: 'user',
    from: senderIdentityOf(message.from),
    subject: message.subject,
    snippet: paragraphs[0] ?? '',
    body: paragraphs,
    // Cleaned by the compose path's own cleaner BEFORE it is stored, whichever way the message arrived: the inbox renders this
    // column, and a customer's mail is whatever its sender made it (PRD 10, S10.17).
    body_html: message.html ? sanitizeEmailHtml(message.html) : null,
    at: message.receivedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    ts: message.receivedAt.getTime(),
    unread: true,
    starred: false,
    folder: 'inbox',
    direction: 'in',
    // The message names files: it says so now, and they are brought over once it is stored (lib/inbound-attachments.ts).
    has_attachment: (message.attachments?.length ?? 0) > 0,
    attachments_pending: (message.attachments?.length ?? 0) > 0,
  };
}

/** The columns of a message held in a Needs review list: no conversation, no customer, its own folder. */
function heldRowData(reason: ReviewReason, mailboxId: string | null, reviewThreadId: string | null) {
  return {
    folder: 'needs_review',
    thread_id: null,
    customer_id: null,
    review_reason: reason,
    review_mailbox_id: mailboxId,
    review_thread_id: reviewThreadId,
  };
}

/**
 * The conversation a reply address belongs to, for a reply that is held: its own when it has one, else (an address a send
 * anchored to a record before any conversation was opened) the record's conversation in the main mailbox, opened now. What a
 * held reply to an invoice or an estimate shows to follows this conversation's record, so it must exist.
 */
async function replyConversationOf(db: PersistDb, row: RoutedToken): Promise<{ id: string; mailboxId: string | null } | null> {
  if (row.thread_id) return { id: row.thread_id, mailboxId: row.thread?.mailbox_id ?? null };
  if (!row.entity_type || !row.entity_id) return null;
  const mainId = await mainMailboxIdOf(db, row.organization_id);
  const found = await db.emailThread.findFirst({
    where: { organization_id: row.organization_id, origin: 'record', record_type: row.entity_type, record_id: row.entity_id, mailbox_id: mainId },
    select: { id: true, mailbox_id: true },
  });
  const thread = found ?? await db.emailThread.create({ data: await replacementConversationData(db, row), select: { id: true, mailbox_id: true } });
  return { id: thread.id, mailboxId: thread.mailbox_id };
}

/**
 * A reply on a reply address that is held for review (PRD 10, S10.18): the sender is not the one we wrote to, the sender failed
 * authentication, the message is automatic, or the address no longer resolves. It joins no conversation and rings nobody. It is
 * filed under the mailbox its address's conversation sits in; an address that no longer resolves is filed under the company's
 * main mailbox, which is where its customer's mail has nowhere better to go.
 */
async function holdTokenReply(
  db: PersistDb, message: InboundMessage, row: RoutedToken, live: boolean, reason: ReviewReason,
): Promise<InboundPlacement> {
  const auth = parseDmarcVerdict(message.headers);
  const conversation = await replyConversationOf(db, row);
  const mailboxId = (live ? conversation?.mailboxId : null) ?? await mainMailboxIdOf(db, row.organization_id);
  const stored = await db.email.create({
    data: {
      ...receivedRowBase(message),
      ...heldRowData(reason, mailboxId, conversation?.id ?? null),
      to: message.receivedFor[0] ?? message.to[0] ?? '',
      provider_message_id: message.providerId,
      // Kept in every case: it is what makes linking by hand one click instead of a search.
      reply_token: row.token,
      inbound_match: 'UNMATCHED_SENDER',
      inbound_auth: auth,
      organization_id: row.organization_id,
    },
    select: { id: true },
  });
  return {
    id: stored.id, providerMessageId: message.providerId, organizationId: row.organization_id, mailboxId, threadId: null,
    state: 'needs_review', auth, review: { reason, threadId: conversation?.id ?? null },
  };
}

/** A reply on a reply address: today's path, including the sender check; or held for review (see `holdTokenReply`). */
async function persistTokenReply(db: PersistDb, message: InboundMessage, row: RoutedToken, live: boolean): Promise<InboundPlacement> {
  const resolution = resolveReplyOnToken(row, message);
  const reason = reviewReasonOf({
    auth: resolution.inbound_auth,
    automatic: isAutomaticMail(message),
    replyAddress: !live ? 'no_longer_resolves' : resolution.inbound_match === 'MATCHED' ? 'accepted' : 'sender_refused',
  });
  if (reason) return holdTokenReply(db, message, row, live, reason);

  // A MATCHED message whose token lost its thread (ON DELETE SET NULL) needs a
  // new one: the inbox is keyed on threads, so a null thread_id here would
  // store the message somewhere nobody can see it. Unassigned deliberately -
  // there is no sender to inherit ownership from.
  const minted = !resolution.thread_id
    ? await db.emailThread.create({ data: await replacementConversationData(db, row), select: { id: true, mailbox_id: true } })
    : null;
  const threadId = minted ? minted.id : resolution.thread_id;
  // A matched reply lands in the mailbox of the conversation it joined.
  const mailboxId = minted ? minted.mailbox_id : row.thread?.mailbox_id ?? null;

  const stored = await db.email.create({
    data: {
      ...receivedRowBase(message),
      // The address the message actually arrived on - our own reply address.
      to: message.receivedFor[0] ?? message.to[0] ?? '',
      // Resend's id for the RECEIVED message. Shares the column with sent mail's
      // id, which also buys idempotency: a redelivery that slipped past the
      // event ledger hits the unique index rather than duplicating the message.
      provider_message_id: message.providerId,
      thread_id: threadId,
      customer_id: resolution.customer_id,
      reply_token: resolution.reply_token,
      inbound_match: resolution.inbound_match,
      inbound_auth: resolution.inbound_auth,
      organization_id: resolution.organization_id,
    },
    select: { id: true },
  });

  return {
    id: stored.id,
    providerMessageId: message.providerId,
    organizationId: resolution.organization_id,
    mailboxId,
    threadId,
    state: 'delivered',
    auth: resolution.inbound_auth,
  };
}

/**
 * Fresh mail to an issued mailbox address (PRD 10, M11b step 2): a NEW conversation in that mailbox, origin "started", owned
 * by nobody. It never joins an existing conversation and is never linked to a job or a lead: that is a person's act (PRD 8's
 * attach rule), never the sender's word. It is linked to a CUSTOMER by the sender's address when exactly one customer of the
 * company has it (S10.20): the link is made on PASS, NO_POLICY and UNAVAILABLE alike (the screens mark the last two as an
 * unverified sender), and never for mail held for review. An address shared by several customers links to none; a person picks.
 * One copy per mailbox reached; the first keeps the provider's message id and each further copy carries its mailbox id too, so
 * every copy is unique and a redelivery cannot store any of them twice.
 */
async function persistMailboxCopies(
  db: PersistDb,
  message: InboundMessage,
  plan: Extract<InboundRoute, { state: 'mailboxes' }>,
): Promise<InboundPlacement[]> {
  const auth = parseDmarcVerdict(message.headers);
  // A failed authentication or automatic mail is held in the mailbox's Needs review list instead of starting a conversation.
  const reason = reviewReasonOf({ auth, automatic: isAutomaticMail(message) });
  // One indexed read for the message, whatever the number of mailboxes it reached; none for mail that is held.
  const customerId = reason ? null : await customerOfSender(db, plan.organizationId, senderAddressOf(message.from));
  const placements: InboundPlacement[] = [];
  for (const [index, delivery] of plan.deliveries.entries()) {
    const providerMessageId = index === 0 ? message.providerId : `${message.providerId}#${delivery.mailboxId}`;
    if (reason) {
      const held = await db.email.create({
        data: {
          ...receivedRowBase(message),
          ...heldRowData(reason, delivery.mailboxId, null),
          to: delivery.address,
          provider_message_id: providerMessageId,
          reply_token: null,
          // No reply address carried it, and nothing attached it to anything.
          inbound_match: 'UNMATCHED_NO_TOKEN',
          inbound_auth: auth,
          organization_id: plan.organizationId,
        },
        select: { id: true },
      });
      placements.push({
        id: held.id, providerMessageId, organizationId: plan.organizationId, mailboxId: delivery.mailboxId, threadId: null,
        state: 'needs_review', auth, review: { reason, threadId: null },
      });
      continue;
    }
    const thread = await db.emailThread.create({
      data: await startedConversationData(db, plan.organizationId, null, delivery.mailboxId),
      select: { id: true },
    });
    const stored = await db.email.create({
      data: {
        ...receivedRowBase(message),
        to: delivery.address,
        provider_message_id: providerMessageId,
        thread_id: thread.id,
        customer_id: customerId,
        reply_token: null,
        inbound_match: 'MATCHED',
        inbound_auth: auth,
        organization_id: plan.organizationId,
      },
      select: { id: true },
    });
    placements.push({
      id: stored.id,
      providerMessageId,
      organizationId: plan.organizationId,
      mailboxId: delivery.mailboxId,
      threadId: thread.id,
      state: 'delivered',
      auth,
    });
  }
  return placements;
}

/**
 * Stores a received message where the router planned it (planInboundMail) and returns one placement per stored copy: the
 * company, the mailbox, the conversation and the state. A token reply is one copy; fresh mail to mailbox addresses is one
 * copy per mailbox reached. A dropped plan stores nothing and never reaches here with a body.
 */
export async function persistInboundEmail(
  db: PersistDb,
  message: InboundMessage,
  plan: Exclude<InboundRoute, { state: 'dropped' }>,
): Promise<InboundPlacement[]> {
  if (plan.state === 'token') return [await persistTokenReply(db, message, plan.token, true)];
  if (plan.state === 'unresolved_token') return [await persistTokenReply(db, message, plan.token, false)];
  return persistMailboxCopies(db, message, plan);
}
