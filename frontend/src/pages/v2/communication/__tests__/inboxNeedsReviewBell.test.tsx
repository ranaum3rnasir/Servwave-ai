/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.19 - the bell of a reply from an address we didn't send to opens the Needs review ITEM on
// the ROUTED Email page (/communication/inbox renders this InboxPage), against the REAL data hooks: only the network layer is
// faked, by URL. The page address carries the held message (`?review=`); the item opens in the reader although it sits in another
// mailbox's list, names the job or lead, and links. Phone width is simulated by answering the kit's own media queries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import api from '@/lib/axios';

const FULL = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);
const READ_ONLY = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
  useEntitlementsReady: () => true,
}));

import InboxPage from '@/pages/v2/communication/InboxPage';

const THREAD_INVOICE = '22222222-2222-4222-8222-222222222222';

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, account: 'user', from: { name: 'Their Spouse', email: 'spouse@example.com' }, to: 'abc@reply.example.test',
  subject: 'Re: Your invoice', snippet: 'We will pay on Friday', body: ['We will pay on Friday.', 'Second paragraph'], at: 'Jun 1',
  ts: 1_000_000, unread: true, starred: false, folder: 'needs_review', direction: 'in', reviewReason: 'sender_mismatch',
  reviewMailboxId: 'box-of-someone-else', linkTo: { threadId: THREAD_INVOICE, subject: 'Your invoice' },
  recordTie: { kind: 'job', id: 'job-1', label: 'J-1042' }, ...extra,
});

/** The held messages of the mailbox the person sees (their own): the bell's message is NOT among them. */
let listed: ReturnType<typeof item>[];
/** What the item route answers by id; a missing id answers 404, as for a message nobody can reach. */
let byId: Record<string, ReturnType<typeof item>>;
const itemCalls: string[] = [];

function answerNetwork() {
  vi.mocked(api.get).mockImplementation(async (url: string, config?: { params?: unknown }) => {
    const params = (config?.params ?? {}) as Record<string, unknown>;
    if (url === '/api/communication/mailboxes') {
      return {
        data: {
          scope: 'attached', selected: params.selected ?? 'mine', selected_label: null, selected_unread: 0, total_unread: 0,
          mine: { id: 'box-mine', unread: 0 }, held: [], main: null, people: null,
          needs_review: { selected: listed.length, total: listed.length },
        },
      };
    }
    const one = /^\/api\/communication\/emails\/unmatched\/([^/]+)$/.exec(url);
    if (one) {
      itemCalls.push(one[1]!);
      const found = byId[one[1]!];
      if (!found) throw { response: { status: 404, data: { error: 'Email not found' } } };
      return { data: { email: found } };
    }
    if (url === '/api/communication/emails/unmatched') {
      const limit = Number(params.limit); const offset = Number(params.offset);
      return { data: { emails: listed.slice(offset, offset + limit), total: listed.length, limit, offset, selected: params.mailbox } };
    }
    if (url === '/api/communication/emails') return { data: { emails: [] } };
    if (url === '/api/communication/email-groups') return { data: { groups: [] } };
    if (url === '/api/communication/forward-rules') return { data: { rules: [] } };
    if (url === '/api/communication/team-members') return { data: { members: [] } };
    if (url === '/api/communication/sending-identity') return { data: { status: 'active', address: 'me@mail.test', name: 'Me at Acme', sendingEnabled: true } };
    if (url === '/api/communication/my-mailbox') return { data: { mailbox: { status: 'active', address: 'me@mail.test' } } };
    return { data: {} };
  });
  vi.mocked(api.patch).mockImplementation(async (url: string) => {
    const id = /emails\/([^/]+)\/link/.exec(url)![1]!;
    delete byId[id];
    listed = listed.filter((i) => i.id !== id);
    return { data: { email: { id } } };
  });
}

/** phone: below md and below lg. desktop: neither (jsdom's default). */
function mockWidth(width: 'phone' | 'desktop') {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: width === 'phone' && (query === MEDIA.belowLg || query === MEDIA.belowMd),
    media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  itemCalls.length = 0;
  listed = [item('held-other', { subject: 'Held in my mailbox', reviewReason: 'automatic', reviewMailboxId: 'box-mine', recordTie: undefined, linkTo: null })];
  byId = { 'held-bell': item('held-bell') };
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u1', email: 'jane@test.com', first_name: 'Jane', last_name: 'Smith', role: 'DISPATCHER', organization_id: 'org-1', org_features: ['email', 'phone'] },
      isAuthenticated: true, isLoading: false, error: null,
    })) as typeof useAuthStore,
  );
  answerNetwork();
});
afterEach(() => mockWidth('desktop'));

