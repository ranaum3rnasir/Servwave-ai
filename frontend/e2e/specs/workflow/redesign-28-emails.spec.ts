import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import {
  maEstimateSentWithDeposit,
  leadToSentEstimate,
  fullStandardFlowToInvoiceSent,
} from '../../helpers/workflow-builders';
import { emailsEnabled, findRecentEmail, getEmailHtml } from '../../helpers/resend-assert';

/**
 * STALE as of the 2026-07-27 hard-coded → Automation Center migration (Phase 3):
 * sendJobAssignmentEmail, sendJobScheduledEmail, sendJobRescheduledEmail and
 * sendTechnicianEnRouteEmail no longer exist — job.controller.ts now dispatches
 * TECH_ASSIGNED/JOB_SCHEDULED/JOB_RESCHEDULED/JOB_EN_ROUTE automation events
 * instead. Still gated off (never runs in CI — see below), so this was left as a
 * marker rather than rewritten; rewrite against the Automation Center's
 * dispatch/seed path before ever setting E2E_ASSERT_EMAILS=1.
 *
 * Stage E — Email assertions (catalog rows SEL-32 / DLV-22 / COL-23).
 *
 * WRITTEN 2026-06-10, NOT YET EXECUTED; default-skipped pending the
 * email-assertion strategy decision (catalog Wave 3: "Resend list-emails vs
 * accept-untested"). Every test opens with
 *   test.skip(!emailsEnabled(), …)
 * so the suite is a no-op until BOTH `E2E_ASSERT_EMAILS=1` and
 * `RESEND_API_KEY` are exported in the shell running Playwright (the test
 * process does NOT read backend/.env — see helpers/resend-assert.ts header).
 * The backend itself must also have RESEND_API_KEY set or every send is a
 * silent no-op (backend/src/lib/email.ts:15).
 *
 * Subjects asserted VERBATIM from backend/src/lib/email.ts:
 *   `Estimate ${n} from ${org.name}`            (:458, sendEstimateEmail)
 *   `Estimate ${n} — Deposit Required`          (:706, sendEstimateWithDepositEmail)
 *   `New Job Assignment: ${jobNumber}`          (:604, sendJobAssignmentEmail)
 *   `Service Scheduled: ${jobNumber}`           (:640, sendJobScheduledEmail)
 *   `Job ${jobNumber} Rescheduled`              (:1322, sendJobRescheduledEmail)
 *   `Payment Received — Invoice ${n}`           (:1470, sendPaymentReceivedEmail)
 *   `Invoice ${n} — Paid in Full`               (:1519, sendInvoicePaidEmail — webhook path ONLY)
 *   'The technician is on the way'              (:1642, sendTechnicianEnRouteEmail)
 *
 * Trigger sites verified:
 *   - estimate.controller.ts:1237/1257 — recipient is the LEAD'S CUSTOMER email;
 *     deposit variant only on FIRST send with deposit_required + a deposit invoice.
 *   - job.controller.ts assign(): tech assignment always (tech.email); customer
 *     'Service Scheduled' only from UNASSIGNED; 'Rescheduled' only when status is
 *     already SCHEDULED AND a scheduled_start is present in the body (a tech swap
 *     that omits scheduled_start/scheduled_end sends NO customer email).
 *   - job.controller.ts enRoute() (:1322) — customer email; time formatted WITHOUT
 *     a timeZone arg (lib/email.ts:1604-1608) → server-default zone (UTC on
 *     Render). The other scheduling emails use formatDateTimeInZone(org tz).
 *   - invoice.controller.ts:1044 (manual record-payment) sends ONLY
 *     'Payment Received'; webhook.controller.ts:391+:401 sends BOTH
 *     'Payment Received' AND 'Paid in Full' — the documented asymmetry
 *     (segments/04-collect-invoice-payment.md §2 step 3b: "paid-in-full receipt,
 *     webhook path only — manual full payment sends only 'payment received'").
 *
 * Conventions: ONE shared provisioned org, serial (workers:1). Data accumulates —
 * all assertions are presence/absence of a UNIQUELY-SCOPED email (subjects carry
 * the per-seed E#/J#/I# number AND every lookup pins the unique
 * `…@e2e-qa.invalid` recipient), never an absolute count. @e2e-qa.invalid
 * recipients BOUNCE; sends still appear in Resend as attempts — we assert the
 * attempt exists, never delivery (no last_event filtering).
 *
 * Absence assertions (DLV-22b tech-swap, COL-23b manual leg) are inherently
 * timing-bound: we can only prove "no email surfaced in Resend within the bounded
 * window", not "never will". Each absence check is paired with a positive control
 * sent through the same plumbing inside the same window, and uses skewMs:0 so the
 * clock-skew pad cannot reach back into a prior legitimate send.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

// ─── Local seed helpers (documented ApiClient surface only) ──────────────────

/** Resolve the seeded customer's @e2e-qa.invalid address from a builder ctx. */
async function customerEmailOf(customerId: string): Promise<string> {
  const customer = await api.getCustomer(customerId);
  expect(customer?.email, 'seeded customer has an email').toBeTruthy();
  return customer.email as string;
}

