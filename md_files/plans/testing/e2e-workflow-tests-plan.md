# E2E Workflow Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a comprehensive API-level E2E test suite (314 scenarios) that tests every workflow path from Lead creation through Job Scheduled, hitting the real backend + real database.

**Architecture:** API-level integration tests using Playwright's test runner with `request` context (no browser). A shared `ApiClient` class wraps all API endpoints. Composable `WorkflowBuilder` functions chain calls for common paths (e.g., lead-to-estimate, estimate-to-job). Each test is self-contained — creates its own data, asserts outcomes, no inter-test dependencies. Tests run sequentially against real Supabase DB.

**Tech Stack:** Playwright Test, TypeScript, HTTP API calls (no browser), Supabase (real DB)

**Scenario spec:** `md_files/plans/testing/workflow-test-scenarios.md` (314 scenarios across 22 sections)

---

## File Structure

```
frontend/e2e/
├── playwright.api.config.ts          # NEW — API-only config (no browser, no frontend webServer)
├── global-setup.ts                   # EXISTING — reuse for auth token
├── helpers/
│   ├── api-client.ts                 # NEW — typed ApiClient class wrapping all endpoints
│   ├── workflow-builders.ts          # NEW — composable chains (leadToEstimate, fullStandardFlow, etc.)
│   ├── db-cleanup.ts                 # NEW — wipe test data before suite
│   ├── api-helpers.ts               # EXISTING — keep, ApiClient will supersede for new tests
│   └── test-data.ts                 # EXISTING — keep for browser tests
├── specs/
│   ├── workflow/                     # NEW — all API workflow tests
│   │   ├── 01-lead-lifecycle.spec.ts
│   │   ├── 02-estimate-crud.spec.ts
│   │   ├── 03-estimate-send.spec.ts
│   │   ├── 04-public-approval.spec.ts
│   │   ├── 05-deposit-non-stripe.spec.ts
│   │   ├── 06-deposit-stripe.spec.ts
│   │   ├── 07-deposit-management.spec.ts
│   │   ├── 08-decline-cancel-expire.spec.ts
│   │   ├── 09-job-creation.spec.ts
│   │   ├── 10-job-assignment.spec.ts
│   │   ├── 11-job-transitions.spec.ts
│   │   ├── 12-job-extras.spec.ts        # notes, timeline, walkthrough, charges
│   │   ├── 13-e2e-standard-flows.spec.ts
│   │   ├── 14-e2e-deposit-flows.spec.ts
│   │   ├── 15-e2e-cancellation-flows.spec.ts
│   │   ├── 16-e2e-edge-cases.spec.ts
│   │   ├── 17-guard-tests.spec.ts
│   │   └── 18-read-filters-stats.spec.ts
│   └── ... (existing browser specs unchanged)
└── ...
```

**Backend change:**
```
backend/src/
├── controllers/
│   └── webhook.controller.ts         # MODIFY — add NODE_ENV=test bypass for signature verification
└── config/
    └── env.ts                        # CHECK — ensure NODE_ENV is available
```

---

## Task 1: API Test Infrastructure

**Files:**
- Create: `frontend/e2e/playwright.api.config.ts`
- Create: `frontend/e2e/helpers/api-client.ts`
- Create: `frontend/e2e/helpers/db-cleanup.ts`

### playwright.api.config.ts

A separate Playwright config for API-only tests:

- [ ] **Step 1: Create the API config**

```typescript
import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './specs/workflow',
  timeout: 15_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report-api' }]],
  outputDir: './test-results-api',

  use: {
    baseURL: 'http://localhost:3000',  // Direct to backend, no frontend needed
  },

  // Only need the backend server
  webServer: {
    command: 'npm run dev',
    cwd: path.resolve(ROOT, '..', 'backend'),
    port: 3000,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
```

Key differences from browser config:
- `baseURL` points to backend directly (port 3000)
- Only backend webServer (no frontend needed)
- `testDir` points to `specs/workflow/`
- No storageState (tests get their own token)

### api-client.ts

A typed class that wraps every API endpoint. Holds the auth token and provides methods for all operations.

- [ ] **Step 2: Create ApiClient class**

