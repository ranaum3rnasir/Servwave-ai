import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

/**
 * Editable record IDs (2026-08-19 plan) — frontend half of the shared rename engine in
 * backend/src/lib/record-renumber.ts. `RenumberComputation`/`DerivedChange` mirror that
 * file's exported types exactly (same field names, same shape) so a preview response can
 * be handed straight to the UI with no translation layer.
 */

export type RenumberableEntity = 'customer' | 'lead' | 'estimate' | 'job' | 'invoice';

export interface DerivedChange {
  table: string;
  id: string;
  column: string;
  oldValue: string;
  newValue: string;
  conflict: boolean;
  /** The id of the row currently squatting on `newValue` in that table, when `conflict`. */
  conflictWithId?: string;
}

export interface RenumberComputation {
  entity: RenumberableEntity;
  parentId: string;
  oldNumber: string;
  newNumber: string;
  parentConflict: boolean;
  parentConflictWithId?: string;
  /** Container estimates + anchored logistic orders — never label rows (labels can't conflict). */
  derived: DerivedChange[];
  /** Denormalized label rows — `conflict` is always false here. */
  labelRefreshes: DerivedChange[];
  /** True iff `parentConflict` or any `derived[].conflict`. */
  hasConflicts: boolean;
}

/** The 200 body of `PATCH /api/{resource}/:id/number` — the renamed entity itself (under a
 * key that varies by `entity`, e.g. `customer`/`lead`/...), plus the same before/after and
 * cascade data the preview computation carries. Callers needing the full renamed entity
 * should re-fetch through their own query key rather than lean on the dynamic key here. */
export interface RenameRecordNumberResponse {
  old_number: string;
  new_number: string;
  derived: DerivedChange[];
  label_refreshes: DerivedChange[];
  [key: string]: unknown;
}

const RESOURCE_PATH: Record<RenumberableEntity, string> = {
  customer: 'customers',
  lead: 'leads',
  estimate: 'estimates',
  job: 'jobs',
  invoice: 'invoices',
};

/**
 * Preview what renaming `entity`/`id` to a candidate number would touch. Read-only, no write
 * — safe to fire on every "check this number" click.
 *
 * A 400 (invalid format) or a conflict-shaped 409 here is an ordinary, expected outcome (a
 * typo, a number already taken), not a system failure, so this still toasts on error the
 * same way every other mutation in this codebase does (extractApiError — a fire-and-forget
 * `mutate()` caller isn't left silently in the dark), but `mutateAsync` ALSO rejects with
 * that same error, so a caller that awaits it (the confirmation dialog) can render the
 * message inline instead of relying on the toast alone.
 */
export function usePreviewRecordNumber(entity: RenumberableEntity, id: string) {
  return useMutation({
    mutationFn: (number: string) =>
      api
        .post<RenumberComputation>(`/api/${RESOURCE_PATH[entity]}/${id}/number/preview`, { number })
        .then((r) => r.data),
    onError: (err) =>
      toast({
        title: 'Could not preview this number',
        description: extractApiError(err, 'Please try again'),
        variant: 'destructive',
      }),
  });
}

/**
 * Rename `entity`/`id` to a new number, then invalidate the ENTIRE query cache.
 *
 * The blanket invalidation is deliberate, not laziness. A rename rewrites a human identifier
 * that the backend cascades across a dozen tables — anchored logistic orders and container
 * estimates, plus denormalized `job_number`/`job_label` copies on job_stages, rfqs,
 * stock_approvals, estimate_reservations, time_entries, calls, messages and emails (see
 * RENUMBER_CONFIG in backend/src/lib/record-renumber.ts). Any of those may be sitting in a
 * cached list the user opens next, and the client's default staleTime is five minutes with
 * refetchOnWindowFocus off, so a targeted key list would leave the rest reading the OLD number
 * until it expired — staging QA renamed a job and found its logistic orders unchanged until a
 * manual reload. Enumerating the affected keys here would also mean re-deriving that cascade in
 * the frontend and keeping the two in step for ever.
 *
 * Renaming is a rare, deliberate, per-record action, so refetching the open queries once is
 * cheap next to showing stale identifiers. Callers still pass `onSuccess` for anything beyond
 * cache invalidation (local state, navigation); the detail pages' own `['customer', id]`-style
 * invalidations are a subset of this one and are left in place deliberately, so each page still
 * refreshes itself if this ever narrows.
 */
export function useRenameRecordNumber(
  entity: RenumberableEntity,
  id: string,
  options?: { onSuccess?: (data: RenameRecordNumberResponse) => void },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (number: string) =>
      api
        .patch<RenameRecordNumberResponse>(`/api/${RESOURCE_PATH[entity]}/${id}/number`, { number })
        .then((r) => r.data),
    onSuccess: (data) => {
      void queryClient.invalidateQueries();
      options?.onSuccess?.(data);
    },
    onError: (err) =>
      toast({
        title: 'Could not rename this record',
        description: extractApiError(err, 'Please try again'),
        variant: 'destructive',
      }),
  });
}
