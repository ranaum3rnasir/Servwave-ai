/**
 * Lead endpoints introduced by the entity redesign.
 *
 * Only the NEW DELETE route lives here. The open-pipeline default list filter is a
 * LIST-PARAM change wired into LeadsPage in Phase 8, not a new endpoint, so list calls
 * stay inline for now. `listLeads` is exposed as an optional convenience signature.
 *
 * Routes verified against backend/src/routes/lead.routes.ts.
 */
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';

/** DELETE /api/leads/:id — hard-delete a lead (new in the redesign). */
export function deleteLead(id: string) {
  return api.delete(`/api/leads/${id}`).then((r) => r.data);
}

/** GET /api/leads — list with optional query params (e.g. open-pipeline default in Phase 8). */
export function listLeads(params?: Record<string, unknown>) {
  return api.get('/api/leads', { params }).then((r) => r.data);
}

/** Where the creator lands on the lead they are about to make: the creator rule's answer, one slot filled. */
export interface LeadCreatorPrefill {
  owner_id: string | null;
  dispatcher_id: string | null;
  /** Whether the signed-in person's own "Can be on a crew" switch is on: the form offers "I'll do this walkthrough" only then. */
  can_be_on_crew: boolean;
}

/**
 * GET /api/leads/creator-prefill - the new-lead form's pre-filled Owner and Dispatcher. The server works it out
 * from the signed-in person's own switches (never a role name), and the create route applies the same rule.
 */
export function useLeadCreatorPrefill() {
  return useQuery<LeadCreatorPrefill>({
    queryKey: ['leads', 'creator-prefill'],
    queryFn: () => api.get('/api/leads/creator-prefill').then((r) => (
      { ...r.data.prefill, can_be_on_crew: r.data.can_be_on_crew === true } as LeadCreatorPrefill
    )),
    // The rule reads switches that can change between two forms; never reuse an earlier answer.
    staleTime: 0,
  });
}
