import { test, expect } from '@playwright/test';
import { ApiClient, provisionedAdmin } from '../../helpers/api-client';
import { leadToSentEstimate } from '../../helpers/workflow-builders';

/**
 * X-01 — systematic cross-org tenant isolation (catalog row X-01, P1).
 *
 * WRITTEN 2026-06-10, NOT YET EXECUTED — first baseline run validates.
 *
 * Sources of truth:
 *  - md_files/specs/testing/lifecycle-regression-catalog.md row X-01 ("✅ STM-04
 *    (statements only) — 🔲 GAP for systematic per-resource probe").
 *  - CLAUDE.md §3.1 / backend/src/lib/tenant.ts — every authed controller spreads
 *    tenantWhere(req) ({organization_id}) into its Prisma where, so a FOREIGN id is a
 *    scoped MISS, indistinguishable from a nonexistent id.
 *  - Code-verified refusal per probe (all are tenant-scoped findUnique → 404 today):
 *      GET  /api/customers/:id        customer.controller.ts getById :490 → 404 'Customer not found'
 *      GET  /api/leads/:id            lead.controller.ts     getById :704 → 404 'Lead not found'
 *      GET  /api/estimates/:id        estimate.controller.ts getById :765 → 404 'Estimate not found'
 *      GET  /api/jobs/:id             job.controller.ts      getById :573 → 404 'Job not found'
 *      GET  /api/invoices/:id         invoice.controller.ts  getById :652 → 404 'Invoice not found'
 *      GET  /api/statements/job/:id   statement.controller.ts getJobStatement :289 → 404 'Job not found'
 *      PATCH /api/leads/:id           lead.controller.ts     update  :728 → 404 'Lead not found'
 *    Assertions accept the {400, 404} family (the contract: a refusal that leaks nothing,
 *    never 2xx, never 5xx) and pin the /not found/i message; the exact observed codes above
 *    are the baseline record.
 *
 * SECOND-ORG DOOR (the strong YES path): POST /api/test/provision-org (E2E_TEST_DOORS-gated,
 * no body) mints a FRESH org every call — crypto runId per invocation (backend/src/lib/
 * e2e-org.ts:51-103) — returning {organizationId, adminEmail, adminPassword, adminUserId,
 * runId} with a confirmed Supabase Auth admin. So this spec provisions org B in beforeAll and
 * logs a second ApiClient in as B's admin, probing org A's REAL row ids (much stronger than
 * STM-04's random-UUID form: a real foreign row either tenant-misses or leaks).
 *
 * ⚠️ TEARDOWN DECISION — we deliberately DO NOT call /api/test/teardown-org for org B here.
 * teardownTestOrg's Auth sweep is FULL-DOMAIN (every @e2e-qa.invalid Auth user, e2e-org.ts:
 * 113-128): invoking it mid-suite would delete the RUN org's admin Auth user too, breaking
 * every later login — any spec file sorting after this one AND this file's own retry
 * (playwright.api.config.ts retries:1 restarts the worker, whose beforeAll re-logins).
 * Cleanup reality, verified in code:
 *  - org B's Auth user IS removed at end of run: global-teardown.ts calls the door (for org
 *    A's id) and its full-domain sweep catches B's admin; next run's global-setup-api.ts
 *    step 1 sweeps again.
 *  - org B's Prisma rows linger (1 Organization + 1 User + DEFAULT_GRANTS RolePermissions —
 *    ZERO business rows: org B never seeds; X-01a's probes are reads only). The orphan sweep
 *    does NOT purge e2e-qa-* org rows when called without an id (teardownTestOrg skips
 *    purgeOrganization for an undefined orgId) — known residue, name-tagged 'e2e-qa-<runId>',
 *    until the door learns to sweep e2e-qa-* orgs id-lessly.
 *
 * PUBLIC-TOKEN ENDPOINTS EXCLUDED INTENTIONALLY: /api/estimates/:id/public|approve|decline
 * and /api/invoices/:id/public|checkout are org-less by design — the unguessable token IS
 * the auth and the org is loaded from the entity row itself (CLAUDE.md API pattern), so a
 * "cross-org" probe is meaningless there (any holder of the token is the intended audience).
 *
 * Conventions: serial via config (workers:1); org A (the run org / default client) seeds one
 * resource of each kind once in beforeAll with unique api.suffix data + @e2e-qa.invalid
 * emails; every check is presence-of-own / absence-of-foreign, never an absolute count.
 */