```typescript
import { APIRequestContext, request } from '@playwright/test';

const BASE = 'http://localhost:3000';

export class ApiClient {
  private token: string = '';
  private ctx!: APIRequestContext;

  /** Login and create a reusable request context */
  async init() {
    // Login as admin
    const loginCtx = await request.newContext({ baseURL: BASE });
    const res = await loginCtx.post('/api/auth/login', {
      data: { email: 'admin@alphacrm.com', password: 'Admin123!@#' },
    });
    const body = await res.json();
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

  // ─── Customers ─────────────────────────────
  async createCustomer(data: {
    first_name: string; last_name: string; email: string; phone: string;
  }) {
    const res = await this.ctx.post('/api/customers', { data });
    return (await res.json()).customer;
  }

  async addLocation(customerId: string, data: {
    address_line1: string; city: string; state: string; zip: string; is_primary?: boolean;
  }) {
    const res = await this.ctx.post(`/api/customers/${customerId}/locations`, { data });
    return (await res.json()).location;
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
    walkthrough_scheduled_at: string; walkthrough_assigned_to: string;
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
    const res = await this.ctx.put(`/api/estimates/${id}`, { data });
    return { res, body: await res.json() };
  }

  async deleteEstimate(id: string) {
    const res = await this.ctx.delete(`/api/estimates/${id}`);
    return { res, status: res.status() };
  }

  async sendEstimate(id: string, data: {
    deposit_required: boolean; payment_methods?: string[];
    message_body?: string;
  }) {
    const res = await this.ctx.post(`/api/estimates/${id}/send`, { data });
    return { res, body: await res.json() };
  }

  async cancelEstimate(id: string, reason: string) {
    const res = await this.ctx.post(`/api/estimates/${id}/cancel`, {
      data: { cancelled_reason: reason },
    });
    return { res, body: await res.json() };
  }

  async duplicateEstimate(id: string) {
    const res = await this.ctx.post(`/api/estimates/${id}/duplicate`);
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
    signature_data: string; payment_method?: string;
  }) {
    const noAuthCtx = await request.newContext({ baseURL: BASE });
    const res = await noAuthCtx.post(`/api/estimates/${id}/public/approve?token=${token}`, { data });
    const body = await res.json();
    await noAuthCtx.dispose();
    return { res, body };
  }

  async declineEstimatePublic(id: string, token: string) {
    const noAuthCtx = await request.newContext({ baseURL: BASE });
    const res = await noAuthCtx.post(`/api/estimates/${id}/public/decline?token=${token}`, { data: {} });
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
  async markDepositReceived(estimateId: string, data?: {
    received_date?: string; reference_number?: string; notes?: string;
  }) {
    const res = await this.ctx.post(`/api/estimates/${estimateId}/mark-deposit-received`, {
      data: data || {},
    });
    return { res, body: await res.json() };
  }

  async waiveDeposit(estimateId: string, action: 'waive' | 'cancel') {
    const res = await this.ctx.post(`/api/estimates/${estimateId}/waive-deposit`, {
      data: { action },
    });
    return { res, body: await res.json() };
  }

  async refundDeposit(estimateId: string, data: {
    reason: string; reason_category: string;
  }) {
    const res = await this.ctx.post(`/api/estimates/${estimateId}/refund-deposit`, { data });
    return { res, body: await res.json() };
  }

  async reactivateDeposit(estimateId: string) {
    const res = await this.ctx.post(`/api/estimates/${estimateId}/reactivate-deposit`);
    return { res, body: await res.json() };
  }

  // ─── Stripe Webhook (simulated) ────────────
  async fireStripeWebhook(data: {
    depositId: string; estimateId: string;
    amount_total: number; payment_intent?: string;
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
            metadata: { depositId: data.depositId, estimateId: data.estimateId },
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
    assigned_to: string; scheduled_start?: string; scheduled_end?: string;
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

  async addCharge(jobId: string, data: {
    description: string; quantity: number; unit_price: number; is_taxable?: boolean;
  }) {
    const res = await this.ctx.post(`/api/jobs/${jobId}/charges`, { data });
    return { res, body: await res.json() };
  }

  async updateCharge(jobId: string, chargeId: string, data: Record<string, any>) {
    const res = await this.ctx.patch(`/api/jobs/${jobId}/charges/${chargeId}`, { data });
    return { res, body: await res.json() };
  }

  async removeCharge(jobId: string, chargeId: string) {
    const res = await this.ctx.delete(`/api/jobs/${jobId}/charges/${chargeId}`);
    return { res, status: res.status() };
  }

  async getCharges(jobId: string) {
    const res = await this.ctx.get(`/api/jobs/${jobId}/charges`);
    return (await res.json());
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

  // ─── Users ─────────────────────────────────
  async createUser(data: {
    email: string; password: string; first_name: string; last_name: string; role: string;
  }) {
    const res = await this.ctx.post('/api/users', { data });
    return { res, body: await res.json() };
  }

  async listLeadAssignees() {
    const res = await this.ctx.get('/api/leads/assignees');
    return (await res.json());
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
```

