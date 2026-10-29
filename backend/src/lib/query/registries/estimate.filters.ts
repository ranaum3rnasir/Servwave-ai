import { EstimateStatus } from '@prisma/client';
import { equalsOrIn, FacetDef } from '../filterEngine';

// Maps the (legacy) DepositStatus query values onto the deposit-invoice
// status they now correspond to, since the standalone Deposit model was
// dissolved into a kind=DEPOSIT Invoice. Kept here (not inlined in the
// facet below) so the single-value and multi-value paths share one source
// of truth for the mapping.
const DEPOSIT_INVOICE_STATUS: Record<string, string | string[]> = {
  REQUESTED: ['DRAFT', 'SENT'],
  PAID: 'PAID',
  VOIDED: 'VOIDED',
  REFUNDED: ['REFUNDED', 'PARTIALLY_REFUNDED'],
};

/**
 * Estimate list facet registry (Task 12). Three facets need a custom `apply`
 * instead of the stock `equalsOrIn` because they are not plain scalar
 * columns on `Estimate`:
 *
 * - `status` is a strict Prisma enum column — an unvalidated `{ in: [...] }`
 *   with a garbage literal throws a Prisma validation error (500) instead of
 *   the desired "silently ignore garbage" behavior (mirrors
 *   `lead.filters.ts`'s `status` facet).
 * - `deposit_status` is NOT a column at all — it's a synthetic value that
 *   maps onto `invoices.some.{kind,status}` (the deposit was dissolved into
 *   a kind=DEPOSIT Invoice; see DEPOSIT_INVOICE_STATUS above).
 * - `customer_id` R6 (2026-07-22) — Estimate.customer_id is a direct column again (mirroring
 *   Job's anchor shape), so this filters it directly rather than through
 *   `estimate -> lead -> customer_id`. Still AND-appended (not a plain `equalsOrIn`) so it
 *   composes safely with any existing `where.AND` (e.g. from another facet or row-scope).
 *
 * `created_by`, `lead_id` and `job_id` are plain direct Estimate columns (scalar today), made
 * array-capable via the stock `equalsOrIn`.
 *
 * `anchor` is not a column either: it is the ANCHOR-KIND question (#2026), and it works by
 * requiring the other two anchor columns to be null. See its own comment below.
 */
export const estimateFacets: FacetDef[] = [
  {
    key: 'status',
    kind: 'multi',
    param: 'status',
    apply: (where, values) => {
      const validStatuses = values.filter((v) => Object.values(EstimateStatus).includes(v as EstimateStatus));
      equalsOrIn('status')(where, validStatuses);
    },
  },
  { key: 'created_by', kind: 'multi', param: 'created_by', apply: equalsOrIn('created_by') },
  { key: 'lead_id', kind: 'multi', param: 'lead_id', apply: equalsOrIn('lead_id') },
  {
    key: 'deposit_status',
    kind: 'multi',
    param: 'deposit_status',
    apply: (where, values) => {
      if (values.length === 0) return;
      // Flatten each selected value's mapped invoice-status(es) into one
      // deduped, order-preserving array; unknown values contribute nothing.
      const targetStatuses: string[] = [];
      for (const value of values) {
        const mapped = DEPOSIT_INVOICE_STATUS[value];
        if (!mapped) continue;
        const statuses = Array.isArray(mapped) ? mapped : [mapped];
        for (const status of statuses) {
          if (!targetStatuses.includes(status)) targetStatuses.push(status);
        }
      }
      if (targetStatuses.length === 0) return;
      const status = targetStatuses.length === 1 ? targetStatuses[0] : { in: targetStatuses };
      where.invoices = { some: { kind: 'DEPOSIT', status } };
    },
  },
  {
    key: 'customer_id',
    kind: 'multi',
    param: 'customer_id',
    apply: (where, values) => {
      if (values.length === 0) return;
      // Direct column — AND-append so this never clobbers an existing where.AND (set by
      // another facet or by row-scope).
      const customerFilter = values.length === 1 ? values[0] : { in: values };
      const existingAnd = Array.isArray(where.AND) ? (where.AND as unknown[]) : [];
      where.AND = [...existingAnd, { customer_id: customerFilter }];
    },
  },
  { key: 'job_id', kind: 'multi', param: 'job_id', apply: equalsOrIn('job_id') },
  {
    key: 'anchor',
    kind: 'multi',
    param: 'anchor',
    apply: (where, values) => {
      // #2026 — an estimate carries exactly ONE anchor (lead, customer or job), but customer_id
      // is denormalised onto EVERY row, so `customer_id=X` alone also returns X's lead- and
      // job-anchored estimates. `anchor=<kind>` asks the narrower question by requiring the OTHER
      // two anchor columns to be null. The anchor id itself still comes from its own param, so
      // this facet composes with lead_id/customer_id/job_id rather than replacing them.
      //
      // customer_id is NOT nullable (it is on every estimate), so the customer case is expressed
      // as "no lead and no job" rather than by nulling the other two ids.
      const NULLED_BY_ANCHOR: Record<string, Record<string, null>> = {
        customer: { lead_id: null, job_id: null },
        lead: { job_id: null },
        job: { lead_id: null },
      };
      // A single value only — an estimate cannot be anchored two ways at once, so an array is
      // meaningless here and an unrecognised value adds no clause at all rather than 500ing.
      const clause = values.length === 1 ? NULLED_BY_ANCHOR[values[0] as string] : undefined;
      if (!clause) return;
      const existingAnd = Array.isArray(where.AND) ? (where.AND as unknown[]) : [];
      where.AND = [...existingAnd, clause];
    },
  },
  { key: 'total', kind: 'range', minParam: 'total_min', maxParam: 'total_max', column: 'total_amount' },
  { key: 'created', kind: 'dateRange', afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' },
  // SRVW-58 - the `customer_id` facet above already writes `where.AND`, which
  // mergeIdFilter appends to rather than replaces.
  { key: 'tags', kind: 'tags', param: 'tags', entityType: 'ESTIMATE' },
];
