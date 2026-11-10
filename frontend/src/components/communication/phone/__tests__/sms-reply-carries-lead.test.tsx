// SPEC-4 §6.8 (approved 24 Oct): tapping the customer's phone number on a lead page and choosing Text opens the
// Text page at that customer's conversation with the lead in the address. The FIRST reply sent on that customer's
// conversation during that visit is filed on the lead (`leadId` in the send), which is what lets it release the lead's
// Spider alert once it goes out. A second reply, or a reply on any other conversation, is not filed on the lead.
//
// The real inbox runs; only the network layer is faked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, communicationSectionAbility } from '@/__tests__/helpers';
import { MY_SWITCHES_URL, VIEWS_CUSTOMERS_ANSWER } from '@/__tests__/support/viewsCustomers';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread, PhoneCustomer } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const PAT_ID = 'c0000000-0000-0000-0000-000000000077';
const SAM_ID = 'c0000000-0000-0000-0000-000000000088';
const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';

function customer(id: string, name: string, phone: string): PhoneCustomer {
  return {
    id,
    name,
    type: 'residential',
    site: 'Austin',
    contacts: [{ id: `ct-${id}`, name, preferredLang: 'en', channels: [{ id: `ch-${id}`, kind: 'phone', value: phone }] }],
  };
}
const PAT = customer(PAT_ID, 'Pat Lee', '+12015550999');
const SAM = customer(SAM_ID, 'Sam Ortiz', '+12015550888');

function thread(id: string, customerId: string, body: string, ts: string): MessageThread {
  return {
    id,
    customerId,
    channel: 'sms',
    campaignType: 'customer_care',
    unread: 0,
    messages: [{ id: `m-${id}`, direction: 'in', body, ts, status: 'received' }],
  };
}
// Sam's conversation is the newer one, so it is NOT what the inbox would open by itself.
const PAT_THREAD = thread('srv-pat-1', PAT_ID, 'Can you come Thursday?', '2026-07-09T14:00:00Z');
const SAM_THREAD = thread('srv-sam-1', SAM_ID, 'Is the part in yet?', '2026-07-09T15:00:00Z');
const THREADS = [SAM_THREAD, PAT_THREAD];

const SMS_NUMBER = { id: 'num-1', e164: '+15512827064', sms_enabled: true, created_at: '2026-07-01T00:00:00Z' };

let listed: MessageThread[] = THREADS;

function Harness() {
  const [threads, setThreads] = useState<MessageThread[]>(listed);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={() => {}} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  listed = THREADS;
  vi.mocked(useAuthStore).mockImplementation((sel: unknown) =>
    (sel as (s: unknown) => unknown)({
      user: {
        id: '00000000-0000-0000-0000-000000000001', email: 'admin@test.com', first_name: 'Test', last_name: 'Admin',
        role: 'ADMIN', org_is_demo: true, organization_id: 'org-demo', org_features: ['phone'],
      },
      isAuthenticated: true, isLoading: false, error: null,
    }),
  );
  mockApi.get.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    if (url === MY_SWITCHES_URL) return VIEWS_CUSTOMERS_ANSWER;
    if (url === '/api/organization') return { data: { phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } };
    if (url === '/api/communication/contacts') return { data: { contacts: [PAT, SAM] } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: listed } };
    if (url === '/api/communication/numbers') return { data: { numbers: [SMS_NUMBER] } };
    // #3023: the line above a text box names the conversation it continues; for a customer, the server's choice (here the
    // customer's one conversation), which Text on the customer opens.
    if (url === '/api/communication/sms/numbers') {
      const p = (config?.params ?? {}) as Record<string, string>;
      return { data: { conversationId: p.threadId ?? listed.find((t) => t.customerId === p.customerId)?.id ?? null } };
    }
    return { data: {} };
  });
  let n = 0;
  mockApi.post.mockImplementation(async (_url: string, args?: unknown) => ({
    data: {
      message: { id: `m-out-${++n}`, direction: 'out', body: (args as { body: string }).body, ts: '2026-07-13T10:00:00Z' },
      delivery: 'sent',
    },
  }));
});

function arriveFromLeadPage() {
  renderWithProviders(<Harness />, {
    initialEntries: [`/communication/text?customerId=${PAT_ID}&leadId=${LEAD_ID}`],
    ability: communicationSectionAbility(),
  });
}

async function reply(body: string) {
  const input = await screen.findByPlaceholderText('Type an SMS reply…');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: body } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
  await waitFor(() => expect(input).toHaveValue(''));
}

const sends = () =>
  mockApi.post.mock.calls.filter(([url]) => url === '/api/communication/sms').map(([, args]) => args);

