// #3021 (parent #3013, row 3): a conversation on a number several customers carry is titled with them in the inbox,
// "Jordan Lee, Pat Morgan +8", and the open conversation's header reads "On Jordan Lee, Pat Morgan and 8 more customers"
// with our number below; "8 more customers" opens the full list, with search and its own scroll.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, communicationSectionAbility } from './helpers';
import { MY_SWITCHES_URL } from './support/viewsCustomers';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const JORDAN = { id: 'c0000000-0000-0000-0000-000000003021', name: 'Jordan Lee' };
const PAT = { id: 'c0000000-0000-0000-0000-000000003022', name: 'Pat Morgan' };
const EIGHT_MORE = ['Alex Kim', 'Bea Cruz', 'Cal Diaz', 'Dee Fox', 'Eli Gray', 'Fay Hill', 'Gus Ives', 'Hal Jones'].map((name, i) => ({
  id: `c0000000-0000-0000-0000-00000000310${i}`, name,
}));

/** A conversation keyed by its pair, on the main line, as the server gives it: filed on Jordan Lee, carried by `customers`. */
function onTheNumber(id: string, body: string, customers: { id: string; name: string }[]): MessageThread {
  return {
    id,
    customerId: JORDAN.id,
    linkedCustomer: JORDAN,
    channel: 'sms',
    campaignType: 'customer_care',
    unread: 0,
    messages: [{ id: `${id}-m`, direction: 'in', body, ts: '2026-10-30T14:36:00Z', status: 'received' }],
    pair: { otherPartyE164: '+15550103002', ourNumberE164: '+15550100000', ourLine: { kind: 'main_line' }, customers },
  };
}

const ON_TEN = onTheNumber('pair-ten', 'Is Tuesday free?', [JORDAN, PAT, ...EIGHT_MORE]);
const ON_TWO = onTheNumber('pair-two', 'Booked, thanks.', [JORDAN, PAT]);
const ON_ONE = onTheNumber('pair-one', 'See you then.', [JORDAN]);

function mockComms(threads: MessageThread[]) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === MY_SWITCHES_URL) return { data: { admin_box: false, values: {} } };
    if (url === '/api/organization') return { data: { phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } };
    if (url === '/api/communication/contacts') return { data: { contacts: [] } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads } };
    const one = threads.find((t) => url === `/api/communication/threads/${t.id}`);
    if (one) return { data: { thread: one } };
    if (url === '/api/communication/numbers') return { data: { numbers: [] } };
    return { data: {} };
  });
  mockApi.patch.mockResolvedValue({ data: { updated: 1 } });
}

function Harness({ initial }: { initial: MessageThread[] }) {
  const [threads, setThreads] = useState<MessageThread[]>(initial);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={() => {}} />;
}

function show(threads: MessageThread[]) {
  mockComms(threads);
  renderWithProviders(<Harness initial={threads} />, { ability: communicationSectionAbility() });
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

/** The open conversation's title block, line by line, as a person reads it. */
async function headerLines() {
  const block = await screen.findByTestId('sms-conversation-heading');
  return Array.from(block.children).map((el) => el.textContent ?? '');
}

describe('the inbox row is titled with the customers carrying the number', () => {
  it.each([
    ['ten customers', ON_TEN, 'Is Tuesday free?', 'Jordan Lee, Pat Morgan +8'],
    ['two customers', ON_TWO, 'Booked, thanks.', 'Jordan Lee, Pat Morgan'],
    ['one customer', ON_ONE, 'See you then.', 'Jordan Lee'],
  ])('on %s', async (_n, thread, preview, title) => {
    show([thread]);

    const row = await rowWith(preview);

    expect(row.children[0]!.textContent).toBe(title);
  });
});

describe("the open conversation's header", () => {
  it('gives the number, "On Jordan Lee, Pat Morgan and 8 more customers", and our number below', async () => {
    show([ON_TEN]);
    await userEvent.click(await rowWith('Is Tuesday free?'));

    expect(await headerLines()).toEqual(['(555) 010-3002', 'On Jordan Lee, Pat Morgan and 8 more customers', '(555) 010-0000 · Main line']);
  });

  it.each([
    ['two customers', ON_TWO, 'Booked, thanks.', 'On Jordan Lee and Pat Morgan'],
    ['one customer', ON_ONE, 'See you then.', 'On Jordan Lee'],
  ])('names them all when it is on %s', async (_n, thread, preview, line) => {
    show([thread]);
    await userEvent.click(await rowWith(preview));

    expect((await headerLines())[1]).toBe(line);
  });

  it('"8 more customers" opens the list of all ten, which a search narrows', async () => {
    show([ON_TEN]);
    await userEvent.click(await rowWith('Is Tuesday free?'));

    await userEvent.click(await screen.findByRole('button', { name: '8 more customers' }));
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Jordan Lee', 'Pat Morgan', ...EIGHT_MORE.map((c) => c.name),
    ]);

    await userEvent.type(screen.getByRole('searchbox', { name: 'Search customers' }), 'mor');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Pat Morgan']);
  });
});

describe('a conversation filed on a customer the person cannot open (ruling: names only customers the viewer can open)', () => {
  /** As the server sends it to a person who reaches Pat Morgan only: no customer it is filed on, only the carrier they open. */
  const FOR_PAT_ONLY: MessageThread = { ...onTheNumber('pair-pat', 'Is Tuesday free?', [PAT]), customerId: '', linkedCustomer: undefined };

  it('is titled and headed with Pat Morgan, and a reply is sent into the conversation by its id', async () => {
    mockApi.post.mockImplementation(async (_url: string, args?: unknown) => ({
      data: { message: { id: 'm-out', direction: 'out', body: (args as { body: string }).body, ts: '2026-10-30T15:00:00Z' }, delivery: 'sent' },
    }));
    show([FOR_PAT_ONLY]);

    const row = await rowWith('Is Tuesday free?');
    expect(row.children[0]!.textContent).toBe('Pat Morgan');
    fireEvent.click(row);
    expect(await headerLines()).toEqual(['(555) 010-3002', 'On Pat Morgan', '(555) 010-0000 · Main line']);

    const input = await screen.findByPlaceholderText('Type an SMS reply…');
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'Tuesday works.' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(input).toHaveValue(''));
    expect(mockApi.post.mock.calls.filter(([url]) => url === '/api/communication/sms').map(([, args]) => args))
      .toEqual([{ threadId: 'pair-pat', body: 'Tuesday works.' }]);
  });
});
