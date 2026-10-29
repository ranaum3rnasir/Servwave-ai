/**
 * The organization's own tax rates (R5c, port-plan §3.3; org-owned rewrite 2026-08-05).
 *
 * Every org holds its own copy of the national list plus any rate it has added by hand, and owns
 * all of them: rename, re-rate, hide or delete. This endpoint is the SETTINGS feed and returns
 * hidden rows too. The picker feed is GET /api/state-tax-rates, which returns only the rates
 * flagged visible, so every tax-rate picker (EstimateReceiptCard, StandaloneInvoiceFormPage,
 * InvoiceDetailPage) shows exactly what the admin chose with no change of its own.
 */
import api from '@/lib/axios';

export interface OrgTaxRate {
  id: string;
  name: string;
  rate: number | string;
  /** The state this row was seeded from; null for a rate the org added by hand. */
  state_code: string | null;
  /** Whether this rate appears in the estimate/invoice/job tax pickers. */
  is_visible: boolean;
  created_at: string;
  updated_at: string;
}

export function listOrgTaxRates() {
  return api.get('/api/org-tax-rates').then((r) => r.data.rates as OrgTaxRate[]);
}

export function createOrgTaxRate(body: { name: string; rate: number }) {
  return api.post('/api/org-tax-rates', body).then((r) => r.data.rate as OrgTaxRate);
}

export function updateOrgTaxRate(
  id: string,
  body: { name?: string; rate?: number; is_visible?: boolean },
) {
  return api.patch(`/api/org-tax-rates/${id}`, body).then((r) => r.data.rate as OrgTaxRate);
}

export function deleteOrgTaxRate(id: string) {
  return api.delete(`/api/org-tax-rates/${id}`);
}
