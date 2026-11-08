import { APIRequestContext, request } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const BASE = process.env.E2E_BACKEND_URL || 'http://localhost:3000';

/** Directory containing test asset files for attachment uploads */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const E2E_ORG_FILE = path.resolve(__dirname, '..', '.auth', 'e2e-org.json');

/**
 * Read the provisioned admin credentials written by global-setup
 * (`.auth/e2e-org.json`). The QA suite runs in a freshly provisioned throwaway org,
 * so the default login is that org's admin — NOT the hardcoded demo admin.
 */
export function provisionedAdmin(): { email: string; password: string; organizationId: string } {
  const raw = JSON.parse(fs.readFileSync(E2E_ORG_FILE, 'utf8'));
  return { email: raw.adminEmail, password: raw.adminPassword, organizationId: raw.organizationId };
}

export class ApiClient {
  private token: string = '';
  private ctx!: APIRequestContext;

  /**
   * Login and create a reusable request context. Credentials default to the
   * provisioned throwaway-org admin (`.auth/e2e-org.json`); pass explicit creds to
   * authenticate as a different user (e.g. a seeded SALES/TECH for scope tests).
   */
  async init(creds?: { email: string; password: string }) {
    const { email, password } = creds ?? provisionedAdmin();
    const loginCtx = await request.newContext({ baseURL: BASE });
    const res = await loginCtx.post('/api/auth/login', { data: { email, password } });
    const body = await res.json();
    if (!res.ok() || !body.session?.access_token) {
      throw new Error(`e2e login failed for ${email}: ${res.status()} ${JSON.stringify(body)}`);
    }
    this.token = body.session?.access_token;
    await loginCtx.dispose();

    // Create reusable context with auth header
    this.ctx = await request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${this.token}` },
    });
    return this;
  }

  async dispose() { await this.ctx.dispose(); }
  get authToken() { return this.token; }

  // ─── Generic escape hatch ─────────────────────────────
  /**
   * Hit ANY authenticated endpoint without adding a typed wrapper. Lets spec files
   * exercise endpoints that have no dedicated method (and avoids serializing edits to
   * this file across parallel spec authors). Returns the raw response + parsed body
   * (body is `{}` when the response has no JSON).
   *
   * @example const { res, body } = await api.raw('post', '/api/customers/'+id+'/archive', {});
   */
  async raw(
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    data?: any,
  ): Promise<{ res: import('@playwright/test').APIResponse; body: any }> {
    const opts = data !== undefined ? { data } : undefined;
    const res = await this.ctx[method](path, opts as any);
    const body = await res.json().catch(() => ({}));
    return { res, body };
  }

  /**
   * Probe a raw FK-protected delete via the boot-guarded test door
   * (`POST /api/test/raw-delete-probe`). Used by §8/§10 rows to prove the DB-level
   * RESTRICT FK blocks orphaning money rows.
   */
  async rawDeleteProbe(model: string, id: string) {
    const res = await this.ctx.post('/api/test/raw-delete-probe', { data: { model, id } });
    return { res, body: await res.json().catch(() => ({})) };
  }

  // ─── Customers ─────────────────────────────
  /**
   * Create a customer. The param is intentionally wide (`Record<string, any>`) so the
   * full §3 customer surface — kind, segment, phones[], extra_emails[], billing_*,
   * tax_exempt, parent_id, bill_to_customer_id, ad_source, etc. — passes straight through
   * to `createCustomerSchema` without editing this client per spec.
   */
  async createCustomer(data: Record<string, any>) {
    // kind/segment are optional in Zod but REQUIRED (NOT NULL) in Prisma — omitting
    // them passes validation then 500s. Default them so a bare createCustomer always
    // succeeds; explicit kind/segment (e.g. COMPANY/COMMERCIAL) still override.
    const res = await this.ctx.post('/api/customers', { data: { kind: 'PERSON', segment: 'RESIDENTIAL', ...data } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok() || !body.customer) {
      throw new Error(`createCustomer failed: ${res.status()} ${body.error ?? JSON.stringify(body)}`);
    }
    return body.customer;
  }

  async getCustomer(id: string) {
    const res = await this.ctx.get(`/api/customers/${id}`);
    return (await res.json()).customer;
  }

  /** PATCH a customer, surfacing the raw response for 4xx-guard assertions. */
  async updateCustomerRaw(id: string, data: Record<string, any>) {
    const res = await this.ctx.patch(`/api/customers/${id}`, { data });
    return { res, body: await res.json().catch(() => ({})) };
  }

  async addLocation(customerId: string, data: Record<string, any>) {
    const res = await this.ctx.post(`/api/customers/${customerId}/locations`, { data });
    const body = await res.json().catch(() => ({}));
    if (!res.ok() || !body.location) {
      throw new Error(`addLocation failed: ${res.status()} ${body.error ?? JSON.stringify(body)}`);
    }
    return body.location;
  }

  /** PATCH a service location (route param is :locId), raw response surfaced. */
  async updateLocationRaw(customerId: string, locationId: string, data: Record<string, any>) {
    const res = await this.ctx.patch(`/api/customers/${customerId}/locations/${locationId}`, { data });
    return { res, body: await res.json().catch(() => ({})) };
  }

  // Entity-redesign §10 — customer lifecycle.
  async archiveCustomer(id: string) {
    const res = await this.ctx.post(`/api/customers/${id}/archive`, { data: {} });
    return { res, body: await res.json() };
  }

  async unarchiveCustomer(id: string) {
    const res = await this.ctx.post(`/api/customers/${id}/unarchive`, { data: {} });
    return { res, body: await res.json() };
  }

  /** Force-purge (admin, money-gated, type-to-confirm). */
  async purgeCustomer(id: string, data?: Record<string, any>) {
    const res = await this.ctx.post(`/api/customers/${id}/purge`, { data: data || {} });
    return { res, body: await res.json() };
  }

  async anonymizeCustomer(id: string, data?: Record<string, any>) {
    const res = await this.ctx.post(`/api/customers/${id}/anonymize`, { data: data || {} });
    return { res, body: await res.json() };
  }

  // ─── Leads ─────────────────────────────────
  async createLead(data: { customer_id: string; service_request: string; [key: string]: any }) {
    const res = await this.ctx.post('/api/leads', { data });
    return { res, body: await res.json() };
  }

  async getLead(id: string) {
    const res = await this.ctx.get(`/api/leads/${id}`);
    return (await res.json()).lead;
  }

  /** Entity-redesign §10 — delete a lead (only when it has no estimate). */
  async deleteLead(id: string) {
    const res = await this.ctx.delete(`/api/leads/${id}`);
    return { res, status: res.status() };
  }

  async updateLead(id: string, data: Record<string, any>) {
    const res = await this.ctx.patch(`/api/leads/${id}`, { data });
    return { res, body: await res.json() };
  }

  async contactLead(id: string, contacted_at?: string, contacted_note?: string) {
    const res = await this.ctx.post(`/api/leads/${id}/contact`, {
      data: { contacted_at: contacted_at || new Date().toISOString(), contacted_note },
    });
    return { res, body: await res.json() };
  }

  async scheduleWalkthrough(id: string, data: {
    walkthrough_scheduled_at: string; performer_ids: string[];
    walkthrough_duration_minutes?: number; send_email?: boolean; force?: boolean;
  }) {
    const res = await this.ctx.post(`/api/leads/${id}/walkthrough/schedule`, {
      data: { send_email: false, force: true, walkthrough_duration_minutes: 60, ...data },
    });
    return { res, body: await res.json() };
  }

  async completeWalkthrough(id: string) {
    const res = await this.ctx.post(`/api/leads/${id}/walkthrough/complete`, { data: {} });
    return { res, body: await res.json() };
  }

  async cancelWalkthrough(id: string, reason: string) {
    const res = await this.ctx.post(`/api/leads/${id}/walkthrough/cancel`, {
      data: { cancelled_reason: reason },
    });
    return { res, body: await res.json() };
  }

  async updateWalkthroughNotes(id: string, data: Record<string, any>) {
    const res = await this.ctx.post(`/api/leads/${id}/walkthrough`, { data });
    return { res, body: await res.json() };
  }

  async assignLead(id: string, assigned_to: string) {
    const res = await this.ctx.post(`/api/leads/${id}/assign`, { data: { assigned_to } });
    return { res, body: await res.json() };
  }

  async markLeadLost(id: string, reason: string) {
    const res = await this.ctx.post(`/api/leads/${id}/mark-lost`, {
      data: { lost_reason: reason },
    });
    return { res, body: await res.json() };
  }

  async cancelLead(id: string, reason: string) {
    const res = await this.ctx.post(`/api/leads/${id}/cancel`, {
      data: { cancelled_reason: reason },
    });
    return { res, body: await res.json() };
  }

  async getLeadNotes(id: string) {
    const res = await this.ctx.get(`/api/leads/${id}/notes`);
    return (await res.json());
  }

  async addLeadNote(id: string, content: string) {
    const res = await this.ctx.post(`/api/leads/${id}/notes`, { data: { content } });
    return { res, body: await res.json() };
  }

  async getLeadStats() {
    const res = await this.ctx.get('/api/leads/stats');
    return (await res.json());
  }

  async listLeads(params?: Record<string, string>) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const res = await this.ctx.get(`/api/leads${qs}`);
    return { res, body: await res.json() };
  }

  // ─── Estimates ─────────────────────────────
  async createEstimate(data: {
    lead_id: string; line_items: Array<{
      description: string; quantity: number; unit_price: number; is_taxable?: boolean;
    }>; scope_notes?: string; tax_rate?: number; [key: string]: any;
  }) {
    const res = await this.ctx.post('/api/estimates', { data });
    return { res, body: await res.json() };
  }

  async getEstimate(id: string) {
    const res = await this.ctx.get(`/api/estimates/${id}`);
    return (await res.json()).estimate;
  }

  async updateEstimate(id: string, data: Record<string, any>) {
    const res = await this.ctx.patch(`/api/estimates/${id}`, { data });
    return { res, body: await res.json() };
  }

  async deleteEstimate(id: string) {
    const res = await this.ctx.delete(`/api/estimates/${id}`);
    return { res, status: res.status() };
  }

  /**
   * Send an estimate. The send schema accepts ONLY `deposit_required`, `payment_methods`,
   * `message_body`, `cc_emails` — the deposit PERCENTAGE is NOT a send-body field; the
   * backend derives it from the org AppSetting `deposit_percentage` (default 50%). The
   * param is widened to `Record<string, any>` so callers can pass extra fields (e.g. a
   * `deposit_percentage` hint) without a type error; the server silently ignores unknown keys.
   */
  async sendEstimate(id: string, data: Record<string, any>) {
    const res = await this.ctx.post(`/api/estimates/${id}/send`, { data });
    return { res, body: await res.json() };
  }

  async cancelEstimate(id: string, reason: string) {
    const res = await this.ctx.post(`/api/estimates/${id}/cancel`, {
      data: { cancelled_reason: reason },
    });
    return { res, body: await res.json() };
  }

  async duplicateEstimate(id: string, data?: { target_lead_id?: string }) {
    const res = await this.ctx.post(`/api/estimates/${id}/duplicate`, { data: data || {} });
    return { res, body: await res.json() };
  }

  /** Entity-redesign §10 — Revise: SENT → DRAFT (invalidates the public link). */
  async reviseEstimate(id: string) {
    const res = await this.ctx.post(`/api/estimates/${id}/revise`, { data: {} });
    return { res, body: await res.json() };
  }

  async addEstimateNote(id: string, content: string) {
    const res = await this.ctx.post(`/api/estimates/${id}/notes`, { data: { content } });
    return { res, body: await res.json() };
  }

  async getEstimateNotes(id: string) {
    const res = await this.ctx.get(`/api/estimates/${id}/notes`);
    return (await res.json());
  }

  async listEstimates(params?: Record<string, string>) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const res = await this.ctx.get(`/api/estimates${qs}`);
    return { res, body: await res.json() };
  }

  async getEstimateStats() {
    const res = await this.ctx.get('/api/estimates/stats');
    return (await res.json());
  }

  async listEstimateCreators() {
    const res = await this.ctx.get('/api/estimates/creators');
    return (await res.json());
  }

  // ─── Public Estimate (no auth) ─────────────
  async getPublicEstimate(id: string, token: string) {
    const noAuthCtx = await request.newContext({ baseURL: BASE });
    const res = await noAuthCtx.get(`/api/estimates/${id}/public?token=${token}`);
    const body = await res.json();
    await noAuthCtx.dispose();
    return { res, body };
  }

  async approveEstimatePublic(id: string, token: string, data: {
    signature_data: string; payment_method?: string; terms_accepted?: boolean;
  }) {
    const noAuthCtx = await request.newContext({ baseURL: BASE });
    // #21 T&C gate: the real public-approval page requires accepting terms, so default
    // terms_accepted:true here — every success-path approval chain depends on it (the org seeds
    // non-empty estimate_terms → snapshot_terms → the controller 400s without acceptance). A caller
    // that explicitly passes terms_accepted (e.g. SEL-31's negative case = false) overrides this.
    const res = await noAuthCtx.post(`/api/estimates/${id}/approve?token=${token}`, { data: { terms_accepted: true, ...data } });
    const body = await res.json();
    await noAuthCtx.dispose();
    return { res, body };
  }

  async declineEstimatePublic(id: string, token: string) {
    const noAuthCtx = await request.newContext({ baseURL: BASE });
    const res = await noAuthCtx.post(`/api/estimates/${id}/decline?token=${token}`, { data: {} });
    const body = await res.json();
    await noAuthCtx.dispose();
    return { res, body };
  }

  async changePaymentMethodPublic(id: string, token: string, payment_method: string) {
    const noAuthCtx = await request.newContext({ baseURL: BASE });
    const res = await noAuthCtx.post(`/api/estimates/${id}/change-payment-method?token=${token}`, {
      data: { payment_method },
    });
    const body = await res.json();
    await noAuthCtx.dispose();
    return { res, body };
  }

  // ─── Deposit Management ────────────────────
  // Entity-redesign Phase 5/D: the legacy Deposit model is gone. The deposit is now a
  // kind=DEPOSIT Invoice exposed at estimate.invoices[0]. Read deposit state via that
  // invoice; record payment via /record-payment; refund via the unified invoice refund.

  /** The kind=DEPOSIT invoice for an estimate (estimate.invoices[0]), or undefined. */
  async getDepositInvoice(estimateId: string) {
    const estimate = await this.getEstimate(estimateId);
    return estimate?.invoices?.[0];
  }

  /**
   * Record the deposit payment. Replaces the removed /mark-deposit-received.
   * Sets the kind=DEPOSIT invoice → PAID, estimate → APPROVED, lead → WON.
   * `amount` defaults to the deposit invoice total (or send_config.deposit_amount).
   */
  async markDepositReceived(estimateId: string, data?: {
    amount?: number; payment_method?: string; reference_number?: string; notes?: string;
  }) {
    let amount = data?.amount;
    if (amount === undefined) {
      const estimate = await this.getEstimate(estimateId);
      amount = Number(
        estimate?.invoices?.[0]?.total_amount
        ?? estimate?.send_config?.deposit_amount
        ?? 0,
      );
    }
    const res = await this.ctx.post(`/api/estimates/${estimateId}/record-payment`, {
      data: {
        amount,
        payment_method: data?.payment_method ?? 'CHECK',
        ...(data?.reference_number ? { reference_number: data.reference_number } : {}),
        ...(data?.notes ? { notes: data.notes } : {}),
      },
    });
    return { res, body: await res.json() };
  }

  async waiveDeposit(estimateId: string, action: 'waive' | 'cancel') {
    const res = await this.ctx.post(`/api/estimates/${estimateId}/waive-deposit`, {
      data: { action },
    });
    return { res, body: await res.json() };
  }

  /**
   * Refund the deposit. The deposit refund is now the unified Invoice refund
   * (POST /api/invoices/:id/refund) on the estimate's kind=DEPOSIT invoice —
   * the routes POST /api/estimates/:id/refund-deposit and /reactivate-deposit
   * were removed in entity-redesign Phase 5.
   *
   * reason_category MUST be one of CUSTOMER_REQUEST|ERROR|GOODWILL|OVERPAYMENT|CHARGEBACK|OTHER.
   * The legacy 'CUSTOMER_CANCELLATION' is mapped to 'CUSTOMER_REQUEST'.
   */
  async refundDepositInvoice(estimateId: string, data: {
    amount?: number; reason: string; reason_category?: string;
  }) {
    const depInv = await this.getDepositInvoice(estimateId);
    const category = this.normalizeRefundCategory(data.reason_category);
    const res = await this.ctx.post(`/api/invoices/${depInv.id}/refund`, {
      data: {
        ...(data.amount !== undefined ? { amount: data.amount } : {}),
        reason: data.reason,
        reason_category: category,
      },
    });
    return { res, body: await res.json(), depositInvoiceId: depInv.id };
  }

  /** Thin alias kept to minimize spec churn — delegates to refundDepositInvoice. */
  async refundDeposit(estimateId: string, data: { reason: string; reason_category?: string; amount?: number }) {
    return this.refundDepositInvoice(estimateId, data);
  }

  // reactivate-deposit removed in entity-redesign Phase 5 — there is NO in-place reactivate.
  // The deposit invoice is voided/reissued via send/revise, not reactivated; callers were
  // converted to the nearest equivalent (waive→revise→re-send→approve) or removed.

  /** Map legacy/lower-case refund categories onto the new upper-case enum. */
  private normalizeRefundCategory(c?: string): string {
    const valid = ['CUSTOMER_REQUEST', 'ERROR', 'GOODWILL', 'OVERPAYMENT', 'CHARGEBACK', 'OTHER'];
    if (!c) return 'CUSTOMER_REQUEST';
    const up = c.toUpperCase();
    if (up === 'CUSTOMER_CANCELLATION') return 'CUSTOMER_REQUEST';
    return valid.includes(up) ? up : 'CUSTOMER_REQUEST';
  }

  // ─── Invoice money model (entity-redesign §8) ──────────
  /** Generalized refund on any invoice (partial/multiple/per-payment). */
  async refundInvoice(invoiceId: string, data: {
    amount?: number; payment_id?: string; method?: string; reference_number?: string;
    non_taxable_concession?: boolean; reason: string; reason_category: string;
  }) {
    const res = await this.ctx.post(`/api/invoices/${invoiceId}/refund`, {
      data: { ...data, reason_category: this.normalizeRefundCategory(data.reason_category) },
    });
    return { res, body: await res.json() };
  }

  /** Credit-first give-back (credit, optionally refund_instead for cash). */
  async creditInvoice(invoiceId: string, data: {
    amount: number; reason: string; category?: string; refund_instead?: boolean;
    method?: string; non_taxable_concession?: boolean;
  }) {
    const res = await this.ctx.post(`/api/invoices/${invoiceId}/credit`, { data });
    return { res, body: await res.json() };
  }

  /** Void a recorded payment (e.g. bounced check) — reopens amount_due. */
  async voidPayment(invoiceId: string, data: {
    payment_id: string; void_category: 'BOUNCED' | 'ERROR' | 'DUPLICATE' | 'WRONG_INVOICE'; reason: string;
  }) {
    const res = await this.ctx.post(`/api/invoices/${invoiceId}/void-payment`, { data });
    return { res, body: await res.json() };
  }

  // ─── Statements (entity-redesign §9) ───────────────────
  async getJobStatement(jobId: string) {
    const res = await this.ctx.get(`/api/statements/job/${jobId}`);
    return { res, body: await res.json() };
  }

  async getCustomerStatement(customerId: string) {
    const res = await this.ctx.get(`/api/statements/customer/${customerId}`);
    return { res, body: await res.json() };
  }

  // ─── Jobs ──────────────────────────────────
  async createJob(data: Record<string, any>) {
    const res = await this.ctx.post('/api/jobs', { data });
    return { res, body: await res.json() };
  }

  async getJob(id: string) {
    const res = await this.ctx.get(`/api/jobs/${id}`);
    return (await res.json()).job;
  }

  async updateJob(id: string, data: Record<string, any>) {
    const res = await this.ctx.patch(`/api/jobs/${id}`, { data });
    return { res, body: await res.json() };
  }

  async deleteJob(id: string) {
    const res = await this.ctx.delete(`/api/jobs/${id}`);
    return { res, status: res.status() };
  }

  async assignJob(jobId: string, data: {
    assignee_ids: string[]; scheduled_start?: string; scheduled_end?: string;
    is_all_day?: boolean; force?: boolean;
  }) {
    const res = await this.ctx.post(`/api/jobs/${jobId}/assign`, { data });
    return { res, body: await res.json() };
  }

  async unassignJob(id: string) {
    const res = await this.ctx.post(`/api/jobs/${id}/unassign`);
    return { res, body: await res.json() };
  }

  async startJob(id: string) {
    const res = await this.ctx.post(`/api/jobs/${id}/start`);
    return { res, body: await res.json() };
  }

  async completeJob(id: string, notes: string) {
    const res = await this.ctx.post(`/api/jobs/${id}/complete`, {
      data: { completion_notes: notes },
    });
    return { res, body: await res.json() };
  }

  async cancelJob(id: string, reason: string) {
    const res = await this.ctx.post(`/api/jobs/${id}/cancel`, {
      data: { cancelled_reason: reason },
    });
    return { res, body: await res.json() };
  }

  // JobCharge retired in entity-redesign Phase D — the Invoice owns line items now.
  // The /api/jobs/:id/charges routes (add/update/remove/getCharges) were removed.
  // Line items are snapshotted from the estimate onto the first STANDARD invoice; for
  // no-estimate jobs the invoice starts empty and lines are added on the invoice itself.

  /** Entity-redesign §10 — Reopen a COMPLETED job → IN_PROGRESS (ADMIN). */
  async reopenJob(id: string) {
    const res = await this.ctx.post(`/api/jobs/${id}/reopen`, { data: {} });
    return { res, body: await res.json() };
  }

  async addJobNote(id: string, content: string) {
    const res = await this.ctx.post(`/api/jobs/${id}/notes`, { data: { content } });
    return { res, body: await res.json() };
  }

  async getJobNotes(id: string) {
    const res = await this.ctx.get(`/api/jobs/${id}/notes`);
    return (await res.json());
  }

  async getJobTimeline(id: string) {
    const res = await this.ctx.get(`/api/jobs/${id}/timeline`);
    return (await res.json());
  }

  async createJobWalkthrough(jobId: string, notes: string) {
    const res = await this.ctx.post(`/api/jobs/${jobId}/walkthrough`, {
      data: { walkthrough_notes: notes },
    });
    return { res, body: await res.json() };
  }

  async listJobs(params?: Record<string, string>) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const res = await this.ctx.get(`/api/jobs${qs}`);
    return { res, body: await res.json() };
  }

  async getJobStats() {
    const res = await this.ctx.get('/api/jobs/stats');
    return (await res.json());
  }

  // ─── Invoices ─────────────────────────────
  async createInvoice(jobId: string) {
    const res = await this.ctx.post('/api/invoices', { data: { job_id: jobId } });
    return { res, body: await res.json() };
  }

  async getInvoice(id: string) {
    const res = await this.ctx.get(`/api/invoices/${id}`);
    return (await res.json()).invoice;
  }

  async listInvoices(params?: Record<string, string>) {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    const res = await this.ctx.get(`/api/invoices${qs}`);
    return { res, body: await res.json() };
  }

  async updateInvoice(id: string, data: Record<string, any>) {
    const res = await this.ctx.patch(`/api/invoices/${id}`, { data });
    return { res, body: await res.json() };
  }

  async deleteInvoice(id: string) {
    const res = await this.ctx.delete(`/api/invoices/${id}`);
    return { res, status: res.status() };
  }

  async sendInvoice(id: string) {
    const res = await this.ctx.post(`/api/invoices/${id}/send`, { data: {} });
    return { res, body: await res.json() };
  }

  async voidInvoice(id: string, reason: string) {
    const res = await this.ctx.post(`/api/invoices/${id}/void`, {
      data: { voided_reason: reason },
    });
    return { res, body: await res.json() };
  }

  async recordPayment(invoiceId: string, data: {
    amount: number; method: string; paid_at?: string;
    reference_number?: string; notes?: string;
  }) {
    const res = await this.ctx.post(`/api/invoices/${invoiceId}/payments`, { data });
    return { res, body: await res.json() };
  }

  async addInvoiceNote(id: string, content: string) {
    const res = await this.ctx.post(`/api/invoices/${id}/notes`, { data: { content } });
    return { res, body: await res.json() };
  }

  async getInvoiceNotes(id: string) {
    const res = await this.ctx.get(`/api/invoices/${id}/notes`);
    return (await res.json());
  }

  // ─── Public Invoice (no auth) ─────────────
  async getPublicInvoice(id: string, token: string) {
    const noAuthCtx = await request.newContext({ baseURL: BASE });
    const res = await noAuthCtx.get(`/api/invoices/${id}/public?token=${token}`);
    const body = await res.json();
    await noAuthCtx.dispose();
    return { res, body };
  }

  async createInvoiceCheckout(id: string, token: string) {
    const noAuthCtx = await request.newContext({ baseURL: BASE });
    const res = await noAuthCtx.post(`/api/invoices/${id}/public/checkout?token=${token}`, { data: {} });
    const body = await res.json();
    await noAuthCtx.dispose();
    return { res, body };
  }

  // ─── Stripe Invoice Webhook (simulated) ───
  async fireStripeInvoiceWebhook(data: {
    invoiceId: string; amount_total: number; payment_intent?: string;
  }) {
    const eventId = `evt_test_${Date.now()}`;
    const noAuthCtx = await request.newContext({ baseURL: BASE });
    const res = await noAuthCtx.post('/api/webhooks/stripe', {
      headers: { 'stripe-signature': 'test_bypass', 'content-type': 'application/json' },
      data: JSON.stringify({
        id: eventId,
        type: 'checkout.session.completed',
        data: {
          object: {
            metadata: { invoiceId: data.invoiceId },
            amount_total: data.amount_total,
            payment_intent: data.payment_intent || `pi_test_${Date.now()}`,
          },
        },
      }),
    });
    const body = await res.json();
    await noAuthCtx.dispose();
    return { res, body, eventId };
  }

  // ─── Stripe test door (§3.5) — replays Stripe-shaped events through the REAL money code ───
  // Unlike fireStripeInvoiceWebhook (which hits the signature-guarded real route and mints a
  // fresh event.id every call), these hit the boot-guarded /api/test/stripe-webhook door and
  // accept a CALLER-SUPPLIED event.id so idempotency-replay rows can reuse the same id.

  /** POST a fully-formed event to the boot-guarded test door. eventId is caller-supplied. */
  async fireStripeEvent(event: { id: string; type: string; account?: string; data: { object: any } }) {
    const ctx = await request.newContext({ baseURL: BASE });
    const res = await ctx.post('/api/test/stripe-webhook', {
      headers: { 'content-type': 'application/json' },
      data: event,
    });
    const body = await res.json().catch(() => ({}));
    await ctx.dispose();
    return { res, body };
  }

  /** checkout.session.completed for a deposit/standard invoice (amountCents = amount_due, face value). */
  depositPaidEvent(invoiceId: string, amountCents: number, opts: { eventId: string; paymentIntent?: string }) {
    return {
      id: opts.eventId, type: 'checkout.session.completed' as const,
      data: { object: { metadata: { invoiceId }, amount_total: amountCents, payment_intent: opts.paymentIntent ?? `pi_${opts.eventId}` } },
    };
  }

  /** charge.refunded — needs a seeded PI on the target Payment (resolveOrgFromEvent path). */
  chargeRefundedEvent(opts: { eventId: string; paymentIntent: string; amountRefundedCents: number; stripeRefundId?: string; source?: 'in_app' | 'dashboard' }) {
    return {
      id: opts.eventId, type: 'charge.refunded' as const,
      data: { object: { payment_intent: opts.paymentIntent, amount_refunded: opts.amountRefundedCents,
        refunds: { data: [{ id: opts.stripeRefundId ?? `re_${opts.eventId}`, metadata: { source: opts.source ?? 'dashboard' } }] } } },
    };
  }

  disputeCreatedEvent(opts: { eventId: string; disputeId: string; paymentIntent: string; account?: string }) {
    return { id: opts.eventId, type: 'charge.dispute.created' as const, account: opts.account,
      data: { object: { id: opts.disputeId, payment_intent: opts.paymentIntent } } };
  }

  disputeClosedEvent(opts: { eventId: string; disputeId: string; paymentIntent: string; status: 'won' | 'lost'; account?: string }) {
    return { id: opts.eventId, type: 'charge.dispute.closed' as const, account: opts.account,
      data: { object: { id: opts.disputeId, payment_intent: opts.paymentIntent, status: opts.status } } };
  }

  /** Helper: cents for amount_due (face value; card is charged the invoice amount). */
  checkoutCents(amountDue: number): number {
    return Math.round(amountDue * 100);
  }

  /** Seed a fake Stripe PI on a Payment so refund/dispute events resolve (§3.5). Test door. */
  async seedPaymentIntent(invoiceId: string, paymentIntent: string) {
    const res = await this.ctx.post('/api/test/seed-payment-intent', { data: { invoiceId, paymentIntent } });
    return { res, body: await res.json().catch(() => ({})) };
  }

  // ─── Attachments ───────────────────────────
  async uploadAttachment(
    entityType: 'LEAD' | 'ESTIMATE' | 'JOB' | 'INVOICE',
    entityId: string,
    data: { file: string; display_name: string; description: string; context?: string },
  ) {
    const filePath = path.join(FIXTURES_DIR, data.file);
    const buffer = fs.readFileSync(filePath);
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.pdf': 'application/pdf',
    };
    const ext = path.extname(data.file).toLowerCase();
    const res = await this.ctx.post(
      `/api/attachments/${entityType}/${entityId}`,
      {
        multipart: {
          file: { name: data.file, mimeType: mimeMap[ext] || 'application/octet-stream', buffer },
          display_name: data.display_name,
          description: data.description,
          context: data.context || 'OTHER',
        },
      },
    );
    return { res, body: await res.json() };
  }

  async listAttachments(entityType: string, entityId: string) {
    const res = await this.ctx.get(`/api/attachments/${entityType}/${entityId}`);
    return { res, body: await res.json() };
  }

  async deleteAttachment(entityType: string, entityId: string, attachmentId: string) {
    const res = await this.ctx.delete(`/api/attachments/${entityType}/${entityId}/${attachmentId}`);
    return { res, status: res.status() };
  }

  // ─── Users ─────────────────────────────────
  async createUser(data: {
    email: string; password: string; first_name: string; last_name: string; role: string;
  }) {
    const res = await this.ctx.post('/api/users', { data });
    return { res, body: await res.json() };
  }

  async updateUser(id: string, data: Record<string, any>) {
    const res = await this.ctx.patch(`/api/users/${id}`, { data });
    return { res, body: await res.json() };
  }

  async listLeadAssignees() {
    const res = await this.ctx.get('/api/leads/assignees');
    return (await res.json());
  }

  // ─── Test-only endpoints ───────────────────
  async triggerExpireEstimates() {
    const res = await this.ctx.post('/api/test/expire-estimates');
    return { res, body: await res.json() };
  }

  async backdateEstimate(id: string, daysAgo: number = 1) {
    const res = await this.ctx.patch(`/api/test/backdate-estimate/${id}`, {
      data: { days_ago: daysAgo },
    });
    return { res, body: await res.json() };
  }

  /** Delete all E2E test data (customers @e2e.local + cascading entities + test users). */
  async cleanup() {
    const res = await this.ctx.post('/api/test/cleanup');
    return { res, body: await res.json() };
  }

  // ─── Helpers ───────────────────────────────
  /** Valid base64 signature for tests */
  get testSignature() {
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }

  /** Generate unique suffix for test data */
  get suffix() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

  /** Future datetime string (hours from now) */
  futureDate(hoursFromNow: number) {
    return new Date(Date.now() + hoursFromNow * 3600000).toISOString();
  }

  /** Past datetime string */
  pastDate(hoursAgo: number) {
    return new Date(Date.now() - hoursAgo * 3600000).toISOString();
  }
}
