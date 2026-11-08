/**
 * Shared scope-of-work helpers. Job.scopes and Invoice.scopes (schema.prisma) are both a raw
 * JSONB column storing an array of flat-priced, non-line-item blocks — narrative scope-of-work
 * text with an optional flat price, distinct from a quantity-priced InvoiceLineItem/job line.
 *
 * GOTCHA every consumer must guard: a JSONB column reads back as `null`, not `[]`, when no
 * scope has ever been added (Prisma doesn't materialize an empty array for an unset Json? column)
 * — always route a raw column read through asScopeArray() rather than assuming it's an array.
 */
import type { Request } from 'express';
import type { ScopeForTotals } from './invoice-totals';
import { canSeePricing } from './permissions/enforce';

export interface ScopeOfWork {
  id: string;
  title: string;
  body: string;
  flat_price: number | null;
  is_taxable: boolean;
  internal_cost: number | null;
  /**
   * #2053 slice 1 — estimate-only. Optional on the type (not every JSONB block written before
   * this feature carries the key), defaulted on read/write by `withOptionalDefaults` /
   * `toEstimateScopeForTotals` below. Job.scopes and Invoice.scopes never populate these — see
   * `toScopeForTotals`, which stays flag-blind on purpose.
   */
  is_optional?: boolean;
  is_selected?: boolean;
  /**
   * The SALESPERSON's recommendation for this block: what they are offering, as distinct from
   * `is_selected` above, which is the live answer on the document. Every send publishes this onto
   * `is_selected` (`publishRepRecommendation`, estimate.controller.ts). Absent means "the rep
   * never expressed a preference on this block", and a send then leaves it alone; the editor
   * falls back to `is_selected`, which is exactly the pre-feature behaviour. Estimate-only, like
   * the pair above. INTERNAL rep state: `stripScopeSendSnapshot` below keeps it off the
   * customer-facing payload.
   *
   * Renamed to `rep_selected` by migration 20260919140000. This is a key inside a JSONB array,
   * not a column, so renaming this field does not rename the stored blobs - that migration
   * rewrites them in place rather than leaving a read-both-keys branch in the code. The full
   * reasoning lives at the one site that READS it, `ScopeOfWorkCard.tsx`.
   */
  rep_selected?: boolean;
}

/** Guards the JSONB-reads-as-null-when-empty gotcha: always returns an array. */
export function asScopeArray(raw: unknown): ScopeOfWork[] {
  return Array.isArray(raw) ? (raw as ScopeOfWork[]) : [];
}

/**
 * Maps stored scopes to the calculator's flat-priced-block shape (invoice-totals.ts). Stays
 * flag-blind ON PURPOSE (#2053 reviewer amendment R1) — shared with Job and Invoice, whose own
 * totals must never become selection-filtered. Estimate's own totals use
 * `toEstimateScopeForTotals` below instead.
 */
export function toScopeForTotals(scopes: ScopeOfWork[]): ScopeForTotals[] {
  return scopes.map((s) => ({ flat_price: s.flat_price, is_taxable: s.is_taxable }));
}

/**
 * #2053 slice 1 — the ESTIMATE-only sibling of `toScopeForTotals`, projecting `is_optional`/
 * `is_selected` through (defaulted) so `countsTowardTotals` has something to filter on. Used at
 * the four estimate call sites that recompute an estimate's OWN totals (never Job's or
 * Invoice's — see the module doc above and reviewer amendment R1/R2).
 */
export function toEstimateScopeForTotals(scopes: ScopeOfWork[]): ScopeForTotals[] {
  return scopes.map((s) => ({
    flat_price: s.flat_price,
    is_taxable: s.is_taxable,
    is_optional: s.is_optional ?? false,
    is_selected: s.is_selected ?? true,
  }));
}

/**
 * #2053 slice 1 — read-time defaults for a scope block that predates this feature (or was never
 * itself touched by an is_optional/is_selected-aware write): `is_optional` defaults to false,
 * `is_selected` to true — "nothing was optional, everything counts", the same backfill the
 * migration applies to EstimateLineItem rows. Estimate-only; never applied to Job/Invoice scopes.
 */
export function withOptionalDefaults(scopes: ScopeOfWork[]): ScopeOfWork[] {
  return scopes.map((s) => ({ ...s, is_optional: s.is_optional ?? false, is_selected: s.is_selected ?? true }));
}

/**
 * A copy of each scope with the rep's recommendation omitted. Two jobs, one rule:
 *  - the customer-facing public payload never carries it (it is the REP's own state, and the
 *    customer's page is driven by `is_selected`, which every send publishes it onto);
 *  - a duplicate/revision is an unsent DRAFT with its own rep to persuade, so it must not
 *    inherit a recommendation made on a different document.
 * Strips the KEY (absent, not null), mirroring `stripScopeCost` below.
 */
export function stripScopeSendSnapshot<T extends { rep_selected?: boolean }>(
  scopes: T[],
): Omit<T, 'rep_selected'>[] {
  return scopes.map(({ rep_selected: _repSelected, ...rest }) => rest);
}

/** A copy of each scope with internal_cost (margin data) omitted — for low-privilege responses. */
export function stripScopeCost(scopes: ScopeOfWork[]): Omit<ScopeOfWork, 'internal_cost'>[] {
  return scopes.map(({ internal_cost: _internalCost, ...rest }) => rest);
}

/**
 * A copy of each scope with BOTH cost and sell price omitted — for a requester who cannot
 * `read Invoice` (D13, Spec A). Distinct from stripScopeCost, which drops cost only and is
 * called UNCONDITIONALLY by invoice-lines.controller.ts and estimate.controller.ts; widening
 * that function would hide flat_price from every user including admins.
 */
export function stripScopeMoney(
  scopes: ScopeOfWork[],
): Omit<ScopeOfWork, 'internal_cost' | 'flat_price'>[] {
  return scopes.map(({ internal_cost: _internalCost, flat_price: _flatPrice, ...rest }) => rest);
}

/**
 * Cost/margin strip shared by Invoice and Estimate detail-shaped responses - internal_cost
 * (scope margin), unit_cost/markup_percent (line margin) and the labor_hours/overhead_mode/
 * overhead_value cost model (D2/D8). Strips the KEY, absent rather than null, mirroring
 * stripLinePricing.
 *
 * SRVW-140 - one policy for both entities: `stripInvoiceCost` (invoice.controller.ts) and
 * `stripEstimateCost` (estimate.controller.ts) were a token-for-token clone of this body, which
 * meant a future field added to the cost model - or a change from key-delete to null - could land
 * in one copy and silently leak from the other. Both are now thin aliases of this function.
 */
export function stripDocumentCost<T extends { scopes?: unknown; line_items?: Array<Record<string, unknown>> }>(
  doc: T,
  req: Request,
): T {
  if (canSeePricing(req)) return doc;
  const out: Record<string, unknown> = {
    ...doc,
    scopes: stripScopeCost(asScopeArray(doc.scopes)),
    // Defensive `?? []`: every real detail-shaped response always carries line_items, but a
    // caller whose select or fixture omits it should simply have nothing to strip rather than 500.
    line_items: (doc.line_items ?? []).map((line) => {
      const l = { ...line };
      delete l.unit_cost;
      delete l.markup_percent;
      return l;
    }),
  };
  delete out.labor_hours;
  delete out.overhead_mode;
  delete out.overhead_value;
  return out as T;
}
