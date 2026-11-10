// #3019 (parent #3013, mockup row 3): a text conversation is a pair of numbers, and the inbox row's second line names
// our number: "(555) 010-3002 · Dana Ruiz's number" or "(555) 010-3002 · Main line". A conversation the split has not
// keyed yet keeps the row it always had.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, communicationSectionAbility } from './helpers';
import { MY_SWITCHES_URL } from './support/viewsCustomers';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const CUSTOMER = 'c0000000-0000-0000-0000-000000003019';

/** A conversation as the server lists it. */
function conversation(id: string, body: string, pair?: MessageThread['pair']): MessageThread {
  return {
    id,
    customerId: CUSTOMER,
    linkedCustomer: { id: CUSTOMER, name: 'Jordan Lee' },
    channel: 'sms',
    campaignType: 'customer_care',
    unread: 0,
    messages: [{ id: `${id}-m`, direction: 'in', body, ts: '2026-10-30T14:36:00Z', status: 'received' }],
    ...(pair ? { pair } : {}),
  };
}

// #3021: the server names every customer carrying the number with the pair.
const CARRIERS = [{ id: CUSTOMER, name: 'Jordan Lee' }];
const ON_DANAS_NUMBER = conversation('pair-dana', 'Any morning next week.', {
  otherPartyE164: '+15550103002', ourNumberE164: '+15550101111', ourLine: { kind: 'person', name: 'Dana Ruiz' }, customers: CARRIERS,
});
const ON_THE_MAIN_LINE = conversation('pair-main', 'Your technician is on the way.', {
  otherPartyE164: '+15550103002', ourNumberE164: '+15550100000', ourLine: { kind: 'main_line' }, customers: CARRIERS,
});
const BEFORE_PAIRS = conversation('legacy', 'Sent before pairs.');

function mockComms() {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === MY_SWITCHES_URL) return { data: { admin_box: false, values: {} } };
    if (url === '/api/organization') return { data: { phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } };
    if (url === '/api/communication/contacts') return { data: { contacts: [] } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: [ON_DANAS_NUMBER, ON_THE_MAIN_LINE, BEFORE_PAIRS] } };
    if (url === '/api/communication/numbers') return { data: { numbers: [] } };
    return { data: {} };
  });
}

function Harness({ initial }: { initial: MessageThread[] }) {
  const [threads, setThreads] = useState<MessageThread[]>(initial);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={() => {}} />;
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

/** The inbox row that previews this text. */
async function rowWith(preview: string) {
  const text = (await screen.findAllByText(preview)).find((el) => el.closest('button'));
  return text!.closest('button') as HTMLElement;
}

/** The row's lines, in order, as a person reads them. */
function linesOf(row: HTMLElement): string[] {
  return Array.from(row.children).map((el) => el.textContent ?? '');
}

describe('the inbox row names our number on a conversation keyed by its pair', () => {
  it("a conversation on Dana's number: (555) 010-3002 · Dana Ruiz's number", async () => {
    mockComms();
    renderWithProviders(<Harness initial={[ON_DANAS_NUMBER, ON_THE_MAIN_LINE, BEFORE_PAIRS]} />, { ability: communicationSectionAbility() });

    const row = await rowWith('Any morning next week.');

    expect(linesOf(row).slice(1)).toEqual(["(555) 010-3002 · Dana Ruiz's number", 'Any morning next week.']);
  });

  it('a conversation on the main line: (555) 010-3002 · Main line', async () => {
    mockComms();
    renderWithProviders(<Harness initial={[ON_DANAS_NUMBER, ON_THE_MAIN_LINE, BEFORE_PAIRS]} />, { ability: communicationSectionAbility() });

    const row = await rowWith('Your technician is on the way.');

    expect(linesOf(row).slice(1)).toEqual(['(555) 010-3002 · Main line', 'Your technician is on the way.']);
  });

  it('a conversation the split has not reached keeps the row it always had', async () => {
    mockComms();
    renderWithProviders(<Harness initial={[ON_DANAS_NUMBER, ON_THE_MAIN_LINE, BEFORE_PAIRS]} />, { ability: communicationSectionAbility() });

    const row = await rowWith('Sent before pairs.');

    expect(linesOf(row).slice(1)).toEqual(['Sent before pairs.', 'Customer care · SMS']);
    expect(within(row).queryByText(/Main line|number/)).not.toBeInTheDocument();
  });
});

describe('a reply leaves in the conversation it is written in', () => {
  /** Opens the conversation that previews this text, writes a reply in it and sends it. */
  async function replyIn(preview: string, body: string) {
    fireEvent.click(await rowWith(preview));
    const input = await screen.findByPlaceholderText('Type an SMS reply…');
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: body } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(input).toHaveValue(''));
  }

  const sends = () => mockApi.post.mock.calls.filter(([url]) => url === '/api/communication/sms').map(([, args]) => args);

  beforeEach(() => {
    mockApi.post.mockImplementation(async (_url: string, args?: unknown) => ({
      data: { message: { id: 'm-out', direction: 'out', body: (args as { body: string }).body, ts: '2026-10-30T15:00:00Z' }, delivery: 'sent' },
    }));
  });

  it('a reply on the main line\'s conversation is sent into that conversation, not to the customer at large', async () => {
    mockComms();
    renderWithProviders(<Harness initial={[ON_DANAS_NUMBER, ON_THE_MAIN_LINE, BEFORE_PAIRS]} />, { ability: communicationSectionAbility() });

    await replyIn('Your technician is on the way.', 'Thanks, see you soon.');

    expect(sends()).toEqual([{ threadId: 'pair-main', body: 'Thanks, see you soon.' }]);
  });

  it('a reply on a conversation the split has not reached is sent as it always was', async () => {
    mockComms();
    renderWithProviders(<Harness initial={[ON_DANAS_NUMBER, ON_THE_MAIN_LINE, BEFORE_PAIRS]} />, { ability: communicationSectionAbility() });

    await replyIn('Sent before pairs.', 'Still there?');

    expect(sends()).toEqual([{ customerId: CUSTOMER, body: 'Still there?' }]);
  });
});
