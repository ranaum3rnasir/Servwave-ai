/**
 * Minimal shape a couple of surviving components need from the fetched estimate (real backend
 * fields only). Originally declared in the now-retired `InfoPanel.tsx` (the pre-v12 three-way
 * split); relocated here since `CustomerHeader.tsx` and `EstimateWorkspacePage.tsx`'s
 * `RawEstimate` still extend it after InfoPanel's own removal (v12 review M7).
 */
/** Either job relation below - both carry the same three fields off the detail select. */
export interface EstimateJobRef {
  id: string;
  job_number: string;
  status?: string | null;
}

export interface PanelEstimate {
  id: string;
  estimate_number: string;
  // Editable record IDs (2026-08-19 plan) - RecordNumberEditor's `isDerivedAndLocked` prop:
  // true when this estimate's number was derived from a container parent (container_kind set)
  // AND has not been custom-edited yet (number_is_custom false). See estimate.controller.ts's
  // estimateDetailSelect for where these are selected.
  container_kind?: string | null;
  number_is_custom?: boolean;
  status: string;
  tax_rate: number;
  discount_type?: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discount_value?: number | null;
  discount_amount?: number | null;
  discount_name?: string | null;
  deposit_type?: 'PERCENTAGE' | 'FIXED' | null;
  deposit_value?: number | null;
  created_at: string;
  sent_at?: string | null;
  approved_at?: string | null;
  declined_at?: string | null;
  // SRVW-285 — why it was lost, and the customer's own words. Optional because only a DECLINED
  // estimate carries either, and a customer may skip both: the reason is deliberately optional
  // so that asking cannot cost us the decline itself.
  lost_reason?: string | null;
  lost_reason_note?: string | null;
  cancelled_at?: string | null;
  signature_data?: string | null;
  signature_at?: string | null;
  creator?: { id?: string; first_name: string; last_name: string } | null;
  send_config?: {
    deposit_required?: boolean | null;
    deposit_amount?: number | null;
    deposit_percentage?: number | null;
  } | null;
  invoices?: Array<{
    id: string;
    invoice_number: string;
    status: string;
    // Copy-to-Invoice: GET /api/estimates/:id now returns both kinds (previously DEPOSIT only).
    kind: 'DEPOSIT' | 'STANDARD';
    total_amount?: number | string | null;
    payments?: Array<{ method?: string | null; stripe_payment_intent_id?: string | null }>;
  }>;
  lead_id?: string | null;
  lead?: {
    id: string;
    /** Number + status - the hero's "Attached to" chip names the lead and shows where it stands. */
    lead_number?: string | null;
    status?: string | null;
    customer?: {
      first_name: string;
      last_name: string;
      company_name?: string | null;
      phone?: string | null;
      email?: string | null;
      billing_address_line1?: string | null;
      billing_address_line2?: string | null;
      billing_city?: string | null;
      billing_state?: string | null;
      billing_zip?: string | null;
    } | null;
    // `service_address_line1`/`2` - the Lead model's real column names (schema.prisma) and what
    // estimateDetailSelect returns. This was declared as `service_address_line` (no suffix), a
    // name the API never sends, so the header's service street line was always undefined.
    service_address_line1?: string | null;
    service_address_line2?: string | null;
    service_city?: string | null;
    service_state?: string | null;
    service_zip?: string | null;
  } | null;
  // Direct/denormalized fields the backend now returns for lead-less (customer-anchored) and
  // job-attached estimates. `customer` mirrors the nested `lead.customer` shape above and is the
  // fallback source for the header when there is no `lead`. `job_id` is the attach FK ("this
  // estimate is attached to a job", which locks tax to the job's service location) - distinct from
  // RawEstimate.job, which is provenance only.
  customer_id?: string | null;
  job_id?: string | null;
  /**
   * The two job relations, both real, both renderable in the hero's "Attached to" strip:
   * `job` is PROVENANCE (Job.estimate_id - a job created FROM this estimate) and `job_link` is
   * the ANCHOR (Estimate.job_id - this estimate was written against an existing job). An
   * estimate carries one or the other; they are not two views of the same row.
   */
  job?: EstimateJobRef | null;
  job_link?: EstimateJobRef | null;
  customer?: {
    first_name: string;
    last_name: string;
    company_name?: string | null;
    phone?: string | null;
    email?: string | null;
    billing_address_line1?: string | null;
    billing_address_line2?: string | null;
    billing_city?: string | null;
    billing_state?: string | null;
    billing_zip?: string | null;
  } | null;
  /**
   * Denormalized job-site address the backend already returns on the detail select. It is the
   * lead-less estimate's Service Location: with no `lead` to read `service_*` off, this is the
   * only source for the header's second column.
   */
  service_location?: {
    address_line1?: string | null;
    address_line2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  } | null;
}
