/**
 * A flat-priced, non-line-item scope-of-work block (`backend/src/lib/scopes.ts` `ScopeOfWork`).
 * Job.scopes, Invoice.scopes and Estimate.scopes share this exact JSONB shape — defined once here
 * and imported by `@/lib/api/jobs`, `invoices` and `estimates` rather than duplicated, so they
 * never silently drift.
 */
export interface Scope {
  id: string;
  title: string;
  body: string;
  flat_price: number | null;
  is_taxable: boolean;
  /** Margin data — absent from the response entirely (not null) when the caller can't `read Invoice` (see `stripScopeCost`). */
  internal_cost?: number | null;
  /** #2053 slice 1 — estimate-only, same doc as InvoiceLineItem's identical pair above. */
  is_optional?: boolean;
  is_selected?: boolean;
  /** The rep's recommendation: same doc as `InvoiceLineItem.rep_selected` above. */
  rep_selected?: boolean | null;
}
