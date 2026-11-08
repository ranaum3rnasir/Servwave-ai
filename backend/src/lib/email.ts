import { Resend, CreateEmailOptions } from 'resend';
import { env } from '../config/env';
import { logger } from './logger';
import { prisma } from './prisma';
import { estimateDocumentSelect, toEstimateDocument } from './estimate-document';
import { generateEstimatePdf, generateInvoicePdf } from './pdf';
import { invoicePdfSelect, toInvoiceForPdf } from './pdf/invoice-select';
import { formatDateTimeInZone, formatEndOfWindowInZone, DEFAULT_TIMEZONE } from './timezone';
import { persistTransactionalEmail, TransactionalEmailAttachment, TransactionalEmailRecord } from './comm-persist';
import { prepareReplyToken, persistReplyToken, replyAddressFor } from './reply-token';
import { isTransactionalSendSuppressed } from './email-suppression';
import { buildSalesRequestEmail, type SalesTopic } from './sales-request-email';

export interface OrganizationBrandingSubset {
  id: string;
  name: string;
  logo_url: string | null;
  brand_color: string;
}

// Exported (email slice 10) so the guided-domain-verification endpoints
// (organization-email-domain.controller.ts) reuse this SAME client instance
// for resend.domains.create/get/verify/remove rather than constructing a
// second one — mirrors resend-webhook.controller.ts's own separate instance,
// which exists ONLY to reach .webhooks.verify() (a distinct, narrower need).
export const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export type EmailDispatchResult =
  | {
      status: 'sent';
      /**
       * Resend's own id for the accepted message - the ONLY key a delivery
       * webhook carries back, so without it no delivery event can ever be
       * correlated to the row it belongs to.
       *
       * Nullable on purpose: resend@6 types the success envelope's `data` as
       * possibly null, and a null envelope with no error is still a send that
       * happened. It means "delivered state for this one is uncorrelatable",
       * never "this failed".
       */
      providerMessageId: string | null;
      /**
       * The bare address this send actually left from. Reported rather than
       * re-derived by callers so a persisted mirror of the send can never name
       * an address the mail did not come from (that was the BUG B drift).
       */
      fromAddress: string;
      /**
       * The display name that actually entered the From header, already
       * sanitized by formatSenderIdentity. Null for a platform-voice send,
       * which deliberately carries no org name.
       *
       * Reported for the same reason as fromAddress: a caller guessing the
       * name is the same drift as a caller guessing the address. Every
       * persisting sender uses the org voice, so the old hardcoded fallback of
       * 'ServWave' was never the right answer at any of them.
       */
      fromName: string | null;
    }
  | {
      status: 'skipped';
      /**
       * 'suppressed' (email slice 4): the recipient hard-bounced or complained
       * on a prior send and is on the global TRANSACTIONAL suppression list
       * (EmailSuppression) — a deliberate policy block, not a provider error.
       *
       * 'no_recipient' (SRVW-243): the caller asked for a send but the party it
       * would go to has no address on file. Never produced by dispatchEmail
       * itself - a caller reports it INSTEAD of dispatching, so an explicit
       * "notify the customer" can answer honestly rather than silently doing
       * nothing. A policy block like the two above, not a failure.
       */
      reason: 'org_disabled' | 'no_api_key' | 'suppressed' | 'no_recipient';
    }
  | { status: 'failed'; error: string };

/**
 * Whose voice the email speaks in.
 *
 * 'organization' (the default) is the contractor talking to their customer, so
 * the From header carries the org's display name. 'platform' is ServWave talking
 * TO the contractor — Payments account notices, internal ops alerts — where
 * stamping the org's name on the message would misrepresent who is speaking.
 * 'spider-alert' and 'bee-alert' are fixed AI Agent product identities for automated notifications.
 */
type SenderIdentity = 'organization' | 'platform' | 'spider-alert' | 'bee-alert';


// Omit over a union must distribute, or the members collapse and CreateEmailOptions
// loses its html/text/react branches.
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * Payload minus `from`. dispatchEmail is the single authority on the From header,
 * so senders cannot set one — the type enforces it.
 */
type DispatchPayload = DistributiveOmit<CreateEmailOptions, 'from'>;

/** Long enough for any real company name; short enough to stay a sane header. */
const MAX_DISPLAY_NAME_LENGTH = 64;

/** RFC 2047 encoded-word: the only safe way to put non-ASCII in a header. */
function encodeNonAsciiDisplayName(name: string): string {
  return `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?=`;
}

/**
 * Build the From header for an org-voice send.
 *
 * organization.name is tenant-controlled input landing in a mail header, so it
 * gets the same distrust as any user string entering HTML. Control characters are
 * the real risk: an embedded CRLF would let an org name inject headers (a `Bcc:`
 * to an address of the attacker's choosing) into every email it sends.
 *
 * Returns the bare address when no usable name survives sanitizing — an empty
 * display name (`"" <addr>`) is worse than none.
 */
/**
 * The display name as it will actually appear, or '' when nothing usable
 * survives. Split out of formatSenderIdentity so a mirrored row can record the
 * SAME string the header carried rather than the raw org name - the two differ
 * whenever a name is long enough to truncate or carries odd whitespace.
 */
export function sanitizeDisplayName(orgName: string | null | undefined): string {
  return (orgName ?? '')
    // Control chars, including the CR/LF that would break the header apart.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    .trim();
}

export function formatSenderIdentity(orgName: string | null | undefined, address: string): string {
  const cleaned = sanitizeDisplayName(orgName);

  if (!cleaned) return address;

  if (/[^\x20-\x7E]/.test(cleaned)) {
    return `${encodeNonAsciiDisplayName(cleaned)} <${address}>`;
  }
  // RFC 5322 quoted-string: backslash first, so the escapes we add aren't re-escaped.
  const quoted = cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${quoted}" <${address}>`;
}

/** Longest local part we will build from an org name. Well inside RFC 5321's
 *  64-octet limit, and short enough that the address still reads as a name. */
const MAX_SENDER_LOCAL_PART = 40;

/**
 * The org's half of a shared-domain sending address: `Northwind Services` becomes
 * `northwind`, for `northwind@mail.servwave.com`.
 *
 * Every org on the shared domain used to send as a flat `no-reply@`, so a
 * recipient's inbox showed an address that named nobody and leaned entirely on
 * the display name. This puts the org in the address itself.
 *
 * Allowlist, not a blocklist: only `[a-z0-9]` survives. The org name is
 * user-controlled and this lands in a From header, so the same header-injection
 * risk sanitizeDisplayName guards against applies here - a permissive rule that
 * happened to let a CR through would be an injected `Bcc:` on every send. Dots
 * and dashes are legal in a local part but buy nothing here, so they go too
 * rather than widen the allowlist for cosmetics.
 *
 * Falls back to `no-reply` when nothing usable survives (an org named only in
 * punctuation, or not named at all). An empty local part is not an address.
 *
 * NOT unique: two orgs with the same name share a local part. Nothing routes on
 * it - replies come back on the per-thread Reply-To token, never on From - so a
 * collision is cosmetic rather than a mis-delivery.
 */
export function orgSenderLocalPart(orgName: string | null | undefined): string {
  const slug = (orgName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, MAX_SENDER_LOCAL_PART);
  return slug || 'no-reply';
}

/**
 * The local part this org actually sends from: its own choice when it has made
 * one, else the name-derived default above.
 *
 * `organizations.email_sender_local_part` is NULLABLE and was never backfilled,
 * so null / undefined / '' all mean the same thing - derive - and an org that
 * has never touched the setting behaves exactly as it did before the column
 * existed, including still moving its address when the company is renamed.
 *
 * Undefined is folded in with null deliberately: a `select` that omits the
 * column yields undefined, and treating that as an override would blank the
 * local part on any caller that forgot to select it.
 */
export function effectiveSenderLocalPart(
  orgName: string | null | undefined,
  explicit: string | null | undefined,
): string {
  return explicit?.trim() || orgSenderLocalPart(orgName);
}

/**
 * The From address for `organizationId`'s business sends.
 *
 * Sending is IN-HOUSE: every org sends from the one shared platform domain
 * (env.EMAIL_FROM_BUSINESS), whose DNS is configured centrally and once. The
 * only org-level choice is the LOCAL part - the string before the `@` - which
 * is the org's own when it has set one and derived from its name otherwise.
 *
 * There is deliberately no per-org sending domain. The guided custom-domain
 * feature that used to sit here (email slice 10) was removed once the in-house
 * decision was made: it was not merely described wrongly in the UI, it worked,
 * and so contradicted the decision every time an org used it.
 *
 * NEVER throws - the whole dispatch path rides on this, so a value that cannot
 * be taken apart is returned untouched rather than raised.
 */
export function sharedSenderAddress(
  orgName: string | null | undefined,
  explicitLocalPart?: string | null,
): string {
  // The domain half is whatever EMAIL_FROM_BUSINESS carries, so moving the
  // platform to a different shared sending domain stays a config change. A
  // value without an `@` is a misconfiguration, not something to guess at -
  // use it verbatim and let the provider reject it loudly.
  const shared = env.EMAIL_FROM_BUSINESS;
  // Only a bare `local@domain` gets rewritten. The value can legitimately be
  // configured as a full identity (`Alpha <noreply@example.com>`), which is an
  // explicit operator choice - rewriting half of it would emit a malformed
  // header, and overriding the name they set would be presumptuous.
  if (!shared || /[<>\s]/.test(shared)) return shared;
  const at = shared.lastIndexOf('@');
  if (at < 0) return shared;
  return `${effectiveSenderLocalPart(orgName, explicitLocalPart)}@${shared.slice(at + 1)}`;
}

/**
 * The From identity a business send from `organizationId` would carry, resolved
 * WITHOUT sending anything.
 *
 * Exists so a compose surface can show the address the recipient will actually
 * see. It deliberately goes through the SAME sharedSenderAddress the dispatch
 * path uses rather than re-deriving: an "About to send as X" that could
 * disagree with the header is worse than showing nothing, which is the same
 * anti-drift rule dispatchEmail follows when it reports fromAddress back on its
 * result.
 *
 * `sendingEnabled` rides along because an org with email switched off still has
 * a perfectly well-formed address. Showing it unqualified would be a fresh lie
 * in the opposite direction from the "No mailbox connected" one this replaces.
 */
export async function orgSendingIdentity(organizationId: string): Promise<{
  address: string;
  name: string | null;
  sendingEnabled: boolean;
  localPart: string;
  localPartIsCustom: boolean;
  senderDomain: string;
}> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, email_sending_enabled: true, email_sender_local_part: true },
  });
  const explicit = org?.email_sender_local_part ?? null;
  return {
    address: sharedSenderAddress(org?.name ?? null, explicit),
    name: sanitizeDisplayName(org?.name) || null,
    sendingEnabled: org?.email_sending_enabled !== false,
    // The settings field renders these three rather than splitting `address`
    // apart itself: the domain is fixed and not the org's to choose, so the UI
    // needs the halves separately, and `localPartIsCustom` is what tells it
    // whether the value shown is the org's own or still tracking the name.
    localPart: effectiveSenderLocalPart(org?.name ?? null, explicit),
    localPartIsCustom: Boolean(explicit?.trim()),
    senderDomain: senderDomainOf(),
  };
}

/** The domain half every org sends from - always the shared one, never an org
 *  choice. Split out so the settings UI can render it as a fixed suffix rather
 *  than parsing it back out of a full address. Empty when EMAIL_FROM_BUSINESS
 *  is configured as a full identity or is otherwise not a bare address, the
 *  same shapes sharedSenderAddress declines to rewrite. */
export function senderDomainOf(): string {
  const shared = env.EMAIL_FROM_BUSINESS;
  if (!shared || /[<>\s]/.test(shared)) return '';
  const at = shared.lastIndexOf('@');
  return at < 0 ? '' : shared.slice(at + 1);
}

/**
 * Single choke point every non-auth-critical sender routes through. Two jobs:
 *
 * 1. Org-level email_sending_enabled (DEFAULT FALSE since migration
 *    20260809031000 - off for every new org, so most orgs sit behind this gate
 *    rather than only the ones that deliberately switched it off) lets an admin
 *    kill all outgoing business email without touching login/account-security
 *    email (MFA OTP, user invite), which call resend.emails.send directly and
 *    never go through this gate. A sender that speaks to ServWave rather than
 *    to the org's customers opts out with `bypassOrgSendingGate` below.
 * 2. It owns the From header — the org's own verified domain when set up
 *    (email slice 10), else the shared business domain, plus, for org-voice
 *    sends, the org's locked display name. Callers cannot override it (see
 *    DispatchPayload).
 *
 * Both need the same org row, so it stays one query.
 */
