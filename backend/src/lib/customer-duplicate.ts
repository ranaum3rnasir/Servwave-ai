import type { Request } from 'express';
import { Prisma, PrismaClient } from '@prisma/client';
import { isCustomerReadableRow, CUSTOMER_PROOF_SELECT } from './permissions/customerScope';

/**
 * Duplicate-customer guard (spec: md_files/plans/customers/2026-06-08-duplicate-customer-guard.md).
 *
 * Detects an existing customer in the same organization whose primary email OR
 * primary phone matches a new customer's contact info. Since #352 phones are
 * stored digits-only canonical (Zod-normalized at the validation boundary +
 * one-time backfill), but the comparison still normalizes BOTH the input and
 * the stored value in JS — cheap, and it keeps the guard correct for any
 * non-canonical stragglers (e.g. carved-out placeholder sentinels) and for
 * mixed-case emails (`A@x.com` vs `a@x.com`).
 */

// Accept either the Prisma client or a transaction client — callable inside the
// existing $transaction in lead.controller.ts as well as standalone.
type Client = PrismaClient | Prisma.TransactionClient;

export interface ExistingMatch {
  id: string;
  customer_number: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  archived_at: Date | null;
  primary_address: { line1: string; city: string; state: string } | null;
  /**
   * The exact value(s) that collided. Because the guard is relation-aware, the
   * match may be on a SECONDARY phones[]/extra_emails[] entry — not the primary
   * email/phone above — so the dialog must show/highlight `matched.*` (the value
   * the user actually typed), not the primary. `null` when that field didn't match.
   */
  matched: { email: string | null; phone: string | null };
}

/**
 * A duplicate match the requester may NOT read. Exactly three keys — `id`, `matched` (booleans:
 * which field collided, never the stored value) and `redacted: true` — and nothing else (#1996).
 */
export interface RedactedMatch {
  id: string;
  matched: { email: boolean; phone: boolean };
  redacted: true;
}

export type DuplicateExisting = ExistingMatch | RedactedMatch;

/**
 * The verdict `findDuplicateCustomer` returns: the full matched row (server-side callers, e.g.
 * the override audit trail, always get the full row) plus whether THIS requester may read it.
 * `duplicateConflictBody` is the only place that turns this into a response.
 */
export interface DuplicateFinding {
  match: ExistingMatch;
  readable: boolean;
}

/**
 * The single body builder for all five duplicate-customer 409 call sites (#1996). Readable →
 * today's body, byte-identical. Not readable → the three-key `RedactedMatch` only — never a
 * top-level `redacted`, never any of the PII keys `ExistingMatch` carries.
 */
export function duplicateConflictBody(
  finding: DuplicateFinding,
): { error: 'duplicate'; existing: DuplicateExisting } {
  if (finding.readable) {
    return { error: 'duplicate', existing: finding.match };
  }
  return {
    error: 'duplicate',
    existing: {
      id: finding.match.id,
      matched: {
        email: finding.match.matched.email !== null,
        phone: finding.match.matched.phone !== null,
      },
      redacted: true,
    },
  };
}

/** Trim + lowercase. Returns null for null/undefined/blank. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return v.length ? v : null;
}

/**
 * Digits-only. Strips spaces, dashes, parens, `+`, etc., and a single leading
 * country `1` from an 11-digit result. Returns null for null/undefined/blank.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length ? digits : null;
}

// Select shape for the duplicate-warning modal (spec §4.4). `organization_id` is selected so the
// #1996 per-instance read check (`can()`) has a row to evaluate — see the docstring below.
const MATCH_SELECT = {
  id: true,
  organization_id: true,
  customer_number: true,
  first_name: true,
  last_name: true,
  company_name: true,
  email: true,
  phone: true,
  is_active: true,
  archived_at: true,
  service_locations: {
    where: { is_primary: true },
    take: 1,
    select: { address_line1: true, city: true, state: true },
  },
  phones: { select: { phone: true } },
  extra_emails: { select: { email: true } },
  // #2041 — projects the row-scope PROOF relations so the readable-verdict below can judge
  // synchronously, in-memory (customerScope.ts). Never part of `ExistingMatch`/`RedactedMatch` —
  // `match` below is built field-by-field, so these keys never reach a response.
  ...CUSTOMER_PROOF_SELECT,
} satisfies Prisma.CustomerSelect;

type Candidate = {
  id: string;
  organization_id: string;
  customer_number: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  archived_at: Date | null;
  service_locations: { address_line1: string; city: string; state: string }[];
  phones: { phone: string }[];
  extra_emails: { email: string }[];
};

/**
 * Returns a verdict for the first existing customer in `orgId` whose normalized primary email
 * or phone equals the (normalized) input, or null when there is no match.
 *
 * Strategy (hybrid): a loose, org-scoped DB pre-filter narrows the candidate
 * set (recall-only — must not drop true matches), then a JS pass normalizes
 * both sides and decides the match. The JS pass is the source of truth.
 *
 * `opts.requester` is REQUIRED (#1996): after a match is found, the requester's per-instance
 * `read Customer` access to THAT ROW is evaluated with `can()` (`./permissions/enforce.ts`) —
 * never a role name — and returned as `readable` alongside the full `match`. Callers must pass
 * the finding through `duplicateConflictBody()` before it reaches a response; they must never
 * spread `match`/the finding into `res.json()` directly, which would leak the PII the redacted
 * branch exists to hide.
 *
 * #2041 contract note: `can()` fails closed on any condition field the row doesn't carry (a
 * missing field reads as `undefined`, which never satisfies a CASL condition — see R8 in
 * spec.md). `MATCH_SELECT` selects only what today's unconditional `read Customer` grants need.
 * If #2041 ever introduces a CONDITIONED `read Customer` grant, the same commit MUST widen
 * `MATCH_SELECT` with whatever fields that condition references, or every match will silently
 * redact for every requester, including ones the new condition intends to allow.
 */