### db-cleanup.ts

Script to wipe all transactional data while preserving reference data and users.

**Preserved tables (reference data):**
- `users` — admin and staff accounts
- `price_book_categories` — price book structure
- `price_book_items` — price book catalog
- `state_tax_rates` — 51 state tax rates

**Deletion order (respects foreign keys):**

```
timelineEvent → note → attachment → payment → invoice → jobCharge → job →
deposit → estimateSendConfig → estimateLineItem → estimate →
leadTag → lead → tag → customerEmail → serviceLocation → customer →
stripeEvent → appSetting
```

**Seed script for reference data:** `backend/src/seed-tax-rates.ts` (run with `npx tsx src/seed-tax-rates.ts`)

- [ ] **Step 3: Create DB cleanup helper**

To run manually: create a temporary `backend/src/cleanup.ts`, run with `npx tsx src/cleanup.ts`, then delete it.

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting data cleanup...\n');

  // 1. Polymorphic / leaf tables
  const timeline = await prisma.timelineEvent.deleteMany();
  console.log('timelineEvent:', timeline.count);
  const notes = await prisma.note.deleteMany();
  console.log('note:', notes.count);
  const attachments = await prisma.attachment.deleteMany();
  console.log('attachment:', attachments.count);

  // 2. Payments → Invoices → JobCharges → Jobs
  const payments = await prisma.payment.deleteMany();
  console.log('payment:', payments.count);
  const invoices = await prisma.invoice.deleteMany();
  console.log('invoice:', invoices.count);
  const charges = await prisma.jobCharge.deleteMany();
  console.log('jobCharge:', charges.count);
  const jobs = await prisma.job.deleteMany();
  console.log('job:', jobs.count);

  // 3. Estimate children → Estimates
  const deposits = await prisma.deposit.deleteMany();
  console.log('deposit:', deposits.count);
  const sendConfigs = await prisma.estimateSendConfig.deleteMany();
  console.log('estimateSendConfig:', sendConfigs.count);
  const lineItems = await prisma.estimateLineItem.deleteMany();
  console.log('estimateLineItem:', lineItems.count);
  const estimates = await prisma.estimate.deleteMany();
  console.log('estimate:', estimates.count);

  // 4. Lead children → Leads → Tags
  const leadTags = await prisma.leadTag.deleteMany();
  console.log('leadTag:', leadTags.count);
  const leads = await prisma.lead.deleteMany();
  console.log('lead:', leads.count);
  const tags = await prisma.tag.deleteMany();
  console.log('tag:', tags.count);

  // 5. Customer children → Customers
  const emails = await prisma.customerEmail.deleteMany();
  console.log('customerEmail:', emails.count);
  const locations = await prisma.serviceLocation.deleteMany();
  console.log('serviceLocation:', locations.count);
  const customers = await prisma.customer.deleteMany();
  console.log('customer:', customers.count);

  // 6. Standalone transactional tables
  const stripeEvents = await prisma.stripeEvent.deleteMany();
  console.log('stripeEvent:', stripeEvents.count);
  const appSettings = await prisma.appSetting.deleteMany();
  console.log('appSetting:', appSettings.count);

  // 7. Delete extra technicians — keep only Mike Turner + Admin
  const techsToDelete = await prisma.user.findMany({
    where: {
      role: 'TECHNICIAN',
      NOT: { first_name: 'Mike', last_name: 'Turner' },
    },
    select: { id: true, first_name: true, last_name: true },
  });
  if (techsToDelete.length > 0) {
    const techIds = techsToDelete.map(t => t.id);
    const deletedTechs = await prisma.user.deleteMany({ where: { id: { in: techIds } } });
    console.log(`technicians deleted: ${deletedTechs.count} (${techsToDelete.map(t => `${t.first_name} ${t.last_name}`).join(', ')})`);
    // Also delete from Supabase Auth:
    // for (const id of techIds) await supabaseAdmin.auth.admin.deleteUser(id);
  }

  // PRESERVED: admin user, Mike Turner (TECHNICIAN), price_book_items, price_book_categories, state_tax_rates
  // To re-seed tax rates if needed: npx tsx src/seed-tax-rates.ts
  const userCount = await prisma.user.count();
  const pbItemCount = await prisma.priceBookItem.count();
  const pbCatCount = await prisma.priceBookCategory.count();
  const taxCount = await prisma.stateTaxRate.count();
  console.log(`\nPreserved: ${userCount} users, ${pbItemCount} price book items, ${pbCatCount} categories, ${taxCount} tax rates`);
  console.log('\nDone — all transactional data cleared.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
```

**Note:** Each E2E test creates unique data per run (timestamp-based) so stale data doesn't interfere. This script is for manual full resets only.

- [ ] **Step 4: Run a smoke test to verify config works**

Create `frontend/e2e/specs/workflow/00-smoke.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';

let api: ApiClient;

test.beforeAll(async () => {
  api = await new ApiClient().init();
});

test.afterAll(async () => {
  await api.dispose();
});

test('API health check', async () => {
  // This verifies: backend is running, auth works, API client is functional
  const { res } = await api.listLeads();
  expect(res.ok()).toBe(true);
});
```

Run: `cd frontend && npx playwright test --config=e2e/playwright.api.config.ts specs/workflow/00-smoke.spec.ts`
Expected: 1 test passes

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/playwright.api.config.ts frontend/e2e/helpers/api-client.ts frontend/e2e/helpers/db-cleanup.ts frontend/e2e/specs/workflow/00-smoke.spec.ts
git commit -m "test: add API test infrastructure — ApiClient, config, smoke test"
```

---

## Task 2: Stripe Webhook Test Bypass

**Files:**
- Modify: `backend/src/controllers/webhook.controller.ts`
- Modify: `backend/src/__tests__/webhook.test.ts` (verify no regression)

- [ ] **Step 1: Add NODE_ENV=test bypass for Stripe signature verification**

In `webhook.controller.ts`, change the signature verification block:

```typescript
let event;
if (process.env.NODE_ENV === 'test') {
  // In test env, parse the body directly (no Stripe signature verification)
  event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
} else {
  try {
    event = constructWebhookEvent(req.body, sig);
  } catch (err: any) {
    logger.error('Webhook signature verification failed');
    res.status(400).json({ error: 'Invalid webhook signature' });
    return;
  }
}
```

Also relax the signature header check for test env:

```typescript
if (!sig && process.env.NODE_ENV !== 'test') {
  res.status(400).json({ error: 'Missing stripe-signature header' });
  return;
}
```

- [ ] **Step 2: Run existing webhook tests**

Run: `npm test --workspace=backend -- --run webhook`
Expected: All webhook tests pass (existing tests already mock constructWebhookEvent)

- [ ] **Step 3: Commit**

```bash
git add backend/src/controllers/webhook.controller.ts
git commit -m "test: add NODE_ENV=test bypass for Stripe webhook signature verification"
```

---

## Task 3: Workflow Builder Helpers

**Files:**
- Create: `frontend/e2e/helpers/workflow-builders.ts`

Composable functions that chain ApiClient calls for common workflows. Each returns IDs/data needed for subsequent steps.

- [ ] **Step 1: Create workflow-builders.ts**

```typescript
import { ApiClient } from './api-client';

/** Create a customer with a primary service location. Returns IDs. */
export async function createCustomerWithLocation(api: ApiClient) {
  const s = api.suffix;
  const customer = await api.createCustomer({
    first_name: `Test-${s}`, last_name: 'Customer',
    email: `test-${s}@e2e.local`, phone: '5551234567',
  });
  const location = await api.addLocation(customer.id, {
    address_line1: `${Math.floor(Math.random() * 9999)} Test St`,
    city: 'Austin', state: 'TX', zip: '78701', is_primary: true,
  });
  return { customerId: customer.id, locationId: location.id };
}

/** Create a lead (NEW status). Returns lead data. */
export async function createNewLead(api: ApiClient, customerId?: string) {
  let custId = customerId;
  let locId: string | undefined;
  if (!custId) {
    const c = await createCustomerWithLocation(api);
    custId = c.customerId;
    locId = c.locationId;
  }
  const { body } = await api.createLead({
    customer_id: custId,
    service_request: `E2E test ${api.suffix}`,
  });
  return { lead: body.lead, customerId: custId, locationId: locId };
}

/** Create a lead and advance to CONTACTED. */
export async function createContactedLead(api: ApiClient) {
  const { lead, customerId, locationId } = await createNewLead(api);
  await api.contactLead(lead.id);
  return { leadId: lead.id, customerId: customerId!, locationId };
}

/** Create a technician user for scheduling tests. */
export async function createTech(api: ApiClient) {
  const s = api.suffix;
  const { body } = await api.createUser({
    email: `tech-${s}@e2e.local`, password: 'Test123!@#',
    first_name: 'Tech', last_name: s, role: 'TECHNICIAN',
  });
  return body.user.id as string;
}

/** Create a SALES user for assignment tests. */
export async function createSalesUser(api: ApiClient) {
  const s = api.suffix;
  const { body } = await api.createUser({
    email: `sales-${s}@e2e.local`, password: 'Test123!@#',
    first_name: 'Sales', last_name: s, role: 'SALES',
  });
  return body.user.id as string;
}

/** Full lead lifecycle: NEW → CONTACTED → WALKTHROUGH_SCHEDULED → WALKTHROUGH_COMPLETED */
export async function leadToWalkthroughCompleted(api: ApiClient) {
  const { leadId, customerId, locationId } = await createContactedLead(api);
  const techId = await createSalesUser(api); // walthrough performer must be SALES or TECHNICIAN
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    walkthrough_assigned_to: techId,
  });
  await api.completeWalkthrough(leadId);
  return { leadId, customerId: customerId!, locationId, techId };
}

/** Create a DRAFT estimate with standard line items. */
export async function createDraftEstimate(api: ApiClient, leadId: string) {
  const { body } = await api.createEstimate({
    lead_id: leadId,
    line_items: [
      { description: 'HVAC Repair', quantity: 1, unit_price: 500, is_taxable: true },
      { description: 'Parts', quantity: 2, unit_price: 75, is_taxable: true },
    ],
    tax_rate: 0.0825,
    scope_notes: 'E2E test estimate',
  });
  return body.estimate;
}

/** Lead → Estimate → SENT (no deposit). Returns estimate with public_token. */
export async function leadToSentEstimate(api: ApiClient, options?: { deposit?: boolean; methods?: string[] }) {
  const { leadId, customerId, locationId, techId } = await leadToWalkthroughCompleted(api);
  const estimate = await createDraftEstimate(api, leadId);
  const { body } = await api.sendEstimate(estimate.id, {
    deposit_required: options?.deposit ?? false,
    payment_methods: options?.methods,
  });
  return {
    leadId, customerId, locationId, techId,
    estimateId: estimate.id,
    estimate: body.estimate,
    publicToken: body.estimate.public_token,
  };
}

/** Full standard flow: Lead → Estimate → APPROVED (no deposit) → Job → SCHEDULED */
export async function fullStandardFlow(api: ApiClient) {
  const ctx = await leadToSentEstimate(api);
  // Approve (no deposit)
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
  });
  // Create job
  const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  const jobId = jobBody.job.id;
  // Assign to tech
  const techId = await createTech(api);
  await api.assignJob(jobId, {
    assigned_to: techId,
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  return { ...ctx, jobId, techId: techId };
}

/** Full deposit flow: Lead → Estimate → SENT (with deposit) → returns context for deposit testing */
export async function leadToSentEstimateWithDeposit(api: ApiClient, methods: string[] = ['CHECK', 'CASH', 'CARD']) {
  return leadToSentEstimate(api, { deposit: true, methods });
}
```

- [ ] **Step 2: Run smoke test to verify builders work**

Update the smoke test to use a workflow builder:

```typescript
test('workflow builder smoke test', async () => {
  const { leadId } = await createContactedLead(api);
  const lead = await api.getLead(leadId);
  expect(lead.status).toBe('CONTACTED');
});
```

Run: `cd frontend && npx playwright test --config=e2e/playwright.api.config.ts specs/workflow/00-smoke.spec.ts`

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/helpers/workflow-builders.ts frontend/e2e/specs/workflow/00-smoke.spec.ts
git commit -m "test: add workflow builder helpers for composable E2E test chains"
```

---

## Task 4: Lead Lifecycle Tests (Section 1 — 50 scenarios)

**Files:**
- Create: `frontend/e2e/specs/workflow/01-lead-lifecycle.spec.ts`

**Scenarios covered:** L-01 through L-42 + sub-items (creation, update, contact, walkthrough schedule/complete/cancel, notes/duration, assignment, mark lost, cancel)

- [ ] **Step 1: Write all lead lifecycle tests**

Each test uses `ApiClient` and workflow builders. Pattern:

```typescript
import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { createNewLead, createContactedLead, createSalesUser, createTech } from '../../helpers/workflow-builders';

let api: ApiClient;

test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

test.describe('Lead Creation', () => {
  test('L-01: Create lead with existing customer', async () => {
    // Create customer first, then lead with customer_id
    const { lead } = await createNewLead(api);
    expect(lead.status).toBe('NEW');
    expect(lead.lead_number).toMatch(/^L\d{5}$/);
  });
  // L-02 through L-04c ...
});

test.describe('Lead Contact', () => {
  test('L-06: Contact a NEW lead', async () => {
    const { lead } = await createNewLead(api);
    const { res, body } = await api.contactLead(lead.id);
    expect(res.ok()).toBe(true);
    expect(body.lead.status).toBe('CONTACTED');
    expect(body.lead.contacted_at).toBeTruthy();
  });
  test('L-07: Contact a non-NEW lead → 400', async () => {
    const { leadId } = await createContactedLead(api);
    const { res } = await api.contactLead(leadId);
    expect(res.status()).toBe(400);
  });
  // etc.
});
// ... all subsections
```

Implement ALL scenarios from Section 1 of the scenario matrix. Use the pattern above. Each scenario is one `test()` block.

- [ ] **Step 2: Run tests**

Run: `cd frontend && npx playwright test --config=e2e/playwright.api.config.ts specs/workflow/01-lead-lifecycle.spec.ts`
Expected: All ~50 tests pass

- [ ] **Step 3: Commit**

```bash
git commit -m "test(e2e): lead lifecycle — 50 API workflow tests"
```

---

## Task 5: Estimate CRUD + Send Tests (Sections 2-3 — 37 scenarios)

**Files:**
- Create: `frontend/e2e/specs/workflow/02-estimate-crud.spec.ts`
- Create: `frontend/e2e/specs/workflow/03-estimate-send.spec.ts`

**Scenarios:** E-01 through E-26 (CRUD, notes), S-01 through S-11 (send with/without deposit, guards)

Pattern same as Task 4. Use `leadToWalkthroughCompleted()` to quickly get a lead ready for estimate creation.

- [ ] **Step 1: Write estimate CRUD tests (E-01 to E-26)**
- [ ] **Step 2: Write estimate send tests (S-01 to S-11)**
- [ ] **Step 3: Run and verify**
- [ ] **Step 4: Commit**

```bash
git commit -m "test(e2e): estimate CRUD + send — 37 API workflow tests"
```

---

## Task 6: Public Approval + Deposit Tests (Sections 4-7 — 39 scenarios)

**Files:**
- Create: `frontend/e2e/specs/workflow/04-public-approval.spec.ts`
- Create: `frontend/e2e/specs/workflow/05-deposit-non-stripe.spec.ts`
- Create: `frontend/e2e/specs/workflow/06-deposit-stripe.spec.ts`
- Create: `frontend/e2e/specs/workflow/07-deposit-management.spec.ts`

**Scenarios:** P-01 to P-05, D-01 to D-14, STR-01 to STR-06, DM-01 to DM-14

The Stripe tests (STR-*) use `api.fireStripeWebhook()` to simulate Stripe's callback. Requires Task 2 (webhook bypass) to be completed first.

For deposit amount calculation in webhook tests: after sending an estimate with deposit, fetch the estimate to get the deposit amount, then calculate `amount_total = (deposit_amount + surcharge) * 100` in cents.

- [ ] **Step 1: Write public approval tests (P-01 to P-05)**
- [ ] **Step 2: Write non-Stripe deposit tests (D-01 to D-14)**
- [ ] **Step 3: Write Stripe deposit tests (STR-01 to STR-06)**
- [ ] **Step 4: Write deposit management tests (DM-01 to DM-14)**
- [ ] **Step 5: Run and verify**
- [ ] **Step 6: Commit**

```bash
git commit -m "test(e2e): public approval + deposit flows — 39 API workflow tests"
```

---

## Task 7: Decline + Cancel + Expiration Tests (Sections 8-10 — 21 scenarios)

**Files:**
- Create: `frontend/e2e/specs/workflow/08-decline-cancel-expire.spec.ts`

**Scenarios:** DC-01 to DC-08, EC-01 to EC-06, EX-01 to EX-07

The expiration tests (EX-*) need to call the cron function directly. Two approaches:
1. **Direct import** — import `expireEstimates` from the backend and call it (requires the test to run in a context that can import backend code)
2. **Backdated valid_until** — set valid_until to a past date via direct DB update, then call a test-only endpoint

Since these are API tests hitting a real backend, the simplest approach: after sending an estimate, use Prisma Studio or a test endpoint to backdate `valid_until`, then trigger the cron. If no test endpoint exists, add a simple `POST /api/test/expire-estimates` (guarded by NODE_ENV=test) that calls `expireEstimates()`.

- [ ] **Step 1: Add test-only cron trigger endpoint (if needed)**

In `backend/src/app.ts`, add:
```typescript
if (process.env.NODE_ENV === 'test') {
  const { expireEstimates } = require('./cron/estimate-expiration');
  app.post('/api/test/expire-estimates', async (_req, res) => {
    const count = await expireEstimates();
    res.json({ expired: count });
  });
  // Also add a backdating endpoint
  app.patch('/api/test/backdate-estimate/:id', async (req, res) => {
    const { valid_until } = req.body;
    await prisma.estimate.update({ where: { id: req.params.id }, data: { valid_until: new Date(valid_until) } });
    res.json({ ok: true });
  });
}
```

- [ ] **Step 2: Write decline tests (DC-01 to DC-08)**
- [ ] **Step 3: Write cancellation tests (EC-01 to EC-06)**
- [ ] **Step 4: Write expiration tests (EX-01 to EX-07)**
- [ ] **Step 5: Run and verify**
- [ ] **Step 6: Commit**

```bash
git commit -m "test(e2e): decline + cancel + expiration — 21 API workflow tests"
```

---

## Task 8: Job Creation + Update + Assignment Tests (Sections 11-14 — 28 scenarios)

**Files:**
- Create: `frontend/e2e/specs/workflow/09-job-creation.spec.ts`
- Create: `frontend/e2e/specs/workflow/10-job-assignment.spec.ts`

**Scenarios:** J-01 to J-07, UJ-01 to UJ-03, JU-01 to JU-05, JA-01 to JA-12

For standard job creation tests, use `leadToSentEstimate()` → approve → then create job. The deposit gate tests need various deposit states.

For conflict detection tests (JA-04 to JA-06), create two overlapping jobs/walkthroughs and verify 409.

- [ ] **Step 1: Write standard job creation tests (J-01 to J-07)**
- [ ] **Step 2: Write urgent job creation tests (UJ-01 to UJ-03)**
- [ ] **Step 3: Write job update tests (JU-01 to JU-05)**
- [ ] **Step 4: Write job assignment tests (JA-01 to JA-12)**
- [ ] **Step 5: Run and verify**
- [ ] **Step 6: Commit**

```bash
git commit -m "test(e2e): job creation + update + assignment — 28 API workflow tests"
```

---

## Task 9: Job Status Transitions + Extras (Sections 15-18 — 41 scenarios)

**Files:**
- Create: `frontend/e2e/specs/workflow/11-job-transitions.spec.ts`
- Create: `frontend/e2e/specs/workflow/12-job-extras.spec.ts`

**Scenarios:** JS-01 to JS-28, JN-01 to JN-03, JW-01 to JW-02, UC-01 to UC-08

- [ ] **Step 1: Write unassign tests (JS-01 to JS-05)**
- [ ] **Step 2: Write start tests (JS-06 to JS-10)**
- [ ] **Step 3: Write complete tests (JS-11 to JS-16)**
- [ ] **Step 4: Write cancel tests (JS-17 to JS-22)**
- [ ] **Step 5: Write delete tests (JS-23 to JS-28)**
- [ ] **Step 6: Write notes/timeline/walkthrough tests (JN, JW)**
- [ ] **Step 7: Write charge tests (UC-01 to UC-08)**
- [ ] **Step 8: Run and verify**
- [ ] **Step 9: Commit**

```bash
git commit -m "test(e2e): job transitions + notes + charges — 41 API workflow tests"
```

---

## Task 10: End-to-End Workflow Paths (Section 19 — 40 scenarios)

**Files:**
- Create: `frontend/e2e/specs/workflow/13-e2e-standard-flows.spec.ts`
- Create: `frontend/e2e/specs/workflow/14-e2e-deposit-flows.spec.ts`
- Create: `frontend/e2e/specs/workflow/15-e2e-cancellation-flows.spec.ts`
- Create: `frontend/e2e/specs/workflow/16-e2e-edge-cases.spec.ts`

**Scenarios:** E2E-01 through E2E-40

These are the most critical tests — full chains from lead creation to job scheduled. Each test exercises the complete workflow with different branching paths.

Split into 4 files by theme:
- **Standard flows** (E2E-01 to E2E-07): happy paths with different deposit/walkthrough variations
- **Deposit flows** (E2E-08 to E2E-15): declined/cancelled/refunded/reactivated deposits
- **Cancellation flows** (E2E-16 to E2E-22): lead lost, lead cancelled, job cancelled, job unassigned
- **Edge cases** (E2E-23 to E2E-40): expiration, multiple estimates, conflicts, all-day, full lifecycle

Each test chains the workflow builders and adds specific assertions at each step.

- [ ] **Step 1: Write standard flow tests (E2E-01 to E2E-07)**
- [ ] **Step 2: Write deposit flow tests (E2E-08 to E2E-15)**
- [ ] **Step 3: Write cancellation flow tests (E2E-16 to E2E-22)**
- [ ] **Step 4: Write edge case tests (E2E-23 to E2E-40)**
- [ ] **Step 5: Run and verify**
- [ ] **Step 6: Commit**

```bash
git commit -m "test(e2e): end-to-end workflow paths — 40 API workflow tests"
```

---

## Task 11: Guard / Negative Tests (Section 20 — 30 scenarios)

**Files:**
- Create: `frontend/e2e/specs/workflow/17-guard-tests.spec.ts`

**Scenarios:** G-01 through G-30

These verify that every invalid operation is properly blocked. Each test sets up a specific state, attempts an invalid action, and asserts the correct error response (400/403/404/409).

- [ ] **Step 1: Write all guard tests**

Pattern:
```typescript
test('G-01: Create job from DRAFT estimate → 400', async () => {
  const { leadId } = await leadToWalkthroughCompleted(api);
  const estimate = await createDraftEstimate(api, leadId);
  const { res } = await api.createJob({ estimate_id: estimate.id });
  expect(res.status()).toBe(400);
});
```

- [ ] **Step 2: Run and verify**
- [ ] **Step 3: Commit**

```bash
git commit -m "test(e2e): guard/negative tests — 30 API workflow tests"
```

---

## Task 12: Read Endpoints, Filters, Stats, Data Integrity (Sections 21-22 — 25 scenarios)

**Files:**
- Create: `frontend/e2e/specs/workflow/18-read-filters-stats.spec.ts`

**Scenarios:** RD-01 to RD-20, DI-01 to DI-05

These test list endpoints with filters, stats endpoints, helper endpoints, and data integrity (deposit calculations, charge totals, renumbering).

- [ ] **Step 1: Write public estimate view tests (RD-01 to RD-04)**
- [ ] **Step 2: Write filter tests (RD-05 to RD-14)**
- [ ] **Step 3: Write stats tests (RD-15 to RD-17)**
- [ ] **Step 4: Write helper endpoint tests (RD-18 to RD-20)**
- [ ] **Step 5: Write data integrity tests (DI-01 to DI-05)**
- [ ] **Step 6: Run and verify**
- [ ] **Step 7: Commit**

```bash
git commit -m "test(e2e): read endpoints + filters + stats + data integrity — 25 API workflow tests"
```

---

## Task 13: Full Suite Run + Results Report

- [ ] **Step 1: Run the complete API test suite**

```bash
cd frontend && npx playwright test --config=e2e/playwright.api.config.ts
```

- [ ] **Step 2: Generate results report**

Create a summary of:
- Total tests / passed / failed
- Which scenarios failed (map back to scenario IDs)
- Categorize failures: backend bug vs test bug vs infrastructure issue

- [ ] **Step 3: Commit final state**

```bash
git commit -m "test(e2e): complete workflow test suite — 314 API scenarios"
```

---

## Execution Order

Tasks 1-3 are prerequisites (infrastructure). Tasks 4-12 can be done in order (each builds on the infrastructure but is otherwise independent). Task 13 is the final validation.

```
Task 1 (infra) → Task 2 (Stripe bypass) → Task 3 (builders)
  ↓
Task 4 (leads) → Task 5 (estimates) → Task 6 (deposits) → Task 7 (decline/cancel/expire)
  ↓
Task 8 (job creation) → Task 9 (job transitions)
  ↓
Task 10 (E2E paths) → Task 11 (guards) → Task 12 (reads/stats)
  ↓
Task 13 (full run + report)
```

## Run Command Reference

```bash
# Run all API workflow tests
cd frontend && npx playwright test --config=e2e/playwright.api.config.ts

# Run a specific spec file
cd frontend && npx playwright test --config=e2e/playwright.api.config.ts specs/workflow/01-lead-lifecycle.spec.ts

# Run with verbose output
cd frontend && npx playwright test --config=e2e/playwright.api.config.ts --reporter=list

# Run existing browser E2E tests (unchanged)
cd frontend && npx playwright test --config=e2e/playwright.config.ts
```
