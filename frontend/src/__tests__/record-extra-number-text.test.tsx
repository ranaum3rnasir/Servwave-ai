/* =============================================================================
   #3018 - Text on an extra number stays on the record.

   Every Call and Text on a job's and a lead's customer card, tapped for real: the card's number menu, then the Text page's
   composer, then Send. Renders the ROUTED pages (the job page's Overview tab, the lead page) and the Text page's composer
   (SmsInboxView) in one router, so the tap really navigates. The API is mocked at the network edge (the axios instance); a
   Call is watched where it leaves the page (the phone tab it opens).

   The numbers on the card, for a customer whose primary is (555) 010-3002, with a Secondary (555) 010-4004 and a phone on
   their list (555) 010-6116 labelled Office:
     - the customer's primary, as it stands;
     - the customer's Secondary;
     - the record's own number, "This job only" / "This lead only";
     - a number the record changed one of the customer's to ("Changed on this job"), in the primary's place or in another
       phone's place, and the customer's own number under it ("Show the customer's phone").
   A Text on any of them but the primary as it stands opens the composer addressed to that number with the record, so the
   server texts it (or the record's changed number for a customer phone the record changed, Ran 2026-11-05) and keeps the
   text on the record. The primary keeps going by the customer, where the server texts the record's number (#3016).
   ========================================================================== */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { ALL_JOB_ACTIONS, LEAD_FIXTURE } from './helpers';
import { renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import { leadDetailElement } from '@/__tests__/harness/leadDetailPage';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread, PhoneCustomer } from '@/lib/api/communication';
import { catalogToggle } from './support/backendSwitchCatalog';

stubBrowser();

const mockApi = vi.mocked(api);
// The pages draw from the person's switches, not from the ability.

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
const LEAD_ID = LEAD_FIXTURE.id;
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';

const PRIMARY = '5550103002';
const SECONDARY = '5550104004';
const LISTED = '5550106116';
const OWN = '5550105252';

/** A person who may view and contact customers, with copying on: what most people hold. */
function meAnswer() {
  return {
    admin_box: false,
    values: {
      [catalogToggle('Copy customer phone').key]: true,
      [catalogToggle('Copy customer email').key]: true,
      [catalogToggle('Contact customers').key]: true,
      [catalogToggle('View customers').key]: true,
    },
  };
}

const CUSTOMER = {
  id: CUSTOMER_ID,
  first_name: 'John',
  last_name: 'Doe',
  company_name: null,
  email: null,
  phone: PRIMARY,
  phones: [
    { phone: PRIMARY, label: 'Mobile', extension: null, is_primary: true },
    { phone: SECONDARY, label: null, extension: null, is_primary: false },
    { phone: LISTED, label: 'Office', extension: null, is_primary: false },
  ],
  emails: [],
};

const entry = (id: string, over: Record<string, unknown>) => ({
  id,
  kind: 'PHONE',
  intent: 'ADDED',
  value: OWN,
  extension: null,
  label: null,
  overridden_field: null,
  overridden_row_id: null,
  customer_value_at_change: null,
  created_by: { id: 'u1', name: 'Dana Reyes' },
  created_at: '2026-10-05T15:00:00.000Z',
  updated_by: { id: 'u1', name: 'Dana Reyes' },
  updated_at: '2026-10-05T15:00:00.000Z',
  source_entry_id: null,
  ...over,
});

/** The record's own number, and the customer's Office phone changed on the record to (555) 010-7373. */
const OWN_AND_LIST_CHANGED = [
  entry('e0000000-0000-0000-0000-000000000001', {}),
  entry('e0000000-0000-0000-0000-000000000002', { intent: 'CHANGED', value: '5550107373', overridden_row_id: 'p1', customer_value_at_change: LISTED }),
];
/** The customer's primary changed on the record to (555) 010-5353. */
const PRIMARY_CHANGED = [
  entry('e0000000-0000-0000-0000-000000000003', { intent: 'CHANGED', value: '5550105353', overridden_field: 'phone', customer_value_at_change: PRIMARY }),
];

