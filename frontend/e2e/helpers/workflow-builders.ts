import { ApiClient } from './api-client';
import { pickRandomAttachments } from './test-data';

// 2026-06-10 catalog-§5 contradiction fix: the duplicate-customer guard (PR #135, lib/customer-duplicate.ts)
// matches on normalized primary PHONE in-org — a fixed builder phone makes every 2nd builder-seeded
// customer per provisioned org 409 and collapses the run. Every builder customer now gets a unique
// 10-digit phone ('9' prefix keeps it disjoint from all fixture literals). Exported for specs.
let phoneSeq = 0;
export function uniquePhone(): string {
  phoneSeq = (phoneSeq + 1) % 100;
  return `9${String(Date.now()).slice(-7)}${String(phoneSeq).padStart(2, '0')}`;
}

/** Create a customer with a primary service location. Returns IDs. */
export async function createCustomerWithLocation(api: ApiClient) {
  const s = api.suffix;
  const customer = await api.createCustomer({
    first_name: `Test-${s}`, last_name: 'Customer',
    email: `test-${s}@e2e-qa.invalid`, phone: uniquePhone(),
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
  } else {
    // A lead in the redesign MUST anchor to one of the customer's service locations
    // (createLead 500s without service_location_id). Resolve the customer's primary.
    const cust = await api.getCustomer(custId);
    const locs: any[] = cust?.service_locations ?? [];
    locId = (locs.find((l) => l.is_primary) ?? locs[0])?.id;
  }
  const { body } = await api.createLead({
    customer_id: custId!, // provably defined after the !custId guard above
    service_request: `E2E test ${api.suffix}`,
    service_location_id: locId,
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
  const { res, body } = await api.createUser({
    email: `tech-${s}@e2e-qa.invalid`, password: 'Test123!@#',
    first_name: 'Tech', last_name: s, role: 'TECHNICIAN',
  });
  if (!body?.user?.id) {
    throw new Error(`createTech failed: ${res.status()} ${body?.error ?? JSON.stringify(body)}`);
  }
  return body.user.id as string;
}

/** Create a SALES user for assignment tests. */
export async function createSalesUser(api: ApiClient) {
  const s = api.suffix;
  const { res, body } = await api.createUser({
    email: `sales-${s}@e2e-qa.invalid`, password: 'Test123!@#',
    first_name: 'Sales', last_name: s, role: 'SALES',
  });
  if (!body?.user?.id) {
    throw new Error(`createSalesUser failed: ${res.status()} ${body?.error ?? JSON.stringify(body)}`);
  }
  return body.user.id as string;
}

/** Lazily create + cache ONE SALES walkthrough-performer per ApiClient session
 *  (avoids creating a Supabase Auth user for every deposit/worked-example seed). */
async function getOrCreatePerformer(api: ApiClient): Promise<string> {
  const key = '__e2ePerformerId';
  const cached = (api as unknown as Record<string, string>)[key];
  if (cached) return cached;
  const id = await createSalesUser(api);
  (api as unknown as Record<string, string>)[key] = id;
  return id;
}

/** Full lead lifecycle: NEW → CONTACTED → WALKTHROUGH_SCHEDULED → WALKTHROUGH_COMPLETED */
export async function leadToWalkthroughCompleted(api: ApiClient) {
  const { leadId, customerId, locationId } = await createContactedLead(api);
  const techId = await createSalesUser(api); // walkthrough performer must be SALES or TECHNICIAN
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    performer_ids: [techId],
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

/** Lead → Estimate → SENT (no deposit by default). Returns estimate with public_token. */
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

/** Shorthand for deposit flow: Lead → Estimate → SENT (with deposit). */
export async function leadToSentEstimateWithDeposit(api: ApiClient, methods: string[] = ['CHECK', 'CASH', 'CARD']) {
  return leadToSentEstimate(api, { deposit: true, methods });
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
    assignee_ids: [techId],
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  // Attach site documentation to the scheduled job (non-fatal if storage unavailable)
  let jobAttachments: any[] = [];
  try { jobAttachments = await attachTestFiles(api, 'JOB', jobId, 2); } catch { /* storage not configured */ }
  return { ...ctx, jobId, techId, jobAttachments };
}

/** Full standard flow through completion: Lead → Estimate → APPROVED → Job → SCHEDULED → IN_PROGRESS → COMPLETED (with attachments) */
export async function fullStandardFlowCompleted(api: ApiClient) {
  const ctx = await fullStandardFlow(api);
  // Start the job
  await api.startJob(ctx.jobId);
  // Complete with realistic notes
  await api.completeJob(ctx.jobId,
    'Replaced evaporator coil with Trane-compatible unit. Recovered and recharged R-410A to manufacturer spec (4 lbs 6 oz). ' +
    'Verified superheat/subcool within range. System pulling 18°F delta at supply/return. Customer confirmed cooling restored.',
  );
  // Attach work documentation photos after completion (non-fatal if storage unavailable)
  let completionAttachments: any[] = [];
  try { completionAttachments = await attachTestFiles(api, 'JOB', ctx.jobId, 2); } catch { /* storage not configured */ }
  return { ...ctx, completionAttachments };
}

/**
 * No-estimate job flow with attachments: Customer → Lead → Contact → No-estimate Job →
 * Assign → Start → Complete (with attachments throughout).
 *
 * Entity-redesign Phase D: the urgent flow is retired. createJob no longer accepts
 * is_urgent/urgency_reason, and the /jobs/:id/charges routes are gone (the Invoice owns
 * line items). A no-estimate job is created with {customer_id, service_location_id}; any
 * money is added as InvoiceLineItems on the invoice that the job spawns.
 */
export async function noEstimateJobWithAttachments(api: ApiClient) {
  const { customerId, locationId } = await createCustomerWithLocation(api);
  const { lead } = await createNewLead(api, customerId);
  const leadId = lead.id;
  await api.contactLead(leadId);

  // Create a no-estimate job (customer + location only).
  const { body: jobBody } = await api.createJob({
    customer_id: customerId,
    service_location_id: locationId,
  });
  const jobId = jobBody.job.id;

  // Assign to tech
  const techId = await createTech(api);
  await api.assignJob(jobId, {
    assignee_ids: [techId],
    scheduled_start: api.futureDate(1),
    scheduled_end: api.futureDate(3),
  });

  // Start the job
  await api.startJob(jobId);

  // Attach walkthrough photos to the job (non-fatal if storage unavailable)
  let walkthroughAttachments: any[] = [];
  try { walkthroughAttachments = await attachTestFiles(api, 'JOB', jobId, 2); } catch { /* storage not configured */ }

  // Complete the job
  await api.completeJob(jobId,
    'Emergency call — found burnt contactor on Carrier 25HCC536. Replaced with OEM part, tested amp draw at 18.2A (spec 19A). ' +
    'Cleaned condenser coils while on-site. System cycling normally, customer satisfied.',
  );

  // Attach work documentation after completion (non-fatal if storage unavailable)
  let completionAttachments: any[] = [];
  try { completionAttachments = await attachTestFiles(api, 'JOB', jobId, 2); } catch { /* storage not configured */ }

  return {
    customerId, locationId, leadId, jobId, techId,
    walkthroughAttachments,
    completionAttachments,
  };
}

/** Back-compat alias — the old "urgent" builder is now a plain no-estimate job. */
export const urgentJobWithAttachments = noEstimateJobWithAttachments;

/** Full standard flow through invoice PAID: Lead → Estimate → Job → Invoice → Payment */
export async function fullStandardFlowToInvoicePaid(api: ApiClient) {
  const ctx = await fullStandardFlowCompleted(api);

  // Create invoice from the completed job
  const { body: invBody } = await api.createInvoice(ctx.jobId);
  const invoice = invBody.invoice;
  const invoiceId = invoice.id;

  // Send the invoice
  const { body: sentBody } = await api.sendInvoice(invoiceId);
  const sentInvoice = sentBody.invoice;

  // Record full payment — residential customer pays with CASH on-site
  const { body: payBody } = await api.recordPayment(invoiceId, {
    amount: Number(sentInvoice.amount_due),
    method: 'CASH',
    notes: 'Collected on-site by technician',
  });

  return {
    ...ctx,
    invoiceId,
    invoice: payBody.invoice,
    payment: payBody.payment,
    publicToken: sentInvoice.public_token,
  };
}

/**
 * No-estimate job flow through the invoice ATTEMPT (the "urgent invoicing" Phase-8 gap).
 *
 * 2026-06-10 catalog-§5 contradiction fix (§5.1): the current backend REJECTS invoicing an
 * estimate-less job — `invoice.controller.ts` create returns 400 'Cannot create invoice with
 * no line items' (a STANDARD invoice snapshots the estimate's lines; owned-line editing is
 * the pending Phase-8 UI, catalog COL-04/P3). This builder previously expected the empty-lines
 * invoice to succeed and went on to send/pay it — that flow is severed today. New shape:
 * execute the job (via urgentJobWithAttachments), attempt the invoice, assert the 400, and
 * return the attempt so callers can assert the gap. Throws a descriptive error if the server
 * unexpectedly accepts — the signal that Phase 8 landed and the send/pay tail should be
 * restored. — verify at baseline run
 */
export async function urgentFlowToInvoicePaid(api: ApiClient) {
  const ctx = await urgentJobWithAttachments(api);

  // Attempt to create an invoice from the completed no-estimate job — current backend: 400.
  const { res, body } = await api.createInvoice(ctx.jobId);
  if (res.status() !== 400) {
    throw new Error(
      `urgentFlowToInvoicePaid: expected 400 'Cannot create invoice with no line items' for a ` +
      `no-estimate job (Phase-8 gap, catalog COL-04), got ${res.status()}. If invoice-owned ` +
      `line items shipped, restore this builder's send/pay tail and update the catalog.`,
    );
  }

  return {
    ...ctx,
    invoiceAttempt: { status: res.status(), error: body?.error as string | undefined },
  };
}

/** Create a tax-exempt government/nonprofit customer with a service location. */
export async function createTaxExemptCustomerWithLocation(api: ApiClient) {
  const s = api.suffix;
  const customer = await api.createCustomer({
    first_name: 'Thomas', last_name: 'Wright',
    email: `twright-${s}@e2e-qa.invalid`, phone: uniquePhone(), // 2026-06-10: dup-guard fix (was fixed '5123456789')
    company_name: 'Austin ISD - Facilities',
    allow_billing: true, tax_exempt: true, payment_type: 'NET 60',
  });
  const location = await api.addLocation(customer.id, {
    address_line1: '1111 W 6th St', city: 'Austin', state: 'TX', zip: '78703', is_primary: true,
  });
  return { customerId: customer.id, locationId: location.id };
}

/** Full standard flow through invoice SENT (stops before payment for flexible payment testing). */
export async function fullStandardFlowToInvoiceSent(api: ApiClient) {
  const ctx = await fullStandardFlowCompleted(api);
  const { body: invBody } = await api.createInvoice(ctx.jobId);
  const invoiceId = invBody.invoice.id;
  const { body: sentBody } = await api.sendInvoice(invoiceId);
  return {
    ...ctx,
    invoiceId,
    invoice: sentBody.invoice,
    publicToken: sentBody.invoice.public_token,
  };
}

/**
 * Upload 1-3 random test attachments to an entity.
 * Uses the attachment pool from test-data.ts and fixture files from e2e/fixtures/.
 *
 * @param api - Authenticated API client
 * @param entityType - LEAD, ESTIMATE, JOB, or INVOICE
 * @param entityId - UUID of the target entity
 * @param count - Number of attachments (default: random 1-3)
 * @returns Array of created attachment records
 */
export async function attachTestFiles(
  api: ApiClient,
  entityType: 'LEAD' | 'ESTIMATE' | 'JOB' | 'INVOICE',
  entityId: string,
  count?: number,
) {
  const picks = pickRandomAttachments(count);
  const results = [];
  for (const pick of picks) {
    const { body } = await api.uploadAttachment(entityType, entityId, pick);
    results.push(body.attachment);
  }
  return results;
}

// ─── Entity-redesign worked-example builders (§3 / §5) ───────────────────────

/**
 * Customer with a MA service location (6.25% state tax) — the worked-example fixture.
 * MA is chosen because the global StateTaxRate fixture (asserted in preflight) is 6.25%,
 * so estimate/invoice tax is derivable and the worked numbers are deterministic.
 */
export async function createMaCustomerWithLocation(api: ApiClient) {
  const s = api.suffix;
  const customer = await api.createCustomer({
    first_name: `MA-${s}`, last_name: 'Customer', email: `ma-${s}@e2e-qa.invalid`, phone: uniquePhone(), // 2026-06-10: dup-guard fix (was fixed '6175551234')
  });
  const location = await api.addLocation(customer.id, {
    address_line1: `${Math.floor(Math.random() * 9999)} Beacon St`, city: 'Boston', state: 'MA', zip: '02108', is_primary: true,
  });
  return { customerId: customer.id, locationId: location.id };
}

/**
 * Lead → Estimate (one $amount taxable line) → SENT with a deposit required, MA location.
 *
 * DEPOSIT PERCENTAGE: `sendEstimate` does NOT accept a deposit percentage —
 * `sendEstimateSchema` only takes `deposit_required`, `payment_methods`, `message_body`,
 * `cc_emails`. The backend derives the percentage from the org AppSetting `deposit_percentage`
 * (default 50%). So to make the worked numbers deterministic (e.g. STD-05's 30% → $76,250),
 * this builder FIRST sets the org's `deposit_percentage` AppSetting to `depositPct`
 * (PATCH /api/settings/deposit_percentage) before sending. The resulting deposit invoice is
 * returned as `estimate.invoices[0]`; read the actual amount from `.total_amount`.
 */
/** Fail-loud unwrap: throw a named HTTP error instead of a downstream TypeError. */
function must<T>(v: T | undefined, res: { status(): number }, label: string, body?: any): T {
  if (!v) throw new Error(`${label} failed: ${res.status()} ${body?.error ?? JSON.stringify(body ?? {})}`);
  return v;
}

export async function maEstimateSentWithDeposit(
  api: ApiClient, amount: number, depositPct: number, methods = ['CHECK', 'CASH', 'CARD'],
) {
  // Pin the org deposit % so the deposit math is deterministic (the send schema ignores
  // any per-request percentage; the controller reads this org AppSetting).
  const { res: setRes, body: setBody } = await api.raw(
    'patch', '/api/settings/deposit_percentage', { value: String(depositPct) },
  );
  if (!setRes.ok()) {
    throw new Error(`deposit_percentage PATCH failed: ${setRes.status()} ${setBody?.error ?? JSON.stringify(setBody)}`);
  }
  const { customerId, locationId } = await createMaCustomerWithLocation(api);
  const { res: leadRes, body: leadBody } = await api.createLead({
    customer_id: customerId, service_request: `worked-${api.suffix}`, service_location_id: locationId,
  });
  const leadId = must(leadBody.lead, leadRes, 'createLead', leadBody).id;
  // Estimate creation is gated on a completed walkthrough (redesign §4):
  // CONTACTED → walkthrough scheduled (SALES/TECH performer) → completed.
  await api.contactLead(leadId);
  const performerId = await getOrCreatePerformer(api);
  await api.scheduleWalkthrough(leadId, {
    walkthrough_scheduled_at: api.futureDate(24),
    performer_ids: [performerId],
  });
  await api.completeWalkthrough(leadId);
  const { res: estRes, body: estBody } = await api.createEstimate({
    lead_id: leadId,
    line_items: [{ description: 'Full job', quantity: 1, unit_price: amount, is_taxable: true }],
  });
  const estimateId = must(estBody.estimate, estRes, 'createEstimate', estBody).id;
  const { res: sendRes, body: sentBody } = await api.sendEstimate(estimateId, {
    deposit_required: true, payment_methods: methods,
  });
  return {
    customerId, locationId, leadId, estimateId,
    estimate: sentBody.estimate,
    publicToken: must(sentBody.estimate?.public_token, sendRes, 'sendEstimate', sentBody),
    depositPct,
  };
}

/**
 * Schedule-only assign hop for estimate-born jobs. A job created from an estimate is born
 * UNASSIGNED (job.controller.ts estimate branch never sets status), and start() 400s unless
 * the job is SCHEDULED/ON_SITE. An empty-crew assign with a time window (explicitly valid per
 * assignJobSchema) flips UNASSIGNED→SCHEDULED with no conflicts/emails and no extra Supabase
 * Auth user per seed; the provisioned admin passes start()'s manage-all check with no assignees.
 */
export async function scheduleJobOnly(api: ApiClient, jobId: string) {
  const { res, body } = await api.assignJob(jobId, {
    assignee_ids: [], scheduled_start: api.futureDate(24), scheduled_end: api.futureDate(26),
  });
  if (!res.ok()) {
    throw new Error(`scheduleJobOnly failed: ${res.status()} ${body?.error ?? JSON.stringify(body)}`);
  }
}
