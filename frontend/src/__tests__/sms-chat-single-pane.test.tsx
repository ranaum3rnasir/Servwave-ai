// Mobile slice 69: text messages and chat are ONE pane at a time below md, the open conversation is
// in the URL, and the composer sits in the footer slot under the only scroller.
//
// jsdom applies no CSS, so the geometry is proven in e2e/mobile/sms-chat-single-pane.spec.ts; what
// is pinned here is the behaviour that decides WHICH pane shows (the routed state shared by both
// pages) and the structure the geometry hangs on (the messages are the one scroller and the composer
// is a sibling after it, never inside it).
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import WhatsAppPage from '@/pages/v2/communication/WhatsAppPage';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import type { MessageThread, PhoneCustomer, WAChat } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

// The directory the page's query returns. The page under test is handed the same list as its
// `threads` prop, the way TextPage merges the seed in.
let directory: MessageThread[] = [];
let directoryFetched = true;
let chatSeed: WAChat[] = [];

vi.mock('@/lib/api/communication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/communication')>();
  return {
    ...actual,
    useMessageThreads: () => ({
      data: directory,
      isFetched: directoryFetched,
      isLoading: !directoryFetched,
    }),
    useWhatsAppChats: () => ({ data: chatSeed, isFetched: true }),
  };
});

window.HTMLElement.prototype.scrollIntoView = vi.fn();
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

function mockViewport(phone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: phone && query === MEDIA.belowMd,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const ANA_ID = 'c0000000-0000-0000-0000-00000000000a';
const BOB_ID = 'c0000000-0000-0000-0000-00000000000b';

function customer(id: string, name: string): PhoneCustomer {
  return {
    id,
    name,
    type: 'commercial',
    site: '1 Main St',
    contacts: [],
    phones: ['+12125550100'],
  };
}

const thread = (id: string, customerId: string, body: string, count = 1): MessageThread => ({
  id,
  customerId,
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: Array.from({ length: count }, (_, i) => ({
    id: `${id}_m${i}`,
    direction: i % 2 ? ('out' as const) : ('in' as const),
    body: count === 1 ? body : `${body} ${i}`,
    ts: new Date(Date.UTC(2026, 6, 9, 14, i)).toISOString(),
    status: 'delivered' as const,
  })),
});

let contacts: PhoneCustomer[] = [];

function Probe() {
  const loc = useLocation();
  return <output data-testid="url">{loc.pathname + loc.search}</output>;
}

function Harness({ initial }: { initial: MessageThread[] }) {
  const [threads, setThreads] = useState(initial);
  return (
    <>
      <SmsInboxView threads={threads} setThreads={setThreads} onToast={() => {}} />
      <Probe />
    </>
  );
}

const listPane = () => document.querySelector<HTMLElement>('[data-pane="list"]')!;
const threadPane = () => document.querySelector<HTMLElement>('[data-pane="thread"]')!;
const shown = (el: HTMLElement) => !el.classList.contains('hidden');

beforeEach(() => {
  vi.clearAllMocks();
  directory = [];
  directoryFetched = true;
  chatSeed = [];
  contacts = [customer(ANA_ID, 'Ana Rivera'), customer(BOB_ID, 'Bob Stone')];
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/communication/contacts') return { data: { contacts } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: directory } };
    if (url === '/api/communication/numbers') return { data: { numbers: [] } };
    return { data: {} };
  });
});