const jobWith = (entries: unknown[]) => ({
  id: JOB_ID,
  job_number: 'J00001',
  status: 'IN_PROGRESS',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null,
  scheduled_end: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  customer: CUSTOMER,
  contact_entries: entries,
  assignees: [],
  service_location: { id: 'l1', address_line1: '12 Main St', address_line2: null, city: 'Springfield', state: 'IL', zip: '62701' },
  estimate: null,
  invoices: [],
  linked_estimates: [],
  tags: [],
  source_plan_id: null,
  actions: ALL_JOB_ACTIONS,
  source_plan: null,
});

const leadWith = (entries: unknown[]) => ({ ...LEAD_FIXTURE, customer: { ...LEAD_FIXTURE.customer, ...CUSTOMER }, contact_entries: entries, actions: [] });

/** The same customer as the directory lists it. */
const DIRECTORY_JOHN: PhoneCustomer = {
  id: CUSTOMER_ID,
  name: 'John Doe',
  type: 'residential',
  site: 'Springfield',
  contacts: [{ id: 'ct1', name: 'John Doe', preferredLang: 'en', channels: [{ id: 'ch1', kind: 'phone', value: `+1${PRIMARY}` }] }],
};

const SMS_NUMBER = { id: 'num-1', e164: '+15550100150', sms_enabled: true, created_at: '2026-07-01T00:00:00Z' };

function Harness() {
  const [threads, setThreads] = useState<MessageThread[]>([]);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={() => {}} />;
}

type Kind = 'job' | 'lead';

function renderCard(kind: Kind, entries: unknown[]) {
  serveJobDetail({
    job: jobWith(entries),
    routes: [
      { match: (url) => url === '/api/permission-switches/me', data: meAnswer() },
      { match: (url) => url === '/api/organization', data: { phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } },
      { match: (url) => url === '/api/communication/contacts', data: { contacts: [DIRECTORY_JOHN] } },
      { match: (url) => url === `/api/customers/${CUSTOMER_ID}`, data: { customer: { jobs: [] } } },
      { match: (url) => url === '/api/communication/agents', data: { agents: [] } },
      { match: (url) => url === '/api/communication/threads', data: { threads: [] } },
      { match: (url) => url === '/api/communication/numbers', data: { numbers: [SMS_NUMBER] } },
      { match: (url) => url.startsWith('/api/leads/'), data: { lead: leadWith(entries) } },
      { match: (url) => url.includes('/api/users'), data: { users: [] } },
      { match: (url) => url.includes('/api/tags'), data: { tags: [] } },
    ],
  });
  mockApi.post.mockResolvedValue({
    data: { message: { id: 'm1', direction: 'out', body: 'Which number is best?', ts: '2026-07-13T10:00:00Z' }, threadId: 'srv-th-1' },
  });
  return renderJobDetail({
    entry: kind === 'job' ? `/jobs/${JOB_ID}` : `/leads/${LEAD_ID}`,
    wrap: (page) => (
      <Routes>
        <Route path="/jobs/:id" element={page} />
        <Route path="/leads/:id" element={leadDetailElement()} />
        <Route path="/communication/text" element={<Harness />} />
      </Routes>
    ),
  });
}

/** The customer card on the page: the job Overview's "Customer & Contact", or the lead page's Customer column. */
async function card(kind: Kind) {
  if (kind === 'job') return (await screen.findByText('Customer & Contact')).closest('div[class*="rounded-card"]') as HTMLElement;
  return (await screen.findByText('Customer', { selector: 'p' })).parentElement as HTMLElement;
}

/** Opens the menu of the number shown as `shown` on the card, first revealing the customer's own number when asked. */
async function openNumberMenu(kind: Kind, shown: string, reveal: boolean) {
  const user = userEvent.setup();
  const c = await card(kind);
  if (reveal) await user.click(await within(c).findByRole('button', { name: "Show the customer's phone" }));
  await user.click(await within(c).findByRole('button', { name: shown }));
  return user;
}

/** Taps Text in the number's menu, writes in the composer the tap opened, and sends. */
async function textFromCard(kind: Kind, shown: string, reveal: boolean) {
  const user = await openNumberMenu(kind, shown, reveal);
  await user.click(await screen.findByRole('menuitem', { name: 'Text' }));
  const panel = (await screen.findByRole('dialog')) as HTMLElement;
  await user.type(within(panel).getByPlaceholderText(/^Write a message to/), 'Which number is best?');
  const send = within(panel).getAllByRole('button', { name: /^send$/i }).at(-1)!;
  await waitFor(() => expect(send).toBeEnabled());
  await user.click(send);
  await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', expect.anything()));
  return mockApi.post.mock.calls.filter((c) => c[0] === '/api/communication/sms').map((c) => c[1]);
}

