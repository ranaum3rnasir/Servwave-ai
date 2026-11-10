/* =============================================================================
   Roles & Permissions, PRD 5 (scenario pass 1): Text on a customer's phone lands on the in-app composer already
   addressed to that phone, for a person who may contact customers but may not view them.

   Renders the ROUTED pages (the job page's Overview tab, the invoice page's phone menu) and the Text page's composer
   (SmsInboxView) in one router, so the tap really navigates. The customer directory and a customer's own record
   answer 403 to a person without View customers; the test counts every request for them.

   The person's switches come from the "Me" answer, keyed by the catalog's own keys. Every case is a custom switch
   set, never a built-in role name.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, ALL_JOB_ACTIONS } from './helpers';
import { renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import { invoiceDetailElement } from '@/__tests__/harness/invoiceDetailPage';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread, PhoneCustomer } from '@/lib/api/communication';
import { usePhoneCustomers } from '@/lib/api/communication';
import { catalogToggle } from './support/backendSwitchCatalog';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));

stubBrowser();

const mockApi = vi.mocked(api);
// The pages draw from the person's switches, not from the ability.

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const NUMBER = '5551234567';
const E164 = '+15551234567';

type Switches = { copyPhone: boolean; contact: boolean; view: boolean };

/** The "Me" answer for a person holding exactly these switches (the others read as off). */
function meAnswer(s: Switches) {
  return {
    admin_box: false,
    values: {
      [catalogToggle('Copy customer phone').key]: s.copyPhone,
      [catalogToggle('Contact customers').key]: s.contact,
      [catalogToggle('View customers').key]: s.view,
    },
  };
}

const CUSTOMER = {
  id: CUSTOMER_ID,
  first_name: 'John',
  last_name: 'Doe',
  company_name: null,
  email: null,
  phone: NUMBER,
  phones: [{ phone: NUMBER, label: 'Mobile', extension: null, is_primary: true }],
  emails: [],
};

const JOB = {
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
  assignees: [],
  service_location: { id: 'l1', address_line1: '12 Main St', address_line2: null, city: 'Springfield', state: 'IL', zip: '62701' },
  estimate: null,
  invoices: [],
  linked_estimates: [],
  tags: [],
  source_plan_id: null,
  actions: ALL_JOB_ACTIONS,
  source_plan: null,
};

const INVOICE = {
  id: 'i0000000-0000-0000-0000-000000000001',
  invoice_number: 'I00001',
  status: 'DRAFT',
  kind: 'STANDARD',
  subtotal: 100, discount_amount: 0, tax_rate: 0, tax_amount: 0, tip: 0, deposit_credit: 0,
  total_amount: 100, amount_due: 100, net_collected: 0,
  public_token: null, sent_at: null, paid_at: null, due_date: null, voided_at: null, voided_reason: null,
  refunded_at: null, total_refunded: null, refund_reason: null, refund_reason_category: null,
  created_at: '2026-01-15T00:00:00.000Z', updated_at: '2026-01-15T00:00:00.000Z',
  line_items: [], scopes: [], payments: [], refunds: [], credits: [], tags: [],
  job: null, estimate: null,
  customer: { id: CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: null, email: null, phone: NUMBER },
};

/** The same customer as the directory lists it, for a person who may view customers. */
const DIRECTORY_JOHN: PhoneCustomer = {
  id: CUSTOMER_ID,
  name: 'John Doe',
  type: 'residential',
  site: 'Springfield',
  contacts: [{ id: 'ct1', name: 'John Doe', preferredLang: 'en', channels: [{ id: 'ch1', kind: 'phone', value: E164 }] }],
};

const SMS_NUMBER = { id: 'num-1', e164: '+15512827064', sms_enabled: true, created_at: '2026-07-01T00:00:00Z' };

/** The conversations the server lists for the person. */
let serverThreads: MessageThread[] = [];

function Harness() {
  const [threads, setThreads] = useState<MessageThread[]>(serverThreads);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={() => {}} />;
}

/** Every URL asked for, so a request that must not happen can be counted. */
const asked = () => mockApi.get.mock.calls.map((c) => String(c[0]));
const askedForCustomers = () =>
  asked().filter((url) => url === '/api/communication/contacts' || url === `/api/customers/${CUSTOMER_ID}`);