const render = (ability = FULL, entry = '/communication/inbox?review=held-bell') =>
  renderWithProviders(<><InboxPage /><Where /></>, { ability, initialEntries: [entry] });

describe('the page the bell opens', () => {
  it('lands on the Needs review folder with the bell\'s message open, though it is in none of the lists the person sees', async () => {
    render();

    expect(await screen.findByRole('heading', { name: 'Re: Your invoice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Needs review/ })).toHaveAttribute('aria-pressed', 'true');
    expect(itemCalls).toEqual(['held-bell']);
    // The list beside it is the mailbox the person sees, and the bell's message is not in it.
    const list = await screen.findByRole('region', { name: 'Held messages' });
    expect(within(list).getByText('Held in my mailbox')).toBeInTheDocument();
    expect(within(list).queryByText('Re: Your invoice')).not.toBeInTheDocument();
    expect(screen.getByText('We will pay on Friday.')).toBeInTheDocument();
  });

  it('names the reason and the job the reply is about', async () => {
    render();

    const reason = (await screen.findAllByText("Reply from an address we didn't send to")).find((el) => el.closest('[role="status"]'));
    expect(reason).toBeTruthy();
    expect(screen.getByText('J-1042')).toBeInTheDocument();
    expect(screen.getByText('Job')).toBeInTheDocument();
  });

  it('names a lead when the reply is about a lead', async () => {
    byId = { 'held-bell': item('held-bell', { recordTie: { kind: 'lead', id: 'lead-1', label: 'L-77' } }) };
    render();

    expect(await screen.findByText('L-77')).toBeInTheDocument();
    expect(screen.getByText('Lead')).toBeInTheDocument();
  });

  it('links it to the conversation it replied to in one step, and leaves the message asked for behind', async () => {
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: 'Link to a conversation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link to a conversation' });
    await user.click(within(dialog).getByRole('button', { name: /It replied to.*Your invoice/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/communication/emails/held-bell/link', {}));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Re: Your invoice' })).not.toBeInTheDocument());
    expect(screen.getByTestId('where')).not.toHaveTextContent('review=');
  });

  it('says so when the message is no longer there, and keeps the list', async () => {
    byId = {};
    render();

    expect(await screen.findByText('This message is no longer waiting for review.')).toBeInTheDocument();
    const list = await screen.findByRole('region', { name: 'Held messages' });
    expect(within(list).getByText('Held in my mailbox')).toBeInTheDocument();
  });

  it('forgets the ask once the person opens another message', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByRole('heading', { name: 'Re: Your invoice' });
    expect(screen.getByTestId('where')).toHaveTextContent('review=held-bell');

    const list = await screen.findByRole('region', { name: 'Held messages' });
    await user.click(within(list).getByText('Held in my mailbox'));

    await waitFor(() => expect(screen.getByTestId('where')).not.toHaveTextContent('review='));
    expect(await screen.findByRole('heading', { name: 'Held in my mailbox' })).toBeInTheDocument();
  });

  it('offers no link to a person who cannot file mail into a conversation, but shows the message', async () => {
    render(READ_ONLY);

    expect(await screen.findByText('We will pay on Friday.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link to a conversation' })).not.toBeInTheDocument();
  });

  it('does not ask for any message when the page is opened without one', async () => {
    const user = userEvent.setup();
    render(FULL, '/communication/inbox');

    expect(await screen.findByRole('button', { name: /^Inbox/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(await screen.findByRole('button', { name: /Needs review/ }));
    await screen.findByRole('region', { name: 'Held messages' });
    expect(itemCalls).toEqual([]);
  });

  it('opens the message full screen at phone width', async () => {
    mockWidth('phone');
    render();

    const reader = await screen.findByRole('dialog', { name: 'Re: Your invoice' });
    expect(within(reader).getByText('We will pay on Friday.')).toBeInTheDocument();
    expect(within(reader).getByRole('button', { name: 'Link to a conversation' })).toBeInTheDocument();
  });
});
