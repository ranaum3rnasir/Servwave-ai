import { Prisma, type PrismaClient } from '@prisma/client';
// The one definition of the three statuses a lead never moves on from. This module used to carry
// a byte-identical private copy of the list; the lead status writer needs the same three for its
// transition guard, and two copies of a list that must agree is how a fourth terminal status ends
// up honoured in one place and ignored in the other.
import { TERMINAL_LEAD_STATUSES } from '../services/lead-stage.service';
import { DONE_OR_CANCELLED_JOB_STATUSES } from './job-status-order';
import { liveCustomerPhoneEntryValuesSql, livePhoneEntriesSql } from './record-contact-entries';

/**
 * Provider-agnostic comms↔CRM identity resolver (DEC6).
 * Read-only: never creates. Resolves a participant (phone OR email) to a
 * Customer, an open Lead (email only), or a Vendor in precedence order Customer → Lead →
 * Vendor (the billable CRM party wins; a supplier matches only as a fallback).
 * The no-match path is the caller's DEC6 "unmatched → offer create-Lead" UX —
 * this module never auto-creates a Lead. Used by CTM (Plan C) and WhatsApp
 * (Plan W) plus the internal create handlers in this phase; the email channel
 * picks it up again when the Resend path lands.
 *
 * Phase 2 is US/Canada-only for phone; international parsing is deferred.
 * No plus-addressing handling for email.
 */

// The narrow Prisma surface the resolver needs (lets unit tests inject a stub).
type ResolverPrisma = Pick<PrismaClient, 'customer' | 'lead' | 'vendor' | 'vendorContact' | '$queryRaw'>;

export interface IdentityMatch {
  kind: 'customer' | 'lead' | 'vendor';
  id: string;            // the matched entity's id (customer/lead/vendor)
  customerId: string | null;
  leadId: string | null;
  vendorId: string | null;
  label: string;         // human-friendly name for "unmatched"-vs-linked UI
}

/** The one lead or job carrying a number as its own (#3015, the fixed order's first step). */
export type OwnRecord = { kind: 'lead'; id: string } | { kind: 'job'; id: string; jobNumber: string | null };

/** Normalize a North-American phone string to E.164 (+1XXXXXXXXXX), or null. */
export function normalizeNAPhone(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Normalize an email (lowercase + trim). Returns null when it is not an email. */
export function normalizeEmail(raw: string): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  // Minimal shape check — local@domain.tld; no plus-addressing handling (DEC6).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

export function customerName(c: { first_name: string | null; last_name: string | null; company_name: string | null }): string {
  return c.company_name ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer');
}

type PickedCustomer = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  /** The lead or job that carries the number as its own, when it is the one record that does (step 1). */
  own_lead_id: string | null;
  own_job_id: string | null;
  own_job_number: string | null;
};

/**
 * The ONE customer a shared number is filed on (#3015, #3013 decision 1), by a fixed order instead of "any row with this
 * number":
 *   1. the one open lead or job carrying the number as its own (its live phone entry, never written to the customer);
 *   2. the customer with the newest open lead or job;
 *   3. the newest active customer.
 * Open (Ran, 2026-11-05): a lead until it is converted (WON) or lost; a job until it is Done or Cancelled, so a Completed,
 * Office review or Ready to close job is still open. A closed record carrying the number does not decide step 1; its
 * customer still carries the number and is weighed by steps 2 and 3.
 * Archived customers come last: one is picked only when no active customer carries the number. One query, whatever the
 * number of customers carrying it; ties end on the id, so the same data always gives the same answer.
 *
 * Step 1 counts records, not entries: a lead or job holding the number in two of its entries is one record, and a lead entry
 * carried onto the job made from that lead (`source_entry_id`) is one record carrying the number, not two: the job is the one.
 */
