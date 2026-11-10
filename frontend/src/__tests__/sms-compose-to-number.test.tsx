// Slice H7 FE — compose to an arbitrary number + Text-page deep links +
// unknown-thread create affordance.
//
// Contract under test:
//   • The New-message dialog gains a free "To" number entry: a valid NA number
//     jumps to the compose pane and Send posts { toNumber: <E.164>, body };
//     the server-resolved threadId becomes the opened conversation. A 409
//     surfaces INSIDE the dialog through smsSendErrorMessage (dialog stays
//     open — there is no conversation to fall back to).
//   • /communication/text?to=<number> opens the composer prefilled (normalized
//     first); ?customerId= selects that customer's thread when one exists,
//     else opens the composer with the customer preselected.
//   • An open unknown-number thread (title-keyed: no customer, no vendor)
//     shows "Unknown number" + Create lead / Create job in the header (each
//     only with its Create + Show pair, S02.27; Create customer is gone),
//     linking to /leads/new?phone=<e164> / /jobs/new?phone=<e164>; its
//     composer replies by threadId (it has no customerId).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, communicationSectionAbility } from './helpers';
import type { AbilityRule } from '@/lib/ability';
import { JOB_PAIR, LEAD_PAIR, personCopiedFrom, personHolding } from './support/unknownNumberPerson';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread, PhoneCustomer } from '@/lib/api/communication';
import { MY_SWITCHES_URL, VIEWS_CUSTOMERS_ANSWER } from './support/viewsCustomers';

const mockApi = vi.mocked(api);

const CUST_ID = 'c0000000-0000-0000-0000-000000000077';
const E164 = '+12015550123';

const PAT: PhoneCustomer = {
  id: CUST_ID,
  name: 'Pat Lee',
  type: 'residential',
  site: 'Austin',
  contacts: [
    {
      id: 'ct1',
      name: 'Pat Lee',
      preferredLang: 'en',
      channels: [{ id: 'ch1', kind: 'phone', value: '+12015550999' }],
    },
  ],
};

// n-search: a roster customer whose ONLY phones live in customer_phones[] —
// contacts[].channels[] carries no phone data (nothing writes it in practice).
// RIVER_PHONE is phones[0] (becomes primaryPhone/the displayed number);
// RIVER_SECONDARY_PHONE is a SECOND, non-primary number (e.g. the customer's
// cell on file alongside an office line) — a dispatcher may search by either.
const RIVER_ID = 'c0000000-0000-0000-0000-000000000088';
const RIVER_PHONE = '+16095557781';
const RIVER_SECONDARY_PHONE = '+12015550100';
const RIVER: PhoneCustomer = {
  id: RIVER_ID,
  name: 'River Chen',
  type: 'residential',
  site: 'Newark',
  contacts: [{ id: 'ct2', name: 'River Chen', preferredLang: 'en', channels: [] }],
  phones: [RIVER_PHONE, RIVER_SECONDARY_PHONE],
};

const PAT_THREAD: MessageThread = {
  id: 'srv-pat-1',
  customerId: CUST_ID,
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: [
    { id: 'mp1', direction: 'out', body: 'See you Thursday.', ts: '2026-07-09T14:00:00Z', status: 'sent' },
  ],
};

// A title-keyed unknown-number thread (no customer, no vendor) — what the CTM
// webhook ingest creates for an unmatched inbound text.
const UNKNOWN_THREAD: MessageThread = {
  id: 'srv-unknown-1',
  customerId: '',
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  title: E164,
  messages: [
    { id: 'mu1', direction: 'in', body: 'Do you service garage doors?', ts: '2026-07-09T15:00:00Z', status: 'received' },
  ],
};

const SMS_NUMBER = {
  id: 'num-1',
  e164: '+15512827064',
  sms_enabled: true,
  created_at: '2026-07-01T00:00:00Z',
};