async function dispatchEmail(
  organizationId: string,
  payload: DispatchPayload,
  options?: {
    senderIdentity?: SenderIdentity;
    /**
     * Send even when the org has outgoing email switched off.
     *
     * ONLY for a message addressed to ServWave itself - the "Reach sales"
     * composer. The kill switch's whole purpose is to stop an org speaking to
     * ITS OWN CUSTOMERS under its own name; a contractor writing to us is not
     * that, and gating it silenced exactly the orgs most likely to need sales
     * (email is off by default, so that is most of them).
     *
     * Deliberately NOT keyed off `senderIdentity: 'platform'`, which the
     * payments notices also use: those go to the ORG'S OWN PEOPLE and stay
     * gated. An opt-out this sharp has to be asked for by name, one caller at
     * a time, or it becomes a way for business email to leak past the brake.
     *
     * Everything else still applies - the suppression gate below and the From
     * header this function owns. A bypass of the org's own preference is not a
     * licence to mail an address that hard-bounced.
     */
    bypassOrgSendingGate?: boolean;
  },
): Promise<EmailDispatchResult> {
  if (!resend) {
    logger.warn('RESEND_API_KEY not set - skipping email send');
    return { status: 'skipped', reason: 'no_api_key' };
  }
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { email_sending_enabled: true, name: true, email_sender_local_part: true },
  });
  if (org?.email_sending_enabled === false && !options?.bypassOrgSendingGate) {
    logger.info(`Email sending disabled for organization ${organizationId} - skipping send`);
    return { status: 'skipped', reason: 'org_disabled' };
  }
  // Email slice 4 — TRANSACTIONAL suppression gate. A prior hard bounce or
  // complaint on this exact address (recorded by the Resend delivery webhook,
  // see resend-webhook.controller.ts) blocks EVERY future business send to it,
  // globally across every org sharing mail.servwave.com — checked before the
  // From header is even built, so a suppressed address never reaches Resend.
  if (await isTransactionalSendSuppressed(payload.to)) {
    logger.warn(`Email to ${recipientLabel(payload.to)} skipped - address is suppressed (hard bounce/complaint)`);
    return { status: 'skipped', reason: 'suppressed' };
  }
  // ONE derivation of the sending address, reported back on the result. Anything
  // that mirrors this send reads it from here rather than re-deriving it, so the
  // record and the header cannot drift apart.
  const isPlatformVoice = options?.senderIdentity === 'platform';
  const isSpiderAlertVoice = options?.senderIdentity === 'spider-alert';
  const isBeeAlertVoice = options?.senderIdentity === 'bee-alert';

  const fromAddress = isSpiderAlertVoice
    ? 'alerts@spider.servwave.com'
    : isBeeAlertVoice
      ? 'alerts@bee.servwave.com'
      : sharedSenderAddress(
          isPlatformVoice ? null : org?.name ?? null,
          isPlatformVoice ? null : org?.email_sender_local_part ?? null,
        );
  const fromName = isSpiderAlertVoice
    ? 'ServWave Spider Alerts'
    : isBeeAlertVoice
      ? 'ServWave Bee Alerts'
      : isPlatformVoice
        ? null
        : sanitizeDisplayName(org?.name) || null;
  const from = isPlatformVoice
    ? fromAddress
    : formatSenderIdentity(isSpiderAlertVoice || isBeeAlertVoice ? fromName : org?.name, fromAddress);
  // The reply address is a bare routing token as its whole local part (see
  // lib/reply-token.ts), so a client with no display name to render falls back
  // to showing the raw token - the customer's reply header reads as a machine
  // id. Naming it hides the token without touching it: same address inside the
  // angle brackets, same thread resolution. Named HERE, beside the From, so the
  // two identities on one message cannot disagree, and so every caller that
  // mints a token gets it without repeating the derivation.
  //
  // Platform voice stays bare for the same reason its From does - that send
  // deliberately does not speak as the org.
  //
  // Per ADDRESS, not per header: Resend types replyTo as `string | string[]`,
  // and naming a joined list would collapse it into one pair of angle brackets
  // and stop being a valid address list at all.
  const nameReplyTo = (address: string) => formatSenderIdentity(org?.name, address);
  const replyTo = isPlatformVoice
    ? payload.replyTo
    : Array.isArray(payload.replyTo)
      ? payload.replyTo.map(nameReplyTo)
      : payload.replyTo && nameReplyTo(payload.replyTo);
  const { data, error } = await resend.emails.send({
    ...payload,
    from,
    ...(replyTo ? { replyTo } : {}),
  } as CreateEmailOptions);
  if (error) {
    logger.error(`Resend rejected email for organization ${organizationId}:`, error);
    return { status: 'failed', error: error.message ?? 'Email provider rejected the message' };
  }
  // `data` is nullable in resend@6's success shape. No id means no later delivery
  // correlation, but the message was still accepted - that is a sent, not a failure.
  return { status: 'sent', providerMessageId: data?.id ?? null, fromAddress, fromName };
}

/**
 * The HTTP status a non-sent dispatch deserves.
 *
 * A send SKIPPED because the org turned email off, or because the recipient is
 * on the TRANSACTIONAL suppression list (email slice 4 — a prior hard bounce or
 * complaint), is not a gateway failure - nothing went wrong upstream, this is a
 * deliberate policy block - so it is a 409 the caller can act on, not a 502
 * that reads as "the provider is down, try again". A missing API key and a
 * provider rejection are both genuinely 502.
 *
 * The classification lives here in one place; the user-facing wording stays
 * with each caller, which is the only thing that knows what was not sent.
 */
export function dispatchFailureStatus(
  result: Exclude<EmailDispatchResult, { status: 'sent' }>,
): 409 | 502 {
  return result.status === 'skipped' && (result.reason === 'org_disabled' || result.reason === 'suppressed')
    ? 409
    : 502;
}

// Test-only handle (not part of the public sender API).
export const __dispatchEmailForTest = dispatchEmail;

/** The 'sent' member of the dispatch union, narrowed. */
type SentDispatch = Extract<EmailDispatchResult, { status: 'sent' }>;

/**
 * Everything a mirrored Email row takes from the dispatch that produced it: the
 * From header as actually sent (name and address), and the provider's
 * correlation key.
 *
 * A helper rather than repeated properties across twelve call sites, because all
 * of it must come from the SAME dispatch result - forwarding one field without
 * the others would give a row a sender from one send and an id from nowhere.
 */
function sentTrace(result: SentDispatch) {
  return {
    fromAddress: result.fromAddress,
    fromName: result.fromName,
    providerMessageId: result.providerMessageId,
  };
}

/**
 * #2251 - a rendered PDF, built ONCE per send so the dispatch and the mirrored
 * row read the same filename and the same bytes. `pdf` goes on the message
 * exactly as before; `record` is what persistTransactionalEmail stores and
 * lists. Two hand-written copies of the filename are how a row comes to
 * describe a file that was not the one sent.
 */
function pdfAttachment(filename: string, content: Buffer): {
  pdf: { filename: string; content: Buffer };
  record: TransactionalEmailAttachment[];
} {
  return {
    pdf: { filename, content },
    record: [{ filename, content, contentType: 'application/pdf' }],
  };
}


/**
 * Two-way email for transactional senders - PHASE 1, before the dispatch.
 *
 * The compose dialog has had this since email slice 6; every sender a customer
 * actually hears from went without it, so a reply to an estimate or an invoice
 * went to the org's own From address on mail.servwave.com - a domain with
 * RECEIVING DISABLED - and bounced silently.
 *
 * Same two-phase shape as the compose path, and for the same reason: the header
 * has to carry the address BEFORE the send, but nothing may be persisted for a
 * send that never leaves. So this is read-only, and finalizeTransactionalSend
 * below owes the write once the dispatch comes back 'sent'.
 *
 * Returns null when the record carries no entity anchor. That is the deliberate
 * opt-out for sends that must stay unreplyable - MFA codes, user invites and
 * internal ops alerts - and it is also the safe default: an unanchored token
 * would reuse on `org + recipient` alone and could silently route this
 * conversation's replies into an unrelated older one.
 */
async function prepareTransactionalReply(
  record: TransactionalEmailRecord | undefined,
  to: string | string[],
): Promise<{ token: string; persist: boolean; address: string; threadId: string | null } | null> {
  if (!record?.entityType || !record.entityId) return null;
  // One address per (entity, recipient) pair, so a multi-addressee send anchors
  // on the party the conversation is actually with - the first To - rather than
  // minting an address nobody can be matched against at reply time.
  const recipient = Array.isArray(to) ? to[0] : to;
  if (!recipient) return null;
  try {
    const prepared = await prepareReplyToken(prisma, {
      organization_id: record.organizationId,
      entity_type: record.entityType,
      entity_id: record.entityId,
      customer_id: record.customerId ?? null,
      expected_from: recipient,
    });
    // The thread only exists once a previous send about this entity created it;
    // a reused token carries it, a fresh one does not yet.
    const existing = prepared.persist
      ? null
      : await prisma.replyToken.findFirst({
          where: { token: prepared.token },
          select: { thread_id: true },
        });
    return {
      ...prepared,
      address: replyAddressFor(prepared.token),
      threadId: existing?.thread_id ?? null,
    };
  } catch (err) {
    // Best-effort, exactly like the compose path's phase 2: a token failure must
    // not cost the customer their estimate. The send still goes, just without a
    // reply address - the pre-existing behaviour, not a new failure mode.
    logger.error('Failed to prepare a transactional reply token:', err);
    return null;
  }
}

/**
 * PHASE 2 - the send left, so the advertised address has to resolve.
 *
 * Creates the conversation on first contact about an entity, writes the token
 * row VERBATIM (the address the customer received must be the address that
 * resolves), then mirrors the message. Never throws: the email has already
 * reached the customer, so a bookkeeping failure must not be reported as a
 * failed send.
 */
async function finalizeTransactionalSend(args: {
  record: TransactionalEmailRecord;
  reply: { token: string; persist: boolean; address: string; threadId: string | null } | null;
  to: string | string[];
  cc?: string[];
  subject: string;
  text: string;
  result: SentDispatch;
  /** #2251 - what the dispatch attached, so the mirrored row can say so. */
  attachments?: TransactionalEmailAttachment[];
}): Promise<void> {
  const { record, reply } = args;
  let threadId = reply?.threadId ?? null;
  if (reply) {
    try {
      // Deferred to here for the same invariant the Email row keeps: a dispatch
      // that never left leaves no orphan thread behind either.
      if (!threadId) {
        threadId = (await prisma.emailThread.create({
          data: { organization_id: record.organizationId },
        })).id;
      }
      if (reply.persist) {
        await persistReplyToken(prisma, {
          token: reply.token,
          organization_id: record.organizationId,
          thread_id: threadId,
          entity_type: record.entityType ?? null,
          entity_id: record.entityId ?? null,
          customer_id: record.customerId ?? null,
          expected_from: Array.isArray(args.to) ? args.to[0] : args.to,
        });
      }
    } catch (err) {
      // The cost is that a reply to THIS message routes to the unmatched queue
      // instead of the thread - visible and recoverable, which beats lying
      // about a send that plainly happened.
      logger.error('Failed to persist a transactional reply token:', err);
    }
  }
  await persistTransactionalEmail({
    ...record,
    cc: args.cc,
    to: Array.isArray(args.to) ? args.to.join(', ') : args.to,
    subject: args.subject,
    text: args.text,
    threadId,
    attachments: args.attachments,
    ...sentTrace(args.result),
  });
}

/**
 * Email.to is a single string, but the PO and stage-pickup senders accept a
 * recipient list (one message, several addressees). Render the list the way a
 * mail client shows a multi-recipient To header rather than dropping all but the
 * first, which would misreport who was on the message.
 */
function recipientLabel(to: string | string[]): string {
  return Array.isArray(to) ? to.join(', ') : to;
}

// Org-aware currency: callers that know the org pass its ISO-4217 code; the
// default keeps prior USD behavior for the many senders that don't yet thread
// it. Intl derives the symbol from the code regardless of the en-US locale. (#126)
function formatCurrency(amount: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

// ─── HTML output-encoding (B-06 / F-18) ──────────────────
//
// Single source of truth for HTML-context escaping. EVERY dynamic value placed
// into an email body must pass through esc() — directly, or implicitly via the
// `h` tagged template below, which escapes every interpolation by default so new
// templates inherit escaping. The only values allowed through raw are pre-built
// HTML fragments we constructed ourselves (wrap them in raw()).
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Marker for values that are ALREADY safe HTML (fragments we built). Anything
// wrapped in raw() bypasses escaping; everything else is escaped.
class RawHtml {
  constructor(public readonly html: string) {}
}
function raw(html: string): RawHtml {
  return new RawHtml(html);
}

// Auto-escaping tagged template. h`<p>Hi ${name}</p>` escapes `name`; embed a
// pre-built fragment with ${raw(fragment)}. Use this for every template body.
function h(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += (v instanceof RawHtml ? v.html : esc(v)) + strings[i + 1];
  }
  return out;
}

// org.logo_url is server-set from a Supabase public URL, but echoed into an
// <img src>. Only allow it through when it is an absolute https URL; otherwise
// fall back to the text wordmark. (Defence in depth against a poisoned value.)
function safeLogoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// ─── HTML Templates ──────────────────────────────────────

function wrapHtml(body: string, org?: { name: string; logo_url: string | null; brand_color: string }): string {
  const brandColor = org?.brand_color ?? '#242424';
  const logo = safeLogoUrl(org?.logo_url);
  const headerContent = logo
    ? h`<img src="${logo}" alt="${org?.name ?? 'ServWave'}" style="max-height:40px;display:block;">`
    : h`<span style="color:#ffffff;font-size:20px;font-weight:700;">${org?.name ?? 'ServWave'}</span>`;
  return h`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; background: #f3f4f6; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  </style>
</head>
<body>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:${brandColor};padding:24px 32px;">
          ${raw(headerContent)}
        </td></tr>
        <tr><td style="padding:32px;">
          ${raw(body)}
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">This is an automated message from ServWave.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Optional sender-authored note from the Send/Resend dialog. Escaped (staff-authored, but never
// trust input into HTML) and newline-preserved; rendered above the boilerplate so the customer
// actually sees it. Returns '' when absent — callers interpolate the result directly.
function customMessageBlock(message?: string): string {
  const trimmed = message?.trim();
  if (!trimmed) return '';
  return `<p style="margin:0 0 16px;font-size:15px;color:#374151;white-space:pre-line;">${esc(trimmed).replace(/\n/g, '<br>')}</p>`;
}

function estimateEmailHtml(params: {
  customerName: string;
  estimateNumber: string;
  total: string;
  publicUrl: string;
  message?: string;
  org: OrganizationBrandingSubset;
}): string {
  const brandColor = params.org?.brand_color ?? '#242424';
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Your Estimate is Ready</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    ${raw(customMessageBlock(params.message))}
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      We've prepared estimate <strong>${params.estimateNumber}</strong> for you.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr>
        <td style="padding:16px 20px;">
          <span style="font-size:13px;color:#6b7280;">Estimate Total</span><br>
          <span style="font-size:24px;font-weight:700;color:#111827;">${params.total}</span>
        </td>
      </tr>
    </table>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td style="background:${brandColor};border-radius:6px;padding:12px 28px;">
        <a href="${params.publicUrl}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">View Estimate</a>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      You can review, approve, or decline this estimate using the link above.
    </p>
  `, params.org);
}