async function pickCustomerForNumber(prisma: ResolverPrisma, orgId: string, spellings: string[]): Promise<PickedCustomer | null> {
  const openLead = Prisma.sql`l.status::text <> ALL(${[...TERMINAL_LEAD_STATUSES]}::text[])`;
  const openJob = Prisma.sql`j.status::text <> ALL(${[...DONE_OR_CANCELLED_JOB_STATUSES]}::text[])`;
  const openOwnRecord = Prisma.sql`(o.lead_status <> ALL(${[...TERMINAL_LEAD_STATUSES]}::text[])
      OR o.job_status <> ALL(${[...DONE_OR_CANCELLED_JOB_STATUSES]}::text[]))`;
  const rows = await prisma.$queryRaw<PickedCustomer[]>`
    WITH own_entries AS (${livePhoneEntriesSql(orgId, spellings)}),
    own AS (
      SELECT o.* FROM own_entries o WHERE NOT EXISTS (SELECT 1 FROM own_entries carried WHERE carried.source_entry_id = o.id)
    ),
    open_own AS (
      SELECT o.* FROM own o WHERE ${openOwnRecord}
    ),
    the_one AS (
      SELECT DISTINCT lead_id, job_id, job_number, customer_id FROM open_own
       WHERE (SELECT count(DISTINCT coalesce(job_id, lead_id)) FROM open_own) = 1
    ),
    carriers AS (
      SELECT c.id FROM customers c
       WHERE c.organization_id = ${orgId}::uuid AND (c.phone = ANY(${spellings}::text[]) OR c.secondary_phone = ANY(${spellings}::text[]))
      UNION
      SELECT cp.customer_id FROM customer_phones cp JOIN customers c ON c.id = cp.customer_id
       WHERE c.organization_id = ${orgId}::uuid AND cp.phone = ANY(${spellings}::text[])
      UNION
      SELECT customer_id FROM own
    )
    SELECT c.id, c.first_name, c.last_name, c.company_name,
           one.lead_id AS own_lead_id, one.job_id AS own_job_id, one.job_number AS own_job_number
      FROM carriers k
      JOIN customers c ON c.id = k.id
      LEFT JOIN the_one one ON one.customer_id = c.id
      LEFT JOIN LATERAL (
        SELECT max(w.created_at) AS newest_open FROM (
          SELECT l.created_at FROM leads l WHERE l.customer_id = c.id AND l.organization_id = ${orgId}::uuid AND ${openLead}
          UNION ALL
          SELECT j.created_at FROM jobs j WHERE j.customer_id = c.id AND j.organization_id = ${orgId}::uuid AND ${openJob}
        ) w
      ) work ON true
     ORDER BY (c.is_active AND c.archived_at IS NULL) DESC, (one.customer_id IS NOT NULL) DESC, work.newest_open DESC NULLS LAST, c.created_at DESC, c.id DESC
     LIMIT 1`;
  return rows?.[0] ?? null;
}

/**
 * Which of these numbers (normalized E.164) someone other than customer `exceptCustomerId` still carries, in the company:
 * another customer (their phone, secondary phone or phones list), or a lead or job of another customer carrying it as its
 * own (a live entry, open or closed). These are the carriers the fixed order weighs (`pickCustomerForNumber`), compared
 * as stored (E.164 or bare ten digits). One query, whatever the number of numbers or customers. Used when a customer is
 * deleted (#3019): a conversation whose number someone else carries is kept.
 */
export async function numbersCarriedByOthers(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  orgId: string,
  numbersE164: readonly string[],
  exceptCustomerId: string,
): Promise<Set<string>> {
  const spellings = [...new Set(numbersE164.flatMap((n) => [n, n.replace(/^\+1/, '')]))];
  if (spellings.length === 0) return new Set();
  const rows = await prisma.$queryRaw<{ spelling: string }[]>`
    SELECT c.phone AS spelling FROM customers c
     WHERE c.organization_id = ${orgId}::uuid AND c.id <> ${exceptCustomerId}::uuid AND c.phone = ANY(${spellings}::text[])
    UNION
    SELECT c.secondary_phone FROM customers c
     WHERE c.organization_id = ${orgId}::uuid AND c.id <> ${exceptCustomerId}::uuid AND c.secondary_phone = ANY(${spellings}::text[])
    UNION
    SELECT cp.phone FROM customer_phones cp JOIN customers c ON c.id = cp.customer_id
     WHERE c.organization_id = ${orgId}::uuid AND c.id <> ${exceptCustomerId}::uuid AND cp.phone = ANY(${spellings}::text[])
    UNION
    SELECT o.value FROM (${livePhoneEntriesSql(orgId, spellings)}) o
     WHERE o.customer_id IS DISTINCT FROM ${exceptCustomerId}::uuid`;
  return new Set(rows.map((r) => normalizeNAPhone(r.spelling)).filter((n): n is string => n !== null));
}

