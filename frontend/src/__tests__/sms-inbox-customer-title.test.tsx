// A text conversation tied to a customer is titled with the customer's name even for a person who may not open the
// customer directory (View customers off): the thread answer carries the display name, drawn as plain text when the
// page is closed to them. The "Message sent" toast follows the Copy customer phone rule: no number for a person who
// may not select it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, communicationSectionAbility } from './helpers';
import { catalogToggle } from './support/backendSwitchCatalog';
import { MY_SWITCHES_URL } from './support/viewsCustomers';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const CUST_ID = 'c0000000-0000-0000-0000-000000000077';
const NAME = 'Sample Customer';

// What the server sends for a text tied to a customer: the id and the display name, nothing else of the customer.
const LINKED_THREAD: MessageThread = {
  id: 'srv-linked-1',
  customerId: CUST_ID,
  linkedCustomer: { id: CUST_ID, name: NAME },
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: [{ id: 'm1', direction: 'in', body: 'Can you come Thursday?', ts: '2026-07-09T14:00:00Z', status: 'received' }],
};

function mockComms(switches: Record<string, boolean>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === MY_SWITCHES_URL) return { data: { admin_box: false, values: switches } };
    if (url === '/api/organization') return { data: { phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } };
    // The customer directory is closed to a person without View customers.
    if (url === '/api/communication/contacts') return { data: { contacts: [] } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: [LINKED_THREAD] } };
    if (url === '/api/communication/numbers') return { data: { numbers: [{ id: 'n1', e164: '+15512827064', sms_enabled: true, created_at: '2026-07-01T00:00:00Z' }] } };
    return { data: {} };
  });
}

function Harness({ initial = [] as MessageThread[], onToast = () => {} }: { initial?: MessageThread[]; onToast?: (m: string) => void }) {
  const [threads, setThreads] = useState<MessageThread[]>(initial);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={onToast} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001', email: 'user@test.com', first_name: 'Test', last_name: 'User',
        role: 'DISPATCHER', org_is_demo: true, organization_id: 'org-demo', org_features: ['phone'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
});

describe('A customer text conversation, for a person without View customers', () => {
  it('is titled with the customer name, as plain text, never "Unknown"', async () => {
    mockComms({ [catalogToggle('View customers').key]: false });
    renderWithProviders(<Harness initial={[LINKED_THREAD]} />, { ability: communicationSectionAbility() });

    expect((await screen.findAllByText(NAME)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: NAME })).not.toBeInTheDocument();
  });

  it('links the name in the open thread header when the person may open the customer page', async () => {
    mockComms({ [catalogToggle('View customers').key]: true });
    renderWithProviders(<Harness initial={[LINKED_THREAD]} />, { ability: communicationSectionAbility() });

    const link = await screen.findByRole('link', { name: NAME });
    expect(link).toHaveAttribute('href', `/customers/${CUST_ID}`);
  });
});

describe('The "Message sent" toast for a typed number follows Copy customer phone', () => {
  async function sendToTypedNumber(copyPhone: boolean) {
    mockComms({ [catalogToggle('Copy customer phone').key]: copyPhone });
    mockApi.post.mockResolvedValue({
      data: { message: { id: 'm-new-1', direction: 'out', body: 'Hi there', ts: '2026-07-13T10:00:00Z' }, threadId: 'srv-th-9' },
    });
    const onToast = vi.fn();
    renderWithProviders(<Harness onToast={onToast} />, { ability: communicationSectionAbility() });

    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    fireEvent.change(screen.getByLabelText('To phone number'), { target: { value: '(201) 555-0123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use number' }));
    fireEvent.change(screen.getByPlaceholderText('Write a message to (201) 555-0123…'), { target: { value: 'Hi there' } });
    const footer = screen.getByRole('button', { name: 'Cancel' }).parentElement!;
    fireEvent.click(within(footer).getByRole('button', { name: /send/i }));
    await waitFor(() => expect(onToast).toHaveBeenCalled());
    return onToast.mock.calls[0]![0] as string;
  }

  it('leaves the number out for a person who may not copy it', async () => {
    const toast = await sendToTypedNumber(false);
    expect(toast).toContain('Message sent');
    expect(toast).not.toContain('555');
  });

  it('names the number for a person who may', async () => {
    const toast = await sendToTypedNumber(true);
    expect(toast).toContain('Message sent to (201) 555-0123');
  });
});
