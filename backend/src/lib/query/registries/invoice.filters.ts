import { InvoiceKind, InvoiceStatus } from '@prisma/client';
import { equalsOrIn, FacetDef } from '../filterEngine';

/**
 * Invoice list facet registry (Task 14).
 *
 * - `status` gets a custom `apply` (not the stock `equalsOrIn` directly) to
 *   validate against the `InvoiceStatus` enum first — the old hand-rolled
 *   controller code passed `?status=` straight into `{ in: [...] }` with no
 *   validation, so a garbage value would throw a Prisma error (500) instead
 *   of being silently dropped. This mirrors `estimate.filters.ts` /
 *   `lead.filters.ts`'s `status` facet and is an intentional consistency
 *   fix, not a behavior-preserving no-op.
 * - `customer_id` IS a direct scalar column on Invoice (entity-redesign §6 —
 *   unlike Estimate, where the customer is reached via `lead.customer_id`),
 *   so the stock `equalsOrIn` applies unmodified.
 * - `total` (renamed to the `_min`/`_max` suffix wire convention locked in
 *   Task 12) and `balance` (NEW — closes the audited gap: invoices had a
 *   Total range but no Balance range) are both plain `range` facets on
 *   scalar columns.
 * - `created` / `due` are plain `dateRange` facets. NOTE: `due` shares its
 *   `due_date` column with the `overdue` toggle, which is NOT a facet (it's
 *   a computed predicate — see `buildInvoiceListWhere` in
 *   `invoice.controller.ts`, which runs it AFTER `applyFilters` and MERGES
 *   its `{ lt: now }` onto whatever `due_date` this facet already set).
 */
export const invoiceFacets: FacetDef[] = [
  {
    key: 'status',
    kind: 'multi',
    param: 'status',
    apply: (where, values) => {
      const validStatuses = values.filter((v) => Object.values(InvoiceStatus).includes(v as InvoiceStatus));
      equalsOrIn('status')(where, validStatuses);
    },
  },
  // `kind` splits DEPOSIT from STANDARD. A deposit invoice is money held against
  // future work, not billed work, so an operator scanning this list needs to be
  // able to separate the two - without it the only way to tell them apart is to
  // open each row. Validated against the enum for the same reason `status` is:
  // an unvalidated value reaches Prisma as a 500 rather than being dropped.
  {
    key: 'kind',
    kind: 'multi',
    param: 'kind',
    apply: (where, values) => {
      const validKinds = values.filter((v) => Object.values(InvoiceKind).includes(v as InvoiceKind));
      equalsOrIn('kind')(where, validKinds);
    },
  },
  { key: 'customer_id', kind: 'multi', param: 'customer_id', apply: equalsOrIn('customer_id') },
  { key: 'total', kind: 'range', minParam: 'total_min', maxParam: 'total_max', column: 'total_amount' },
  { key: 'balance', kind: 'range', minParam: 'balance_min', maxParam: 'balance_max', column: 'amount_due' },
  { key: 'created', kind: 'dateRange', afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' },
  { key: 'due', kind: 'dateRange', afterParam: 'due_after', beforeParam: 'due_before', column: 'due_date' },
  // SRVW-58 - polymorphic TagAssignment rows resolved to invoice ids by the shared
  // `tags` facet kind.
  { key: 'tags', kind: 'tags', param: 'tags', entityType: 'INVOICE' },
];