/** Create a TECHNICIAN keeping the unique email in hand (createTech() drops it). */
async function createTechWithEmail(): Promise<{ techId: string; techEmail: string }> {
  const s = api.suffix;
  const techEmail = `tech-${s}@e2e-qa.invalid`;
  const { res, body } = await api.createUser({
    email: techEmail, password: 'Test123!@#',
    first_name: 'Tech', last_name: s, role: 'TECHNICIAN',
  });
  expect(res.status(), 'seed tech create').toBe(201);
  return { techId: body.user.id as string, techEmail };
}

/**
 * Seed an UNASSIGNED no-estimate job whose customer email we control (mirrors
 * workflow-builders.noEstimateJobWithAttachments minus attachments/assign).
 */
async function seedUnassignedJob() {
  const s = api.suffix;
  const customerEmail = `cust-${s}@e2e-qa.invalid`;
  const customer = await api.createCustomer({
    first_name: `Mail-${s}`, last_name: 'Customer',
    email: customerEmail, phone: '5551230000',
  });
  const location = await api.addLocation(customer.id, {
    address_line1: `${Math.floor(Math.random() * 9999)} Mail St`,
    city: 'Austin', state: 'TX', zip: '78701', is_primary: true,
  });
  const { body: leadBody } = await api.createLead({
    customer_id: customer.id, service_request: `email-assert ${s}`,
    service_location_id: location.id,
  });
  await api.contactLead(leadBody.lead.id);
  const { res: jobRes, body: jobBody } = await api.createJob({
    customer_id: customer.id, service_location_id: location.id,
  });
  expect(jobRes.status(), 'seed job create').toBe(201);
  return {
    customerId: customer.id as string,
    customerEmail,
    jobId: jobBody.job.id as string,
    jobNumber: jobBody.job.job_number as string,
  };
}

// ─── DLV-22c time plumbing (org tz = America/New_York for the provisioned org:
//     Organization.timezone defaults to it and getOrgTimezone() falls back to
//     DEFAULT_TIMEZONE='America/New_York' — backend/src/lib/timezone.ts) ───────

const ORG_TZ = 'America/New_York';

/** Signed offset minutes of America/New_York at a UTC instant (EDT=-240, EST=-300). */
function nyOffsetMinutesAt(utcInstant: Date): number {
  const tzPart = new Intl.DateTimeFormat('en-US', { timeZone: ORG_TZ, timeZoneName: 'shortOffset' })
    .formatToParts(utcInstant)
    .find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzPart);
  const sign = m?.[1];
  const hours = m?.[2];
  if (!sign || !hours) throw new Error(`Cannot parse America/New_York offset from "${tzPart}"`);
  return (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(m?.[3] ?? '0'));
}

/**
 * UTC instant for "tomorrow 15:00 wall-clock in America/New_York", DST-robust.
 *
 * Math (made explicit per the probe spec):
 *   EDT (2nd Sun Mar → 1st Sun Nov, UTC-4): 15:00 NY == 19:00 UTC → UTC render "7:00 PM"
 *   EST (rest of year,          UTC-5): 15:00 NY == 20:00 UTC → UTC render "8:00 PM"
 * Two-pass offset resolution: probe the offset at the naive instant, rebuild, and
 * re-probe — so a run that straddles a DST flip between "now" and "tomorrow 15:00"
 * still lands on the exact wall-clock instant.
 */
