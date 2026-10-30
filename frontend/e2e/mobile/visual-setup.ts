import { test as setup, expect, request } from '@playwright/test';
import fs from 'fs';
import type { APIResponse } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { e2eUserPassword } from '../helpers/workflow-builders';
import { AUTH_DIR, ORG_FILE, SESSIONS_DIR, VISUAL_FIXTURES_FILE, gateBackend } from './paths';
import { teardownLeftoverOrg } from './mobile-teardown';
import { gateCustomerEmail } from './gate-customer';
import type { VisualFixtures } from './visual-states';

const BASE = gateBackend();

/** Unwrap an ApiClient call, failing with the server's own words instead of a later undefined. */
async function must(label: string, call: Promise<{ res: APIResponse; body: any }>): Promise<any> {
  const { res, body } = await call;
  if (!res.ok()) throw new Error(`visual seed step "${label}" failed: ${res.status()} ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

/**
 * Fixed literals, never the gate's random-suffix builders: a baseline is only worth having if the
 * same source draws the same pixels tomorrow. The org is provisioned fresh for this run and nothing
 * else writes to it, so per-org numbering starts at 1 and every number on screen is the same each
 * run (the first estimate is E00001, the first invoice I00001, and so on). Neutral made-up people.
 */
const PEOPLE = {
  dana: { first_name: 'Dana', last_name: 'Whitfield', company_name: 'Whitfield Property Group', email: gateCustomerEmail('dana'), phone: '6175550142' },
  priya: { first_name: 'Priya', last_name: 'Nair', email: gateCustomerEmail('priya'), phone: '6175550187' },
  tomas: { first_name: 'Tomas', last_name: 'Eklund', email: gateCustomerEmail('tomas'), phone: '6175550163' },
};
const SITES = {
  dana: { address_line1: '77 Beacon Street', city: 'Boston', state: 'MA', zip: '02108', is_primary: true },
  priya: { address_line1: '12 Harbor Way', city: 'Salem', state: 'MA', zip: '01970', is_primary: true },
  tomas: { address_line1: '240 Lincoln Avenue', city: 'Quincy', state: 'MA', zip: '02169', is_primary: true },
};
const LINES = [
  { description: 'Condenser unit replacement - 3 ton', quantity: 1, unit_price: 2450, is_taxable: true },
  { description: 'Refrigerant recharge (R-410A), per lb', quantity: 4, unit_price: 65, is_taxable: true },
  { description: 'Labor - certified HVAC technician', quantity: 6, unit_price: 145, is_taxable: true },
];

async function customerWithSite(api: ApiClient, who: keyof typeof PEOPLE) {
  const customer = await api.createCustomer(PEOPLE[who]);
  if (!customer?.id) throw new Error(`visual seed step "create customer ${who}" returned no id`);
  const location = await api.addLocation(customer.id, SITES[who]);
  if (!location?.id) throw new Error(`visual seed step "add location ${who}" returned no id`);
  return { customerId: customer.id as string, locationId: location.id as string };
}

async function sentEstimateFor(api: ApiClient, who: keyof typeof PEOPLE, request_: string) {
  const { customerId, locationId } = await customerWithSite(api, who);
  const lead = (await must('create lead', api.createLead({ customer_id: customerId, service_request: request_, service_location_id: locationId }))).lead;
  await must('contact lead', api.contactLead(lead.id));
  const estimate = (await must('create estimate', api.createEstimate({ lead_id: lead.id, line_items: LINES, tax_rate: 0.0625, scope_notes: 'Remove and dispose of the failed rooftop condenser, set the replacement on the existing curb, braze new line set connections, pressure test and recharge.' }))).estimate;
  // mark-sent: the same first-send commit as Send, minus the email. The payment receipt ignores the
  // org's outgoing-email switch, so these people are on the provider's test inbox (gate-customer.ts).
  const sent = (await must('mark estimate sent', api.raw('post', `/api/estimates/${estimate.id}/mark-sent`, { deposit_required: false }))).estimate;
  return { customerId, locationId, leadId: lead.id as string, estimateId: estimate.id as string, estimateToken: sent.public_token as string };
}

/**
 * Provision a throwaway org of the baselines' own and seed the fixed records the screens show.
 * Its own org, not the gate's: the gate's setup seeds random names and its specs create records
 * while they run, so a baseline taken there would number and name things differently every run.
 */
setup('provision a throwaway org and seed the fixed baseline records', async () => {
  setup.setTimeout(300_000);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  if (fs.existsSync(ORG_FILE)) {
    console.log('[mobile-visual] a previous run left its throwaway org behind; tearing it down first');
    await teardownLeftoverOrg().catch((err) => console.log(`[mobile-visual] could not tear the earlier org down (${String(err)}); its id is in ${ORG_FILE}`));
  }
  fs.rmSync(SESSIONS_DIR, { recursive: true, force: true }); // sessions belong to ONE org

  const api0 = await request.newContext({ baseURL: BASE });
  const pre = await api0.post('/api/test/preflight');
  expect(pre.status(), `preflight failed (is the doored API up on ${BASE}?): ${await pre.text()}`).toBe(200);
  const prov = await api0.post('/api/test/provision-org');
  const provBody = await prov.text();
  expect(prov.status(), `provision failed: ${provBody}`).toBe(200);
  await api0.dispose();
  fs.writeFileSync(ORG_FILE, provBody);
  const org = JSON.parse(provBody) as { organizationId: string };

  const api = await new ApiClient().init();
  try {
    // 1. Dana: the whole chain to a SENT invoice with one partial payment (customer, job, invoice pages).
    const dana = await sentEstimateFor(api, 'dana', 'Rooftop condenser failed - no cooling on the second floor.');
    await must('approve estimate', api.approveEstimatePublic(dana.estimateId, dana.estimateToken, { signature_data: api.testSignature }));
    const job = (await must('create job', api.createJob({ estimate_id: dana.estimateId }))).job;
    const tech = await api.createUser({ email: 'marcus.reyes@e2e-qa.invalid', password: e2eUserPassword('baseline'), first_name: 'Marcus', last_name: 'Reyes', role: 'TECHNICIAN' });
    if (!tech.body?.user?.id) throw new Error(`visual seed step "create technician" failed: ${tech.res.status()} ${JSON.stringify(tech.body).slice(0, 300)}`);
    await must('assign job', api.assignJob(job.id, { assignee_ids: [tech.body.user.id], scheduled_start: '2026-01-07T14:00:00.000Z', scheduled_end: '2026-01-07T17:00:00.000Z', force: true }));
    await must('start job', api.startJob(job.id));
    await must('complete job', api.completeJob(job.id, 'Replaced the rooftop condenser with an equivalent 3 ton unit. Recovered the old charge, pressure tested the new line set at 400 psi, and recharged to 4 lb 6 oz per the plate.'));
    const invoice = (await must('create invoice', api.createInvoice(job.id))).invoice;
    // mark-sent: issues the DRAFT and mints its public link without emailing it (a payment link no longer does).
    const sentInvoice = (await must('mark invoice sent', api.raw('post', `/api/invoices/${invoice.id}/mark-sent`, {}))).invoice;
    await must('record payment', api.recordPayment(invoice.id, { amount: 1500, method: 'CHECK', notes: 'Check 4471, deposited same day.' }));

    // 2. Priya: a SENT estimate nobody has answered (the public estimate with Approve and Decline).
    const priya = await sentEstimateFor(api, 'priya', 'Mini-split install in the finished attic.');

    // 3. Tomas: an open, contacted lead (the lead page, its status choices, Mark Lost).
    const tomas = await customerWithSite(api, 'tomas');
    const lead = (await must('create lead', api.createLead({ customer_id: tomas.customerId, service_request: 'Furnace short-cycles on cold mornings.', service_location_id: tomas.locationId }))).lead;
    await must('contact lead', api.contactLead(lead.id));

    // 4. A draft automation with no steps, never enabled, so nothing can run or send.
    const wf = await must('create draft automation', api.raw('post', '/api/workflows', { name: 'Baseline draft automation', trigger_type: 'JOB_COMPLETED' }));
    const automationId = (wf.workflow ?? wf).id as string;

    const fixtures: VisualFixtures = {
      organizationId: org.organizationId,
      customerId: dana.customerId,
      leadId: lead.id,
      estimateOpen: { id: priya.estimateId, token: priya.estimateToken },
      invoiceOpen: { id: invoice.id, token: sentInvoice.public_token },
      jobId: job.id,
      automationId,
    };
    for (const [k, v] of Object.entries(fixtures)) {
      if (typeof v === 'string') expect(v, `fixture ${k}`).toBeTruthy();
      else expect(v.id && v.token, `fixture ${k} needs an id and a public token`).toBeTruthy();
    }
    fs.writeFileSync(VISUAL_FIXTURES_FILE, JSON.stringify(fixtures, null, 2));
  } finally {
    await api.dispose();
  }
});