/** The inbox's left-pane conversation list. */
function leftPaneList() {
  return document.querySelector('.min-h-0.flex-1.overflow-y-auto') as HTMLElement;
}

async function openConversationOf(name: string) {
  fireEvent.click(await within(leftPaneList()).findByText(name));
}

/** The conversation pane has opened the customer's thread: its message shows outside the list's preview. */
async function onConversation(lastMessage: string) {
  await waitFor(() =>
    expect(screen.getAllByText(lastMessage).some((el) => !leftPaneList()?.contains(el))).toBe(true),
  );
}

describe('the Text page reached from a lead page\'s phone number', () => {
  it('files the first reply on the customer\'s conversation on the lead', async () => {
    arriveFromLeadPage();
    await onConversation('Can you come Thursday?');

    await reply('Yes, Thursday at 9.');

    await waitFor(() =>
      expect(sends()).toEqual([{ customerId: PAT_ID, body: 'Yes, Thursday at 9.', leadId: LEAD_ID }]),
    );
  });

  it('does not file a second reply on the lead', async () => {
    arriveFromLeadPage();
    await onConversation('Can you come Thursday?');

    await reply('Yes, Thursday at 9.');
    await reply('Bring the side gate code.');

    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends()[1]).toEqual({ customerId: PAT_ID, body: 'Bring the side gate code.' });
  });

  it('does not file a reply on another conversation on the lead, nor one back on the customer\'s after leaving it', async () => {
    arriveFromLeadPage();
    await onConversation('Can you come Thursday?');

    await openConversationOf('Sam Ortiz');
    await onConversation('Is the part in yet?');
    await reply('It arrives Monday.');
    await openConversationOf('Pat Lee');
    await reply('Yes, Thursday at 9.');

    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends()).toEqual([
      { customerId: SAM_ID, body: 'It arrives Monday.' },
      { customerId: PAT_ID, body: 'Yes, Thursday at 9.' },
    ]);
  });

  it('files nothing on a lead when the address names none', async () => {
    renderWithProviders(<Harness />, {
      initialEntries: [`/communication/text?customerId=${PAT_ID}`],
      ability: communicationSectionAbility(),
    });
    await onConversation('Can you come Thursday?');

    await reply('Yes, Thursday at 9.');

    await waitFor(() => expect(sends()).toEqual([{ customerId: PAT_ID, body: 'Yes, Thursday at 9.' }]));
  });

  it('files the first text on the lead when the customer has no conversation yet and the composer starts one', async () => {
    listed = [SAM_THREAD];
    arriveFromLeadPage();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('To: Pat Lee')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByPlaceholderText('Write a message to Pat Lee…'), {
      target: { value: 'Hi Pat, about your request.' },
    });
    const footer = within(dialog).getByRole('button', { name: 'Cancel' }).parentElement!;
    fireEvent.click(within(footer).getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(sends()).toEqual([{ customerId: PAT_ID, body: 'Hi Pat, about your request.', leadId: LEAD_ID }]),
    );
    await reply('And bring the gate code.');
    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends()[1]).toEqual({ customerId: PAT_ID, body: 'And bring the gate code.' });
  });

  it('files the first reply on the lead when the composer only opens the customer\'s new conversation', async () => {
    listed = [SAM_THREAD];
    arriveFromLeadPage();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('To: Pat Lee')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /open conversation/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await reply('Hi Pat, about your request.');
    await reply('And bring the gate code.');

    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends()).toEqual([
      { customerId: PAT_ID, body: 'Hi Pat, about your request.', leadId: LEAD_ID },
      { customerId: PAT_ID, body: 'And bring the gate code.' },
    ]);
  });

  it('drops the lead once the person goes to another conversation before texting the customer, so a later new message to them is not filed on it', async () => {
    listed = [SAM_THREAD];
    arriveFromLeadPage();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('To: Pat Lee')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await openConversationOf('Sam Ortiz');
    await onConversation('Is the part in yet?');
    await reply('It arrives Monday.');

    fireEvent.click(screen.getByRole('button', { name: /^new$/i }));
    const composer = await screen.findByRole('dialog');
    fireEvent.click(await within(composer).findByText('Pat Lee'));
    fireEvent.change(within(composer).getByPlaceholderText('Write a message to Pat Lee…'), {
      target: { value: 'Hi Pat, a quick question.' },
    });
    const footer = within(composer).getByRole('button', { name: 'Cancel' }).parentElement!;
    fireEvent.click(within(footer).getByRole('button', { name: /send/i }));

    await waitFor(() => expect(sends()).toHaveLength(2));
    expect(sends()).toEqual([
      { customerId: SAM_ID, body: 'It arrives Monday.' },
      { customerId: PAT_ID, body: 'Hi Pat, a quick question.' },
    ]);
  });
});
