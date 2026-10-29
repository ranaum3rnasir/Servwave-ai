/**
 * Making a new estimate: the anchor shape, and the cache drop that has to follow every create or
 * copy. Extracted after `/estimates/new`'s create-and-redirect shim shipped without the
 * invalidation `EstimateTabs` already had - so the workspace it landed on rendered its tab strip
 * from a sibling list that predated the estimate the user had just created, and (App.tsx pins
 * staleTime to 5 minutes with no refetch on focus) kept doing so for five minutes.
 */
import type { QueryClient } from '@tanstack/react-query';
import { createEstimate } from '@/lib/api/estimates';

/** Exactly ONE of lead / customer / job - the backend's single-anchor guard rejects more (SERV10X-61 §5.1). */
export type EstimateAnchor = { lead_id: string } | { customer_id: string } | { job_id: string };

/**
 * Drop every cached estimate list so a just-created/copied estimate is actually in them.
 * `['estimates']` is matched as a PREFIX, so this one call covers both the per-lead tab strip
 * (`['estimates', { lead_id }]`) and EstimatesPage's paged key (`['estimates', { page, ... }]`).
 */
export function invalidateEstimateLists(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ['estimates'] });
}

/**
 * Create an empty DRAFT on `anchor`, refresh the lists, and resolve with the new estimate's id.
 * Landing on it is left to the caller - `/estimates/new` replaces itself, the tab strip pushes.
 */
export async function createEstimateForAnchor(
  anchor: EstimateAnchor,
  queryClient: QueryClient,
): Promise<string> {
  const res = await createEstimate(anchor);
  invalidateEstimateLists(queryClient);
  return res.estimate.id as string;
}
