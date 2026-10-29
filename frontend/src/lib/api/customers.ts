/**
 * Customer lifecycle endpoints (entity-redesign §10).
 *
 * Thin wrappers over the shared axios instance for the NEW lifecycle routes only.
 * Existing customer reads/writes remain inline in CustomersPage / CustomerDetailPage;
 * these are imported by the Phase-8 lifecycle UI (archive / unarchive / purge / anonymize
 * + service-location archive).
 *
 * Routes verified against backend/src/routes/customer.routes.ts.
 */
import api from '@/lib/axios';

/** POST /api/customers/:id/archive — soft-archive (sets archived_at). */
export function archiveCustomer(id: string) {
  return api.post(`/api/customers/${id}/archive`).then((r) => r.data);
}

/** POST /api/customers/:id/unarchive — clear archived_at. */
export function unarchiveCustomer(id: string) {
  return api.post(`/api/customers/${id}/unarchive`).then((r) => r.data);
}

/** POST /api/customers/:id/purge — force-purge the customer subtree (admin-only, money-gated). */
export function purgeCustomer(id: string, body?: Record<string, unknown>) {
  return api.post(`/api/customers/${id}/purge`, body).then((r) => r.data);
}

/** POST /api/customers/:id/anonymize — anonymize PII while retaining ledger rows (admin-only). */
export function anonymizeCustomer(id: string) {
  return api.post(`/api/customers/${id}/anonymize`).then((r) => r.data);
}

/** POST /api/customers/:id/locations/:locId/archive — archive a service location. */
export function archiveServiceLocation(customerId: string, locationId: string) {
  return api
    .post(`/api/customers/${customerId}/locations/${locationId}/archive`)
    .then((r) => r.data);
}
