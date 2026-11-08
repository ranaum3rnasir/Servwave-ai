/**
 * Lead endpoints introduced by the entity redesign.
 *
 * Only the NEW DELETE route lives here. The open-pipeline default list filter is a
 * LIST-PARAM change wired into LeadsPage in Phase 8, not a new endpoint, so list calls
 * stay inline for now. `listLeads` is exposed as an optional convenience signature.
 *
 * Routes verified against backend/src/routes/lead.routes.ts.
 */
import api from '@/lib/axios';

/** DELETE /api/leads/:id — hard-delete a lead (new in the redesign). */
export function deleteLead(id: string) {
  return api.delete(`/api/leads/${id}`).then((r) => r.data);
}

/** POST /api/leads/:id/cancel — administratively void a lead (distinct from mark-lost). */
export function cancelLead(id: string, body: { cancelled_reason: string }) {
  return api.post(`/api/leads/${id}/cancel`, body).then((r) => r.data);
}

/** GET /api/leads — list with optional query params (e.g. open-pipeline default in Phase 8). */
export function listLeads(params?: Record<string, unknown>) {
  return api.get('/api/leads', { params }).then((r) => r.data);
}
