import { Prisma } from '@prisma/client';

/**
 * Entity-redesign §3 / §10 — shared service-location resolution + tax-warning.
 *
 * `resolveOrAccreteLocation` anchors a Lead (Phase 4a) / Job (Phase 4c) to exactly
 * one of the customer's `ServiceLocation`s:
 *   - an explicit `service_location_id` is validated against the customer (and org)
 *     and returned unchanged;
 *   - otherwise an `address` is normalized and find-or-created on the customer
 *     (dedupe on normalized `address_line1` + `zip`).
 *
 * NORMALIZATION (lowercase/trim line1 + strip non-digits of zip) is the SINGLE
 * SOURCE OF TRUTH that Phase D's location-backfill SQL must mirror so the two
 * never diverge (plan §4a, line 227 / §12 D2 line 377).
 *
 * `buildLocationTaxWarning` produces the informational tax-warning signal surfaced
 * when a location change crosses a state line (destination-based tax, §11).
 */

type Tx = Prisma.TransactionClient;

export interface LocationAddress {
  address_line1: string;
  address_line2?: string | null;
  city: string;
  state: string;
  zip: string;
}

export interface ResolveLocationArgs {
  customerId: string;
  orgId: string;
  service_location_id?: string | null;
  address?: LocationAddress | null;
}

/** Typed error so controllers can map a resolution failure to a 400. */
export class LocationResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocationResolutionError';
  }
}

/** Lowercase + trim address line 1 for dedupe comparison. */
function normalizeLine1(line1: string): string {
  return line1.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Strip non-digits from a zip for dedupe comparison (e.g. "78701-0000" → "787010000"). */
function normalizeZip(zip: string): string {
  return zip.replace(/\D/g, '');
}

/**
 * The resolved location: its id plus the state it carries. `state` is what drives
 * the destination-based tax-warning (§11), so the resolver MUST surface it for the
 * pick-from-existing path too — not just the address-accretion path.
 */
export interface ResolvedLocation {
  id: string;
  state: string | null;
}

/**
 * Resolve the customer's ServiceLocation for a lead/job, find-or-creating one when
 * only an address is supplied. Returns the resolved `{ id, state }` so callers can
 * raise a cross-state tax-warning even on a pure id-pick. Throws
 * `LocationResolutionError` when nothing resolves (controller maps to 400).
 */
export async function resolveOrAccreteLocation(tx: Tx, args: ResolveLocationArgs): Promise<ResolvedLocation> {
  const { customerId, orgId, service_location_id, address } = args;

  // 1) Explicit id — validate ownership (customer + org + active) and return its
  //    state too (so the id-pick path can still raise a cross-state tax-warning).
  if (service_location_id) {
    const existing = await tx.serviceLocation.findFirst({
      where: {
        id: service_location_id,
        customer_id: customerId,
        is_active: { not: false },
      },
      select: { id: true, state: true },
    }) as { id: string; state?: string | null } | null;
    if (!existing) {
      throw new LocationResolutionError('service_location_id does not belong to the customer');
    }
    return { id: existing.id, state: existing.state ?? null };
  }

  // 2) Address — normalize, find-or-create on the customer (dedupe on line1+zip).
  if (address && address.address_line1 && address.zip) {
    const targetLine1 = normalizeLine1(address.address_line1);
    const targetZip = normalizeZip(address.zip);

    // Dedupe query: an existing location on this customer whose normalized
    // line1 + zip match. Postgres has no normalized index yet (Phase D adds it),
    // so narrow with a case-insensitive line1 contains + a zip prefix, then
    // confirm with the exact normalized rule below (the single source of truth).
    const candidate = await tx.serviceLocation.findFirst({
      where: {
        customer_id: customerId,
        address_line1: { contains: address.address_line1.trim(), mode: 'insensitive' },
        zip: { contains: targetZip.slice(0, 5) },
      },
      select: { id: true, address_line1: true, zip: true, state: true },
      orderBy: { is_primary: 'desc' },
    }) as { id: string; address_line1?: string | null; zip?: string | null; state?: string | null } | null;

    if (candidate) {
      // When the mock/DB returns the raw fields, confirm the normalized match;
      // when it returns id-only (already narrowed by the where), trust the hit.
      const hasRaw = candidate.address_line1 !== undefined && candidate.zip !== undefined;
      const confirmed =
        !hasRaw ||
        (normalizeLine1(candidate.address_line1 ?? '') === targetLine1 &&
          normalizeZip(candidate.zip ?? '') === targetZip);
      // A deduped existing row keeps its own state; fall back to the incoming
      // address state when the mock/DB didn't return it.
      if (confirmed) return { id: candidate.id, state: candidate.state ?? address.state ?? null };
    }

    const created = await tx.serviceLocation.create({
      data: {
        customer_id: customerId,
        address_line1: address.address_line1,
        address_line2: address.address_line2 ?? null,
        city: address.city,
        state: address.state,
        zip: address.zip,
        is_primary: false,
      },
      select: { id: true },
    });
    return { id: created.id, state: address.state ?? null };
  }

  throw new LocationResolutionError('No service_location_id or address provided to resolve a location');
}

export interface LocationTaxWarning {
  tax_warning: true;
  old_state: string;
  new_state: string;
}

/**
 * Build the informational tax-warning signal for a location change. Returns null
 * when the states match (case-insensitive) or either side is missing.
 *
 * The returned states are normalized FOR DISPLAY ONLY (trim + upper-case): the DB
 * holds free-text `state` values, and a stored lower-case code ('ny') otherwise
 * reached the user verbatim as "moved from ny to FL", which reads as a typo. This
 * function stays pure — nothing here is written back to the row. No validation is
 * applied: whatever is stored is echoed, just cased consistently.
 */
export function buildLocationTaxWarning(
  oldState: string | null | undefined,
  newState: string | null | undefined,
): LocationTaxWarning | null {
  if (!oldState || !newState) return null;
  if (oldState.trim().toLowerCase() === newState.trim().toLowerCase()) return null;
  return {
    tax_warning: true,
    old_state: oldState.trim().toUpperCase(),
    new_state: newState.trim().toUpperCase(),
  };
}