// ─── PDF Helper ──────────────────────────────────────────

async function renderEstimatePdfBuffer(estimateId: string): Promise<Buffer> {
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId },
    // #2028 — the SAME projection the previewed PDF and the public page use. This select used to
    // be a hand-copied subset that had drifted: it omitted `scopes`, `scope_notes` and both
    // discount fields, so the document the customer received in their inbox dropped every priced
    // scope block while its Sub total still contained them.
    select: estimateDocumentSelect,
  });
  if (!est) throw new Error(`Estimate not found for PDF: ${estimateId}`);

  // The estimate's OWN organization. findFirst() with no where clause returned whichever org the
  // database happened to yield first, so on a multi-tenant instance the emailed PDF could carry
  // another tenant's branding, terms and template.
  const org = await prisma.organization.findUnique({ where: { id: est.organization_id } });
  if (!org) throw new Error('Organization not configured');

  // Prisma returns Decimal for numeric fields; EstimateForPdf expects number — cast via any (same pattern as controller)
  return generateEstimatePdf(toEstimateDocument(est) as any, org, (org.estimate_template ?? 'alpha-classic') as any);
}

/** Mirrors renderEstimatePdfBuffer above, sharing invoicePdfSelect/toInvoiceForPdf with
 * invoice.controller.ts's getPdf/getPublicPdf (lib/pdf/invoice-select.ts) so all three entry
 * points read/reshape the invoice row identically. Returns the org row alongside the buffer
 * so the caller (sendInvoiceEmail) can reuse it for the subject line instead of a second
 * organization.findUnique for the same id. */
async function renderInvoicePdfBuffer(invoiceId: string): Promise<{ buffer: Buffer; org: { name: string | null } }> {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: invoicePdfSelect,
  });
  if (!inv) throw new Error(`Invoice not found for PDF: ${invoiceId}`);

  // The invoice's OWN organization, exactly as renderEstimatePdfBuffer scopes to the estimate's.
  // Both PDFs are branded from the record's org on purpose: a where-less read of `organization`
  // yields an arbitrary row, which on a multi-tenant instance puts another tenant's branding on a
  // document mailed to this one's customer. Guarded by the cross-tenant block in
  // __tests__/email-estimate-senders.test.ts.
  const org = await prisma.organization.findUnique({ where: { id: inv.organization_id } });
  if (!org) throw new Error('Organization not configured');

  const buffer = await generateInvoicePdf(toInvoiceForPdf(inv), org, (org.estimate_template ?? 'alpha-classic') as any);
  return { buffer, org };
}

// ─── Public API ──────────────────────────────────────────

/**
 * Send a human-composed message from the Communication inbox compose window
 * (email slice 7 - the Resend send path). Unlike every other sender in this
 * file, there is no template to render: `text`/`html` arrive exactly as the
 * caller composed them, and `attachments` are the caller's own in-memory file
 * buffers (no PDF rendering).
 *
 * Still routed through the SAME `dispatchEmail` choke point as every other
 * sender, so the org-level `email_sending_enabled` kill switch and the locked
 * From header apply identically to a compose send as to a transactional one.
 * The controller owns persistence directly (HUMAN_COMPOSED_ACCOUNT, cc/bcc,
 * EmailAttachment rows) rather than going through persistTransactionalEmail,
 * which hardcodes `account: 'system'` for the MIRRORED-transactional shape -
 * see HUMAN_COMPOSED_ACCOUNT's own comment in comm-whatsapp-email.controller.ts
 * for why a person-composed row can never carry that marker.
 */
export async function sendComposedEmail(params: {
  organizationId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
  /**
   * Email slice 6: the `<token>@EMAIL_REPLY_DOMAIN` address a customer's reply
   * should land on. OPTIONAL, so a caller with no thread to route a reply back
   * to simply omits it and keeps the previous behaviour - a reply then goes to
   * the From address, which is unmonitored. Never defaulted here: silently
   * inventing a reply address for a caller that did not mint a token would
   * advertise an address resolving to nothing.
   */
  replyTo?: string;
}): Promise<EmailDispatchResult> {
  try {
    return await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(params.cc ? { cc: params.cc } : {}),
      ...(params.bcc ? { bcc: params.bcc } : {}),
      subject: params.subject,
      text: params.text,
      ...(params.html ? { html: params.html } : {}),
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
      ...(params.attachments && params.attachments.length > 0 ? { attachments: params.attachments } : {}),
    });
  } catch (err) {
    logger.error(`Failed to send composed email to ${params.to}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

export async function sendEstimateEmail(params: {
  estimateId: string;
  org: OrganizationBrandingSubset;
  to: string;
  cc?: string[];
  message?: string;
  customerName: string;
  estimateNumber: string;
  total: string;
  publicUrl: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  try {
    const pdfBuffer = await renderEstimatePdfBuffer(params.estimateId);
    const attachment = pdfAttachment(`estimate-${params.estimateNumber}.pdf`, pdfBuffer);
    const subject = `Estimate ${params.estimateNumber} from ${params.org.name}`;
    const customMessage = params.message?.trim();
    const text = customMessage
      ? `Hi ${params.customerName},\n\n${customMessage}\n\nYour estimate ${params.estimateNumber} for ${params.total} is ready. View it here: ${params.publicUrl}`
      : `Hi ${params.customerName}, your estimate ${params.estimateNumber} for ${params.total} is ready. View it here: ${params.publicUrl}`;
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.org.id, {
      to: params.to,
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
      ...(reply ? { replyTo: reply.address } : {}),
      subject,
      text,
      html: estimateEmailHtml({
        customerName: params.customerName,
        estimateNumber: params.estimateNumber,
        total: params.total,
        publicUrl: params.publicUrl,
        message: params.message,
        org: params.org,
      }),
      attachments: [attachment.pdf],
    });
    if (result.status === 'sent') {
      logger.info(`Estimate email sent to ${params.to} for ${params.estimateNumber}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, cc: params.cc, subject, text, result,
          attachments: attachment.record,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error(`Failed to send estimate email for ${params.estimateNumber}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

// ─── Stage pickup ticket (inventory Staging → assigned tech / pickup contacts) ──
// A clean HTML line table, no PDF. Routed through dispatchEmail so the org email
// kill-switch applies like every business sender.
export interface StagePickupEmailLine {
  sku: string;
  name: string;
  qtyReceived: number;
  qtyOrdered: number;
  uom: string;
}

export type StagePickupEmailResult = EmailDispatchResult & { subject: string; html: string };

function stagePickupEmailHtml(params: {
  org: OrganizationBrandingSubset;
  message?: string;
  jobNumber: string;
  customer: string;
  site: string;
  scheduledFor?: string | null;
  notes?: string | null;
  lines: StagePickupEmailLine[];
  /** The ORG's zone. The backend process runs in UTC, so without this the ticket mails a UTC wall clock. */
  timezone?: string;
}): string {
  const lineRows = params.lines.map((line) => h`
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#6b7280;">${line.sku || '-'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;">${line.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;text-align:center;">${line.qtyReceived}/${line.qtyOrdered}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;text-align:center;">${line.uom}</td>
    </tr>
  `).join('');

  const scheduledRow = params.scheduledFor
    ? h`<p style="margin:0 0 8px;font-size:14px;color:#6b7280;">Scheduled: ${new Date(params.scheduledFor).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: params.timezone ?? DEFAULT_TIMEZONE })}</p>`
    : '';
  const notesBlock = params.notes
    ? h`<p style="margin:16px 0 0;font-size:14px;color:#374151;"><strong>Notes:</strong> ${params.notes}</p>`
    : '';

  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Pickup Ticket · ${params.jobNumber}</h2>
    <p style="margin:0 0 4px;font-size:15px;color:#374151;">${params.customer}</p>
    <p style="margin:0 0 8px;font-size:14px;color:#6b7280;">${params.site}</p>
    ${raw(scheduledRow)}
    ${raw(customMessageBlock(params.message))}
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin:16px 0 0;">
      <tr style="background:#f9fafb;">
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6b7280;font-weight:600;">SKU</th>
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6b7280;font-weight:600;">Item</th>
        <th style="padding:10px 12px;text-align:center;font-size:13px;color:#6b7280;font-weight:600;">Received</th>
        <th style="padding:10px 12px;text-align:center;font-size:13px;color:#6b7280;font-weight:600;">UoM</th>
      </tr>
      ${raw(lineRows)}
    </table>
    ${raw(notesBlock)}
    <p style="margin:24px 0 0;font-size:13px;color:#9ca3af;">Reply to this email to acknowledge pickup.</p>
  `, params.org);
}

export async function sendStagePickupEmail(params: {
  organizationId: string;
  org: OrganizationBrandingSubset;
  to: string | string[];
  cc?: string[];
  subject?: string;
  message?: string;
  jobNumber: string;
  customer: string;
  site: string;
  scheduledFor?: string | null;
  notes?: string | null;
  lines: StagePickupEmailLine[];
  /**
   * The ORG's zone. This was the one sender that prints a visit time and did not thread it,
   * so it mailed the technician a UTC wall clock - the backend process runs in UTC.
   */
  timezone?: string;
  /** Stamp the send on the job's Communication history (pass jobId/jobLabel). */
  record?: TransactionalEmailRecord;
}): Promise<StagePickupEmailResult> {
  const subject = params.subject?.trim() || `Pickup Ticket ${params.jobNumber} - ${params.customer}`;
  const html = stagePickupEmailHtml(params);
  try {
    const customMessage = params.message?.trim();
    const base = `Pickup ticket ${params.jobNumber} - ${params.customer} at ${params.site}. ${params.lines.length} line(s).`;
    const text = customMessage ? `${customMessage}\n\n${base}` : base;
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
      subject,
      text,
      html,
    });
    if (result.status === 'sent') {
      logger.info(`Stage pickup email sent to ${params.to} for ${params.jobNumber}`);
      // Also an outside-party send (pickup contacts), and the StageAuditEntry the
      // controller writes lives on the stage, not on the job's Communication tab.
      if (params.record) {
        await persistTransactionalEmail({
          ...params.record,
          cc: params.cc,
          to: recipientLabel(params.to),
          subject,
          text,
          ...sentTrace(result),
        });
      }
    }
    return { ...result, subject, html };
  } catch (err) {
    logger.error(`Failed to send stage pickup email for ${params.jobNumber}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error', subject, html };
  }
}

function userInviteHtml(params: {
  firstName: string;
  orgName: string;
  inviteUrl: string;
  org: OrganizationBrandingSubset;
}): string {
  const brandColor = params.org?.brand_color ?? '#242424';
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">You're invited to ${params.orgName}</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">Hi ${params.firstName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      You've been invited to join <strong>${params.orgName}</strong> on ServWave.
      Click below to finish setting up your account.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td style="background:${brandColor};border-radius:6px;padding:12px 28px;">
        <a href="${params.inviteUrl}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">Accept your invitation</a>
      </td></tr>
    </table>
    <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
      On the next screen you can set a password or continue with Google - no password needed.
    </p>
    <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">This invitation link expires in 7 days.</p>
  `, params.org);
}

/**
 * Send a branded user-invitation email. Fetches org branding by id. Returns true
 * if the email was actually dispatched, false if Resend is unconfigured or the
 * send failed (the caller surfaces this so the admin can copy the link instead).
 */
export async function sendUserInviteEmail(params: {
  to: string;
  firstName: string;
  inviteUrl: string;
  organizationId: string;
}): Promise<boolean> {
  if (!resend) {
    logger.warn('RESEND_API_KEY not set - skipping user invite email');
    return false;
  }
  const orgRow = await prisma.organization.findUnique({
    where: { id: params.organizationId },
    select: { name: true, logo_url: true, brand_color: true },
  });
  const org: OrganizationBrandingSubset = {
    id: params.organizationId,
    name: orgRow?.name ?? 'ServWave',
    logo_url: orgRow?.logo_url ?? null,
    brand_color: orgRow?.brand_color ?? '#242424',
  };
  try {
    await resend.emails.send({
      from: env.EMAIL_FROM,
      to: params.to,
      subject: `You're invited to ${org.name} on ServWave`,
      text: `Hi ${params.firstName}, you've been invited to join ${org.name} on ServWave. Accept your invitation to finish setup: ${params.inviteUrl} - you can set a password or continue with Google.`,
      html: userInviteHtml({ firstName: params.firstName, orgName: org.name, inviteUrl: params.inviteUrl, org }),
    });
    logger.info(`User invite email sent to ${params.to}`);
    return true;
  } catch (err) {
    logger.error(`Failed to send user invite email to ${params.to}:`, err);
    return false;
  }
}