let api: ApiClient;  // org A — the run org: seeds + positive controls
let apiB: ApiClient; // org B — the second throwaway org: the hostile reader
let orgB: { organizationId: string; adminEmail: string; adminPassword: string };
let seeded: {
  customerId: string;
  leadId: string;
  estimateId: string;
  jobId: string;
  invoiceId: string;
  serviceRequest: string;
};

test.beforeAll(async () => {
  // Provision + second login + a full seed chain (~18 serial calls) on a possibly-cold backend.
  test.setTimeout(120_000);
  api = await new ApiClient().init();

  // Door: mint org B. The door ignores auth (E2E_TEST_DOORS-gated), so calling it through
  // org A's authed context is harmless; no wrapper exists → raw().
  const prov = await api.raw('post', '/api/test/provision-org');
  expect(prov.res.status(), 'provision-org for org B').toBe(200);
  orgB = prov.body;
  apiB = await new ApiClient().init({ email: orgB.adminEmail, password: orgB.adminPassword });

  // Seed org A: customer → lead → walkthrough → estimate SENT → public approve (job gate) →
  // job → DRAFT invoice. Mirrors the fullStandardFlow spine minus attachments/assignment.
  const ctx = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
  });
  const { res: jobRes, body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  expect(jobRes.status(), 'seed: job create').toBe(201);
  const { res: invRes, body: invBody } = await api.createInvoice(jobBody.job.id);
  expect(invRes.status(), 'seed: invoice create').toBe(201);
  const lead = await api.getLead(ctx.leadId);
  seeded = {
    customerId: ctx.customerId,
    leadId: ctx.leadId,
    estimateId: ctx.estimateId,
    jobId: jobBody.job.id,
    invoiceId: invBody.invoice.id,
    serviceRequest: lead.service_request,
  };
});

test.afterAll(async () => {
  // NO door teardown for org B — see the header block. Dispose HTTP contexts only.
  await api?.dispose();
  await apiB?.dispose();
});

/**
 * A tenant miss must be a no-leak 4xx refusal: 404 (the code-verified value today) or 400,
 * NEVER 2xx (leak) and NEVER 5xx (scoping crash). `leakKey` is the success-payload key that
 * must be absent from the refusal body.
 */
function expectTenantMiss(
  label: string,
  probe: { res: { status(): number }; body: any },
  leakKey: string,
) {
  const status = probe.res.status();
  expect([400, 404], `${label}: expected a 404/400 tenant miss, got ${status}`).toContain(status);
  expect(String(probe.body?.error ?? ''), `${label}: refusal message`).toMatch(/not found/i);
  expect(probe.body?.[leakKey], `${label}: no entity payload may leak`).toBeUndefined();
}