function mockComms({
  serverThreads = [] as MessageThread[],
  contacts = [] as PhoneCustomer[],
} = {}) {
  mockApi.get.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    if (url === MY_SWITCHES_URL) return VIEWS_CUSTOMERS_ANSWER;
    if (url === '/api/organization') return { data: { phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } };
    if (url === '/api/communication/contacts') return { data: { contacts } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: serverThreads } };
    if (url === '/api/communication/numbers') return { data: { numbers: [SMS_NUMBER] } };
    // #3023: the line above a text box names the conversation it continues; for a customer, the server's choice (here the
    // customer's one conversation), which Text on the customer opens.
    if (url === '/api/communication/sms/numbers') {
      const p = (config?.params ?? {}) as Record<string, string>;
      return { data: { conversationId: p.threadId ?? serverThreads.find((t) => t.customerId === p.customerId)?.id ?? null } };
    }
    return { data: {} };
  });
}

/** Stateful harness — the inbox mutates threads through setThreads. */
function Harness({
  initial = [] as MessageThread[],
  onToast = () => {},
}: {
  initial?: MessageThread[];
  onToast?: (m: string) => void;
}) {
  const [threads, setThreads] = useState<MessageThread[]>(initial);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={onToast} />;
}

/** Location probe for asserting create-form navigation targets. */
function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname + loc.search}</div>;
}

/** The dialog's footer Send button (the main composer has its own Send). */
function dialogSendButton() {
  const footer = screen.getByRole('button', { name: 'Cancel' }).parentElement!;
  return within(footer).getByRole('button', { name: /send/i });
}

/** The New-message dialog's own panel — scopes queries away from the main
 *  inbox's left-pane roster, which renders the SAME customer name/subtitle
 *  text for its thread-less "person" rows (both derive from buildRecipients).
 *  The dialog composes ui/modal (Radix Dialog), which gives its content panel
 *  role="dialog" — a stable anchor independent of the modal's internal DOM. */
function dialogPanel() {
  return screen.getByRole('dialog') as HTMLElement;
}

/** The inbox's left-pane thread/roster list — scopes queries away from the
 *  conversation pane and right-rail context panel, which also render the
 *  open customer's name. */
function leftPaneList() {
  return document.querySelector('.min-h-0.flex-1.overflow-y-auto') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  // A `phone`-entitled org → useFeature('phone') true, so the thread-directory
  // query runs (the ?customerId= composer fallback waits on isFetched).
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
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

describe('SmsInboxView — compose to an arbitrary number', () => {
  it('sends { toNumber, body }, opens the server-resolved thread, closes the dialog', async () => {
    mockComms();
    mockApi.post.mockResolvedValue({
      data: {
        message: { id: 'm-new-1', direction: 'out', body: 'Hi there', ts: '2026-07-13T10:00:00Z' },
        threadId: 'srv-th-9',
      },
    });
    renderWithProviders(<Harness />, { ability: communicationSectionAbility() });

    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    const numberInput = screen.getByLabelText('To phone number');
    fireEvent.change(numberInput, { target: { value: '(201) 555-0123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use number' }));

    // Compose pane addressed to the formatted number.
    expect(screen.getByText('To: (201) 555-0123')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Write a message to (201) 555-0123…'), {
      target: { value: 'Hi there' },
    });
    fireEvent.click(dialogSendButton());

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', {
        toNumber: E164,
        body: 'Hi there',
      }),
    );
    // Dialog closed; the conversation (titled by the number) is open with the bubble.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument(),
    );
    // The thread (titled by the number) is open: list row + header + bubble.
    expect(screen.getAllByText('(201) 555-0123').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Hi there').length).toBeGreaterThan(0);
  });

  it('keeps the dialog open on a 409 and surfaces the mapped reason inline', async () => {
    mockComms();
    mockApi.post.mockRejectedValue({
      response: {
        data: {
          error: 'Number is not on the outbound test allowlist',
          code: 'NOT_IN_TEST_ALLOWLIST',
        },
      },
    });
    renderWithProviders(<Harness />, { ability: communicationSectionAbility() });

    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    fireEvent.change(screen.getByLabelText('To phone number'), {
      target: { value: '2015550123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use number' }));
    fireEvent.change(screen.getByPlaceholderText('Write a message to (201) 555-0123…'), {
      target: { value: 'Blocked text' },
    });
    fireEvent.click(dialogSendButton());

    expect(await screen.findByText("This number isn't on the test allowlist")).toBeInTheDocument();
    // Still in the dialog — the draft survives for a retry.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Write a message to (201) 555-0123…')).toHaveValue('Blocked text');
  });

  it('disables "Use number" until the entry normalizes to a NA number', async () => {
    mockComms();
    renderWithProviders(<Harness />, { ability: communicationSectionAbility() });

    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    const useBtn = screen.getByRole('button', { name: 'Use number' });
    expect(useBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText('To phone number'), { target: { value: '12345' } });
    expect(useBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText('To phone number'), {
      target: { value: '201-555-0123' },
    });
    expect(useBtn).toBeEnabled();
  });
});