function mfaCodeHtml(params: { firstName?: string | null; code: string }): string {
  const greeting = params.firstName ? `Hi ${params.firstName},` : 'Hi,';
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Your verification code</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Use this code to finish signing in. It expires in 10 minutes.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td style="background:#f3f4f6;border-radius:8px;padding:16px 28px;">
        <span style="font-size:30px;font-weight:700;letter-spacing:8px;color:#111827;">${params.code}</span>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      If you didn't try to sign in, you can ignore this email - someone may have mistyped their address.
    </p>
  `);
}

/**
 * Send an email-OTP verification code (2FA login or enrollment). Degrades
 * gracefully: if Resend is unconfigured the code is logged (dev/demo) and the
 * caller still proceeds, mirroring every other sender in this module. Returns
 * true only when the email was actually dispatched.
 */
export async function sendMfaCodeEmail(params: {
  to: string;
  code: string;
  firstName?: string | null;
}): Promise<boolean> {
  if (!resend) {
    // No mailer in this environment — surface the code so a dev/demo can still
    // complete the flow. NEVER reachable in production (a verified Resend domain
    // is required there); guard on NODE_ENV anyway so a live OTP can never be
    // written to production logs even if that invariant is ever violated.
    if (env.NODE_ENV === 'production') {
      logger.error(`RESEND_API_KEY not set - cannot send MFA code to ${params.to}`);
    } else {
      logger.warn(`RESEND_API_KEY not set - MFA code for ${params.to} is ${params.code} (dev fallback)`);
    }
    return false;
  }
  try {
    await resend.emails.send({
      from: env.EMAIL_FROM,
      to: params.to,
      subject: `Your ServWave verification code: ${params.code}`,
      text: `Your ServWave verification code is ${params.code}. It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.`,
      html: mfaCodeHtml({ firstName: params.firstName, code: params.code }),
    });
    logger.info(`MFA code email sent to ${params.to}`);
    return true;
  } catch (err) {
    logger.error(`Failed to send MFA code email to ${params.to}:`, err);
    return false;
  }
}

export async function sendEstimateApprovedNotification(params: {
  estimateId: string;
  org: OrganizationBrandingSubset;
  to: string;
  customerName: string;
  estimateNumber: string;
  total: string;
  /**
   * #2090 - the add-ons the customer chose and the ones they turned down, derived from the
   * DOCUMENT view-model (lib/estimate-document-view.ts) rather than re-read from the flags, so
   * this email and the attached PDF cannot disagree about what was taken. Absent, or with two
   * empty lists, this email is byte-for-byte what it was before optional items existed.
   */
  options?: { chosen: string[]; declined: string[] };
  record?: TransactionalEmailRecord;
}): Promise<void> {
  try {
    const pdfBuffer = await renderEstimatePdfBuffer(params.estimateId);
    const attachment = pdfAttachment(`estimate-${params.estimateNumber}.pdf`, pdfBuffer);
    const subject = `Estimate ${params.estimateNumber} - Approved`;
    const chosen = params.options?.chosen ?? [];
    const declined = params.options?.declined ?? [];
    const optionsText = [
      chosen.length > 0 ? `Add-ons included: ${chosen.join(', ')}.` : '',
      declined.length > 0 ? `Add-ons not included: ${declined.join(', ')}.` : '',
    ].filter(Boolean).join(' ');
    const text = `Hi ${params.customerName}, your estimate ${params.estimateNumber} for ${params.total} has been approved.`
      + (optionsText ? ` ${optionsText}` : '')
      + ' Please find the signed estimate attached.';
    const result = await dispatchEmail(params.org.id, {
      to: params.to,
      subject,
      text,
      html: wrapHtml(h`
        <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Estimate Approved</h2>
        <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
        <p style="margin:0 0 16px;font-size:15px;color:#374151;">
          Thank you for approving estimate <strong>${params.estimateNumber}</strong> for <strong>${params.total}</strong>.
          Please find the signed estimate attached to this email.
        </p>
        ${raw(chosen.length > 0 ? h`
        <p style="margin:0 0 8px;font-size:15px;color:#374151;">
          <strong>Add-ons included:</strong> ${chosen.join(', ')}
        </p>` : '')}
        ${raw(declined.length > 0 ? h`
        <p style="margin:0 0 16px;font-size:15px;color:#6b7280;">
          <strong>Add-ons not included:</strong> ${declined.join(', ')}
        </p>` : '')}
        <p style="margin:0;font-size:13px;color:#9ca3af;">
          Our team will be in touch shortly to schedule your service.
        </p>
      `, params.org),
      attachments: [attachment.pdf],
    });
    if (result.status === 'sent') {
      logger.info(`Estimate approved notification sent to ${params.to} for ${params.estimateNumber}`);
      if (params.record) {
        await persistTransactionalEmail({
          ...params.record, to: params.to, subject, text, attachments: attachment.record, ...sentTrace(result),
        });
      }
    }
  } catch (err) {
    logger.error(`Failed to send estimate approved notification for ${params.estimateNumber}:`, err);
  }
}

export async function sendEstimateWithDepositEmail(params: {
  estimateId: string;
  org: OrganizationBrandingSubset;
  to: string;
  cc?: string[];
  message?: string;
  customerName: string;
  estimateNumber: string;
  total: string;
  depositAmount: string;
  depositPercentage: number;
  publicUrl: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Your Estimate is Ready</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    ${raw(customMessageBlock(params.message))}
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">We've prepared estimate <strong>${params.estimateNumber}</strong> for you. A deposit is required to confirm your appointment.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Estimate</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.estimateNumber}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Estimate Total</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.total}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Deposit Required (${params.depositPercentage}%)</p>
        <p style="margin:0;font-size:24px;font-weight:700;color:#111827;">${params.depositAmount}</p>
      </td></tr>
    </table>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td style="background:${params.org.brand_color};border-radius:6px;padding:12px 28px;">
        <a href="${params.publicUrl}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">View Estimate &amp; Pay Deposit</a>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      You can review and pay your deposit using the link above.
    </p>
  `, params.org);
  try {
    const pdfBuffer = await renderEstimatePdfBuffer(params.estimateId);
    const attachment = pdfAttachment(`estimate-${params.estimateNumber}.pdf`, pdfBuffer);
    const subject = `Estimate ${params.estimateNumber} - Deposit Required`;
    const customMessage = params.message?.trim();
    const text = customMessage
      ? `Hi ${params.customerName},\n\n${customMessage}\n\nEstimate ${params.estimateNumber} for ${params.total} is ready. A deposit of ${params.depositAmount} (${params.depositPercentage}%) is required. View it here: ${params.publicUrl}`
      : `Hi ${params.customerName}, estimate ${params.estimateNumber} for ${params.total} is ready. A deposit of ${params.depositAmount} (${params.depositPercentage}%) is required. View it here: ${params.publicUrl}`;
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.org.id, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
      subject,
      text,
      html,
      attachments: [attachment.pdf],
    });
    if (result.status === 'sent') {
      logger.info(`Estimate with deposit email sent to ${params.to} for ${params.estimateNumber}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, cc: params.cc, subject, text, result,
          attachments: attachment.record,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error(`Failed to send estimate with deposit email for ${params.estimateNumber}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

export async function sendDepositPaymentConfirmation(params: {
  organizationId: string;
  to: string;
  customerName: string;
  estimateNumber: string;
  depositAmount: number;
  totalCharged: number;
  paymentMethod: string;
  transactionId?: string;
  companyName: string;
  record?: TransactionalEmailRecord;
}): Promise<void> {
  const txRow = params.transactionId ? h`
    <tr>
      <td style="padding:6px 12px;font-size:13px;color:#9ca3af;">Transaction ID</td>
      <td style="padding:6px 12px;font-size:13px;color:#9ca3af;text-align:right;">${params.transactionId}</td>
    </tr>
  ` : '';
  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Deposit Payment Confirmed</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      We've received your deposit payment for estimate <strong>${params.estimateNumber}</strong>. Our team will be in touch to schedule your service.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin:0 0 24px;">
      <tr style="background:#f9fafb;">
        <th style="padding:10px 12px;text-align:left;font-size:13px;color:#6b7280;font-weight:600;">Description</th>
        <th style="padding:10px 12px;text-align:right;font-size:13px;color:#6b7280;font-weight:600;">Amount</th>
      </tr>
      <tr>
        <td style="padding:8px 12px;font-size:14px;color:#374151;">Deposit - ${params.estimateNumber}</td>
        <td style="padding:8px 12px;font-size:14px;color:#374151;text-align:right;">${formatCurrency(params.depositAmount)}</td>
      </tr>
      <tr style="background:#f9fafb;">
        <td style="padding:10px 12px;font-size:15px;font-weight:700;color:#111827;">Total Charged</td>
        <td style="padding:10px 12px;font-size:15px;font-weight:700;color:#111827;text-align:right;">${formatCurrency(params.totalCharged)}</td>
      </tr>
      <tr>
        <td style="padding:6px 12px;font-size:13px;color:#9ca3af;">Payment Method</td>
        <td style="padding:6px 12px;font-size:13px;color:#9ca3af;text-align:right;">${params.paymentMethod}</td>
      </tr>
      ${raw(txRow)}
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      Thank you for choosing ${params.companyName}.
    </p>
  `);
  try {
    const subject = `Deposit Receipt - ${params.estimateNumber}`;
    const text = `Hi ${params.customerName}, your deposit of ${formatCurrency(params.totalCharged)} for estimate ${params.estimateNumber} has been received via ${params.paymentMethod}. Thank you for choosing ${params.companyName}.`;
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      subject,
      text,
      html,
    });
    if (result.status === 'sent') {
      logger.info(`Deposit payment confirmation sent to ${params.to} for ${params.estimateNumber}`);
      if (params.record) {
        await persistTransactionalEmail({ ...params.record, to: params.to, subject, text, ...sentTrace(result) });
      }
    }
  } catch (err) {
    logger.error(`Failed to send deposit payment confirmation for ${params.estimateNumber}:`, err);
  }
}

export async function sendDepositReceivedConfirmation(params: {
  organizationId: string;
  to: string;
  customerName: string;
  estimateNumber: string;
  depositAmount: number;
  paymentMethod: string;
  receivedDate: string;
  companyName: string;
  record?: TransactionalEmailRecord;
}): Promise<void> {
  const methodLabels: Record<string, string> = {
    CARD: 'Credit/Debit Card',
    BANK_TRANSFER: 'Bank Transfer (ACH)',
    CHECK: 'Check',
    CASH: 'Cash',
    // R5b (2026-07-22) — D3.
    ZELLE: 'Zelle',
    VENMO: 'Venmo',
    CASH_APP: 'Cash App',
    OTHER: 'Other',
  };
  const methodLabel = methodLabels[params.paymentMethod] ?? params.paymentMethod;
  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Deposit Received</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      We've recorded your deposit payment for estimate <strong>${params.estimateNumber}</strong>. Our team will be in touch to schedule your service.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Deposit Amount</p>
        <p style="margin:0 0 16px;font-size:24px;font-weight:700;color:#111827;">${formatCurrency(params.depositAmount)}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Payment Method</p>
        <p style="margin:0 0 16px;font-size:15px;color:#374151;">${methodLabel}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Date Received</p>
        <p style="margin:0;font-size:15px;color:#374151;">${params.receivedDate}</p>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      Thank you for choosing ${params.companyName}.
    </p>
  `);
  try {
    const subject = `Deposit Received - ${params.estimateNumber}`;
    const text = `Hi ${params.customerName}, your deposit of ${formatCurrency(params.depositAmount)} for estimate ${params.estimateNumber} has been received via ${methodLabel} on ${params.receivedDate}. Thank you for choosing ${params.companyName}.`;
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      subject,
      text,
      html,
    });
    if (result.status === 'sent') {
      logger.info(`Deposit received confirmation sent to ${params.to} for ${params.estimateNumber}`);
      if (params.record) {
        await persistTransactionalEmail({ ...params.record, to: params.to, subject, text, ...sentTrace(result) });
      }
    }
  } catch (err) {
    logger.error(`Failed to send deposit received confirmation for ${params.estimateNumber}:`, err);
  }
}

export async function sendRefundNotification(params: {
  organizationId: string;
  to: string;
  customerName: string;
  estimateNumber: string;
  refundAmount: number;
  reason: string;
  companyName: string;
  record?: TransactionalEmailRecord;
}): Promise<void> {
  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Deposit Refund Issued</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      A refund has been issued for the deposit on estimate <strong>${params.estimateNumber}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Refund Amount</p>
        <p style="margin:0 0 16px;font-size:24px;font-weight:700;color:#111827;">${formatCurrency(params.refundAmount)}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Reason</p>
        <p style="margin:0;font-size:15px;color:#374151;">${params.reason}</p>
      </td></tr>
    </table>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Please allow 5–10 business days for the refund to appear on your statement, depending on your payment method and bank.
    </p>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      If you have any questions, please contact ${params.companyName} directly.
    </p>
  `);
  try {
    const subject = `Refund Issued - ${params.estimateNumber}`;
    const text = `Hi ${params.customerName}, a refund of ${formatCurrency(params.refundAmount)} has been issued for estimate ${params.estimateNumber}. Reason: ${params.reason}. Please allow 5–10 business days for the refund to appear.`;
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      subject,
      text,
      html,
    });
    if (result.status === 'sent') {
      logger.info(`Refund notification sent to ${params.to} for ${params.estimateNumber}`);
      if (params.record) {
        await persistTransactionalEmail({ ...params.record, to: params.to, subject, text, ...sentTrace(result) });
      }
    }
  } catch (err) {
    logger.error(`Failed to send refund notification for ${params.estimateNumber}:`, err);
  }
}

export async function sendInvoiceRefundNotification(params: {
  organizationId: string;
  to: string;
  customerName: string;
  invoiceNumber: string;
  refundAmount: number;
  record?: TransactionalEmailRecord;
}): Promise<void> {
  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Invoice Refund Issued</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      A refund has been issued for invoice <strong>${params.invoiceNumber}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Refund Amount</p>
        <p style="margin:0;font-size:24px;font-weight:700;color:#111827;">${formatCurrency(params.refundAmount)}</p>
      </td></tr>
    </table>
    <p style="margin:0;font-size:15px;color:#374151;">
      Please allow 5–10 business days for the refund to appear on your statement.
    </p>
  `);
  try {
    const subject = `Refund Issued - ${params.invoiceNumber}`;
    const text = `Hi ${params.customerName}, a refund of ${formatCurrency(params.refundAmount)} has been issued for invoice ${params.invoiceNumber}. Please allow 5–10 business days for the refund to appear.`;
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      subject,
      text,
      html,
    });
    if (result.status === 'sent') {
      logger.info(`Invoice refund notification sent to ${params.to} for ${params.invoiceNumber}`);
      if (params.record) {
        await persistTransactionalEmail({ ...params.record, to: params.to, subject, text, ...sentTrace(result) });
      }
    }
  } catch (err) {
    logger.error(`Failed to send invoice refund notification for ${params.invoiceNumber}:`, err);
  }
}

