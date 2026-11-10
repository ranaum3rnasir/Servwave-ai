/* =============================================================================
   #3018 - Text on a customer's Secondary phone texts the Secondary, on the CUSTOMER page too (acceptance line 2 is not
   limited to a lead's or a job's card).

   The customer page's Contact Details, tapped for real: the number's menu, Text, then the Text page's text box, then Send.
   Renders the ROUTED customer page and the Text page (SmsInboxView) in one router, so the tap really navigates. The API is
   mocked at the network edge only (the app's HTTP client).

   Jordan Lee's primary is (555) 010-3002 and their Secondary (555) 010-4004. Each number has its own conversation with our
   main line (555) 010-0000 (#3019: a conversation is the other party's number plus ours). Text on a number opens the
   conversation the server names for that number - the one the inbox and a lead's card continue for it (#3023) - else New
   message to that number; the line above the box names the number, the send goes to it, and the toast names it.
   The Primary keeps going by the customer, as before.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import CustomerDetailPage from '@/pages/v2/customers/CustomerDetailPage';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread, PhoneCustomer, SendingNumbers } from '@/lib/api/communication';
import { catalogToggle } from './support/backendSwitchCatalog';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000003018';
const PRIMARY_E164 = '+15550103002';
const SECONDARY_E164 = '+15550104004';
const MAIN_LINE = '+15550100000';
const PRIMARYS = 'a0000000-0000-0000-0000-000000003002';
const SECONDARYS = 'a0000000-0000-0000-0000-000000004004';
const BODY = 'Which number is best?';

/** A person who may view and contact customers, with copying on. */
const ME = {
  admin_box: false,
  values: {
    [catalogToggle('Copy customer phone').key]: true,
    [catalogToggle('Copy customer email').key]: true,
    [catalogToggle('Contact customers').key]: true,
    [catalogToggle('View communication').key]: true,
    [catalogToggle('View customers').key]: true,
  },
};

const CUSTOMER_DETAIL = {
  customer: {
    id: CUSTOMER_ID,
    customer_number: 'C03018',
    first_name: 'Jordan',
    last_name: 'Lee',
    company_name: null,
    email: null,
    phone: '5550103002',
    phone_ext: null,
    secondary_phone: '5550104004',
    secondary_phone_ext: null,
    ad_source: null,
    allow_billing: false,
    tax_exempt: false,
    payment_type: null,
    extra_emails: [],
    custom_fields: {},
    created_at: '2026-01-01T00:00:00.000Z',
    archived_at: null,
    is_active: true,
    tags: [],
    service_locations: [],
    _count: { leads: 0, jobs: 0 },
    jobs: [],
    activity_notes: [],
    orphan_invoices: [],
    invoices: [],
  },
  summary: {
    financials: { lifetime_revenue: 0, total_invoiced: 0, past_due_balance: 0, due_balance: 0, paid_invoice_count: 0, unpaid_invoice_count: 0 },
    estimates: { total: 0, pending: 0, approved: 0, total_value: 0 },
    deposits: { collected: 0, pending: 0 },
    leads: { open: 0, active: 0 },
    tasks: { open: 0 },
  },
};

const DIRECTORY_JORDAN: PhoneCustomer = {
  id: CUSTOMER_ID,
  name: 'Jordan Lee',
  type: 'residential',
  site: 'Austin',
  contacts: [{ id: 'ct1', name: 'Jordan Lee', preferredLang: 'en', channels: [{ id: 'ch1', kind: 'phone', value: PRIMARY_E164 }] }],
};

/** The conversation between `otherParty` and our main line, holding one text from the customer. */
function conversation(id: string, otherParty: string, body: string): MessageThread {
  return {
    id,
    customerId: CUSTOMER_ID,
    linkedCustomer: { id: CUSTOMER_ID, name: 'Jordan Lee' },
    channel: 'sms',
    campaignType: 'customer_care',
    unread: 0,
    messages: [{ id: `${id}-m`, direction: 'in', body, ts: '2026-11-05T15:00:00Z', status: 'received' }],
    pair: { otherPartyE164: otherParty, ourNumberE164: MAIN_LINE, ourLine: { kind: 'main_line' }, customers: [{ id: CUSTOMER_ID, name: 'Jordan Lee' }] },
  };
}
const ON_THE_PRIMARY = conversation(PRIMARYS, PRIMARY_E164, 'Primary here, see you Monday');
const ON_THE_SECONDARY = conversation(SECONDARYS, SECONDARY_E164, 'Secondary here, call after five');

/** The conversations the server lists. */
let listed: MessageThread[] = [];

/** What the server's line answers for the fields a text box names (GET /api/communication/sms/numbers). */
function lineAnswer(params: Record<string, string>): SendingNumbers & { conversationId: string | null } {
  const continues = (n: string) => listed.find((t) => t.pair?.otherPartyE164 === n)?.id ?? null;
  const toward = (n: string) => ({ to: n, from: MAIN_LINE, fromIsYours: false, noLongerInUse: null, cannotSendTexts: null, conversationId: continues(n) });
  if (params.threadId) return { ...toward(listed.find((t) => t.id === params.threadId)!.pair!.otherPartyE164), conversationId: params.threadId };
  if (params.customerId) return toward(PRIMARY_E164);
  const digits = String(params.toNumber).replace(/\D/g, '').slice(-10);
  return toward(`+1${digits}`);
}

const toasts: string[] = [];