function renderAt(path: string, switches: Switches) {
  /** What the server answers a person without View customers. */
  const refusedWithoutView = (answer: () => unknown) => () => {
    if (!switches.view) throw { response: { status: 403, data: { error: 'Insufficient permissions' } } };
    return answer();
  };
  serveJobDetail({
    jobId: JOB_ID,
    job: JOB,
    routes: [
      { match: (url) => url === '/api/permission-switches/me', data: meAnswer(switches) },
      { match: (url) => url === '/api/organization', data: { phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } },
      { match: (url) => url === '/api/communication/contacts', data: refusedWithoutView(() => ({ contacts: [DIRECTORY_JOHN] })) },
      { match: (url) => url === `/api/customers/${CUSTOMER_ID}`, data: refusedWithoutView(() => ({ customer: { jobs: [] } })) },
      { match: (url) => url === '/api/communication/agents', data: { agents: [] } },
      { match: (url) => url === '/api/communication/threads', data: () => ({ threads: serverThreads }) },
      { match: (url) => url === '/api/communication/numbers', data: { numbers: [SMS_NUMBER] } },
      { match: (url) => url.startsWith('/api/invoices/'), data: { invoice: INVOICE } },
    ],
  });
  mockApi.post.mockResolvedValue({
    data: { message: { id: 'm1', direction: 'out', body: 'On my way', ts: '2026-07-13T10:00:00Z' }, threadId: 'srv-th-1' },
  });
  return renderJobDetail({
    entry: path,
    wrap: (page) => (
      <Routes>
        <Route path="/jobs/:id" element={page} />
        <Route path="/invoices/:id" element={invoiceDetailElement()} />
        <Route path="/communication/text" element={<Harness />} />
      </Routes>
    ),
  });
}

/** The composer's panel, and its footer Send button (the inbox has its own Send). */
const composer = async () => (await screen.findByRole('dialog')) as HTMLElement;
const sendButton = (panel: HTMLElement) => within(panel.querySelector('[role="dialog"]') ?? panel).getAllByRole('button', { name: /^send$/i }).at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  serverThreads = [];
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'tech@test.com',
        first_name: 'Test',
        last_name: 'Tech',
        role: 'TECHNICIAN',
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

const NO_VIEW: Switches = { copyPhone: false, contact: true, view: false };

describe('Text from the job page, for a person who may contact customers but not view them', () => {
  it('opens the composer addressed to the customer with the number filled, and the text is filed on the job', async () => {
    const user = userEvent.setup();
    renderAt(`/jobs/${JOB_ID}`, NO_VIEW);

    const card = (await screen.findByText('Customer & Contact')).closest('div[class*="rounded-card"]') as HTMLElement;
    await user.click(await within(card).findByRole('button', { name: 'Text' }));

    const panel = await composer();
    expect(within(panel).getByText('To: John Doe')).toBeInTheDocument();
    // The number is filled in: the customer's, not a search box to search the directory.
    expect(within(panel).getByText('(555) 123-4567')).toBeInTheDocument();
    expect(within(panel).queryByText('No matches.')).not.toBeInTheDocument();

    await user.type(within(panel).getByPlaceholderText('Write a message to John Doe…'), 'On my way');
    await waitFor(() => expect(sendButton(panel)).toBeEnabled());
    await user.click(sendButton(panel));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', { toNumber: E164, body: 'On my way', jobId: JOB_ID }),
    );
  });

  it('never asks for the customer directory or the customer record, which would answer 403', async () => {
    const user = userEvent.setup();
    renderAt(`/jobs/${JOB_ID}`, NO_VIEW);

    const card = (await screen.findByText('Customer & Contact')).closest('div[class*="rounded-card"]') as HTMLElement;
    await user.click(await within(card).findByRole('button', { name: 'Text' }));
    await composer();

    expect(askedForCustomers()).toEqual([]);
  });

  it('draws the number in the composer unselectable with Copy customer phone off, and selectable with it on', async () => {
    const user = userEvent.setup();
    const { unmount } = renderAt(`/jobs/${JOB_ID}`, NO_VIEW);
    let card = (await screen.findByText('Customer & Contact')).closest('div[class*="rounded-card"]') as HTMLElement;
    await user.click(await within(card).findByRole('button', { name: 'Text' }));
    let panel = await composer();
    expect(within(panel).getByText('(555) 123-4567').className).toContain('select-none');
    unmount();

    localStorage.clear();
    renderAt(`/jobs/${JOB_ID}`, { ...NO_VIEW, copyPhone: true });
    card = (await screen.findByText('Customer & Contact')).closest('div[class*="rounded-card"]') as HTMLElement;
    await user.click(await within(card).findByRole('button', { name: 'Text' }));
    panel = await composer();
    expect(within(panel).getByText('(555) 123-4567').className).not.toContain('select-none');
  });
});

