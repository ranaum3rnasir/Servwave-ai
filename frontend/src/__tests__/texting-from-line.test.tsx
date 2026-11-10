// #3023 (parent #3013, row 2): one line above every text box names both numbers, in Ran's three wordings (2026-11-06):
//   - our number is the person's own:            "Texting (555) 010-5252 from your number, (555) 010-1111"
//   - any other number of ours (colleague, main): "Texting (555) 010-5252 from (555) 010-1111"
//   - the conversation's number is gone:          "(555) 010-1111 is no longer in use."
//   - the conversation's number cannot text:      "(555) 010-1111 cannot send texts."
// The server's answer is faked at the network edge (the app's HTTP client); the line asks for the same fields the send names.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders, communicationSectionAbility } from './helpers';
import { MY_SWITCHES_URL } from './support/viewsCustomers';
import { TextingFromLine } from '@/components/communication/shared/TextingFromLine';
import type { SendingNumbers } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

/** The server's answer for the line, and the fields it was asked with. */
function serverSays(numbers: SendingNumbers) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === MY_SWITCHES_URL) return { data: { admin_box: false, values: {} } };
    if (url === '/api/communication/sms/numbers') return { data: numbers };
    return { data: {} };
  });
}

const asked = () => mockApi.get.mock.calls.filter(([url]) => url === '/api/communication/sms/numbers').map(([, config]) => config);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the line above the text box', () => {
  it('our number is the person\'s own: "Texting (555) 010-5252 from your number, (555) 010-1111"', async () => {
    serverSays({ to: '+15550105252', from: '+15550101111', fromIsYours: true, noLongerInUse: null, cannotSendTexts: null });
    renderWithProviders(<TextingFromLine target={{ threadId: 'conversation-1' }} />, { ability: communicationSectionAbility() });

    const line = await screen.findByText(/^Texting/);

    expect(line.textContent).toBe('Texting (555) 010-5252 from your number, (555) 010-1111');
    expect(asked()).toEqual([{ params: { threadId: 'conversation-1' } }]);
  });

  it('a colleague\'s number or the main line: "Texting (555) 010-5252 from (555) 010-1111", naming no one', async () => {
    serverSays({ to: '+15550105252', from: '+15550101111', fromIsYours: false, noLongerInUse: null, cannotSendTexts: null });
    renderWithProviders(<TextingFromLine target={{ customerId: 'customer-1', leadId: 'lead-1' }} />, { ability: communicationSectionAbility() });

    const line = await screen.findByText(/^Texting/);

    expect(line.textContent).toBe('Texting (555) 010-5252 from (555) 010-1111');
    expect(asked()).toEqual([{ params: { customerId: 'customer-1', leadId: 'lead-1' } }]);
  });

  it('the conversation\'s number was released: only "(555) 010-1111 is no longer in use."', async () => {
    serverSays({ to: '+15550105252', from: '+15550100000', fromIsYours: false, noLongerInUse: '+15550101111', cannotSendTexts: null });
    renderWithProviders(<TextingFromLine target={{ threadId: 'conversation-1' }} />, { ability: communicationSectionAbility() });

    const line = await screen.findByText(/no longer in use/);

    expect(line.textContent).toBe('(555) 010-1111 is no longer in use.');
    expect(screen.queryByText(/Texting/)).not.toBeInTheDocument();
  });

  it('the conversation\'s number is still in use but cannot send texts: only "(555) 010-1111 cannot send texts."', async () => {
    serverSays({ to: '+15550105252', from: '+15550100000', fromIsYours: false, noLongerInUse: null, cannotSendTexts: '+15550101111' });
    renderWithProviders(<TextingFromLine target={{ threadId: 'conversation-1' }} />, { ability: communicationSectionAbility() });

    const line = await screen.findByText(/cannot send texts/);

    expect(line.textContent).toBe('(555) 010-1111 cannot send texts.');
    expect(screen.queryByText(/Texting/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no longer in use/)).not.toBeInTheDocument();
  });

  it('with no one to text yet, nothing is asked and nothing is drawn', async () => {
    serverSays({ to: '+15550105252', from: '+15550101111', fromIsYours: true, noLongerInUse: null, cannotSendTexts: null });
    const { container } = renderWithProviders(<TextingFromLine target={null} />, { ability: communicationSectionAbility() });

    expect(container.querySelector('[data-slot="texting-from"]')).toBeNull();
    expect(asked()).toEqual([]);
  });
});