function TextPage() {
  const [threads, setThreads] = useState<MessageThread[]>(listed);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={(m) => toasts.push(m)} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  toasts.length = 0;
  listed = [];
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
  mockApi.get.mockImplementation(async (url: string, config?: { params?: Record<string, string> }) => {
    if (url === '/api/permission-switches/me') return { data: ME };
    if (url === '/api/organization') return { data: { id: 'org-demo', timezone: 'America/New_York', phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } };
    if (url === '/api/communication/contacts') return { data: { contacts: [DIRECTORY_JORDAN] } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: listed } };
    if (url === '/api/communication/sms/numbers') return { data: lineAnswer(config?.params ?? {}) };
    if (url === `/api/customers/${CUSTOMER_ID}`) return { data: CUSTOMER_DETAIL };
    if (url === '/api/leads') return { data: { leads: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } } };
    return { data: {} };
  });
  // The send answers with the conversation the server filed the text in and the number it went to.
  mockApi.post.mockImplementation(async (_url: string, args?: unknown) => {
    const a = args as Record<string, string>;
    const to = a.threadId ? listed.find((t) => t.id === a.threadId)!.pair!.otherPartyE164 : a.toNumber ?? PRIMARY_E164;
    return {
      data: {
        message: { id: 'm-out', direction: 'out', body: a.body, ts: '2026-11-06T10:00:00Z', status: 'sent' },
        delivery: 'sent',
        threadId: a.threadId ?? (to === SECONDARY_E164 ? SECONDARYS : PRIMARYS),
        to,
      },
    };
  });
});

/** The open conversation on the Text page. */
const conversationPane = () => document.querySelector('[data-pane="thread"]') as HTMLElement;

const sends = () => mockApi.post.mock.calls.filter(([url]) => url === '/api/communication/sms').map(([, args]) => args);

/** Opens the customer page, taps the number shown as `shown` in Contact Details, then Text. */
async function textOnTheCustomerPage(shown: string) {
  const user = userEvent.setup();
  renderWithProviders(
    <Routes>
      <Route path="/customers/:id" element={<CustomerDetailPage />} />
      <Route path="/communication/text" element={<TextPage />} />
    </Routes>,
    { initialEntries: [`/customers/${CUSTOMER_ID}`], ability: adminAbility },
  );
  const details = within((await screen.findByText('Contact Details')).parentElement as HTMLElement);
  await user.click(await details.findByRole('button', { name: shown }));
  await user.click(await screen.findByRole('menuitem', { name: 'Text' }));
  return user;
}

/** Writes in the text box found by its placeholder and presses its Send. */
async function writeAndSend(user: ReturnType<typeof userEvent.setup>, placeholder: RegExp) {
  const box = await screen.findByPlaceholderText(placeholder);
  await waitFor(() => expect(box).toBeEnabled());
  await user.type(box, BODY);
  const send = screen.getAllByRole('button', { name: /^send$/i }).at(-1)!;
  await waitFor(() => expect(send).toBeEnabled());
  await user.click(send);
  await waitFor(() => expect(sends()).toHaveLength(1));
}

describe("Text on the customer's Secondary, on the customer page", () => {
  it("opens the Secondary's own conversation, the line names the Secondary, and the reply goes to it", async () => {
    // Listed first, the primary's conversation is the one the Text page would show if nothing opened the Secondary's.
    listed = [ON_THE_PRIMARY, ON_THE_SECONDARY];
    const user = await textOnTheCustomerPage('(555) 010-4004');

    await waitFor(() => expect(within(conversationPane()).getByText('Secondary here, call after five')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(conversationPane()).queryByText('Primary here, see you Monday')).toBeNull();
    expect((await within(conversationPane()).findByText(/^Texting/)).textContent).toBe('Texting (555) 010-4004 from (555) 010-0000');
    await writeAndSend(user, /Type an SMS reply/);

    expect(sends()).toEqual([{ threadId: SECONDARYS, body: BODY }]);
  });

  it('with no conversation on the Secondary yet, opens New message to the Secondary, which texts it and the toast names it', async () => {
    listed = [ON_THE_PRIMARY];
    const user = await textOnTheCustomerPage('(555) 010-4004');

    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByText(/^Texting/)).textContent).toBe('Texting (555) 010-4004 from (555) 010-0000');
    await writeAndSend(user, /^Write a message to/);

    expect(sends()).toEqual([{ toNumber: SECONDARY_E164, body: BODY }]);
    await waitFor(() => expect(toasts).toContain('✉️ Message sent to (555) 010-4004'));
  });
});

describe("Text on the customer's Primary, on the customer page (unchanged)", () => {
  it("opens the primary's conversation and the reply goes to the primary", async () => {
    listed = [ON_THE_SECONDARY, ON_THE_PRIMARY];
    const user = await textOnTheCustomerPage('(555) 010-3002');

    await waitFor(() => expect(within(conversationPane()).getByText('Primary here, see you Monday')).toBeInTheDocument());
    expect(within(conversationPane()).queryByText('Secondary here, call after five')).toBeNull();
    expect((await within(conversationPane()).findByText(/^Texting/)).textContent).toBe('Texting (555) 010-3002 from (555) 010-0000');
    await writeAndSend(user, /Type an SMS reply/);

    expect(sends()).toEqual([{ threadId: PRIMARYS, body: BODY }]);
  });

  it('with no conversation yet, opens New message to the customer, sent by the customer', async () => {
    listed = [];
    const user = await textOnTheCustomerPage('(555) 010-3002');

    await writeAndSend(user, /^Write a message to Jordan Lee/);

    expect(sends()).toEqual([{ customerId: CUSTOMER_ID, body: BODY }]);
    await waitFor(() => expect(toasts).toContain('✉️ Message sent to Jordan Lee'));
  });
});