describe('Text from the invoice page phone menu, for a person who may contact customers but not view them', () => {
  it('opens the composer addressed to the tapped number, asking for no customer record', async () => {
    const user = userEvent.setup();
    renderAt(`/invoices/${INVOICE.id}`, NO_VIEW);

    await user.click(await screen.findByRole('button', { name: '(555) 123-4567' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Text' }));

    const panel = await composer();
    expect(within(panel).getByText('To: John Doe')).toBeInTheDocument();
    await user.type(within(panel).getByPlaceholderText('Write a message to John Doe…'), 'On my way');
    await waitFor(() => expect(sendButton(panel)).toBeEnabled());
    await user.click(sendButton(panel));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', { toNumber: E164, body: 'On my way' }),
    );
    expect(askedForCustomers()).toEqual([]);
  });
});

describe('Text from the job page, for a person who may view customers', () => {
  it('opens the composer addressed to the number the job shows, and the text is filed on the job (#3017)', async () => {
    const user = userEvent.setup();
    renderAt(`/jobs/${JOB_ID}`, { copyPhone: true, contact: true, view: true });

    const card = (await screen.findByText('Customer & Contact')).closest('div[class*="rounded-card"]') as HTMLElement;
    await user.click(await within(card).findByRole('button', { name: 'Text' }));

    const panel = await composer();
    expect(await within(panel).findByText('To: John Doe')).toBeInTheDocument();
    expect(within(panel).getByText('(555) 123-4567')).toBeInTheDocument();

    await user.type(within(panel).getByPlaceholderText('Write a message to John Doe…'), 'On my way');
    await waitFor(() => expect(sendButton(panel)).toBeEnabled());
    await user.click(sendButton(panel));
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', { toNumber: E164, body: 'On my way', jobId: JOB_ID }),
    );
  });
});

describe('refused reads on the Communication pages', () => {
  const CUSTOMER_THREAD: MessageThread = {
    id: 'srv-john-1',
    customerId: CUSTOMER_ID,
    channel: 'sms',
    campaignType: 'customer_care',
    unread: 0,
    messages: [{ id: 'm0', direction: 'in', body: 'Are you coming today?', ts: '2026-07-09T14:00:00Z', status: 'received' }],
  };

  it('does not ask for the customer record when a text conversation tied to a customer opens, without View customers', async () => {
    serverThreads = [CUSTOMER_THREAD];
    renderAt(`/communication/text?threadId=${CUSTOMER_THREAD.id}`, NO_VIEW);

    await screen.findAllByText('Are you coming today?');
    await waitFor(() => expect(asked()).toContain('/api/communication/threads'));

    expect(askedForCustomers()).toEqual([]);
  });

  it('asks for the customer record when the same conversation opens for a person who may view customers', async () => {
    serverThreads = [CUSTOMER_THREAD];
    renderAt(`/communication/text?threadId=${CUSTOMER_THREAD.id}`, { copyPhone: true, contact: true, view: true });

    await screen.findAllByText('Are you coming today?');

    await waitFor(() => expect(asked()).toContain(`/api/customers/${CUSTOMER_ID}`));
  });

  function DirectoryReader() {
    usePhoneCustomers();
    return null;
  }

  it('does not ask for the customer directory without View customers, and does with it', async () => {
    const { unmount } = (() => {
      mockApi.get.mockImplementation(async (url: string) =>
        url === '/api/permission-switches/me' ? { data: meAnswer(NO_VIEW) } : { data: { contacts: [] } });
      return renderWithProviders(<DirectoryReader />);
    })();
    await waitFor(() => expect(asked()).toContain('/api/permission-switches/me'));
    // Give the query the chance it would take.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked()).not.toContain('/api/communication/contacts');
    unmount();

    localStorage.clear();
    vi.clearAllMocks();
    mockApi.get.mockImplementation(async (url: string) =>
      url === '/api/permission-switches/me' ? { data: meAnswer({ copyPhone: false, contact: true, view: true }) } : { data: { contacts: [] } });
    renderWithProviders(<DirectoryReader />);
    await waitFor(() => expect(asked()).toContain('/api/communication/contacts'));
  });
});