/** Taps Call in the number's menu, and reads the number and the record off the phone tab it opens. */
async function callFromCard(kind: Kind, shown: string, reveal: boolean) {
  const user = await openNumberMenu(kind, shown, reveal);
  await user.click(await screen.findByRole('menuitem', { name: 'Call' }));
  await waitFor(() => expect(window.open).toHaveBeenCalled());
  const url = new URL(String(vi.mocked(window.open).mock.calls[0]![0]), 'https://app.test');
  return { dial: url.searchParams.get('dial'), ctx: JSON.parse(url.searchParams.get('ctx') ?? '{}') };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.stubGlobal('open', vi.fn(() => null));
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000002',
        email: 'amanda@summitmech.com',
        first_name: 'Amanda',
        last_name: 'Foster',
        role: 'DISPATCHER',
        org_is_demo: true,
        organization_id: 'org-demo',
        org_features: ['phone'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BODY = 'Which number is best?';

/** Every number on the card: which entries the record has, the number shown, whether it sits under "Show the customer's phone",
 *  and the number the Text names. `null` = by the customer, not by a number. */
const CARD: { what: string; entries: unknown[]; shown: string; reveal: boolean; texts: string | null; dials: string }[] = [
  { what: "the customer's primary, as it stands", entries: OWN_AND_LIST_CHANGED, shown: '(555) 010-3002', reveal: false, texts: null, dials: PRIMARY },
  { what: "the customer's Secondary", entries: OWN_AND_LIST_CHANGED, shown: '(555) 010-4004', reveal: false, texts: '+15550104004', dials: SECONDARY },
  { what: "the record's own number, also another customer's primary", entries: OWN_AND_LIST_CHANGED, shown: '(555) 010-5252', reveal: false, texts: '+15550105252', dials: OWN },
  { what: "the record's changed number for the customer's Office phone", entries: OWN_AND_LIST_CHANGED, shown: '(555) 010-7373', reveal: false, texts: '+15550107373', dials: '5550107373' },
  { what: "the customer's Office phone under that changed number", entries: OWN_AND_LIST_CHANGED, shown: '(555) 010-6116', reveal: true, texts: '+15550106116', dials: LISTED },
  { what: "the record's changed number for the customer's primary", entries: PRIMARY_CHANGED, shown: '(555) 010-5353', reveal: false, texts: '+15550105353', dials: '5550105353' },
  { what: "the customer's primary under that changed number", entries: PRIMARY_CHANGED, shown: '(555) 010-3002', reveal: true, texts: '+15550103002', dials: PRIMARY },
];

describe.each([
  { kind: 'job' as const, record: { jobId: JOB_ID }, call: { jobId: JOB_ID, jobLabel: 'J00001' }, byCustomer: { customerId: CUSTOMER_ID, body: BODY } },
])('every number on the $kind card', ({ kind, record, byCustomer }) => {
  it.each(CARD)(`Text on $what`, async ({ entries, shown, reveal, texts }) => {
    renderCard(kind, entries);

    const sent = await textFromCard(kind, shown, reveal);

    expect(sent).toEqual([texts ? { toNumber: texts, body: BODY, ...record } : byCustomer]);
  });
});

describe.each([
  {
    kind: 'lead' as const,
    record: { leadId: LEAD_ID },
    call: { leadId: LEAD_ID, leadLabel: 'L00001' },
    byCustomer: { customerId: CUSTOMER_ID, body: BODY, leadId: LEAD_ID },
  },
])('every number on the $kind card', ({ kind, call }) => {
  it.each(CARD)(`Call on $what dials it, on the ${kind}`, async ({ entries, shown, reveal, dials }) => {
    renderCard(kind, entries);

    const placed = await callFromCard(kind, shown, reveal);

    expect(placed).toEqual({ dial: dials, ctx: { ...call, customerId: CUSTOMER_ID, customerName: 'John Doe' } });
  });
});