/**
 * Resolve a phone number to a Customer / open Lead / Vendor in `orgId`. A number several customers share picks one customer
 * by the fixed order (`pickCustomerForNumber`). A phone match never carries a lead: an incoming text is tied to a lead or
 * job by the reply rule (lib/sms-reply-router.ts, #3020), a call by its own record (`matchCallerByPhone`).
 */
export async function matchByPhone(prisma: ResolverPrisma, orgId: string, raw: string): Promise<IdentityMatch | null> {
  return (await resolvePhone(prisma, orgId, raw)).match;
}

/**
 * The call ingest's door (#3013 decision 1): the same match, plus the one lead or job carrying the number as its own when
 * that record decided the pick, so an incoming call is filed on it. One query, like `matchByPhone`.
 */
export async function matchCallerByPhone(
  prisma: ResolverPrisma,
  orgId: string,
  raw: string,
): Promise<{ match: IdentityMatch | null; ownRecord: OwnRecord | null }> {
  return resolvePhone(prisma, orgId, raw);
}

async function resolvePhone(
  prisma: ResolverPrisma,
  orgId: string,
  raw: string,
): Promise<{ match: IdentityMatch | null; ownRecord: OwnRecord | null }> {
  const found = (match: IdentityMatch | null) => ({ match, ownRecord: null });
  const e164 = normalizeNAPhone(raw);
  if (!e164) return found(null);
  const bare = e164.replace('+1', '');
  // Customer.phone is stored UNFORMATTED ("5551234567"); match the bare form,
  // the E.164 form, and the raw input to cover any stored variant.
  const phoneIn = { in: [e164, bare, raw] };

  const customer = await pickCustomerForNumber(prisma, orgId, [e164, bare, raw]);
  if (customer) {
    const ownRecord: OwnRecord | null = customer.own_lead_id
      ? { kind: 'lead', id: customer.own_lead_id }
      : customer.own_job_id
        ? { kind: 'job', id: customer.own_job_id, jobNumber: customer.own_job_number }
        : null;
    return {
      match: { kind: 'customer', id: customer.id, customerId: customer.id, leadId: null, vendorId: null, label: customerName(customer) },
      ownRecord,
    };
  }

  // No lead step (#3020): every number a lead carries is its customer's or its own entry, and the customer pick above
  // counts both, so a customer always matched first. A text or a call is tied to a lead by the record rules
  // (lib/sms-reply-router.ts; a call's own record), never by the identity match.

  const vendor = await prisma.vendor.findFirst({
    where: { organization_id: orgId, contact_phone: phoneIn },
    select: { id: true, name: true },
  });
  if (vendor) {
    return found({ kind: 'vendor', id: vendor.id, customerId: null, leadId: null, vendorId: vendor.id, label: vendor.name });
  }

  const vc = await prisma.vendorContact.findFirst({
    where: { organization_id: orgId, phone: phoneIn },
    select: { id: true, vendor_id: true, vendor: { select: { id: true, name: true } } },
  });
  if (vc) {
    return found({ kind: 'vendor', id: vc.vendor_id, customerId: null, leadId: null, vendorId: vc.vendor_id, label: vc.vendor?.name ?? 'Vendor' });
  }

  return found(null);
}

