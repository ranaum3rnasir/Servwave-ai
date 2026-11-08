import type { PrismaClient, InboundMatchState, InboundAuthVerdict } from '@prisma/client';
import { parseReplyAddress, resolveReplyToken } from './reply-token';
import { Resend } from 'resend';
import { parseDmarcVerdict } from './inbound-auth';
import { env } from '../config/env';

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
    reply_token: token,
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
  };
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

type PersistDb = Pick<PrismaClient, 'replyToken' | 'email' | 'emailThread'>;

/**
 * Resolves and stores a received message, returning the row id, or null when
 * the message could not be attributed to any org.
 *
 * Null is a DROP, and the caller acknowledges the webhook rather than retrying:
 * a token that does not resolve will not start resolving on redelivery, and a
 * retry loop over junk addressed to the catch-all domain is its own problem.
 *
 * `thread_id` is the thread the message ACTUALLY landed on, which is not always
 * `resolution.thread_id`: a MATCHED message whose token lost its thread gets a
 * fresh one minted below, and the caller (which notifies whoever owns that
 * thread) needs the real id rather than the null the resolution still carries.
 */
export async function persistInboundEmail(
  db: PersistDb,
  message: InboundMessage,
): Promise<{ id: string; thread_id: string | null; resolution: InboundResolution } | null> {
  const resolution = await resolveInboundMessage(db, message);
  if (!resolution) return null;

  // A MATCHED message whose token lost its thread (ON DELETE SET NULL) needs a
  // new one: the inbox is keyed on threads, so a null thread_id here would
  // store the message somewhere nobody can see it. Unassigned deliberately -
  // there is no sender to inherit ownership from. An UNMATCHED_SENDER row gets
  // no thread at all; withholding it is the point, and the unmatched queue
  // finds it by inbound_match instead.
  const threadId = resolution.inbound_match === 'MATCHED' && !resolution.thread_id
    ? (await db.emailThread.create({ data: { organization_id: resolution.organization_id } })).id
    : resolution.thread_id;

  const paragraphs = paragraphsOf(message.text);
  const row = await db.email.create({
    data: {
      // Not 'system': that marker means "the app sent this by itself" and is
      // read by the transactional chip. A customer's reply is human-written.
      account: 'user',
      from: senderIdentityOf(message.from),
      // The address the message actually arrived on - our own reply address.
      to: message.receivedFor[0] ?? message.to[0] ?? '',
      subject: message.subject,
      snippet: paragraphs[0] ?? '',
      body: paragraphs,
      body_html: message.html,
      at: message.receivedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      ts: message.receivedAt.getTime(),
      unread: true,
      starred: false,
      folder: 'inbox',
      direction: 'in',
      // Resend's id for the RECEIVED message. Shares the column with sent mail's
      // id, which also buys idempotency: a redelivery that slipped past the
      // event ledger hits the unique index rather than duplicating the message.
      provider_message_id: message.providerId,
      thread_id: threadId,
      customer_id: resolution.customer_id,
      reply_token: resolution.reply_token,
      inbound_match: resolution.inbound_match,
      inbound_auth: resolution.inbound_auth,
      has_attachment: false,
      organization_id: resolution.organization_id,
    },
  });

  return { id: row.id, thread_id: threadId, resolution };
}