export async function sendDepositPaidAlert(params: {
  organizationId: string;
  to: string;
  estimateNumber: string;
  customerName: string;
  depositAmount: number;
  paymentMethod: string;
}): Promise<void> {
  const methodLabels: Record<string, string> = {
    CARD: 'Card',
    BANK_TRANSFER: 'Bank Transfer',
    CHECK: 'Check',
    CASH: 'Cash',
    // R5b (2026-07-22) — D3.
    ZELLE: 'Zelle',
    VENMO: 'Venmo',
    CASH_APP: 'Cash App',
    OTHER: 'Other',
  };
  const methodLabel = methodLabels[params.paymentMethod] ?? params.paymentMethod;
  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Deposit Received</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Deposit received for <strong>${params.estimateNumber}</strong> from <strong>${params.customerName}</strong> -
      <strong>${formatCurrency(params.depositAmount)}</strong> via ${methodLabel}.
    </p>
    <p style="margin:0;font-size:15px;color:#374151;">
      You can now create a job for this estimate.
    </p>
  `);
  try {
    await dispatchEmail(params.organizationId, {
      to: params.to,
      subject: `Deposit Received - ${params.estimateNumber}`,
      text: `Deposit received for ${params.estimateNumber} from ${params.customerName} - ${formatCurrency(params.depositAmount)} via ${methodLabel}. You can now create a job.`,
      html,
    });
    logger.info(`Deposit paid alert sent to ${params.to} for ${params.estimateNumber}`);
  } catch (err) {
    logger.error(`Failed to send deposit paid alert for ${params.estimateNumber}:`, err);
  }
}

export async function sendPaymentMethodSelectedAlert(params: {
  organizationId: string;
  to: string;
  estimateNumber: string;
  customerName: string;
  paymentMethod: string;
  depositAmount: number;
}): Promise<void> {
  const methodLabels: Record<string, string> = {
    CARD: 'Card',
    BANK_TRANSFER: 'Bank Transfer',
    CHECK: 'Check',
    CASH: 'Cash',
    // R5b (2026-07-22) — D3.
    ZELLE: 'Zelle',
    VENMO: 'Venmo',
    CASH_APP: 'Cash App',
    OTHER: 'Other',
  };
  const methodLabel = methodLabels[params.paymentMethod] ?? params.paymentMethod;
  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Customer Selected Payment Method</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      <strong>${params.customerName}</strong> selected <strong>${methodLabel}</strong> for the
      <strong>${formatCurrency(params.depositAmount)}</strong> deposit on estimate <strong>${params.estimateNumber}</strong>.
    </p>
    <p style="margin:0;font-size:15px;color:#374151;">
      Watch for incoming payment before marking the deposit as received.
    </p>
  `);
  try {
    await dispatchEmail(params.organizationId, {
      to: params.to,
      subject: `Payment Method Selected - ${params.estimateNumber}`,
      text: `Customer selected ${methodLabel} for ${formatCurrency(params.depositAmount)} deposit on ${params.estimateNumber}. Watch for incoming payment.`,
      html,
    });
    logger.info(`Payment method selected alert sent to ${params.to} for ${params.estimateNumber}`);
  } catch (err) {
    logger.error(`Failed to send payment method selected alert for ${params.estimateNumber}:`, err);
  }
}

// ─── ServWave Payments — action-needed email (Task 1.9 / §6.6-§6.8) ──────────
//
// The in-app notification service (services/notifications/) has no email
// channel — it only writes Notification/NotificationRecipient rows. For the
// "Stripe needs more info" / "payments paused" moments, an admin who doesn't
// have the app open needs an actual email. Co-branded as ServWave Payments,
// not raw Stripe, matching every other sender in this file.

function paymentsActionNeededHtml(params: {
  orgName: string;
  fixUrl: string;
}): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Action needed to keep payments running</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#374151;">
      Stripe needs one more thing to keep <strong>${params.orgName}</strong>'s card payments running.
      Finish setup below and we'll turn your card payments back on automatically.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td style="background:#242424;border-radius:6px;padding:12px 28px;">
        <a href="${params.fixUrl}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">Finish setup</a>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      This is a ServWave Payments account notice, not a message from Stripe.
    </p>
  `);
}

/**
 * Co-branded action-needed email (Task 1.9). Sent to every active org ADMIN
 * from webhook.controller.ts's handleAccountLifecycle when Stripe's
 * requirements_due gains items or the account becomes disabled/restricted —
 * the "Interrupt + email" half of billing.payments_action_needed /
 * billing.payments_paused (§6.7). Deep-links to Settings → Payments.
 */
export async function sendPaymentsActionNeededEmail(params: {
  organizationId: string;
  to: string;
  orgName: string;
  fixUrl: string;
}): Promise<void> {
  try {
    // §6.8 copy appendix: "Action needed | Status card / email subject | Stripe
    // needs one more thing to keep your payments running." — subject is the
    // exact centralized string; the body personalizes with the org name.
    //
    // The specific Stripe requirement (raw codes like `requirements.past_due` or
    // `individual.ssn_last_4`) is deliberately NOT surfaced here - those machine
    // strings are not user-friendly and the actual to-do always lives on Stripe's
    // own screens behind the "Finish setup" link.
    const subject = 'Stripe needs one more thing to keep your payments running.';
    const text = `Stripe needs one more thing to keep ${params.orgName}'s card payments running. Finish setup: ${params.fixUrl}`;
    await dispatchEmail(params.organizationId, {
      to: params.to,
      subject,
      text,
      html: paymentsActionNeededHtml({ orgName: params.orgName, fixUrl: params.fixUrl }),
    }, { senderIdentity: 'platform' });
    logger.info(`Payments action-needed email sent to ${params.to} for org ${params.organizationId}`);
  } catch (err) {
    logger.error(`Failed to send payments action-needed email for org ${params.organizationId}:`, err);
  }
}

// ─── ServWave Payments — rate-change notice (Task 4.3 / §3.6) ────────────────
//
// Within-ceiling changes to the support-only Organization.platform_fee_bps
// knob (never exposed in patchOrgSchema or any settings UI) need no
// re-acceptance, but DO need ≥30-day advance notice. Co-branded like every
// other sender in this file — this is a ServWave Payments notice, not Stripe.

function paymentsRateChangeNoticeHtml(params: {
  orgName: string;
  oldRate: string;
  newRate: string;
  effectiveDate: string;
}): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Your ServWave Payments rate is changing</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      We're updating the ServWave Payments processing rate for <strong>${params.orgName}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Current rate</p>
        <p style="margin:0 0 16px;font-size:15px;color:#374151;">${params.oldRate}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">New rate</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.newRate}</p>
        <p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Effective</p>
        <p style="margin:0;font-size:15px;color:#374151;">${params.effectiveDate}</p>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      No action is needed - this stays within the terms you've already accepted, so no re-acceptance is required.
    </p>
  `);
}

/**
 * Within-ceiling rate-change notice (Task 4.3 / §3.6). Sent to every active org
 * ADMIN by notifyPlatformFeeRateChange (lib/platform-fee-rate-notice.ts) when
 * Organization.platform_fee_bps changes within the 2% ceiling. Co-branded,
 * matching sendPaymentsActionNeededEmail's structure.
 */
export async function sendPaymentsRateChangeNotice(params: {
  organizationId: string;
  to: string;
  orgName: string;
  oldRate: string;
  newRate: string;
  effectiveDate: string;
}): Promise<void> {
  try {
    const subject = 'Your ServWave Payments rate is changing.';
    const text = `${params.orgName}'s ServWave Payments processing rate is changing from ${params.oldRate} to ${params.newRate}, effective ${params.effectiveDate}. No action is needed - no re-acceptance is required.`;
    await dispatchEmail(params.organizationId, {
      to: params.to,
      subject,
      text,
      html: paymentsRateChangeNoticeHtml({
        orgName: params.orgName,
        oldRate: params.oldRate,
        newRate: params.newRate,
        effectiveDate: params.effectiveDate,
      }),
    }, { senderIdentity: 'platform' });
    logger.info(`Payments rate-change notice sent to ${params.to} for org ${params.organizationId}`);
  } catch (err) {
    logger.error(`Failed to send payments rate-change notice for org ${params.organizationId}:`, err);
  }
}

// ─── Invoice Email Functions ──────────────────────────────

const methodLabels: Record<string, string> = {
  CARD: 'Card',
  BANK_TRANSFER: 'Bank Transfer',
  CHECK: 'Check',
  CASH: 'Cash',
  // R5b (2026-07-22) — D3.
  ZELLE: 'Zelle',
  VENMO: 'Venmo',
  CASH_APP: 'Cash App',
  OTHER: 'Other',
};

// ─── Schedule notices to the customer (SRVW-243) ──────────────────────────
//
// These four are the pre-#1003 senders, restored. #1003 deleted them on the
// premise that the Automation Center would carry the same messages, but a
// workflow only speaks for an org that HAS the workflow rows, and four of five
// prod orgs never got them - so between the cutover and now, scheduling a job
// told the customer nothing while the confirm dialog claimed otherwise.
//
// The one deliberate change from the deleted versions: they were
// `Promise<void>` around a swallowing catch, and these return
// EmailDispatchResult. A caller that just pressed "notify the customer" is owed
// the answer (#973's send-honesty rule), and cannot get it from a void.
//
// Customer-facing only. The performer/owner/crew copies the old walkthrough
// senders also fanned out are internal notices with no opt-in behind them, and
// stay the automation engine's business.

function jobScheduledHtml(params: {
  customerName: string;
  jobNumber: string;
  technicianName: string;
  scheduledStart?: string | null;
  serviceAddress: string;
  message?: string;
  /** Undefined only when the org row itself could not be loaded — wrapHtml's own
   *  'ServWave' fallback is reserved for exactly that case, not a routine omission. */
  org?: OrganizationBrandingSubset;
}): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Your Service Has Been Scheduled</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    ${raw(params.message?.trim()
      ? customMessageBlock(params.message)
      : h`<p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Your service appointment <strong>${params.jobNumber}</strong> has been scheduled. Here are the details:
    </p>`)}
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Technician</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.technicianName}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Service Address</p>
        <p style="margin:0 0 16px;font-size:15px;color:#374151;">${params.serviceAddress}</p>
        ${raw(params.scheduledStart ? h`
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Scheduled Date &amp; Time</p>
        <p style="margin:0;font-size:15px;font-weight:600;color:#111827;">${params.scheduledStart}</p>
        ` : '')}
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      If you need to reschedule, please contact us.
    </p>
  `, params.org);
}

function jobRescheduledHtml(params: {
  customerName: string;
  jobNumber: string;
  newScheduledStart: string;
  technicianName: string;
  serviceAddress: string;
  message?: string;
  /** Undefined only when the org row itself could not be loaded — see jobScheduledHtml. */
  org?: OrganizationBrandingSubset;
}): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Job Rescheduled: ${params.jobNumber}</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    ${raw(params.message?.trim()
      ? customMessageBlock(params.message)
      : h`<p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Your scheduled job has been rescheduled. Here are the updated details:
    </p>`)}
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">New Date &amp; Time</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.newScheduledStart}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Technician</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.technicianName}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Service Address</p>
        <p style="margin:0;font-size:15px;color:#374151;">${params.serviceAddress}</p>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      If you have any questions, please contact us.
    </p>
  `, params.org);
}

/**
 * Multi-visit D19 / user story 39. The heading names the TRIP, never the job: cancelling a visit
 * unschedules that visit and leaves the job standing (D16), so copy that reads "Job J00001
 * cancelled" would tell the customer something false.
 */
