import { randomBytes } from 'crypto';
import type { PrismaClient, ReplyToken } from '@prisma/client';
import { env } from '../config/env';

/**
 * Email slice 6 (inbound reply capture) - the reply-token library.
 *
 * A reply address is `<token>@${EMAIL_REPLY_DOMAIN}`, where the token is an
 * OPAQUE 128-bit lookup key, not a signed self-describing payload.
 *
 * WHY A LOOKUP KEY. RFC 5321 4.5.3.1.1 caps an email local part at 64 OCTETS.
 * Three UUIDs alone are 48 raw bytes = 64 base64url characters, before any MAC,
 * prefix or separator - so the org/entity/customer payload an earlier draft
 * specified simply does not fit. Given that the payload has to live in the
 * database anyway, a MAC buys nothing either: a MAC exists to make a
 * SELF-DESCRIBING payload tamper-evident, and we are already hitting the
 * database to resolve the thread. Unguessability is the only property actually
 * needed, and 128 CSPRNG bits deliver it in 22 characters.
 *
 * WHY `<token>@` AND NOT `reply+<token>@`. Plus-addressing (RFC 5233
 * sub-addressing) is real and works at the major providers, but `+` is mangled
 * or rejected by enough MTAs and hand-rolled address parsers to be a needless
 * failure mode. A dedicated subdomain with the token as the whole local part
 * has no such problem.
 *
 * THE TOKEN AUTHENTICATES THE THREAD, NOT THE PERSON. Anyone who can read the
 * email can reply, and mail is trivially forwarded. So possession of a valid
 * token is necessary but NOT sufficient: the caller must also compare the
 * inbound `From` against `expected_from` and route a mismatch to the unmatched
 * queue (InboundMatchState.UNMATCHED_SENDER). This module deliberately does not
 * make that call itself - it resolves, it does not authorize.
 */

/**
 * Anything with the ReplyToken delegate: the PrismaClient or a $transaction tx
 * (Prisma.TransactionClient keeps the model delegates, so it satisfies this).
 *
 * Picked off PrismaClient rather than hand-declared. A hand-written structural
 * type with `(args: unknown)` parameters looks more permissive but is actually
 * INCOMPATIBLE with the real client - method parameters are contravariant, so
 * the generated generic signatures do not accept it, and every call site fails
 * to typecheck.
 */
type Db = Pick<PrismaClient, 'replyToken'>;

export type ReplyTokenRow = ReplyToken;

export interface MintReplyTokenArgs {
  organization_id: string;
  thread_id?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  customer_id?: string | null;
  /** The address we are mailing. Normalized before storage. */
  expected_from: string;
  created_by_user_id?: string | null;
}

/**
 * 128 bits from a CSPRNG, base64url, unpadded - 22 characters.
 *
 * 16 bytes base64-encode to 24 characters of which the last two are always
 * `==` padding, so stripping padding is lossless here and leaves exactly 22
 * significant characters. Padding is stripped because `=` in a local part is
 * legal-but-unusual and needlessly invites mangling by intermediate parsers.
 *
 * base64url (not base64) because `+` and `/` are both hostile in an email
 * address - `+` collides with sub-addressing semantics and `/` is not valid in
 * an unquoted local part at all.
 */
export function generateReplyToken(): string {
  return randomBytes(16).toString('base64url');
}

/** `<token>@${EMAIL_REPLY_DOMAIN}` - the address a customer replies to. */
export function replyAddressFor(token: string): string {
  return `${token}@${env.EMAIL_REPLY_DOMAIN}`;
}

/**
 * Pulls the token out of an inbound `To` (or `Delivered-To`) value, or null if
 * the address is not one of ours.
 *
 * Accepts both the bare `token@domain` form and the display-name
 * `Name <token@domain>` form, since which one arrives depends on the sending
 * client.
 *
 * The DOMAIN compares case-insensitively (DNS is case-insensitive) but the
 * LOCAL PART's case is preserved: base64url is case-SIGNIFICANT, so lowercasing
 * it would collapse distinct tokens onto each other and throw away ~21 bits of
 * the keyspace.
 */
export function parseReplyAddress(raw: string): string | null {
  if (!raw) return null;

  // `Name <addr>` -> `addr`; a bare address is left as-is.
  const angled = raw.match(/<([^>]*)>/);
  const address = (angled ? angled[1] : raw).trim();

  const at = address.lastIndexOf('@');
  if (at <= 0) return null; // no `@`, or an empty local part (`@domain`).

  const localPart = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();

  // Exact domain equality, NOT endsWith: `evilreply.servwave.com` ends with
  // `reply.servwave.com` and is a domain an attacker can register.
  if (domain !== env.EMAIL_REPLY_DOMAIN.toLowerCase()) return null;
  if (!localPart) return null;

  return localPart;
}