describe('Text page deep links', () => {
  it('?to=<number> opens the composer prefilled with the normalized number', async () => {
    mockComms();
    renderWithProviders(<Harness />, {
      initialEntries: [`/communication/text?to=${encodeURIComponent(E164)}`],
      ability: communicationSectionAbility(),
    });

    expect(await screen.findByText('To: (201) 555-0123')).toBeInTheDocument();
    expect(screen.getByText('New number')).toBeInTheDocument();
  });

  it('?customerId= selects that customer’s existing thread', async () => {
    mockComms({ serverThreads: [UNKNOWN_THREAD, PAT_THREAD], contacts: [PAT] });
    renderWithProviders(<Harness initial={[UNKNOWN_THREAD, PAT_THREAD]} />, {
      initialEntries: [`/communication/text?customerId=${CUST_ID}`],
      ability: communicationSectionAbility(),
    });

    // Pat's thread becomes the OPEN one — the right rail shows her site.
    expect(await screen.findByText('Austin')).toBeInTheDocument();
    expect(screen.queryByText('Unknown number')).not.toBeInTheDocument();
  });

  it('?customerId= with no existing thread opens the composer with the customer preselected', async () => {
    mockComms({ serverThreads: [], contacts: [PAT] });
    renderWithProviders(<Harness />, {
      initialEntries: [`/communication/text?customerId=${CUST_ID}`],
      ability: communicationSectionAbility(),
    });

    expect(await screen.findByText('To: Pat Lee')).toBeInTheDocument();
  });
});