function tomorrow3pmNewYorkUtc(): Date {
  const nyDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: ORG_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + 24 * 3_600_000)); // "YYYY-MM-DD" as seen in NY
  const [y, mo, d] = nyDate.split('-').map(Number);
  if (!y || !mo || !d) throw new Error(`Bad NY calendar date "${nyDate}"`);
  const wallAsUtcMs = Date.UTC(y, mo - 1, d, 15, 0, 0);
  let offsetMin = nyOffsetMinutesAt(new Date(wallAsUtcMs));
  let instantMs = wallAsUtcMs - offsetMin * 60_000;
  const secondPass = nyOffsetMinutesAt(new Date(instantMs));
  if (secondPass !== offsetMin) {
    offsetMin = secondPass;
    instantMs = wallAsUtcMs - offsetMin * 60_000;
  }
  return new Date(instantMs);
}

/** EXACT formatter from lib/email.ts:1605 (hour numeric, minute 2-digit, hour12). */
function timeLabel(date: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/** Node 20 ICU emits U+202F (narrow NBSP) before AM/PM — normalize space flavors for compare. */
const normSpace = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ').trim();

const SKIP_MSG = 'email assertions disabled — set E2E_ASSERT_EMAILS=1 + RESEND_API_KEY';

test.describe('Stage E — Email assertions (SEL-32 / DLV-22 / COL-23)', () => {
  // ─── SEL-32a ───────────────────────────────────────────────────────────────
  test('SEL-32a: send estimate WITH deposit → "Deposit Required" email to the customer', async () => {
    test.skip(!emailsEnabled(), SKIP_MSG);
    test.setTimeout(150_000);

    const t0 = Date.now();
    // maEstimateSentWithDeposit performs the send as its last step — t0 captured first.
    const ctx = await maEstimateSentWithDeposit(api, 10_000, 30);
    const custEmail = await customerEmailOf(ctx.customerId);
    const estimateNumber = ctx.estimate.estimate_number as string;

    // Verbatim subject (email.ts:706): `Estimate ${n} — Deposit Required` (em-dash).
    // Scoped beyond the task's bare 'Deposit Required' with the unique E# because the
    // Resend account is shared across environments.
    const email = await findRecentEmail({
      subjectIncludes: `Estimate ${estimateNumber} — Deposit Required`,
      to: custEmail,
      sinceMs: t0,
    });
    expect(email, `deposit-required email for ${estimateNumber} reaches ${custEmail}`).not.toBeNull();
    expect(email!.to.map((t) => t.toLowerCase())).toContain(custEmail.toLowerCase());
  });

  // ─── SEL-32b ───────────────────────────────────────────────────────────────
  test('SEL-32b: send estimate WITHOUT deposit → plain estimate email to the customer', async () => {
    test.skip(!emailsEnabled(), SKIP_MSG);
    test.setTimeout(150_000);

    const t0 = Date.now();
    const ctx = await leadToSentEstimate(api); // deposit defaults to false
    const custEmail = await customerEmailOf(ctx.customerId);
    const estimateNumber = ctx.estimate.estimate_number as string;

    // Verbatim subject (email.ts:458): `Estimate ${n} from ${org.name}`. The provisioned
    // org's name is generated, so match on the stable prefix `Estimate E# from` — the
    // ' from ' makes it disjoint from the '— Deposit Required' variant.
    const email = await findRecentEmail({
      subjectIncludes: `Estimate ${estimateNumber} from`,
      to: custEmail,
      sinceMs: t0,
    });
    expect(email, `plain estimate email for ${estimateNumber} reaches ${custEmail}`).not.toBeNull();
  });

  // ─── DLV-22a ───────────────────────────────────────────────────────────────
  test('DLV-22a: first assign with dates → assignment email to tech AND scheduled email to customer', async () => {
    test.skip(!emailsEnabled(), SKIP_MSG);
    test.setTimeout(150_000);

    const seed = await seedUnassignedJob();
    const { techId, techEmail } = await createTechWithEmail();

    const t0 = Date.now();
    const assigned = await api.assignJob(seed.jobId, {
      assignee_ids: [techId],
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });
    expect(assigned.res.status(), 'assign').toBe(200);

    // Verbatim (email.ts:604) — to the TECHNICIAN (job.controller.ts:868).
    const assignmentEmail = await findRecentEmail({
      subjectIncludes: `New Job Assignment: ${seed.jobNumber}`,
      to: techEmail,
      sinceMs: t0,
    });
    expect(assignmentEmail, `assignment email for ${seed.jobNumber} reaches tech ${techEmail}`).not.toBeNull();

    // Verbatim (email.ts:640) — to the CUSTOMER, fired only on the UNASSIGNED→SCHEDULED
    // first assign (job.controller.ts:881).
    const scheduledEmail = await findRecentEmail({
      subjectIncludes: `Service Scheduled: ${seed.jobNumber}`,
      to: seed.customerEmail,
      sinceMs: t0,
    });
    expect(scheduledEmail, `scheduled email for ${seed.jobNumber} reaches customer ${seed.customerEmail}`).not.toBeNull();
  });

  // ─── DLV-22b ───────────────────────────────────────────────────────────────
  test('DLV-22b: rescheduled email only when a new scheduled_start is supplied (tech swap stays silent)', async () => {
    test.skip(!emailsEnabled(), SKIP_MSG);
    test.setTimeout(240_000);

    const seed = await seedUnassignedJob();
    const tech1 = await createTechWithEmail();
    const tech2 = await createTechWithEmail();

    // First assign → SCHEDULED (fires assignment+scheduled; not asserted here).
    const first = await api.assignJob(seed.jobId, {
      assignee_ids: [tech1.techId],
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });
    expect(first.res.status(), 'initial assign').toBe(200);

    // ── Absence leg FIRST (so no legitimate Rescheduled email for this J# exists yet,
    //    making the absence check immune to clock skew by construction). Tech swap
    //    only: assignJobSchema allows omitting BOTH scheduled_start and scheduled_end,
    //    and the controller only fires sendJobRescheduledEmail when status==='SCHEDULED'
    //    AND a scheduled_start is in the body (job.controller.ts:900) — note it keys on
    //    the field's PRESENCE, not on the value actually changing.
    const tSwap = Date.now();
    const swap = await api.assignJob(seed.jobId, { assignee_ids: [tech2.techId] });
    expect(swap.res.status(), 'tech swap (no dates)').toBe(200);

    // Positive control INSIDE the absence window: the swap DOES email the new tech
    // (assignment email has no schedule precondition) — proves email plumbing was live
    // while we assert the customer email's absence.
    const controlEmail = await findRecentEmail({
      subjectIncludes: `New Job Assignment: ${seed.jobNumber}`,
      to: tech2.techEmail,
      sinceMs: tSwap,
    });
    expect(controlEmail, 'positive control: swap assignment email reached the new tech').not.toBeNull();

    // Presence-of-absence: no Rescheduled email for THIS job/customer since the swap.
    // skewMs:0 so the pad cannot reach earlier traffic; short extra budget since the
    // positive control already burned the realistic propagation delay. CAVEAT: this is
    // a bounded-window proof — a pathologically slow send could surface after the
    // window closes; accepted as inherent to black-box email assertion.
    const ghost = await findRecentEmail({
      subjectIncludes: `Job ${seed.jobNumber} Rescheduled`,
      to: seed.customerEmail,
      sinceMs: tSwap,
      skewMs: 0,
      timeoutMs: 6_000,
    });
    expect(ghost, 'tech swap without a new start must NOT email the customer a Rescheduled notice').toBeNull();

    // ── Presence leg: re-assign with a NEW scheduled_start (schema requires start+end
    //    together) → verbatim subject `Job ${n} Rescheduled` (email.ts:1322).
    const tResched = Date.now();
    const resched = await api.assignJob(seed.jobId, {
      assignee_ids: [tech2.techId],
      scheduled_start: api.futureDate(72),
      scheduled_end: api.futureDate(74),
    });
    expect(resched.res.status(), 're-assign with new start').toBe(200);

    const reschedEmail = await findRecentEmail({
      subjectIncludes: `Job ${seed.jobNumber} Rescheduled`,
      to: seed.customerEmail,
      sinceMs: tResched,
    });
    expect(reschedEmail, `rescheduled email for ${seed.jobNumber} reaches customer ${seed.customerEmail}`).not.toBeNull();
  });

  // ─── DLV-22c (en-route email renders in the org timezone, map §6.6) ────────
  test('DLV-22c: en-route email renders the scheduled time in the org timezone', async () => {
    test.skip(!emailsEnabled(), SKIP_MSG);
    test.setTimeout(150_000);

    // Seed a job scheduled at a KNOWN org-local wall clock: tomorrow 15:00 America/New_York.
    //   EDT (UTC-4): instant = 19:00Z; EST (UTC-5): instant = 20:00Z.
    //   org-rendered label is "3:00 PM" in BOTH cases.
    const scheduledStart = tomorrow3pmNewYorkUtc();
    const scheduledEnd = new Date(scheduledStart.getTime() + 2 * 3_600_000);

    const seed = await seedUnassignedJob();
    const { techId } = await createTechWithEmail();
    const assigned = await api.assignJob(seed.jobId, {
      assignee_ids: [techId],
      scheduled_start: scheduledStart.toISOString(),
      scheduled_end: scheduledEnd.toISOString(),
    });
    expect(assigned.res.status(), 'assign at 15:00 NY').toBe(200);

    // Fire en-route as the provisioned ADMIN (manage-all bypasses the assigned-tech
    // gate — job.controller.ts:1291). No ApiClient wrapper exists → raw().
    const t0 = Date.now();
    const enRoute = await api.raw('post', `/api/jobs/${seed.jobId}/en-route`);
    expect(enRoute.res.status(), 'en-route').toBe(200);

    // Static subject (email.ts:1642) — NOT unique, so the unique recipient + sinceMs
    // carry the scoping on the shared Resend account.
    const email = await findRecentEmail({
      subjectIncludes: 'The technician is on the way',
      to: seed.customerEmail,
      sinceMs: t0,
    });
    expect(email, `en-route email reaches customer ${seed.customerEmail}`).not.toBeNull();

    const html = await getEmailHtml(email!.id);
    expect(html, 'en-route email has html').toBeTruthy();

    // Extract the rendered Scheduled Time cell (email.ts:1630-1635 markup).
    const m = /Scheduled Time<\/span><br>\s*<span[^>]*>([^<]+)<\/span>/.exec(html!);
    expect(m?.[1], 'Scheduled Time block present in en-route html').toBeTruthy();
    const rendered = normSpace(m![1]!);

    // sendTechnicianEnRouteEmail now formats the scheduled time in the org timezone
    // (lib/email.ts), like every other scheduling email. For a 15:00 America/New_York
    // appointment the customer sees "3:00 PM" regardless of the server's zone.
    const orgRendered = normSpace(timeLabel(scheduledStart, ORG_TZ));       // org-zone label ("3:00 PM")

    expect(rendered, 'en-route time renders in the org timezone').toBe(orgRendered);
  });

  // ─── COL-23a ───────────────────────────────────────────────────────────────
  test('COL-23a: manual full payment on a SENT invoice → "Payment Received" email to the customer', async () => {
    test.skip(!emailsEnabled(), SKIP_MSG);
    test.setTimeout(240_000);

    const ctx = await fullStandardFlowToInvoiceSent(api); // long chain: lead→…→invoice SENT
    const custEmail = await customerEmailOf(ctx.customerId);
    const invoiceNumber = ctx.invoice.invoice_number as string;
    const due = Number(ctx.invoice.amount_due);
    expect(due, 'SENT invoice has a balance').toBeGreaterThan(0);

    const t0 = Date.now();
    const paid = await api.recordPayment(ctx.invoiceId, { amount: due, method: 'CHECK' });
    expect(paid.res.status(), 'record full payment').toBe(201);
    expect(paid.body.invoice.status).toBe('PAID');

    // Verbatim subject (email.ts:1470): `Payment Received — Invoice ${n}` (em-dash).
    const email = await findRecentEmail({
      subjectIncludes: `Payment Received — Invoice ${invoiceNumber}`,
      to: custEmail,
      sinceMs: t0,
    });
    expect(email, `payment-received email for ${invoiceNumber} reaches ${custEmail}`).not.toBeNull();
  });

  // ─── COL-23b ───────────────────────────────────────────────────────────────
  test('COL-23b: paid-in-full receipt is webhook-only — manual full payment never sends it', async () => {
    test.skip(!emailsEnabled(), SKIP_MSG);
    test.setTimeout(300_000); // two full seed chains + four bounded email polls

    // ── Leg 1: webhook-paid invoice → BOTH receipts (webhook.controller.ts:391 + :401).
    // The /api/test/stripe-webhook door replays through processStripeEvent — the EXACT
    // post-signature code that fires the emails — and the event amount must equal
    // amount_due in cents, face value (checkoutCents matches that verification).
    const hook = await fullStandardFlowToInvoiceSent(api);
    const hookCustEmail = await customerEmailOf(hook.customerId);
    const hookInvoiceNumber = hook.invoice.invoice_number as string;
    const hookDue = Number(hook.invoice.amount_due);
    expect(hookDue, 'webhook-leg invoice has a balance').toBeGreaterThan(0);

    const tHook = Date.now();
    const ev = api.depositPaidEvent(hook.invoiceId, api.checkoutCents(hookDue), {
      eventId: `evt_col23b_${api.suffix}`,
      paymentIntent: `pi_col23b_${api.suffix}`,
    });
    const fired = await api.fireStripeEvent(ev);
    expect(fired.body.received, 'webhook door accepted the event').toBe(true);
    expect((await api.getInvoice(hook.invoiceId)).status).toBe('PAID');

    const hookReceived = await findRecentEmail({
      subjectIncludes: `Payment Received — Invoice ${hookInvoiceNumber}`,
      to: hookCustEmail,
      sinceMs: tHook,
    });
    expect(hookReceived, 'webhook leg: payment-received email found').not.toBeNull();

    // Verbatim subject (email.ts:1519): `Invoice ${n} — Paid in Full` (em-dash).
    const hookPaidInFull = await findRecentEmail({
      subjectIncludes: `Invoice ${hookInvoiceNumber} — Paid in Full`,
      to: hookCustEmail,
      sinceMs: tHook,
    });
    expect(hookPaidInFull, 'webhook leg: paid-in-full receipt found (webhook-only email)').not.toBeNull();

    // ── Leg 2: MANUAL full payment → 'Payment Received' only; the paid-in-full call
    // site simply does not exist on this path (invoice.controller.ts:1038-1066;
    // segments/04 §2 step 3b). Fresh seed → fresh unique I#, so the absence lookup
    // cannot collide with leg 1's emails.
    const man = await fullStandardFlowToInvoiceSent(api);
    const manCustEmail = await customerEmailOf(man.customerId);
    const manInvoiceNumber = man.invoice.invoice_number as string;
    const manDue = Number(man.invoice.amount_due);
    expect(manDue, 'manual-leg invoice has a balance').toBeGreaterThan(0);

    const tMan = Date.now();
    const paid = await api.recordPayment(man.invoiceId, { amount: manDue, method: 'CASH' });
    expect(paid.res.status(), 'manual full payment').toBe(201);
    expect(paid.body.invoice.status).toBe('PAID');

    // Positive control inside the absence window: the SAME action's received-receipt
    // arrives, proving plumbing was live when we then assert the absence.
    const manReceived = await findRecentEmail({
      subjectIncludes: `Payment Received — Invoice ${manInvoiceNumber}`,
      to: manCustEmail,
      sinceMs: tMan,
    });
    expect(manReceived, 'manual leg: payment-received email found').not.toBeNull();

    // Bounded absence (skewMs:0; short residual budget since the control already
    // absorbed propagation delay). Same inherent timing caveat as DLV-22b.
    const manPaidInFull = await findRecentEmail({
      subjectIncludes: `Invoice ${manInvoiceNumber} — Paid in Full`,
      to: manCustEmail,
      sinceMs: tMan,
      skewMs: 0,
      timeoutMs: 6_000,
    });
    expect(manPaidInFull, 'manual full payment must NOT send the paid-in-full receipt').toBeNull();
  });
});