/** Resolve an email address to a Customer / open Lead / Vendor in `orgId`. */
export async function matchByEmail(
  prisma: ResolverPrisma,
  orgId: string,
  raw: string,
): Promise<IdentityMatch | null> {
  const email = normalizeEmail(raw);
  if (!email) return null;

  const customer = await prisma.customer.findFirst({
    where: { organization_id: orgId, email },
    select: { id: true, first_name: true, last_name: true, company_name: true },
  });
  if (customer) {
    return { kind: 'customer', id: customer.id, customerId: customer.id, leadId: null, vendorId: null, label: customerName(customer) };
  }

  const lead = await prisma.lead.findFirst({
    where: {
      organization_id: orgId,
      status: { notIn: [...TERMINAL_LEAD_STATUSES] },
      customer: { email },
    },
    select: { id: true, lead_number: true, customer_id: true },
    orderBy: { created_at: 'desc' },
  });
  if (lead) {
    return { kind: 'lead', id: lead.id, customerId: lead.customer_id, leadId: lead.id, vendorId: null, label: lead.lead_number };
  }

  const vendor = await prisma.vendor.findFirst({
    where: { organization_id: orgId, contact_email: email },
    select: { id: true, name: true },
  });
  if (vendor) {
    return { kind: 'vendor', id: vendor.id, customerId: null, leadId: null, vendorId: vendor.id, label: vendor.name };
  }

  const vc = await prisma.vendorContact.findFirst({
    where: { organization_id: orgId, email },
    select: { id: true, vendor_id: true, vendor: { select: { id: true, name: true } } },
  });
  if (vc) {
    return { kind: 'vendor', id: vc.vendor_id, customerId: null, leadId: null, vendorId: vc.vendor_id, label: vc.vendor?.name ?? 'Vendor' };
  }

  return null;
}

// ─── #3021: every customer carrying a number ───────────────────────────────

/*
 * The customers who carry a number (#3021, #3013 decision 5): worked out every time it is asked, from the customers' phone
 * fields and the leads' and jobs' own numbers, never stored. A conversation (a pair of numbers, CONTEXT.md) shows on every
 * one of them, so removing the number from a customer's record takes the conversation off that customer's page at once.
 * A customer carries a number when it is their phone, their second phone or one of their phones list, or a live phone entry
 * of one of their leads or jobs (open or closed): the carriers the fixed order weighs (`pickCustomerForNumber`). Stored values
 * are compared as stored, in the two spellings that rule compares: E.164 and the bare ten digits. These pick no customer:
 * they list every carrier, in the fixed order.
 */

/** A customer carrying a number, as the screens name them. */
export interface NumberCarrier {
  id: string;
  name: string;
}

const E164 = /^\+1\d{10}$/;

/** The stored spellings the rule compares for these numbers: each E.164 and its bare ten digits. */
function spellingsOf(numbersE164: readonly string[]): string[] {
  return [...new Set(numbersE164.filter((n) => E164.test(n)).flatMap((n) => [n, n.slice(2)]))];
}

/** A stored value in one of the compared spellings, as E.164; null for any other spelling. */
function asE164(stored: string | null): string | null {
  if (stored === null) return null;
  if (E164.test(stored)) return stored;
  return /^\d{10}$/.test(stored) ? `+1${stored}` : null;
}

function nameOf(c: { first_name: string | null; last_name: string | null; company_name: string | null }): string {
  return c.company_name ?? [c.first_name, c.last_name].filter(Boolean).join(' ');
}

/**
 * The customers of the company who carry each of these numbers (E.164), in the fixed order (#3015): the customer whose lead
 * or job is the one open record carrying the number as its own, then the customer with the newest open lead or job, then
 * the newest; archived and inactive customers last; ties end on the id. A number nobody carries is absent from the map.
 * ONE query, whatever the number of numbers or customers.
 */