describe('text messages: one pane at a time below md', () => {
  it('shows the list first, and the thread only once a conversation is opened', async () => {
    mockViewport(true);
    directory = [thread('thr_a', ANA_ID, 'Gate code is 4412'), thread('thr_b', BOB_ID, 'Running late')];
    renderWithProviders(<Harness initial={directory} />, { initialEntries: ['/communication/text'] });

    await within(listPane()).findByText('Ana Rivera');
    expect(shown(listPane())).toBe(true);
    expect(shown(threadPane())).toBe(false);
    expect(screen.getByTestId('url')).toHaveTextContent('/communication/text');
    expect(screen.getByTestId('url')).not.toHaveTextContent('threadId');

    fireEvent.click(screen.getByRole('button', { name: /Ana Rivera/ }));

    expect(shown(listPane())).toBe(false);
    expect(shown(threadPane())).toBe(true);
    expect(screen.getByTestId('url')).toHaveTextContent('threadId=thr_a');
    expect(within(threadPane()).getAllByText('Gate code is 4412').length).toBeGreaterThan(0);
  });

  it('Back returns to the list: the back control and the browser Back are the same move', async () => {
    mockViewport(true);
    directory = [thread('thr_a', ANA_ID, 'Gate code is 4412')];
    renderWithProviders(<Harness initial={directory} />, { initialEntries: ['/communication/text'] });
    await within(listPane()).findByText('Ana Rivera');

    fireEvent.click(screen.getByRole('button', { name: /Ana Rivera/ }));
    expect(shown(threadPane())).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));

    await waitFor(() => expect(shown(listPane())).toBe(true));
    expect(shown(threadPane())).toBe(false);
    expect(screen.getByTestId('url')).not.toHaveTextContent('threadId');
  });

  it('a link to a conversation lands on it, and Back from there leaves the thread for the list', async () => {
    mockViewport(true);
    directory = [thread('thr_a', ANA_ID, 'Gate code is 4412'), thread('thr_b', BOB_ID, 'Running late')];
    renderWithProviders(<Harness initial={directory} />, {
      initialEntries: ['/communication/text?threadId=thr_b'],
    });

    await waitFor(() => expect(shown(threadPane())).toBe(true));
    expect(shown(listPane())).toBe(false);
    expect(within(threadPane()).getAllByText('Running late').length).toBeGreaterThan(0);

    // Entered on the thread: there is no list entry to pop, so the control replaces the URL.
    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }));
    await waitFor(() => expect(shown(listPane())).toBe(true));
    expect(screen.getByTestId('url')).not.toHaveTextContent('threadId');
  });

  it('a link to a conversation that does not exist shows the list and drops the dead id', async () => {
    mockViewport(true);
    directory = [thread('thr_a', ANA_ID, 'Gate code is 4412')];
    renderWithProviders(<Harness initial={directory} />, {
      initialEntries: ['/communication/text?threadId=thr_gone'],
    });

    await waitFor(() => expect(screen.getByTestId('url')).not.toHaveTextContent('thr_gone'));
    expect(shown(listPane())).toBe(true);
    expect(shown(threadPane())).toBe(false);
  });

  it('while the directory is still loading, a linked thread says so instead of showing another one', async () => {
    mockViewport(true);
    directoryFetched = false;
    renderWithProviders(<Harness initial={[]} />, {
      initialEntries: ['/communication/text?threadId=thr_b'],
    });

    expect(await screen.findByText('Loading conversation…')).toBeInTheDocument();
    expect(screen.getByTestId('url')).toHaveTextContent('threadId=thr_b');
  });

  it('from md up both panes show and picking a thread leaves the URL alone', async () => {
    mockViewport(false);
    directory = [thread('thr_a', ANA_ID, 'Gate code is 4412'), thread('thr_b', BOB_ID, 'Running late')];
    renderWithProviders(<Harness initial={directory} />, { initialEntries: ['/communication/text'] });
    await within(listPane()).findByText('Ana Rivera');

    expect(shown(listPane())).toBe(true);
    expect(shown(threadPane())).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Bob Stone/ }));

    expect(shown(listPane())).toBe(true);
    expect(shown(threadPane())).toBe(true);
    expect(screen.getByTestId('url')).not.toHaveTextContent('threadId');
    expect(within(threadPane()).getAllByText('Running late').length).toBeGreaterThan(0);
  });
});