function jobVisitCancelledHtml(params: {
  customerName: string;
  tripLabel: string;
  /** The trip's window, already rendered on the org clock. Start alone when it had no end. */
  cancelledWindow: string | null;
  /** The crew, or "Our team" when the trip carried none. */
  technicianName?: string;
  reason: string;
  message?: string;
  /** Undefined only when the org row itself could not be loaded — see jobScheduledHtml. */
  org?: OrganizationBrandingSubset;
}): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Visit Cancelled: ${params.tripLabel}</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    ${raw(params.message?.trim()
      ? customMessageBlock(params.message)
      : h`<p style="margin:0 0 16px;font-size:15px;color:#374151;">
      One of your scheduled visits has been cancelled. The rest of your service is unaffected.
    </p>`)}
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        ${raw(params.cancelledWindow ? h`
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Was Scheduled For</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.cancelledWindow}</p>
        ` : '')}
        ${raw(params.technicianName ? h`
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Your Technician</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.technicianName}</p>
        ` : '')}
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Reason</p>
        <p style="margin:0;font-size:15px;color:#374151;">${params.reason}</p>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      We will be in touch to rebook. If you have any questions, please contact us.
    </p>
  `, params.org);
}

/**
 * Calendar Entries (slice 07, spec §5) — customer-facing half of the three-outcome family
 * (scheduled / moved / cancelled). The whole point of the SCHEDULED outcome is free text (the
 * entry's own title/description, editable in the send dialog) — this is the ONE outcome of the
 * three that carries a `message` on its sender, exactly like jobScheduledHtml above.
 */
function calendarEntryScheduledHtml(params: {
  customerName: string;
  entryTitle: string;
  whenLabel?: string | null;
  message?: string;
  /** Undefined only when the org row itself could not be loaded — see jobScheduledHtml. */
  org?: OrganizationBrandingSubset;
}): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">You're Invited: ${params.entryTitle}</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    ${raw(params.message?.trim()
      ? customMessageBlock(params.message)
      : h`<p style="margin:0 0 16px;font-size:15px;color:#374151;">
      You've been added to <strong>${params.entryTitle}</strong> on the schedule.
    </p>`)}
    ${raw(params.whenLabel ? h`
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">When</p>
        <p style="margin:0;font-size:15px;font-weight:600;color:#111827;">${params.whenLabel}</p>
      </td></tr>
    </table>
    ` : '')}
  `, params.org);
}

/**
 * MOVED — fixed system wording (spec §5: "a dispatcher who has to hand-write [this] skips the
 * compose step and the customer never learns the time changed" — #1550 arriving through the UI).
 * Deliberately no `message` parameter anywhere in this function's signature — there is nothing
 * for a caller to plumb through, which is what makes the wording actually fixed rather than
 * fixed-by-convention.
 */
function calendarEntryMovedHtml(params: {
  customerName: string;
  entryTitle: string;
  whenLabel: string;
  /** Undefined only when the org row itself could not be loaded — see jobScheduledHtml. */
  org?: OrganizationBrandingSubset;
}): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Event Moved: ${params.entryTitle}</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      <strong>${params.entryTitle}</strong> has been moved to a new time. Here are the updated details:
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">New Date &amp; Time</p>
        <p style="margin:0;font-size:15px;font-weight:600;color:#111827;">${params.whenLabel}</p>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      If you have any questions, please contact us.
    </p>
  `, params.org);
}

/** CANCELLED — fixed system wording, same reasoning as calendarEntryMovedHtml above. */
function calendarEntryCancelledHtml(params: {
  customerName: string;
  entryTitle: string;
  whenLabel?: string | null;
  /** Undefined only when the org row itself could not be loaded — see jobScheduledHtml. */
  org?: OrganizationBrandingSubset;
}): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Cancelled: ${params.entryTitle}</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      <strong>${params.entryTitle}</strong> has been cancelled${params.whenLabel ? ` (was scheduled for ${params.whenLabel})` : ''}.
    </p>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      If you have any questions, please contact us.
    </p>
  `, params.org);
}

function walkthroughScheduledHtml(params: {
  customerName: string;
  scheduledDate: string;
  performerName: string;
  serviceAddress: string;
  companyName: string;
  message?: string;
  /** Undefined only when the org row itself could not be loaded — see jobScheduledHtml. */
  org?: OrganizationBrandingSubset;
}): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Site Visit Scheduled</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    ${raw(params.message?.trim()
      ? customMessageBlock(params.message)
      : h`<p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Your site visit has been scheduled. Here are the details:
    </p>`)}
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Date &amp; Time</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.scheduledDate}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Your Technician</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.performerName}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Service Address</p>
        <p style="margin:0;font-size:15px;color:#374151;">${params.serviceAddress}</p>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      Need to reschedule? Contact us at ${params.companyName}.
    </p>
  `, params.org);
}

function walkthroughRescheduledHtml(params: {
  customerName: string;
  newDate: string;
  performerName: string;
  serviceAddress: string;
  message?: string;
  /** Undefined only when the org row itself could not be loaded — see jobScheduledHtml. */
  org?: OrganizationBrandingSubset;
}): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Site Visit Rescheduled</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    ${raw(params.message?.trim()
      ? customMessageBlock(params.message)
      : h`<p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Your site visit has been rescheduled. Here are the updated details:
    </p>`)}
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">New Date &amp; Time</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.newDate}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Your Technician</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.performerName}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Service Address</p>
        <p style="margin:0;font-size:15px;color:#374151;">${params.serviceAddress}</p>
      </td></tr>
    </table>
  `, params.org);
}

/**
 * SRVW-243 - the text/plain twin of the HTML body.
 *
 * The HTML templates already render the admin's message in place of the
 * boilerplate intro while keeping the details table beneath it. The text part
 * was built from boilerplate alone, which broke two things at once: a
 * plain-text client read wording the admin never wrote, and
 * persistTransactionalEmail derives the mirrored row's snippet and body from
 * this same string, so the Communication tab misquoted an email that had left
 * the building correctly.
 *
 * `details` always follows the message, for the same reason the HTML table sits
 * below it - edited prose may add to the announcement but must never replace
 * what it states. Shape copied from sendEstimateEmail, which had this right.
 */
function composeNotifyText(customerName: string, details: string, message?: string): string {
  const custom = message?.trim();
  if (!custom) return `Hi ${customerName}, ${details}`;
  // Every caller writes `details` to continue "Hi {name}, " inline, so it opens
  // lowercase. Dropped under a custom message it starts its own paragraph and
  // needs a capital - prod sent "...this is a test\n\nyour service J00005 has
  // been scheduled...", and the same string is what the Communication tab
  // quotes back. Capitalising here rather than at the four call sites keeps the
  // no-message shape reading as one sentence.
  return `Hi ${customerName},\n\n${custom}\n\n${details.charAt(0).toUpperCase()}${details.slice(1)}`;
}

/**
 * Multi-visit D13: the customer is told about a TRIP, so the label names it. `visit_seq` is the
 * number that has already been in an inbox - never an index into the time-sorted list, which
 * renumbers when a trip is added or cancelled.
 *
 * Absent visitSeq the label is the bare job number, byte-identical to what the legacy /assign
 * door has always sent - that door passes none, so it has zero regression here.
 */
function tripLabel(jobNumber: string, visitSeq?: number | null): string {
  return visitSeq == null ? jobNumber : `${jobNumber} - Visit ${visitSeq}`;
}