export async function carriersOfNumbers(
  db: Pick<PrismaClient, '$queryRaw'>, organizationId: string, numbersE164: readonly string[],
): Promise<Map<string, NumberCarrier[]>> {
  const out = new Map<string, NumberCarrier[]>();
  const spellings = spellingsOf(numbersE164);
  if (spellings.length === 0) return out;
  const numbers = [...new Set(numbersE164.filter((n) => E164.test(n)))];
  const openLead = Prisma.sql`l.status::text <> ALL(${[...TERMINAL_LEAD_STATUSES]}::text[])`;
  const openJob = Prisma.sql`j.status::text <> ALL(${[...DONE_OR_CANCELLED_JOB_STATUSES]}::text[])`;
  const openOwnRecord = Prisma.sql`(o.lead_status <> ALL(${[...TERMINAL_LEAD_STATUSES]}::text[])
      OR o.job_status <> ALL(${[...DONE_OR_CANCELLED_JOB_STATUSES]}::text[]))`;
  const rows = await db.$queryRaw<{ e164: string; id: string; first_name: string | null; last_name: string | null; company_name: string | null }[]>`
    WITH wanted AS (
      SELECT n AS e164, n AS spelling FROM unnest(${numbers}::text[]) n
      UNION
      SELECT n, substr(n, 3) FROM unnest(${numbers}::text[]) n
    ),
    own_entries AS (
      SELECT w.e164, o.* FROM (${livePhoneEntriesSql(organizationId, spellings)}) o
        JOIN wanted w ON w.spelling = o.value
    ),
    own AS (
      SELECT o.* FROM own_entries o
       WHERE NOT EXISTS (SELECT 1 FROM own_entries carried WHERE carried.source_entry_id = o.id AND carried.e164 = o.e164)
    ),
    open_own AS (
      SELECT o.* FROM own o WHERE ${openOwnRecord}
    ),
    the_one AS (
      SELECT DISTINCT o.e164, o.customer_id FROM open_own o
       WHERE (SELECT count(DISTINCT coalesce(x.job_id, x.lead_id)) FROM open_own x WHERE x.e164 = o.e164) = 1
    ),
    carriers AS (
      SELECT w.e164, c.id FROM customers c JOIN wanted w ON c.phone = w.spelling
       WHERE c.organization_id = ${organizationId}::uuid
      UNION
      SELECT w.e164, c.id FROM customers c JOIN wanted w ON c.secondary_phone = w.spelling
       WHERE c.organization_id = ${organizationId}::uuid
      UNION
      SELECT w.e164, cp.customer_id FROM customer_phones cp JOIN customers c ON c.id = cp.customer_id JOIN wanted w ON cp.phone = w.spelling
       WHERE c.organization_id = ${organizationId}::uuid
      UNION
      SELECT o.e164, o.customer_id FROM own o WHERE o.customer_id IS NOT NULL
    )
    SELECT k.e164, c.id, c.first_name, c.last_name, c.company_name
      FROM carriers k
      JOIN customers c ON c.id = k.id AND c.organization_id = ${organizationId}::uuid
      LEFT JOIN the_one one ON one.customer_id = c.id AND one.e164 = k.e164
      LEFT JOIN LATERAL (
        SELECT max(w.created_at) AS newest_open FROM (
          SELECT l.created_at FROM leads l WHERE l.customer_id = c.id AND l.organization_id = ${organizationId}::uuid AND ${openLead}
          UNION ALL
          SELECT j.created_at FROM jobs j WHERE j.customer_id = c.id AND j.organization_id = ${organizationId}::uuid AND ${openJob}
        ) w
      ) work ON true
     ORDER BY k.e164, (c.is_active AND c.archived_at IS NULL) DESC, (one.customer_id IS NOT NULL) DESC,
              work.newest_open DESC NULLS LAST, c.created_at DESC, c.id DESC`;
  for (const row of rows) {
    const list = out.get(row.e164) ?? [];
    list.push({ id: row.id, name: nameOf(row) });
    out.set(row.e164, list);
  }
  return out;
}

/**
 * The numbers (E.164) one customer of the company carries: their phone fields and the live phone entries of their leads and
 * jobs, in the spellings the rule compares. One query.
 */
export async function numbersCustomerCarries(db: Pick<PrismaClient, '$queryRaw'>, organizationId: string, customerId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ value: string | null }[]>`
    SELECT c.phone AS value FROM customers c WHERE c.id = ${customerId}::uuid AND c.organization_id = ${organizationId}::uuid
    UNION
    SELECT c.secondary_phone FROM customers c WHERE c.id = ${customerId}::uuid AND c.organization_id = ${organizationId}::uuid
    UNION
    SELECT cp.phone FROM customer_phones cp JOIN customers c ON c.id = cp.customer_id
     WHERE c.id = ${customerId}::uuid AND c.organization_id = ${organizationId}::uuid
    UNION
    ${liveCustomerPhoneEntryValuesSql(organizationId, customerId)}`;
  return [...new Set(rows.map((r) => asE164(r.value)).filter((n): n is string => n !== null))];
}
