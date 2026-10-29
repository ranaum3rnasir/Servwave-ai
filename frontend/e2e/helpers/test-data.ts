import { type Page, expect } from '@playwright/test';
import { LeadsListPage } from '../pages/leads-list.page';
import { LeadFormPage } from '../pages/lead-form.page';

const TS = () => Date.now().toString(36);

// ─── Attachment Test Assets ─────────────────────────
// Files located in: frontend/e2e/fixtures/
// These are minimal valid files for testing the upload pipeline.

export type TestAttachment = {
  file: string;
  display_name: string;
  description: string;
  context: 'WALKTHROUGH' | 'JOB_WORK' | 'ESTIMATE' | 'OTHER';
};

/** Pool of realistic attachment metadata. Pick randomly or by index. */
export const ATTACHMENT_POOL: TestAttachment[] = [
  // Walkthrough / site visit photos
  {
    file: 'test-photo.jpg',
    display_name: 'Existing unit — front view',
    description: 'Current HVAC unit exterior, showing model plate and condition',
    context: 'WALKTHROUGH',
  },
  {
    file: 'test-image.png',
    display_name: 'Thermostat reading',
    description: 'Thermostat displaying 86°F with setpoint at 72°F — confirms cooling failure',
    context: 'WALKTHROUGH',
  },
  // Job work documentation
  {
    file: 'test-photo.jpg',
    display_name: 'Before — damaged pipe section',
    description: 'Burst copper pipe at basement ceiling junction, active corrosion visible',
    context: 'JOB_WORK',
  },
  {
    file: 'test-image.png',
    display_name: 'After — completed repair',
    description: 'New copper section installed, tested under pressure — no leaks',
    context: 'JOB_WORK',
  },
  {
    file: 'test-photo.jpg',
    display_name: 'Panel upgrade — before',
    description: '100A Square D panel, 30 of 40 slots used, no room for EV charger circuit',
    context: 'JOB_WORK',
  },
  {
    file: 'test-image.png',
    display_name: 'Panel upgrade — after',
    description: '200A Homeline panel installed, new 50A breaker for EV charger, permit sticker applied',
    context: 'JOB_WORK',
  },
  // Documents
  {
    file: 'test-document.pdf',
    display_name: 'Permit documentation',
    description: 'City of Austin electrical permit #2026-EL-4521, signed off by inspector',
    context: 'OTHER',
  },
  {
    file: 'test-document.pdf',
    display_name: 'Camera inspection report',
    description: 'Sewer line camera inspection — root intrusion found at 42ft mark',
    context: 'OTHER',
  },
  {
    file: 'test-document.pdf',
    display_name: 'Manufacturer warranty',
    description: 'Rheem 50-gallon water heater warranty registration — 6 year parts, 1 year labor',
    context: 'OTHER',
  },
  // Estimate supporting docs
  {
    file: 'test-photo.jpg',
    display_name: 'Ductwork condition — attic',
    description: 'Two separation points at joints near air handler, needs sealing before install',
    context: 'ESTIMATE',
  },
];

/** Pick 1-3 random attachments from the pool */
export function pickRandomAttachments(count?: number): TestAttachment[] {
  const n = count ?? (1 + Math.floor(Math.random() * 3)); // 1-3
  const shuffled = [...ATTACHMENT_POOL].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

/**
 * Create a test lead via the UI.
 * Returns the unique service request text so the test can find the lead later.
 */
export async function createTestLead(
  page: Page,
  options?: { serviceRequest?: string },
): Promise<{ serviceRequest: string; firstName: string; lastName: string }> {
  const suffix = TS();
  const TEST_NAMES = [
    { first: 'James', last: 'Johnson' },
    { first: 'Maria', last: 'Martinez' },
    { first: 'Robert', last: 'Williams' },
    { first: 'Sarah', last: 'Chen' },
    { first: 'Michael', last: 'Thompson' },
  ];
  const idx = Math.abs(suffix.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % TEST_NAMES.length;
  const firstName = TEST_NAMES[idx].first;
  const lastName = TEST_NAMES[idx].last;
  const serviceRequest =
    options?.serviceRequest ?? `E2E test service request ${suffix}`;

  const listPage = new LeadsListPage(page);
  await listPage.goto();
  await listPage.clickNewLead();

  // Wait for the form page to load
  await page.waitForURL('/leads/new');
  const formPage = new LeadFormPage(page);

  await formPage.fillNewCustomer({
    firstName,
    lastName,
    // 2026-06-10 dup-guard fix: fixed phone 409s on the 2nd inline-customer create per org
    // (no import from workflow-builders here — it would be circular; inline equivalent).
    phone: `9${String(Date.now()).slice(-9)}`,
    serviceRequest,
    address: '123 Test St',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
  });

  await formPage.submit();
  await formPage.waitForRedirect();

  return { serviceRequest, firstName, lastName };
}