export async function sendJobScheduledEmail(params: {
  organizationId: string;
  /** SRVW-243 header-brand fix - the org row the header wordmark/logo renders from
   *  (email.ts:80's From-name convention, applied to the body header too). Optional
   *  only so a caller that genuinely could not load the org still sends rather than
   *  throwing; wrapHtml's 'ServWave' fallback is reserved for exactly that case. */
  org?: OrganizationBrandingSubset;
  to: string;
  customerName: string;
  jobNumber: string;
  /** Multi-visit D13 - names the trip in the subject and the body. Omitted on the legacy
   *  /assign door, which keeps sending exactly what it always did. */
  visitSeq?: number | null;
  technicianName: string;
  scheduledStart?: Date | null;
  serviceAddress: string;
  timezone: string;
  /** SRVW-243 - extra addressees from the compose dialog (max 5, validated at the schema). */
  cc?: string[];
  /** SRVW-243 - the admin's own wording. Replaces the boilerplate intro line;
   *  the details table below it always renders, so an edited message can never
   *  make the email disagree with the schedule it is announcing. */
  message?: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  const scheduledStart = params.scheduledStart
    ? formatDateTimeInZone(params.scheduledStart, params.timezone)
    : null;
  const label = tripLabel(params.jobNumber, params.visitSeq);
  const subject = `Service Scheduled: ${label}`;
  const text = composeNotifyText(
    params.customerName,
    `your service ${label} has been scheduled${scheduledStart ? ` for ${scheduledStart}` : ''}. Technician: ${params.technicianName}. Address: ${params.serviceAddress}.`,
    params.message,
  );
  try {
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
      subject,
      text,
      html: jobScheduledHtml({
        message: params.message,
        customerName: params.customerName,
        jobNumber: label,
        technicianName: params.technicianName,
        scheduledStart,
        serviceAddress: params.serviceAddress,
        org: params.org,
      }),
    });
    if (result.status === 'sent') {
      logger.info(`Job scheduled email sent to ${params.to} for ${params.jobNumber}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, cc: params.cc, subject, text, result,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error(`Failed to send job scheduled email for ${params.jobNumber}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

export async function sendJobRescheduledEmail(params: {
  organizationId: string;
  /** SRVW-243 header-brand fix - see sendJobScheduledEmail. */
  org?: OrganizationBrandingSubset;
  to: string;
  customerName: string;
  jobNumber: string;
  /** Multi-visit D13 - see sendJobScheduledEmail. */
  visitSeq?: number | null;
  newScheduledStart: Date;
  technicianName: string;
  serviceAddress: string;
  timezone: string;
  /** SRVW-243 - extra addressees from the compose dialog (max 5, validated at the schema). */
  cc?: string[];
  /** SRVW-243 - the admin's own wording. Replaces the boilerplate intro line;
   *  the details table below it always renders, so an edited message can never
   *  make the email disagree with the schedule it is announcing. */
  message?: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  const scheduledStr = formatDateTimeInZone(params.newScheduledStart, params.timezone);
  const label = tripLabel(params.jobNumber, params.visitSeq);
  const subject = `Job ${label} Rescheduled`;
  const text = composeNotifyText(
    params.customerName,
    `your job ${label} has been rescheduled to ${scheduledStr}. Technician: ${params.technicianName}. Address: ${params.serviceAddress}.`,
    params.message,
  );
  try {
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
      subject,
      text,
      html: jobRescheduledHtml({
        message: params.message,
        customerName: params.customerName,
        jobNumber: label,
        newScheduledStart: scheduledStr,
        technicianName: params.technicianName,
        serviceAddress: params.serviceAddress,
        org: params.org,
      }),
    });
    if (result.status === 'sent') {
      logger.info(`Job rescheduled email sent to ${params.to} for ${params.jobNumber}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, cc: params.cc, subject, text, result,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error(`Failed to send job rescheduled email for ${params.jobNumber}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

/**
 * Multi-visit D19 / user story 39: the customer is told a TRIP is off.
 *
 * Same parameter shape and the same composeNotifyText / prepareTransactionalReply /
 * dispatchEmail / finalizeTransactionalSend pipeline as its scheduled and rescheduled siblings -
 * additive, not a second pipeline. The reply anchor stays on the JOB for the same reason theirs
 * does: one address for the whole conversation.
 */
export async function sendJobVisitCancelledEmail(params: {
  organizationId: string;
  /** SRVW-243 header-brand fix - see sendJobScheduledEmail. */
  org?: OrganizationBrandingSubset;
  to: string;
  customerName: string;
  jobNumber: string;
  visitSeq?: number | null;
  cancelledStart?: Date | null;
  /** The trip's end, so the notice names the WINDOW the customer was holding open. */
  cancelledEnd?: Date | null;
  /**
   * The crew, already resolved to "Our team" for a crewless trip by the caller. Optional
   * only so the legacy job-level door can omit it; every visit door passes it.
   */
  technicianName?: string;
  reason: string;
  timezone: string;
  cc?: string[];
  message?: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  const label = tripLabel(params.jobNumber, params.visitSeq);
  const cancelledStart = params.cancelledStart
    ? formatDateTimeInZone(params.cancelledStart, params.timezone)
    : null;
  // The customer held a WINDOW open, not an instant, so the notice names both ends - the
  // end is appended as a bare time because the start already carries the date, and a trip
  // that runs past midnight is the one case where that is not enough, so it re-dates.
  const cancelledWindow = cancelledStart && params.cancelledEnd
    ? `${cancelledStart} - ${formatEndOfWindowInZone(params.cancelledStart!, params.cancelledEnd, params.timezone)}`
    : cancelledStart;
  const subject = `Visit Cancelled: ${label}`;
  const text = composeNotifyText(
    params.customerName,
    `one of your scheduled visits${cancelledWindow ? ` (${cancelledWindow})` : ''} for ${label} has been cancelled. Reason: ${params.reason}. The rest of your service is unaffected and we will be in touch to rebook.`,
    params.message,
  );
  try {
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
      subject,
      text,
      html: jobVisitCancelledHtml({
        message: params.message,
        customerName: params.customerName,
        tripLabel: label,
        cancelledWindow,
        technicianName: params.technicianName,
        reason: params.reason,
        org: params.org,
      }),
    });
    if (result.status === 'sent') {
      logger.info(`Job visit cancelled email sent to ${params.to} for ${label}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, cc: params.cc, subject, text, result,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error(`Failed to send job visit cancelled email for ${label}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

/**
 * Calendar Entries (slice 07, spec §5) — three outcomes mirroring the sendJob* trio above so
 * they inherit the same Reply-To resolution (#1594 → #1603), org branding (SRVW-243) and CC
 * path. WHICH of the three fires is decided entirely by the CALLER (calendar-entry.controller.ts
 * / lib/calendar-entries/notify.ts) from a diff of the entry's previous and next start/end and
 * each participant's own notified_at — never from a status column, because CalendarEntry has
 * none (spec §9 risk 3, issue #1550's precedent).
 *
 * SCHEDULED is the only one of the three that takes a `message` — free text, seeded from the
 * entry's own title/description in the send dialog and editable there (spec §5). MOVED and
 * CANCELLED below take no `message` parameter at all, which is what makes their wording
 * genuinely fixed rather than fixed-by-convention: there is no plumbing a caller could use to
 * override it even by mistake.
 */
export async function sendCalendarEntryScheduledEmail(params: {
  organizationId: string;
  /** SRVW-243 header-brand fix - see sendJobScheduledEmail. */
  org?: OrganizationBrandingSubset;
  to: string;
  customerName: string;
  entryTitle: string;
  /** Null for an entry with no scheduled instant is not a real case today (start/end are
   *  required columns) but kept nullable defensively, mirroring sendJobScheduledEmail. */
  start?: Date | null;
  isAllDay?: boolean;
  timezone: string;
  /** Free text, seeded from the entry's title/description by the send dialog and editable
   *  there before it goes (spec §5). Falls back to a plain "you've been added" line when
   *  absent, exactly like every other sender in this family. */
  message?: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  const whenLabel = params.start && !params.isAllDay
    ? formatDateTimeInZone(params.start, params.timezone)
    : null;
  const subject = `You're Invited: ${params.entryTitle}`;
  const text = composeNotifyText(
    params.customerName,
    `you've been added to ${params.entryTitle}${whenLabel ? ` on ${whenLabel}` : ''}.`,
    params.message,
  );
  try {
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      subject,
      text,
      html: calendarEntryScheduledHtml({
        message: params.message,
        customerName: params.customerName,
        entryTitle: params.entryTitle,
        whenLabel,
        org: params.org,
      }),
    });
    if (result.status === 'sent') {
      logger.info(`Calendar entry scheduled email sent to ${params.to} for ${params.entryTitle}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, subject, text, result,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error(`Failed to send calendar entry scheduled email for ${params.entryTitle}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

export async function sendCalendarEntryMovedEmail(params: {
  organizationId: string;
  /** SRVW-243 header-brand fix - see sendJobScheduledEmail. */
  org?: OrganizationBrandingSubset;
  to: string;
  customerName: string;
  entryTitle: string;
  newStart: Date;
  isAllDay?: boolean;
  timezone: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  const whenLabel = params.isAllDay
    ? formatDateTimeInZone(params.newStart, params.timezone).split(',')[0] // date only for an all-day entry
    : formatDateTimeInZone(params.newStart, params.timezone);
  const subject = `Event Moved: ${params.entryTitle}`;
  const text = composeNotifyText(
    params.customerName,
    `${params.entryTitle} has been moved to a new time: ${whenLabel}.`,
  );
  try {
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      subject,
      text,
      html: calendarEntryMovedHtml({
        customerName: params.customerName,
        entryTitle: params.entryTitle,
        whenLabel,
        org: params.org,
      }),
    });
    if (result.status === 'sent') {
      logger.info(`Calendar entry moved email sent to ${params.to} for ${params.entryTitle}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, subject, text, result,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error(`Failed to send calendar entry moved email for ${params.entryTitle}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

export async function sendCalendarEntryCancelledEmail(params: {
  organizationId: string;
  /** SRVW-243 header-brand fix - see sendJobScheduledEmail. */
  org?: OrganizationBrandingSubset;
  to: string;
  customerName: string;
  entryTitle: string;
  cancelledStart?: Date | null;
  isAllDay?: boolean;
  timezone: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  const whenLabel = params.cancelledStart
    ? (params.isAllDay
        ? formatDateTimeInZone(params.cancelledStart, params.timezone).split(',')[0]
        : formatDateTimeInZone(params.cancelledStart, params.timezone))
    : null;
  const subject = `Cancelled: ${params.entryTitle}`;
  const text = composeNotifyText(
    params.customerName,
    `${params.entryTitle}${whenLabel ? ` (${whenLabel})` : ''} has been cancelled.`,
  );
  try {
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      subject,
      text,
      html: calendarEntryCancelledHtml({
        customerName: params.customerName,
        entryTitle: params.entryTitle,
        whenLabel,
        org: params.org,
      }),
    });
    if (result.status === 'sent') {
      logger.info(`Calendar entry cancelled email sent to ${params.to} for ${params.entryTitle}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, subject, text, result,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error(`Failed to send calendar entry cancelled email for ${params.entryTitle}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

export async function sendWalkthroughScheduledEmail(params: {
  organizationId: string;
  /** SRVW-243 header-brand fix - see sendJobScheduledEmail. */
  org?: OrganizationBrandingSubset;
  to: string;
  customerName: string;
  /** Multi-visit D13 - names the trip. Omitted on the legacy /walkthrough/schedule door, which
   *  keeps sending exactly what it always did. */
  visitSeq?: number | null;
  scheduledDate: Date;
  performerName: string;
  serviceAddress: string;
  companyName: string;
  timezone: string;
  replyTo?: string;
  /** SRVW-243 - extra addressees from the compose dialog (max 5, validated at the schema). */
  cc?: string[];
  /** SRVW-243 - the admin's own wording. Replaces the boilerplate intro line;
   *  the details table below it always renders, so an edited message can never
   *  make the email disagree with the schedule it is announcing. */
  message?: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  const dateStr = formatDateTimeInZone(params.scheduledDate, params.timezone);
  const visitLabel = params.visitSeq == null ? 'Site Visit' : `Visit ${params.visitSeq}`;
  const subject = `${visitLabel} Scheduled - ${dateStr}`;
  const text = composeNotifyText(
    params.customerName,
    `your site visit has been scheduled for ${dateStr}. ${params.performerName} will visit ${params.serviceAddress}.`,
    params.message,
  );
  try {
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
      subject,
      text,
      html: walkthroughScheduledHtml({
        message: params.message,
        customerName: params.customerName,
        scheduledDate: dateStr,
        performerName: params.performerName,
        serviceAddress: params.serviceAddress,
        companyName: params.companyName,
        org: params.org,
      }),
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    });
    if (result.status === 'sent') {
      logger.info(`Walkthrough scheduled email sent to ${params.to}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, cc: params.cc, subject, text, result,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error('Failed to send walkthrough scheduled email:', err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

export async function sendWalkthroughRescheduledEmail(params: {
  organizationId: string;
  /** SRVW-243 header-brand fix - see sendJobScheduledEmail. */
  org?: OrganizationBrandingSubset;
  to: string;
  customerName: string;
  /** Multi-visit D13 - see sendWalkthroughScheduledEmail. */
  visitSeq?: number | null;
  newDate: Date;
  performerName: string;
  serviceAddress: string;
  timezone: string;
  replyTo?: string;
  /** SRVW-243 - extra addressees from the compose dialog (max 5, validated at the schema). */
  cc?: string[];
  /** SRVW-243 - the admin's own wording. Replaces the boilerplate intro line;
   *  the details table below it always renders, so an edited message can never
   *  make the email disagree with the schedule it is announcing. */
  message?: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  const dateStr = formatDateTimeInZone(params.newDate, params.timezone);
  const visitLabel = params.visitSeq == null ? 'Site Visit' : `Visit ${params.visitSeq}`;
  const subject = `${visitLabel} Rescheduled - ${dateStr}`;
  const text = composeNotifyText(
    params.customerName,
    `your site visit has been rescheduled to ${dateStr}. ${params.performerName} will visit ${params.serviceAddress}.`,
    params.message,
  );
  try {
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
      subject,
      text,
      html: walkthroughRescheduledHtml({
        message: params.message,
        customerName: params.customerName,
        newDate: dateStr,
        performerName: params.performerName,
        serviceAddress: params.serviceAddress,
        org: params.org,
      }),
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    });
    if (result.status === 'sent') {
      logger.info(`Walkthrough rescheduled email sent to ${params.to}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, cc: params.cc, subject, text, result,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error('Failed to send walkthrough rescheduled email:', err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

export async function sendInvoiceEmail(params: {
  invoiceId: string;
  organizationId: string;
  to: string;
  cc?: string[];
  message?: string;
  customerName: string;
  invoiceNumber: string;
  total: number;
  amountDue: number;
  dueDate: string;
  publicUrl: string;
  timezone?: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  const dueFormatted = new Date(params.dueDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: params.timezone ?? DEFAULT_TIMEZONE });
  // Optional sender-authored note from the Send/Resend dialog. Escaped (staff-authored, but never trust input into HTML)
  // and newline-preserved; rendered above the boilerplate so the customer actually sees it.
  const customMessage = params.message?.trim();
  const customMessageHtml = customMessage
    ? `<p style="margin:0 0 16px;font-size:15px;color:#374151;white-space:pre-line;">${esc(customMessage).replace(/\n/g, '<br>')}</p>`
    : '';
  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Invoice Ready</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    ${raw(customMessageHtml)}
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Invoice <strong>${params.invoiceNumber}</strong> is ready for your review and payment.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr>
        <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb;">
          <span style="font-size:13px;color:#6b7280;">Invoice Total</span><br>
          <span style="font-size:24px;font-weight:700;color:#111827;">${formatCurrency(params.total)}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb;">
          <span style="font-size:13px;color:#6b7280;">Amount Due</span><br>
          <span style="font-size:20px;font-weight:600;color:#111827;">${formatCurrency(params.amountDue)}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 20px;">
          <span style="font-size:13px;color:#6b7280;">Due Date</span><br>
          <span style="font-size:15px;font-weight:600;color:#111827;">${dueFormatted}</span>
        </td>
      </tr>
    </table>
    <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr><td style="background:#2563EB;border-radius:6px;padding:12px 28px;">
        <a href="${params.publicUrl}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;">View &amp; Pay Invoice</a>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      You can view your invoice and make a payment online using the link above.
    </p>
  `);
  try {
    // Same document the customer's "View & Pay Invoice" link renders (getPublicPdf) — the
    // customer gets the priced invoice attached, not just a link. A rendering failure here
    // fails the whole send (matches sendEstimateEmail's renderEstimatePdfBuffer precedent).
    // Reuses the org row this already fetched (same organizationId) for the subject line below,
    // rather than a second organization.findUnique via resolveOrgName.
    const { buffer: pdfBuffer, org: pdfOrg } = await renderInvoicePdfBuffer(params.invoiceId);
    const attachment = pdfAttachment(`invoice-${params.invoiceNumber}.pdf`, pdfBuffer);
    // The customer hired the contractor, not us — name the org, exactly like
    // sendEstimateEmail does, degrading to a bare subject rather than naming the wrong party.
    const orgName = pdfOrg.name?.trim() || null;
    const subject = orgName ? `Invoice ${params.invoiceNumber} from ${orgName}` : `Invoice ${params.invoiceNumber}`;
    const text = customMessage
      ? `Hi ${params.customerName},\n\n${customMessage}\n\nInvoice ${params.invoiceNumber} for ${formatCurrency(params.amountDue)} is due on ${dueFormatted}. Pay here: ${params.publicUrl}`
      : `Hi ${params.customerName}, invoice ${params.invoiceNumber} for ${formatCurrency(params.amountDue)} is due on ${dueFormatted}. Pay here: ${params.publicUrl}`;
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc } : {}),
      subject,
      text,
      html,
      attachments: [attachment.pdf],
    });
    if (result.status === 'sent') {
      logger.info(`Invoice email sent to ${params.to} for ${params.invoiceNumber}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, cc: params.cc, subject, text, result,
          attachments: attachment.record,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error(`Failed to send invoice email for ${params.invoiceNumber}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}

export async function sendPaymentReceivedEmail(params: {
  organizationId: string;
  to: string;
  customerName: string;
  invoiceNumber: string;
  amount: number;
  method: string;
  newBalance: number;
  record?: TransactionalEmailRecord;
}): Promise<void> {
  const methodLabel = methodLabels[params.method] ?? params.method;
  const balanceText = params.newBalance <= 0
    ? '<span style="color:#16a34a;font-weight:600;">Paid in Full</span>'
    : h`<span style="font-size:15px;font-weight:600;color:#111827;">${formatCurrency(params.newBalance)}</span>`;
  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Payment Received</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.customerName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      We've received your payment for invoice <strong>${params.invoiceNumber}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr>
        <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb;">
          <span style="font-size:13px;color:#6b7280;">Payment Amount</span><br>
          <span style="font-size:24px;font-weight:700;color:#111827;">${formatCurrency(params.amount)}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb;">
          <span style="font-size:13px;color:#6b7280;">Payment Method</span><br>
          <span style="font-size:15px;font-weight:600;color:#111827;">${methodLabel}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 20px;">
          <span style="font-size:13px;color:#6b7280;">Remaining Balance</span><br>
          ${raw(balanceText)}
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">Thank you for your payment.</p>
  `);
  try {
    const subject = `Payment Received - Invoice ${params.invoiceNumber}`;
    const text = `Hi ${params.customerName}, we received your payment of ${formatCurrency(params.amount)} via ${methodLabel} for invoice ${params.invoiceNumber}. Remaining balance: ${params.newBalance <= 0 ? 'Paid in Full' : formatCurrency(params.newBalance)}.`;
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      subject,
      text,
      html,
    });
    if (result.status === 'sent') {
      logger.info(`Payment received email sent to ${params.to} for ${params.invoiceNumber}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record, reply, to: params.to, subject, text, result,
        });
      }
    }
  } catch (err) {
    logger.error(`Failed to send payment received email for ${params.invoiceNumber}:`, err);
  }
}

// ─── Timeclock — clock-in override emails ────────────────

/**
 * Notify every approver (admins + users with can_approve_clock_overrides) that a
 * technician requested an out-of-zone clock-in override. One email per recipient.
 * Times render in the org timezone (the backend runs in UTC).
 */
export async function sendClockOverrideRequestedEmail(params: {
  org: OrganizationBrandingSubset;
  to: string[];
  technicianName: string;
  requestedAt: Date;
  distanceM: number;
  nearestLabel: string;
  timezone?: string;
}): Promise<void> {
  if (params.to.length === 0) return;
  const when = formatDateTimeInZone(params.requestedAt, params.timezone);
  const distance = Math.round(params.distanceM);
  const subject = `Clock-in override requested - ${params.technicianName}`;
  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Clock-in Override Requested</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      <strong>${params.technicianName}</strong> clocked in outside the allowed area and requested an override.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Requested At</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${when}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Distance From Nearest Zone</p>
        <p style="margin:0 0 16px;font-size:15px;color:#374151;">${distance} m from ${params.nearestLabel}</p>
      </td></tr>
    </table>
    <p style="margin:0;font-size:13px;color:#9ca3af;">
      Review and approve or reject this override in ${params.org.name}.
    </p>
  `, params.org);
  const text = `${params.technicianName} requested a clock-in override at ${when}, ${distance} m from ${params.nearestLabel}. Review it in ${params.org.name}.`;
  for (const to of params.to) {
    try {
      await dispatchEmail(params.org.id, { to, subject, text, html });
      logger.info(`Clock override requested email sent to ${to} for ${params.technicianName}`);
    } catch (err) {
      logger.error(`Failed to send clock override requested email to ${to}:`, err);
    }
  }
}

/**
 * Notify the requesting technician that their clock-in override was approved or
 * rejected by an approver.
 */
export async function sendClockOverrideDecisionEmail(params: {
  org: OrganizationBrandingSubset;
  to: string;
  technicianName: string;
  decision: 'approved' | 'rejected';
  decidedByName: string;
}): Promise<void> {
  const subject = `Your clock-in override was ${params.decision}`;
  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Clock-in Override ${params.decision === 'approved' ? 'Approved' : 'Rejected'}</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Hi ${params.technicianName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Your out-of-zone clock-in override was <strong>${params.decision}</strong> by <strong>${params.decidedByName}</strong>.
    </p>
  `, params.org);
  const text = `Hi ${params.technicianName}, your clock-in override was ${params.decision} by ${params.decidedByName}.`;
  try {
    await dispatchEmail(params.org.id, { to: params.to, subject, text, html });
    logger.info(`Clock override decision email (${params.decision}) sent to ${params.to}`);
  } catch (err) {
    logger.error(`Failed to send clock override decision email to ${params.to}:`, err);
  }
}

// ─── Automation Center ───────────────────────────────────

/**
 * Generic sender for Automation Center email actions. Subject/text/html arrive
 * fully merge-rendered from the automation engine (html already esc()-escaped
 * per-value); this wraps the fragment in the branded shell and mirrors the
 * send into the Communication tab when a record is supplied.
 *
 * Same contract as every sender here: never throws, fire-and-forget safe, and
 * routed through dispatchEmail so the org's email_sending_enabled kill switch
 * stops it. That gate matters most here — automations fire unattended, on a
 * poller, at customers — so `organizationId` is required rather than read off
 * the optional branding subset. (#906)
 *
 * Returns the real EmailDispatchResult rather than discarding it: the caller
 * (executeSendEmail) is the Automation Center's own Activity tab, and a
 * suppressed or provider-rejected send must not read the same as a delivered
 * one there. (#1068)
 */
export async function sendAutomationEmail(params: {
  /** Whose kill switch applies. Required — an ungated automation send is a bug. */
  organizationId: string;
  to: string;
  subject: string;
  /** Plain-text body (unescaped) — used for the text part + inbox mirror. */
  text: string;
  /** HTML body fragment — every dynamic value already escaped via esc(). */
  html: string;
  /** Optional sender identity (e.g. 'spider-alert' | 'bee-alert') */
  senderIdentity?: 'spider-alert' | 'bee-alert';
  org?: OrganizationBrandingSubset;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  let result: EmailDispatchResult;
  try {
    result = await dispatchEmail(
      params.organizationId,
      {
        to: params.to,
        subject: params.subject,
        text: params.text,
        html: wrapHtml(params.html, params.org),
      },
      params.senderIdentity ? { senderIdentity: params.senderIdentity } : undefined,
    );
  } catch (err) {
    logger.error(`Failed to send automation email to ${params.to}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unknown error' };
  }
  if (result.status !== 'sent') return result;
  logger.info(`Automation email sent to ${params.to}`);
  // Mirror only a real send - a Communication-tab row for a killed email
  // would show the office a message the customer never received. A failure to
  // persist the mirror doesn't change the fact that the email itself sent.
  if (params.record) {
    try {
      await persistTransactionalEmail({
        ...params.record,
        to: params.to,
        subject: params.subject,
        text: params.text,
        ...sentTrace(result),
      });
    } catch (err) {
      logger.error(`Failed to persist Communication-tab mirror for ${params.to}:`, err);
    }
  }
  return result;
}

// ─── AI Agentic Farm — "book a call" ──────────────────────
//
// Internal ServWave sales lead, not customer-facing business correspondence, so
// it always sends (bypasses dispatchEmail's per-org email_sending_enabled gate,
// same as the other account/sales-critical senders in this file). Unlike those,
// a failed send here must surface to the caller — the controller turns a thrown
// error into a 502 so the frontend never shows a false "you're booked" screen.

interface AiFarmBookingParams {
  requesterName: string;
  requesterEmail: string;
  orgName: string;
  agentName: string;
  agentRole: string;
  day: string;
  slot: string;
}

function aiFarmBookingNotifyHtml(params: AiFarmBookingParams): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">New AI Agentic Farm Call Request</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      <strong>${params.requesterName}</strong> (${params.orgName}) wants to talk about
      <strong>${params.agentName}</strong> - ${params.agentRole}.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;margin:0 0 24px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Requested Time</p>
        <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#111827;">${params.day}, ${params.slot}</p>
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Contact</p>
        <p style="margin:0;font-size:15px;color:#374151;">${params.requesterEmail}</p>
      </td></tr>
    </table>
  `);
}

function aiFarmBookingConfirmationHtml(params: AiFarmBookingParams): string {
  return wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">You're booked!</h2>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">Hi ${params.requesterName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Your call about <strong>${params.agentName}</strong> (${params.agentRole}) is confirmed for
      <strong>${params.day}, ${params.slot}</strong>. Our team will reach out shortly beforehand.
    </p>
  `);
}

export async function sendAiFarmBookingEmails(params: AiFarmBookingParams): Promise<void> {
  if (!resend) {
    logger.warn('RESEND_API_KEY not set - skipping AI Agentic Farm booking emails');
    return;
  }
  await resend.emails.send({
    from: env.EMAIL_FROM,
    to: env.AI_FARM_SALES_EMAIL,
    subject: `New AI Agentic Farm call request: ${params.agentName} - ${params.orgName}`,
    text: `${params.requesterName} (${params.orgName}) wants to talk about ${params.agentName} (${params.agentRole}) on ${params.day} at ${params.slot}. Contact: ${params.requesterEmail}.`,
    html: aiFarmBookingNotifyHtml(params),
    replyTo: params.requesterEmail,
  });
  await resend.emails.send({
    from: env.EMAIL_FROM,
    to: params.requesterEmail,
    subject: `You're booked - ${params.agentName} call, ${params.day} ${params.slot}`,
    text: `Hi ${params.requesterName}, your call about ${params.agentName} (${params.agentRole}) is confirmed for ${params.day} at ${params.slot}. Our team will reach out shortly beforehand.`,
    html: aiFarmBookingConfirmationHtml(params),
  });
  logger.info(`AI Agentic Farm booking emails sent for ${params.agentName} (${params.requesterEmail})`);
}

// ─── "Reach sales" - the in-app sales/support contact form ───────────────────
//
// The Phone header's plan-usage panel lets an owner write to us. The recipient
// is fixed HERE, server-side, and is never read off the request body: the
// composer would otherwise be an authenticated open relay - anyone with a login
// could post an arbitrary `to` and have our own verified sending domain deliver
// it. The frontend shows the same address purely as a label.
export const SALES_CONTACT_EMAIL = 'info@servwave.com';

/**
 * Deliver an owner's sales/support message to the ServWave inbox.
 *
 * Platform voice: this is a contractor writing TO us, so the From must not be
 * stamped with the org's display name as if the org were the sender. The org is
 * identified in the body instead, and `replyTo` carries the person who wrote it,
 * so hitting reply in the inbox answers the human rather than the mailer.
 *
 * The body's identity block is read HERE, from the org row, rather than taken
 * from the request - the sender names only their message, subject, reply-to and
 * topic. See sales-request-email.ts for what it renders.
 *
 * Returns the raw dispatch result. Unlike most senders here this one does NOT
 * swallow its failure - the composer told the owner their message was sent, so
 * the caller has to be able to tell them the truth when it was not.
 */
export async function sendSalesContactEmail(params: {
  organizationId: string;
  to: string;
  subject: string;
  message: string;
  replyTo: string;
  topic: SalesTopic | null;
  sender: { id: string; name: string | null; email: string; role: string };
}): Promise<EmailDispatchResult> {
  const org = await prisma.organization.findUnique({
    where: { id: params.organizationId },
    select: {
      name: true,
      plan: true,
      is_demo: true,
      city: true,
      state: true,
      phone: true,
      ctm_account_id: true,
      _count: { select: { users: true } },
    },
  });

  const { text, html } = buildSalesRequestEmail({
    organization: {
      id: params.organizationId,
      name: org?.name?.trim() || 'Unknown organization',
      plan: org?.plan ?? 'Unknown plan',
      isDemo: org?.is_demo ?? false,
      city: org?.city ?? null,
      state: org?.state ?? null,
      phone: org?.phone ?? null,
      phoneModuleConnected: Boolean(org?.ctm_account_id),
      userCount: org?._count?.users ?? null,
    },
    sender: params.sender,
    topic: params.topic,
    subject: params.subject,
    message: params.message,
  });

  const result = await dispatchEmail(
    params.organizationId,
    { to: params.to, subject: params.subject, text, html: wrapHtml(html), replyTo: params.replyTo },
    // Always sends. See bypassOrgSendingGate on dispatchEmail: the org's
    // customer-email kill switch must not cut the org's own line to us.
    { senderIdentity: 'platform', bypassOrgSendingGate: true },
  );
  if (result.status === 'sent') {
    logger.info(
      `Sales request from user ${params.sender.id} (org ${params.organizationId}) delivered to ${params.to}`,
    );
  } else {
    logger.error(
      `Sales request from user ${params.sender.id} (org ${params.organizationId}) was not delivered (${result.status})`,
    );
  }
  return result;
}

export async function sendWarrantyEmail(params: {
  organizationId: string;
  to: string;
  customerName: string;
  jobType: string;
  jobNumber?: string;
  invoiceNumber: string;
  warrantyDuration: string;
  warrantyStartDate: Date;
  warrantyEndDate: Date;
  coverageDetails?: string;
  record?: TransactionalEmailRecord;
}): Promise<EmailDispatchResult> {
  const startFormatted = params.warrantyStartDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const endFormatted = params.warrantyEndDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const org = await prisma.organization.findUnique({
    where: { id: params.organizationId },
    select: { name: true, brand_color: true },
  });
  const orgName = org?.name?.trim() || 'ServWave';
  const brandColor = org?.brand_color || '#2563EB';

  const coverage = params.coverageDetails || 'Full coverage for labor and parts on all completed work as specified in your job invoice.';

  const html = wrapHtml(h`
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827;">Your Service Warranty Certificate</h2>
    <p style="margin:0 0 24px;font-size:15px;color:#6b7280;">Dear ${params.customerName},</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;">
      Thank you for your business. Your service on <strong>${params.jobType}</strong> (Invoice #${params.invoiceNumber}${params.jobNumber ? `, Job #${params.jobNumber}` : ''}) is backed by our official service warranty.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;margin:0 0 24px;">
      <tr>
        <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb;">
          <span style="font-size:13px;color:#6b7280;font-weight:500;">Warranty Coverage</span><br>
          <span style="font-size:20px;font-weight:700;color:${brandColor};">${esc(params.warrantyDuration)}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 20px;border-bottom:1px solid #e5e7eb;">
          <span style="font-size:13px;color:#6b7280;font-weight:500;">Effective Period</span><br>
          <span style="font-size:15px;font-weight:600;color:#111827;">${startFormatted} – ${endFormatted}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 20px;">
          <span style="font-size:13px;color:#6b7280;font-weight:500;">Coverage Terms</span><br>
          <span style="font-size:14px;color:#374151;">${esc(coverage)}</span>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px;font-size:14px;color:#6b7280;">
      If you experience any issues or need support during your warranty period, please contact ${esc(orgName)}.
    </p>
  `);

  const text = `Dear ${params.customerName},\n\nYour service on ${params.jobType} (Invoice #${params.invoiceNumber}) is backed by our official service warranty.\n\nCoverage: ${params.warrantyDuration}\nValid from: ${startFormatted} to ${endFormatted}\nTerms: ${coverage}\n\nThank you for choosing ${orgName}.`;
  const subject = `Service Warranty Certificate: ${params.jobType} — ${orgName}`;

  try {
    const reply = await prepareTransactionalReply(params.record, params.to);
    const result = await dispatchEmail(params.organizationId, {
      to: params.to,
      ...(reply ? { replyTo: reply.address } : {}),
      subject,
      text,
      html,
    });

    if (result.status === 'sent') {
      logger.info(`[BeeWarranty] Warranty certificate sent to ${params.to} for invoice ${params.invoiceNumber}`);
      if (params.record) {
        await finalizeTransactionalSend({
          record: params.record,
          reply,
          to: params.to,
          subject,
          text,
          result,
        });
      }
    }
    return result;
  } catch (err) {
    logger.error(`[BeeWarranty] Failed to send warranty email for invoice ${params.invoiceNumber}:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unexpected email error' };
  }
}