describe('text messages: Send stays in the footer slot', () => {
  it('the messages are the one scroller and the composer is a sibling after it', async () => {
    mockViewport(true);
    directory = [thread('thr_a', ANA_ID, 'Gate code is 4412', 80)];
    renderWithProviders(<Harness initial={directory} />, {
      initialEntries: ['/communication/text?threadId=thr_a'],
    });
    await waitFor(() => expect(shown(threadPane())).toBe(true));

    const messages = threadPane().querySelector<HTMLElement>('[data-slot="sms-messages"]')!;
    const composer = threadPane().querySelector<HTMLElement>('[data-slot="sms-composer"]')!;
    expect(messages).toBeTruthy();
    expect(composer).toBeTruthy();

    // The bounded column: the scroller shrinks (min-h-0 + flex-1 + overflow-y), the footer does not.
    expect(messages.className).toMatch(/\bmin-h-0\b/);
    expect(messages.className).toMatch(/\bflex-1\b/);
    expect(messages.className).toMatch(/\boverflow-y-auto\b/);
    expect(composer.className).toMatch(/\bflex-none\b/);
    // Send is in the footer, never inside the scroller.
    expect(within(composer).getByRole('button', { name: /Send/ })).toBeInTheDocument();
    expect(messages.contains(composer)).toBe(false);
    expect(messages.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(messages.parentElement).toBe(composer.parentElement);
    // The column that holds both is itself bounded.
    expect(messages.parentElement!.className).toMatch(/\bmin-h-0\b/);
  });

  it('offers older messages a page at a time on a phone, and all of them from md up', async () => {
    directory = [thread('thr_a', ANA_ID, 'Msg', 65)];

    mockViewport(true);
    const phone = renderWithProviders(<Harness initial={directory} />, {
      initialEntries: ['/communication/text?threadId=thr_a'],
    });
    await waitFor(() => expect(shown(threadPane())).toBe(true));
    const messages = () => threadPane().querySelector<HTMLElement>('[data-slot="sms-messages"]')!;
    // 65 messages, a page is 60: the newest 60 are drawn and the 5 oldest are a tap away.
    expect(within(messages()).queryByText('Msg 0')).toBeNull();
    expect(within(messages()).getByText('Msg 64')).toBeInTheDocument();
    const more = within(messages()).getByRole('button', { name: 'Show 5 earlier messages' });
    fireEvent.click(more);
    expect(within(messages()).getByText('Msg 0')).toBeInTheDocument();
    expect(within(messages()).queryByRole('button', { name: /earlier messages/ })).toBeNull();
    phone.unmount();

    mockViewport(false);
    renderWithProviders(<Harness initial={directory} />, { initialEntries: ['/communication/text'] });
    await waitFor(() => expect(threadPane().querySelector('[data-slot="sms-messages"]')).toBeTruthy());
    expect(within(messages()).getByText('Msg 0')).toBeInTheDocument();
    expect(within(messages()).queryByRole('button', { name: /earlier messages/ })).toBeNull();
  });
});

describe('text messages: the list is a page at a time on a phone', () => {
  it('draws the first page of the directory and offers the rest', async () => {
    contacts = Array.from({ length: 55 }, (_, i) => customer(`c${i}`, `Customer ${String(i).padStart(3, '0')}`));
    directory = [];

    mockViewport(true);
    const phone = renderWithProviders(<Harness initial={[]} />, { initialEntries: ['/communication/text'] });
    await screen.findByText('Customer 000');
    expect(within(listPane()).getAllByText(/^Customer \d{3}$/)).toHaveLength(40);
    expect(screen.queryByText('Customer 054')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show 15 more/ }));
    expect(within(listPane()).getAllByText(/^Customer \d{3}$/)).toHaveLength(55);
    phone.unmount();

    mockViewport(false);
    renderWithProviders(<Harness initial={[]} />, { initialEntries: ['/communication/text'] });
    await screen.findByText('Customer 054');
    expect(within(listPane()).getAllByText(/^Customer \d{3}$/)).toHaveLength(55);
    expect(screen.queryByRole('button', { name: /more \(/ })).toBeNull();
  });
});

const chat = (id: string, name: string, text: string): WAChat => ({
  id,
  name,
  org: `${name} Co`,
  phone: '+12125550100',
  unread: 0,
  lastAt: '9:00 AM',
  messages: [{ id: `${id}_1`, from: 'them', text, at: '9:00 AM' }],
});

describe('chat: the same one-pane routed state', () => {
  it('shows the list, opens a chat into the URL and goes back to the list', async () => {
    mockViewport(true);
    chatSeed = [chat('wa_1', 'Dana', 'Is the gate open?'), chat('wa_2', 'Eli', 'See you at 3')];
    renderWithProviders(
      <>
        <WhatsAppPage />
        <Probe />
      </>,
      { initialEntries: ['/communication/whatsapp'] },
    );

    await within(listPane()).findByText('Dana');
    expect(shown(listPane())).toBe(true);
    expect(shown(threadPane())).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Eli/ }));
    expect(shown(listPane())).toBe(false);
    expect(shown(threadPane())).toBe(true);
    expect(screen.getByTestId('url')).toHaveTextContent('chatId=wa_2');
    expect(within(threadPane()).getByText('See you at 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to chats' }));
    await waitFor(() => expect(shown(listPane())).toBe(true));
    expect(shown(threadPane())).toBe(false);
    expect(screen.getByTestId('url')).not.toHaveTextContent('chatId');
  });

  it('keeps the composer in a footer under the one scroller, and shows both panes from md up', async () => {
    mockViewport(false);
    chatSeed = [chat('wa_1', 'Dana', 'Is the gate open?')];
    renderWithProviders(<WhatsAppPage />, { initialEntries: ['/communication/whatsapp'] });
    await within(listPane()).findByText('Dana');

    expect(shown(listPane())).toBe(true);
    expect(shown(threadPane())).toBe(true);
    const composer = threadPane().querySelector<HTMLElement>('[data-slot="chat-composer"]')!;
    expect(composer.className).toMatch(/\bflex-none\b/);
    expect(within(composer).getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});
