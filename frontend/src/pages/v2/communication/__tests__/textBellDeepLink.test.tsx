/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 8, S08.21 (final pass) - the bell's "New text" link is /communication/text?threadId=<id>.
// A person can read a conversation by record (a crew member on the job it is about) without it being in their Inbox
// list, which follows their scope. The link must open THAT conversation (single read, by id), and one they may not read
// must say so, never show some other conversation.
//
// Renders the ROUTED Text page with the real hooks; only the network is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { useAuthStore } from '@/stores/auth.store';
import TextPage from '@/pages/v2/communication/TextPage';
import { MY_SWITCHES_URL, VIEWS_CUSTOMERS_ANSWER } from '@/__tests__/support/viewsCustomers';

const mockApi = vi.mocked(api);
const COMM = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

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

const IN_LIST = 'a0000000-0000-4000-8000-000000000001';
const BY_RECORD = 'a0000000-0000-4000-8000-000000000002';
const UNREADABLE = 'a0000000-0000-4000-8000-000000000003';

const thread = (id: string, title: string, body: string) => ({
  id, customerId: '', channel: 'sms', campaignType: 'customer_care', unread: 0, title,
  messages: [{ id: `${id}_m`, direction: 'in', body, ts: '2026-06-09T14:00:00Z', status: 'delivered' }],
});

// The one conversation the Inbox list holds, and the one the person reaches by the job they are crew on.
const LISTED = thread(IN_LIST, '+16095550001', 'Listed conversation message');
const REACHED = thread(BY_RECORD, '+16095550002', 'Reached by the job message');

function readRefused(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error: 'Thread not found' } } });
}

function renderBellLink(threadId: string, opts: { phone?: boolean } = {}) {
  mockViewport(Boolean(opts.phone));
  vi.mocked(useAuthStore).mockImplementation((sel: unknown) =>
    (sel as (s: unknown) => unknown)({
      user: {
        id: 'u1', email: 'custom@test.com', first_name: 'Custom', last_name: 'Role', role: 'CUSTOM',
        organization_id: '00000000-0000-4000-8000-000000000a01', org_is_demo: false, org_features: ['phone'],
      },
      isAuthenticated: true, isLoading: false, error: null,
    }),
  );
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === MY_SWITCHES_URL) return VIEWS_CUSTOMERS_ANSWER;
    if (url === '/api/communication/threads') return { data: { threads: [LISTED] } };
    if (url === `/api/communication/threads/${BY_RECORD}`) return { data: { thread: REACHED } };
    if (url === `/api/communication/threads/${UNREADABLE}`) throw readRefused(404);
    if (url === '/api/communication/contacts') return { data: { contacts: [] } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/numbers') return { data: { numbers: [] } };
    return { data: {} };
  });
  return renderWithProviders(
    <Routes><Route path="/communication/text" element={<TextPage />} /></Routes>,
    { initialEntries: [`/communication/text?threadId=${threadId}`], ability: COMM },
  );
}

const threadPane = () => document.querySelector<HTMLElement>('[data-pane="thread"]')!;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Text page, a bell link to a conversation', () => {
  it('opens a conversation the person may read but the list does not hold, instead of the list\'s first one', async () => {
    renderBellLink(BY_RECORD);

    expect(await within(threadPane()).findByText('Reached by the job message')).toBeInTheDocument();
    expect(within(threadPane()).queryByText('Listed conversation message')).not.toBeInTheDocument();
  });

  it('opens that conversation on a phone too', async () => {
    renderBellLink(BY_RECORD, { phone: true });

    expect(await within(threadPane()).findByText('Reached by the job message')).toBeInTheDocument();
    expect(within(threadPane()).queryByText('Listed conversation message')).not.toBeInTheDocument();
  });

  it('opens a conversation that is in the list from the list, with no extra read', async () => {
    renderBellLink(IN_LIST);

    expect(await within(threadPane()).findByText('Listed conversation message')).toBeInTheDocument();
    const urls = () => mockApi.get.mock.calls.map((c) => c[0]);
    await waitFor(() => expect(urls()).toContain('/api/communication/threads'));
    expect(urls()).not.toContain(`/api/communication/threads/${IN_LIST}`);
  });

  it('says the conversation is not available when the person may not read it, and shows no other conversation', async () => {
    renderBellLink(UNREADABLE);

    expect(await within(threadPane()).findByText('This conversation is not available.')).toBeInTheDocument();
    expect(within(threadPane()).queryByText('Listed conversation message')).not.toBeInTheDocument();
    expect(within(threadPane()).queryByText('Reached by the job message')).not.toBeInTheDocument();
  });

  it('opens another conversation from the list after saying the linked one is not available', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderBellLink(UNREADABLE);
    await within(threadPane()).findByText('This conversation is not available.');

    await user.click(await screen.findByRole('button', { name: /555-0001/ }));

    expect(await within(threadPane()).findByText('Listed conversation message')).toBeInTheDocument();
  });

  it('keeps a phone on the list, with a toast, when the linked conversation may not be read', async () => {
    renderBellLink(UNREADABLE, { phone: true });

    expect(await screen.findByText('This conversation is not available.')).toBeInTheDocument();
    await waitFor(() => expect(threadPane()).toHaveClass('hidden'));
    expect(screen.queryByText('Listed conversation message')).toBeInTheDocument(); // the list row, not a thread
    expect(within(threadPane()).queryByText('Listed conversation message')).not.toBeInTheDocument();
  });
});