describe('Unknown-number thread affordance', () => {
  // Roles & Permissions S02.27 - Create customer is gone for everyone; Create lead and Create job follow Create + Show.
  const COMMUNICATION_RULES: AbilityRule[] = [
    { action: 'read', subject: 'Communication' },
    { action: 'create', subject: 'Communication' },
    { action: 'access_inbox', subject: 'Communication' },
  ];

  function renderUnknownThreadAs(person: ReturnType<typeof personHolding>) {
    person.seed();
    mockComms({ serverThreads: [UNKNOWN_THREAD] });
    // The server's answer to the person's own switches agrees with what was seeded as the last-known one.
    const commsAnswer = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, ...rest: unknown[]) =>
      url === '/api/permission-switches/me'
        ? { data: { admin_box: false, values: person.values, rules: [] } }
        : (commsAnswer as (u: string, ...r: unknown[]) => Promise<unknown>)(url, ...rest));
    return renderWithProviders(
      <Routes>
        <Route path="/communication/text" element={<Harness initial={[UNKNOWN_THREAD]} />} />
        <Route path="/leads/new" element={<Probe />} />
        <Route path="/jobs/new" element={<Probe />} />
        <Route path="/customers/new" element={<Probe />} />
      </Routes>,
      { initialEntries: ['/communication/text'], ability: person.ability },
    );
  }

  const createButtons = () => ({
    customer: screen.queryByRole('button', { name: /create customer/i }),
    lead: screen.queryByRole('button', { name: /create lead/i }),
    job: screen.queryByRole('button', { name: /create job/i }),
  });

  beforeEach(() => localStorage.clear());

  it('offers Create lead with Create leads + View leads, opening /leads/new?phone=<e164>', async () => {
    renderUnknownThreadAs(personHolding(LEAD_PAIR, COMMUNICATION_RULES));

    expect(await screen.findByText('Unknown number')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /create lead/i }));
    expect(await screen.findByTestId('probe')).toHaveTextContent(`/leads/new?phone=${encodeURIComponent(E164)}`);
  });

  it('offers Create job with Create jobs + View jobs, opening /jobs/new?phone=<e164>', async () => {
    renderUnknownThreadAs(personHolding(JOB_PAIR, COMMUNICATION_RULES));

    fireEvent.click(await screen.findByRole('button', { name: /create job/i }));
    expect(await screen.findByTestId('probe')).toHaveTextContent(`/jobs/new?phone=${encodeURIComponent(E164)}`);
  });

  it('never offers Create customer, whatever the person holds', async () => {
    renderUnknownThreadAs(personHolding(
      [...LEAD_PAIR, ...JOB_PAIR, 'Create customers', 'View customers'],
      [...COMMUNICATION_RULES, { action: 'manage', subject: 'all' }],
    ));

    await screen.findByRole('button', { name: /create lead/i });
    expect(createButtons().customer).not.toBeInTheDocument();
  });

  it.each([
    ['Create leads without View leads', ['Create leads']],
    ['View leads without Create leads', ['View leads']],
    ['Create jobs without View jobs', ['Create jobs']],
    ['View jobs without Create jobs', ['View jobs']],
  ])('offers nothing for %s', async (_name, held) => {
    // Create without its View is a set the catalog refuses (Create needs View), kept on purpose: it proves the screen asks for both.
    const onPurpose = held[0]!.startsWith('Create') ? { impossibleOnPurpose: 'PENDING RAN: Create without its View can no longer be held; keep or drop this row' } : {};
    renderUnknownThreadAs(personHolding(held, COMMUNICATION_RULES, onPurpose));

    expect(await screen.findByText('Unknown number')).toBeInTheDocument();
    // The person's answer has to be in before an absent button means anything: a held pair always draws its own.
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    const { customer, lead, job } = createButtons();
    expect([customer, lead, job]).toEqual([null, null, null]);
  });

  it("shows Create lead only for the Sales preset's values", async () => {
    renderUnknownThreadAs(personCopiedFrom('SALES', COMMUNICATION_RULES));

    await screen.findByRole('button', { name: /create lead/i });
    const { customer, job } = createButtons();
    expect(job).not.toBeInTheDocument();
    expect(customer).not.toBeInTheDocument();
  });

  it('shows both buttons for the Dispatcher and Technician presets, and the Admin preset', async () => {
    for (const role of ['ADMIN', 'DISPATCHER', 'TECHNICIAN'] as const) {
      const { unmount } = renderUnknownThreadAs(personCopiedFrom(role, COMMUNICATION_RULES));
      expect(await screen.findByRole('button', { name: /create lead/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create job/i })).toBeInTheDocument();
      unmount();
    }
  });

  it('shows the number and no create button for a person who holds neither pair', async () => {
    renderUnknownThreadAs(personHolding([], COMMUNICATION_RULES));

    expect(await screen.findByText('Unknown number')).toBeInTheDocument();
    // The thread title carries the number itself.
    expect(screen.getAllByText(/\(201\) 555-0123/).length).toBeGreaterThan(0);
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(createButtons()).toEqual({ customer: null, lead: null, job: null });
  });

  it('replies to an unknown-number thread by threadId (it has no customerId)', async () => {
    mockComms({ serverThreads: [UNKNOWN_THREAD] });
    mockApi.post.mockResolvedValue({
      data: {
        message: { id: 'm-reply-1', direction: 'out', body: 'Yes we do!', ts: '2026-07-13T10:05:00Z' },
      },
    });
    renderWithProviders(<Harness initial={[UNKNOWN_THREAD]} />, { ability: communicationSectionAbility() });

    const input = await screen.findByPlaceholderText('Type an SMS reply…');
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'Yes we do!' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', {
        threadId: UNKNOWN_THREAD.id,
        body: 'Yes we do!',
      }),
    );
  });

  it('shows NO affordance on a linked-customer thread', async () => {
    mockComms({ serverThreads: [PAT_THREAD], contacts: [PAT] });
    renderWithProviders(<Harness initial={[PAT_THREAD]} />, { ability: communicationSectionAbility() });

    expect((await screen.findAllByText('Pat Lee')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Unknown number')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create customer/i })).not.toBeInTheDocument();
  });
});