test.describe('X-01 — cross-org isolation (redesign-24)', () => {
  // ─── X-01a ────────────────────────────────────────────────────────────────
  test('X-01a: door sanity — org B admin authenticates into a DIFFERENT org and sees none of org A in lists', async () => {
    // Direct proof apiB landed in org B (not a mis-login into the run org).
    const me = await apiB.raw('get', '/api/auth/me');
    expect(me.res.status(), 'GET /api/auth/me as B').toBe(200);
    expect(me.body.user.organization_id).toBe(orgB.organizationId);
    expect(me.body.user.organization_id).not.toBe(provisionedAdmin().organizationId);

    // Org B's collection reads succeed (200 — its token works) and contain NONE of org A's
    // seeds. Absence-of-foreign, not absolute counts (org B is empty, but don't pin that).
    const customers = await apiB.raw('get', '/api/customers');
    expect(customers.res.status(), 'GET /api/customers as B').toBe(200);
    expect((customers.body.customers ?? []).map((c: any) => c.id)).not.toContain(seeded.customerId);

    const leads = await apiB.listLeads();
    expect(leads.res.status(), 'GET /api/leads as B').toBe(200);
    expect((leads.body.leads ?? []).map((l: any) => l.id)).not.toContain(seeded.leadId);
  });

  // ─── X-01b ────────────────────────────────────────────────────────────────
  test('X-01b: cross-org GET by id — customer / lead / estimate / job / invoice / job-statement all tenant-miss', async () => {
    // Each probe targets a REAL org-A row id with org B's credentials. tenantWhere makes the
    // scoped findUnique miss → observed 404 '<Entity> not found' on every endpoint (header
    // table records the exact controller lines).
    const cust = await apiB.raw('get', `/api/customers/${seeded.customerId}`);
    expectTenantMiss('GET /api/customers/:id', cust, 'customer');

    const lead = await apiB.raw('get', `/api/leads/${seeded.leadId}`);
    expectTenantMiss('GET /api/leads/:id', lead, 'lead');

    const est = await apiB.raw('get', `/api/estimates/${seeded.estimateId}`);
    expectTenantMiss('GET /api/estimates/:id', est, 'estimate');

    const job = await apiB.raw('get', `/api/jobs/${seeded.jobId}`);
    expectTenantMiss('GET /api/jobs/:id', job, 'job');

    const inv = await apiB.raw('get', `/api/invoices/${seeded.invoiceId}`);
    expectTenantMiss('GET /api/invoices/:id', inv, 'invoice');

    // Statement (the one X-01 surface that already had coverage — STM-04 — but only with a
    // random UUID; this is the real-foreign-row form). Success shape is {job, lines, totals}.
    const stm = await apiB.getJobStatement(seeded.jobId);
    expectTenantMiss('GET /api/statements/job/:jobId', stm, 'lines');
  });

  // ─── X-01c ────────────────────────────────────────────────────────────────
  test("X-01c: cross-org mutation — org B PATCHing org A's lead tenant-misses and the write never lands", async () => {
    const attempted = `TENANT-BREACH-${api.suffix}`;
    const patched = await apiB.updateLead(seeded.leadId, { service_request: attempted });
    expectTenantMiss('PATCH /api/leads/:id', patched, 'lead');

    // Re-read as org A: the original value survives, the attempted value never landed.
    const lead = await api.getLead(seeded.leadId);
    expect(lead.service_request, 'org A lead unchanged after foreign PATCH').toBe(seeded.serviceRequest);
    expect(lead.service_request).not.toBe(attempted);
  });

  // ─── X-01d ────────────────────────────────────────────────────────────────
  test('X-01d: positive control — org A still reads every probed resource 200 (ids are real; the refusals are tenancy)', async () => {
    const probes: Array<[string, string]> = [
      ['GET /api/customers/:id as A', `/api/customers/${seeded.customerId}`],
      ['GET /api/leads/:id as A', `/api/leads/${seeded.leadId}`],
      ['GET /api/estimates/:id as A', `/api/estimates/${seeded.estimateId}`],
      ['GET /api/jobs/:id as A', `/api/jobs/${seeded.jobId}`],
      ['GET /api/invoices/:id as A', `/api/invoices/${seeded.invoiceId}`],
    ];
    for (const [label, path] of probes) {
      const { res } = await api.raw('get', path);
      expect(res.status(), label).toBe(200);
    }
    const stm = await api.getJobStatement(seeded.jobId);
    expect(stm.res.status(), 'GET /api/statements/job/:jobId as A').toBe(200);
    expect(stm.body.job?.id).toBe(seeded.jobId);
  });
});
