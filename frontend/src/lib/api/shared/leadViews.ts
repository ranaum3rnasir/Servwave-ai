import type { QueryClient } from '@tanstack/react-query';

/**
 * The lead views an outbound contact can change (#2618): the server moves a New lead to
 * Contacted on a qualifying contact, so the lead's detail, the leads list (prefix match, every
 * page and filter) and the lead's History panel go stale. Refetching after a contact that moved
 * nothing is harmless. Exported for the attach doors (SPEC-4 §6.10): attaching an existing
 * communication to a lead can move it too.
 */
export function invalidateLeadViews(qc: QueryClient, leadId: string) {
  qc.invalidateQueries({ queryKey: ['lead', leadId] });
  qc.invalidateQueries({ queryKey: ['leads'] });
  qc.invalidateQueries({ queryKey: ['timeline', 'LEAD', leadId] });
}

/**
 * Every lead view, by prefix (SPEC-4 D7, §6.12.6): a detach, a move away, an edit or a delete can
 * move the lead a communication LEFT back to New, and the hook does not know which lead that was.
 * Only the queries on screen refetch; the rest are marked stale. It also covers the lead the entry
 * reached.
 */
export function invalidateAllLeadViews(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['lead'] });
  qc.invalidateQueries({ queryKey: ['leads'] });
  qc.invalidateQueries({ queryKey: ['timeline', 'LEAD'] });
}