describe('SmsInboxView — 409 on a customer send does not create a phantom thread (s1d)', () => {
  it('customer path: a 409 leaves the customer a thread-less person row, no success toast', async () => {
    mockComms({ contacts: [PAT] }); // no server thread for Pat yet
    mockApi.post.mockRejectedValue({
      response: {
        data: {
          error: 'Number is not on the outbound test allowlist',
          code: 'NOT_IN_TEST_ALLOWLIST',
        },
      },
    });
    const onToast = vi.fn();
    renderWithProviders(<Harness onToast={onToast} />, { ability: communicationSectionAbility() });

    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    fireEvent.click(within(dialogPanel()).getByText('Pat Lee'));
    fireEvent.change(screen.getByPlaceholderText('Write a message to Pat Lee…'), {
      target: { value: 'Hello Pat' },
    });
    fireEvent.click(dialogSendButton());

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', {
        customerId: CUST_ID,
        body: 'Hello Pat',
      }),
    );
    // Dialog closes on error too (existing behavior) — Pat stays a plain,
    // thread-less "Text" row in the main list: no phantom thread was created.
    // (A phantom thread would replace her person row with a THREAD row,
    // which never shows the "Text" action badge.)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(within(leftPaneList()).getByText('Text')).toBeInTheDocument());
    expect(onToast).not.toHaveBeenCalled();
  });
});

describe('New-message composer — phone search (n-search)', () => {
  // Asserting on the row's formatted phone text (rendered ONLY inside the
  // dialog's filtered recipient list) rather than the customer's name — the
  // main inbox's left-pane roster always shows a thread-less customer as a
  // "person" row regardless of this dialog's search query, so the name alone
  // is not a reliable signal of the FILTER actually matching.
  it('finds a roster customer by a phone substring that only lives on phones[]', async () => {
    mockComms({ contacts: [RIVER] });
    renderWithProviders(<Harness />, { ability: communicationSectionAbility() });

    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    // "9555" spans the area-code/exchange formatting boundary in
    // "(609) 555-7781" — it only matches the digit-stripped haystack form,
    // proving the fix isn't just an artifact of the formatted-display string.
    fireEvent.change(screen.getByPlaceholderText('Search customers…'), {
      target: { value: '9555' },
    });

    expect(await screen.findByText('(609) 555-7781')).toBeInTheDocument();
  });

  it('does not match an unrelated digit string', async () => {
    mockComms({ contacts: [RIVER] });
    renderWithProviders(<Harness />, { ability: communicationSectionAbility() });

    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    // Sanity check: the row is there before typing — proves the assertion
    // below is the search filter at work, not an empty roster.
    expect(await screen.findByText('(609) 555-7781')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search customers…'), {
      target: { value: '4321' },
    });

    expect(screen.queryByText('(609) 555-7781')).not.toBeInTheDocument();
  });

  it('finds a customer by a SECOND, non-primary phones[] entry (not just phones[0])', async () => {
    // River's displayed/primary number is RIVER_PHONE (phones[0]); this
    // searches RIVER_SECONDARY_PHONE (phones[1]) — the realistic case of a
    // dispatcher knowing the customer's cell when the office line is primary.
    mockComms({ contacts: [RIVER] });
    renderWithProviders(<Harness />, { ability: communicationSectionAbility() });

    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    // "5501" is unique to RIVER_SECONDARY_PHONE's digits (2015550100) — it
    // does not appear anywhere in RIVER_PHONE's digits (6095557781).
    fireEvent.change(screen.getByPlaceholderText('Search customers…'), {
      target: { value: '5501' },
    });

    // The row surfaces (still displaying the PRIMARY number, the composer's
    // single "number" field) even though the match came from phones[1].
    expect(await screen.findByText('(609) 555-7781')).toBeInTheDocument();
  });
});