export async function findDuplicateCustomer(
  client: Client,
  orgId: string,
  input: { email?: string | null; phone?: string | null },
  opts: {
    requester: Request;
    /**
     * When set, this customer is excluded from the candidate set. Used by the
     * cross-customer accretion guard: while a customer is already linked, its OWN
     * prefilled primary/secondary contact must not count as a "duplicate" — only a
     * DIFFERENT customer's contact should. (accreteContactMethods dedups the
     * same-customer case separately.)
     */
    excludeCustomerId?: string;
  },
): Promise<DuplicateFinding | null> {
  const excludeCustomerId = opts.excludeCustomerId;
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  if (!email && !phone) return null;

  // DB pre-filter is recall-only — it must not drop a true match, since the JS
  // pass below is the source of truth. Phone is stored formatted/un-normalized,
  // so it cannot be matched in SQL; when a phone is supplied we fall back to the
  // full org-scoped candidate set and let the JS pass decide. When only an email
  // is supplied we can safely narrow with a case-insensitive equality.
  const baseWhere: Prisma.CustomerWhereInput = phone
    ? { organization_id: orgId }
    : {
        organization_id: orgId,
        OR: [
          { email: { equals: email as string, mode: 'insensitive' } },
          { extra_emails: { some: { email: { equals: email as string, mode: 'insensitive' } } } },
        ],
      };
  const where: Prisma.CustomerWhereInput = excludeCustomerId
    ? { ...baseWhere, id: { not: excludeCustomerId } }
    : baseWhere;

  const candidates = (await client.customer.findMany({
    where,
    select: MATCH_SELECT,
  })) as Candidate[];

  for (const c of candidates) {
    // Capture the exact value that matched (primary first, else the secondary
    // relation entry) so the dialog can show the value the user actually typed.
    const emailMatch = email
      ? (normalizeEmail(c.email) === email
          ? c.email
          : c.extra_emails.find((e) => normalizeEmail(e.email) === email)?.email ?? null)
      : null;
    const phoneMatch = phone
      ? (normalizePhone(c.phone) === phone
          ? c.phone
          : c.phones.find((p) => normalizePhone(p.phone) === phone)?.phone ?? null)
      : null;
    if (emailMatch || phoneMatch) {
      // R9/#2041: evaluate the readable-verdict against the candidate row AS SELECTED
      // (MATCH_SELECT + CUSTOMER_PROOF_SELECT + organization_id) — never a clone. Was
      // `can(opts.requester,'read','Customer',c)`; @casl/prisma throws on OWN_CUSTOMER's nested
      // to-one -> to-many arms, so this is now the synchronous, SQL-backed `matchesFragment`
      // verdict instead. Evaluate before reshaping into `ExistingMatch` below.
      const readable = isCustomerReadableRow(opts.requester, c as unknown as Record<string, unknown>);
      const loc = c.service_locations[0];
      const match: ExistingMatch = {
        id: c.id,
        customer_number: c.customer_number,
        first_name: c.first_name,
        last_name: c.last_name,
        company_name: c.company_name,
        email: c.email,
        phone: c.phone,
        is_active: c.is_active,
        archived_at: c.archived_at,
        primary_address: loc
          ? { line1: loc.address_line1, city: loc.city, state: loc.state }
          : null,
        matched: { email: emailMatch, phone: phoneMatch },
      };
      return { match, readable };
    }
  }

  return null;
}