/**
 * Lowercase + trim, so the `From` comparison at reply time is case-insensitive.
 * The local part of an email address is technically case-sensitive per RFC
 * 5321, but no mainstream provider treats it that way, and a customer whose
 * client capitalizes their own address must not be demoted to the unmatched
 * queue over it.
 */
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Returns the reply token for a (thread-or-entity, recipient) pair, reusing a
 * live one if it exists.
 *
 * REUSE IS THE POINT. One stable reply address per pair is what makes threading
 * work: a fresh address per message would scatter a single conversation across
 * as many threads as it has messages, and would leave a customer replying to an
 * older message in the thread hitting a different address than the newest one.
 *
 * Reuse is enforced HERE rather than by a DB unique constraint because Postgres
 * treats NULLs as DISTINCT in a unique index, and thread_id/entity_id/
 * customer_id are all nullable - such a constraint would silently fail to
 * constrain exactly the rows it appears to cover. The race this leaves open is
 * benign: two tokens for the same pair both resolve to the same thread.
 */
export async function mintReplyToken(db: Db, args: MintReplyTokenArgs): Promise<string> {
  const { token, persist } = await prepareReplyToken(db, args);
  if (persist) await persistReplyToken(db, { ...args, token });
  return token;
}

/**
 * PHASE 1 - resolve an existing live token, or generate a candidate, WITHOUT
 * writing anything.
 *
 * This exists because of an ordering constraint in the compose path: it creates
 * its EmailThread only AFTER a successful dispatch, so that a send which never
 * left leaves no orphan thread behind ("a dispatch that never left persists
 * NOTHING"). But the reply token has to be inside the Reply-To header OF that
 * dispatch. Writing the row up front would persist state for a send that may
 * never happen; generating the string up front costs nothing and commits to
 * nothing.
 *
 * `persist: false` means an existing row was reused and the caller must NOT
 * write again. `persist: true` means the token is only a candidate so far and
 * the caller owes a persistReplyToken() once the send has actually succeeded.
 */
export async function prepareReplyToken(
  db: Db,
  args: MintReplyTokenArgs,
): Promise<{ token: string; persist: boolean }> {
  const expectedFrom = normalizeAddress(args.expected_from);

  // Match on whichever anchor the caller actually has. thread_id is the
  // strongest; entity is the fallback for transactional sends, which have no
  // thread (persistTransactionalEmail never mints one - see the schema comment).
  //
  // NO ANCHOR MEANS NO REUSE, never "match anything unanchored". A fresh compose
  // has neither a thread (it is created after the dispatch) nor an entity, and
  // an unanchored lookup would then be `org + recipient` alone - which happily
  // matches a token bound to some OTHER thread, silently routing this
  // conversation's replies into an older one. Two fresh composes to the same
  // person are two conversations and must get two addresses.
  const anchor = args.thread_id
    ? { thread_id: args.thread_id }
    : args.entity_type && args.entity_id
      ? { entity_type: args.entity_type, entity_id: args.entity_id }
      : null;

  if (!anchor) return { token: generateReplyToken(), persist: true };

  const existing = await db.replyToken.findFirst({
    where: {
      organization_id: args.organization_id,
      expected_from: expectedFrom,
      revoked_at: null,
      ...anchor,
    },
  });
  // A live token is one that is neither revoked (filtered above) nor past its
  // expiry. Nothing sets expires_at today, but honour it here so a later policy
  // change mints a fresh token rather than handing back a dead one.
  if (existing && !isExpired(existing)) return { token: existing.token, persist: false };

  return { token: generateReplyToken(), persist: true };
}

/**
 * PHASE 2 - write the row for a token that has already gone out in a header.
 *
 * `token` is written VERBATIM, never regenerated: the row has to match the
 * address the customer actually received, or their reply resolves to nothing.
 *
 * The anchor fields are taken at THIS point rather than at prepare time
 * precisely so a fresh compose can attach the thread id that only came into
 * existence after the dispatch succeeded.
 */
export async function persistReplyToken(
  db: Db,
  args: MintReplyTokenArgs & { token: string },
): Promise<void> {
  await db.replyToken.create({
    data: {
      token: args.token,
      organization_id: args.organization_id,
      thread_id: args.thread_id ?? null,
      entity_type: args.entity_type ?? null,
      entity_id: args.entity_id ?? null,
      customer_id: args.customer_id ?? null,
      expected_from: normalizeAddress(args.expected_from),
      created_by_user_id: args.created_by_user_id ?? null,
      // expires_at is deliberately NOT set - tokens never expire (settled
      // 2026-08-05), consistent with access not expiring when a job closes.
      // Revocation is revoked_at, not a clock.
    },
  });
}

function isExpired(row: ReplyTokenRow): boolean {
  return row.expires_at !== null && row.expires_at.getTime() <= Date.now();
}

/**
 * Resolves a token to its row, or null if it is unknown, revoked or expired.
 *
 * Null means "route this to the unmatched queue" - NEVER "reject the message".
 * A dead token must not hard-bounce at the customer: they replied in good faith
 * to an address we gave them, and an operator can still link the message by
 * hand. A visible, recoverable failure beats a lost message.
 */
export async function resolveReplyToken(db: Db, token: string): Promise<ReplyTokenRow | null> {
  const row = await db.replyToken.findUnique({ where: { token } });
  if (!row) return null;
  if (row.revoked_at) return null;
  if (isExpired(row)) return null;
  return row;
}
