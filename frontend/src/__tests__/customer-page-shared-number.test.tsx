// #3021 (parent #3013, decision 5): a conversation on a number Jordan Lee and Pat Morgan both carry shows on both
// customers' pages. On Pat Morgan's Communication tab its texts are listed, and opening one opens the conversation with the
// same header the inbox gives it: the number, "On Jordan Lee and Pat Morgan", and our number below.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, communicationSectionAbility } from './helpers';
import { CustomerCommunicationsTab } from '@/components/communication/CustomerCommunicationsTab';
import type { MessageThread } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const JORDAN = { id: 'c0000000-0000-0000-0000-000000003021', name: 'Jordan Lee' };
const PAT = { id: 'c0000000-0000-0000-0000-000000003022', name: 'Pat Morgan' };
const CONVERSATION = 'a0000000-0000-0000-0000-000000003021';

/** The conversation as the server opens it: filed on Jordan Lee, on a number Jordan Lee and Pat Morgan carry. */
const SHARED: MessageThread = {
  id: CONVERSATION,
  customerId: JORDAN.id,
  linkedCustomer: JORDAN,
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: [{ id: 'm-1', direction: 'in', body: 'Is Tuesday free?', ts: '2026-10-30T14:36:00Z', status: 'received' }],
  pair: { otherPartyE164: '+15550103002', ourNumberE164: '+15550100000', ourLine: { kind: 'main_line' }, customers: [JORDAN, PAT] },
};

/** Pat Morgan's Communication tab, as the server lists it: the conversation's text, with Pat Morgan. */
const PATS_TAB = [{
  id: 'm-1', channel: 'sms', direction: 'in', who: 'Pat Morgan', title: 'Text message', preview: 'Is Tuesday free?',
  at: '2026-10-30T14:36:00.000Z', threadId: CONVERSATION,
}];

/** The server: Pat Morgan's tab, and the conversation as it is opened for this person. */
function serve(thread: MessageThread) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/customers/${PAT.id}/communications`) return { data: { items: PATS_TAB } };
    if (url === `/api/communication/threads/${CONVERSATION}`) return { data: { thread } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001', email: 'user@test.com', first_name: 'Test', last_name: 'User',
        role: 'DISPATCHER', organization_id: 'org-demo', org_features: ['phone'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
  serve(SHARED);
  mockApi.patch.mockResolvedValue({ data: { updated: 1 } });
});

describe("Pat Morgan's page shows the conversation on the number Pat shares with Jordan Lee", () => {
  it('lists its text, and opens the conversation on both customers', async () => {
    renderWithProviders(<CustomerCommunicationsTab customerId={PAT.id} />, { ability: communicationSectionAbility() });

    await userEvent.click(await screen.findByText('Is Tuesday free?'));

    const heading = await screen.findByTestId('sms-conversation-heading');
    expect(Array.from(heading.children).map((el) => el.textContent)).toEqual([
      '(555) 010-3002', 'On Jordan Lee and Pat Morgan', '(555) 010-0000 · Main line',
    ]);
  });
});

describe('for a person who reaches Pat Morgan only, the conversation filed on Jordan Lee', () => {
  it('opens on Pat Morgan alone, though the server sends no customer it is filed on', async () => {
    // As the server sends it to them: no id or name of Jordan Lee, the one carrier they can open.
    serve({ ...SHARED, customerId: '', linkedCustomer: undefined, pair: { ...SHARED.pair!, customers: [PAT] } });
    renderWithProviders(<CustomerCommunicationsTab customerId={PAT.id} />, { ability: communicationSectionAbility() });

    await userEvent.click(await screen.findByText('Is Tuesday free?'));

    const heading = await screen.findByTestId('sms-conversation-heading');
    expect(Array.from(heading.children).map((el) => el.textContent)).toEqual([
      '(555) 010-3002', 'On Pat Morgan', '(555) 010-0000 · Main line',
    ]);
  });
});
