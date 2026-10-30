import type { APIResponse } from '@playwright/test';
import type { ApiClient } from '../helpers/api-client';
import { createTech, e2eUserPassword } from '../helpers/workflow-builders';
import { gateCustomerWithLocation } from './gate-customer';
import { BOARD_JOB_SLOT, BOARD_TIMEZONE_FALLBACK, BOARD_WALKTHROUGH_SLOT, bookedAt, jobEnd, type BoardSlot, type Booking } from './schedule-booking';
import type { GateFixtures } from './routes';

/** Unwrap an ApiClient call, failing with the server's own words instead of a later undefined. */
async function must(label: string, call: Promise<{ res: APIResponse; body: any }>): Promise<any> {
  const { res, body } = await call;
  if (!res.ok()) throw new Error(`seed step "${label}" failed: ${res.status()} ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

/**
 * When a visit starts (schedule-booking.ts). A 'board' visit sits at a fixed hour of the ORG's day,
 * and the Schedule draws the org's day in the org's own zone, so the zone is read from the org (the
 * throwaway org has none, which the page answers with its fallback; so does this).
 */
async function visitStart(api: ApiClient, booking: Booking, slot: BoardSlot): Promise<Date> {
  let timeZone = BOARD_TIMEZONE_FALLBACK;
  if (booking === 'board') {
    const { res, body } = await api.raw('get', '/api/organization');
    if (res.ok() && typeof body?.timezone === 'string' && body.timezone) timeZone = body.timezone;
  }
  return bookedAt(booking, slot, timeZone);
}

const LINES = [
  { description: 'Service call', quantity: 1, unit_price: 180, is_taxable: true },
  { description: 'Replacement part', quantity: 2, unit_price: 65, is_taxable: true },
];

/**
 * Customer -> lead -> walkthrough done -> estimate SENT. Neutral names only. Exported for
 * signature.spec.ts, which signs and submits a fresh one per device (never the shared key-route one).
 *
 * `booking` says where the walkthrough sits on the Schedule (schedule-booking.ts). A spec that
 * builds its own record leaves it alone: 'apart' is a day of its own, far ahead, so the shared
 * board does not gain a double-booked card per device, retry and repeat. Only `seedGateFixtures`
 * asks for the 'board'.
 */
export async function sentEstimate(api: ApiClient, techId: string, booking: Booking = 'apart') {
  const { customerId, locationId } = await gateCustomerWithLocation(api);
  const lead = (await must('create lead', api.createLead({ customer_id: customerId, service_request: 'Gate check visit', service_location_id: locationId }))).lead;
  await must('contact lead', api.contactLead(lead.id));
  await must('schedule walkthrough', api.scheduleWalkthrough(lead.id, { walkthrough_scheduled_at: (await visitStart(api, booking, BOARD_WALKTHROUGH_SLOT)).toISOString(), performer_ids: [techId] }));
  await must('complete walkthrough', api.completeWalkthrough(lead.id));
  const estimate = (await must('create estimate', api.createEstimate({ lead_id: lead.id, line_items: LINES, tax_rate: 0.0625, scope_notes: 'Gate check estimate' }))).estimate;
  // mark-sent: the same first-send commit as Send, minus the email. The throwaway org has outgoing
  // email off, but the payment receipt ignores that switch, so the customer is on the provider's
  // test inbox (gate-customer.ts): whatever mail the org does send is delivered there, never bounced.
  const sent = (await must('mark estimate sent', api.raw('post', `/api/estimates/${estimate.id}/mark-sent`, { deposit_required: false }))).estimate;
  return { customerId, locationId, leadId: lead.id as string, estimateId: estimate.id as string, estimateToken: sent.public_token as string };
}

/** ...then approved on its public page and turned into a job assigned to the technician (booked like the estimate's walkthrough). */
export async function scheduledJob(api: ApiClient, techId: string, booking: Booking = 'apart') {
  const e = await sentEstimate(api, techId, booking);
  await must('approve estimate', api.approveEstimatePublic(e.estimateId, e.estimateToken, { signature_data: api.testSignature }));
  const job = (await must('create job', api.createJob({ estimate_id: e.estimateId }))).job;
  const start = await visitStart(api, booking, BOARD_JOB_SLOT);
  await must('assign job', api.assignJob(job.id, { assignee_ids: [techId], scheduled_start: start.toISOString(), scheduled_end: jobEnd(start).toISOString(), force: true }));
  return { ...e, jobId: job.id as string };
}

/** ...then started, completed and invoiced; the invoice SENT (open) or also paid in cash. */
export async function invoicedJob(api: ApiClient, techId: string, paid: boolean) {
  const j = await scheduledJob(api, techId, 'board');
  await must('start job', api.startJob(j.jobId));
  await must('complete job', api.completeJob(j.jobId, 'Work finished and checked with the customer.'));
  const invoice = (await must('create invoice', api.createInvoice(j.jobId))).invoice;
  // mark-sent: issues the DRAFT and mints its public link without emailing it. (A payment link used to
  // do this; since the payments W4 change it keeps the invoice a DRAFT, and the Void Invoice and Issue
  // Credit cases need an issued one. src/__tests__/mobile-gate-seed-invoices.test.ts holds the rule.)
  const sent = (await must('mark invoice sent', api.raw('post', `/api/invoices/${invoice.id}/mark-sent`, {}))).invoice;
  if (paid) await must('record payment', api.recordPayment(invoice.id, { amount: Number(sent.amount_due), method: 'CASH', notes: 'Paid on site' }));
  return { ...j, invoiceId: invoice.id as string, invoiceToken: sent.public_token as string };
}

/**
 * A few tax rates, so /settings/tax-rates measures real rows (name, rate, visibility switch,
 * delete): the audit counted 104 targets under 24 px there (slice 25). Neutral names only.
 */
async function taxRates(api: ApiClient) {
  for (const [name, rate] of [['Gate rate A', 0.0625], ['Gate rate B', 0.08], ['Gate rate C', 0.045]] as const) {
    await must(`create tax rate ${name}`, api.raw('post', '/api/org-tax-rates', { name, rate }));
  }
}

/** A draft automation with no steps, never enabled, so nothing can run or send (`/automations/:id`, slice 62). */
async function draftAutomation(api: ApiClient) {
  const body = await must('create draft automation', api.raw('post', '/api/workflows', { name: 'Gate draft automation', trigger_type: 'JOB_COMPLETED' }));
  const id = (body.workflow ?? body).id as string;
  if (!id) throw new Error(`seed step "create draft automation": no id in ${JSON.stringify(body).slice(0, 300)}`);
  return id;
}

/**
 * The technician the Lighthouse run signs in as (slice 62). Its own login: a global sign-out in the
 * measured browser then revokes only this user's sessions, never the admin the gate's workers share.
 */
async function lighthouseTech(api: ApiClient) {
  const s = api.suffix;
  const email = `lh-tech-${s}@e2e-qa.invalid`;
  const password = e2eUserPassword(s);
  const { res, body } = await api.createUser({ email, password, first_name: 'Lighthouse', last_name: s, role: 'TECHNICIAN' });
  if (!body?.user?.id) throw new Error(`seed step "create lighthouse technician" failed: ${res.status()} ${body?.error ?? JSON.stringify(body)}`);
  return { lighthouseTechEmail: email, lighthouseTechPassword: password };
}

/** Seed the records the key routes open, in the provisioned throwaway org. */
export async function seedGateFixtures(api: ApiClient, organizationId: string): Promise<GateFixtures> {
  const techId = await createTech(api);
  await taxRates(api);
  const automationId = await draftAutomation(api);
  const lh = await lighthouseTech(api);
  const paid = await invoicedJob(api, techId, true);
  const open = await invoicedJob(api, techId, false);
  const scheduled = await scheduledJob(api, techId, 'board');
  const estimate = await sentEstimate(api, techId, 'board');
  return {
    organizationId,
    automationId,
    ...lh,
    techId,
    leadId: estimate.leadId,
    customerId: paid.customerId,
    jobId: scheduled.jobId,
    estimateOpen: { id: estimate.estimateId, token: estimate.estimateToken },
    estimateWon: { id: paid.estimateId, token: paid.estimateToken },
    invoiceOpen: { id: open.invoiceId, token: open.invoiceToken },
    invoicePaid: { id: paid.invoiceId, token: paid.invoiceToken },
  };
}
