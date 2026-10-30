/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.18 - the Needs review folder on the ROUTED Email page (/communication/inbox renders this
// InboxPage), against the REAL data hooks: only the network layer is faked, by URL. The folder sits in the rail beside the
// others with a count of what is waiting, lists the held mail of the mailbox picked there with each item's reason, reads one
// item, and links it to a conversation. Phone width is simulated by answering the kit's own media queries.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const THREAD_A = '11111111-1111-4111-8111-111111111111';
const THREAD_B = '22222222-2222-4222-8222-222222222222';
const CONVERSATIONS = [
  { id: 'c1', threadId: THREAD_A, account: 'user', from: { name: 'Maria Garcia', email: 'maria@example.com' }, to: 'office@example.test', subject: 'Quote request', snippet: 'q', body: ['q'], at: 'May 1', ts: 20, unread: false, starred: false, folder: 'inbox', direction: 'in' },
  { id: 'c2', threadId: THREAD_B, account: 'user', from: { name: 'Office', email: 'office@example.test' }, to: 'pat@example.com', subject: 'Your invoice', snippet: 'i', body: ['i'], at: 'May 2', ts: 30, unread: false, starred: false, folder: 'sent', direction: 'out' },
];

type Reason = 'failed_authentication' | 'automatic' | 'sender_mismatch' | 'unknown_reply';
const held = (n: number, reason: Reason = 'automatic', extra: Record<string, unknown> = {}) => ({
  id: `held-${n}`, account: 'user', from: { name: `Sender ${n}`, email: `sender${n}@example.com` }, to: 'office@example.test',
  subject: `Held subject ${n}`, snippet: `Snippet ${n}`, body: [`Body paragraph ${n}`, 'Second paragraph'], at: 'Jun 1', ts: 1_000_000 - n,
  unread: true, starred: false, folder: 'needs_review', direction: 'in', reviewReason: reason, reviewMailboxId: 'box-mine', linkTo: null, ...extra,
});

let all: ReturnType<typeof held>[];
const unmatchedCalls: { mailbox: string; limit: number; offset: number }[] = [];

function answerNetwork() {
  vi.mocked(api.get).mockImplementation(async (url: string, config?: { params?: unknown }) => {
    const params = (config?.params ?? {}) as Record<string, unknown>;
    if (url === '/api/communication/mailboxes') {
      return {
        data: {
          scope: 'attached', selected: params.selected ?? 'mine', selected_label: null, selected_unread: 0, total_unread: 0,
          mine: { id: 'box-mine', unread: 0 }, held: [], main: null, people: null,
          needs_review: { selected: all.length, total: all.length },
        },
      };
    }
    if (url === '/api/communication/emails/unmatched') {
      const limit = Number(params.limit); const offset = Number(params.offset);
      unmatchedCalls.push({ mailbox: String(params.mailbox), limit, offset });
      return { data: { emails: all.slice(offset, offset + limit), total: all.length, limit, offset, selected: params.mailbox } };
    }
    if (url === '/api/communication/emails') return { data: { emails: CONVERSATIONS } };
    if (url === '/api/communication/email-groups') return { data: { groups: [] } };
    if (url === '/api/communication/forward-rules') return { data: { rules: [] } };
    if (url === '/api/communication/team-members') return { data: { members: [] } };
    if (url === '/api/communication/sending-identity') return { data: { status: 'active', address: 'me@mail.test', name: 'Me at Acme', sendingEnabled: true } };
    if (url === '/api/communication/my-mailbox') return { data: { mailbox: { status: 'active', address: 'me@mail.test' } } };
    return { data: {} };
  });
  vi.mocked(api.patch).mockImplementation(async (url: string) => {
    const id = /emails\/([^/]+)\/link/.exec(url)![1]!;
    all = all.filter((i) => i.id !== id);
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

beforeEach(() => {
  vi.clearAllMocks();
  unmatchedCalls.length = 0;
  all = [held(1, 'failed_authentication'), held(2, 'automatic'), held(3, 'sender_mismatch', { linkTo: { threadId: THREAD_B, subject: 'Your invoice' } }), held(4, 'unknown_reply')];
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u1', email: 'jane@test.com', first_name: 'Jane', last_name: 'Smith', role: 'DISPATCHER', organization_id: 'org-1', org_features: ['email', 'phone'] },
      isAuthenticated: true, isLoading: false, error: null,
    })) as typeof useAuthStore,
  );
  answerNetwork();
});
afterEach(() => mockWidth('desktop'));

const render = (ability = FULL, entry = '/communication/inbox') => renderWithProviders(<InboxPage />, { ability, initialEntries: [entry] });
const openFolder = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: /Needs review/ }));
  return screen.findByRole('region', { name: 'Held messages' });
};

describe('the Needs review folder in the rail', () => {
  it('sits beside the other folders with the number of items waiting in the picked mailbox', async () => {
    render();
    const entry = await screen.findByRole('button', { name: /Needs review/ });
    await waitFor(() => expect(entry).toHaveTextContent('4'));
    expect(entry).toHaveAttribute('aria-pressed', 'false');
    // Inbox is still where the page opens.
    expect(screen.getByRole('button', { name: /^Inbox/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows no count when nothing is waiting, and an honest empty list', async () => {
    all = [];
    const user = userEvent.setup();
    render();
    const entry = await screen.findByRole('button', { name: /Needs review/ });
    expect(entry).not.toHaveTextContent(/\d/);
    await user.click(entry);
    expect(await screen.findByText('Nothing to review.')).toBeInTheDocument();
  });
});

describe('the list', () => {
  it('lists the held mail of the picked mailbox, each with the reason it is held, in place of the inbox list', async () => {
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);

    expect(unmatchedCalls[0]).toMatchObject({ mailbox: 'mine', offset: 0 });
    expect(within(list).getAllByRole('button', { pressed: false })).toHaveLength(4);
    const first = within(list).getByText('Held subject 1').closest('button')!;
    expect(first).toHaveTextContent('Sender 1');
    expect(first).toHaveTextContent('Sender check failed');
    expect(within(list).getByText('Held subject 2').closest('button')).toHaveTextContent('Automatic mail');
    expect(within(list).getByText('Held subject 3').closest('button')).toHaveTextContent("Reply from an address we didn't send to");
    expect(within(list).getByText('Held subject 4').closest('button')).toHaveTextContent("Reply to an email we can't match");
    // The inbox list is not shown.
    expect(screen.queryByText('Quote request')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search mail')).not.toBeInTheDocument();
  });

  it('asks for the mailbox the page address names', async () => {
    const user = userEvent.setup();
    render(FULL, '/communication/inbox?mailbox=box-handed');
    await openFolder(user);
    await waitFor(() => expect(unmatchedCalls.some((c) => c.mailbox === 'box-handed')).toBe(true));
  });

  it('scales: 230 items come a page at a time inside a scroll of their own, every one reachable', async () => {
    all = Array.from({ length: 230 }, (_, n) => held(n + 1));
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);

    await waitFor(() => expect(within(list).getAllByRole('button', { pressed: false }).length).toBeGreaterThanOrEqual(50));
    expect(list.className).toMatch(/\boverflow-y-auto\b/);
    expect(unmatchedCalls).toEqual([{ mailbox: 'mine', limit: 50, offset: 0 }]);
    const more = await within(list).findByRole('button', { name: /Show more \(180\)/ });
    await user.click(more);
    await user.click(await within(list).findByRole('button', { name: /Show more \(130\)/ }));
    await user.click(await within(list).findByRole('button', { name: /Show more \(80\)/ }));
    await user.click(await within(list).findByRole('button', { name: /Show more \(30\)/ }));
    await waitFor(() => expect(within(list).queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument());
    expect(unmatchedCalls.map((c) => c.offset)).toEqual([0, 50, 100, 150, 200]);
    expect(list.querySelectorAll('[data-review-row]')).toHaveLength(230);
    expect(screen.getByRole('heading', { name: 'Needs review' }).parentElement).toHaveTextContent('230');
    // 230 rows in jsdom on a busy machine: the test is the slow part, not the page.
  }, 120_000);
});

describe('reading an item and linking it', () => {
  it('names the reason in a banner, shows the message, and offers the one action', async () => {
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);
    await user.click(within(list).getByText('Held subject 1'));

    // The banner is the one status region holding the reason and the action.
    const reason = (await screen.findAllByText('Sender check failed')).find((el) => el.closest('[role="status"]'))!;
    expect(reason.closest('[role="status"]')).toContainElement(screen.getByRole('button', { name: 'Link to a conversation' }));
    expect(screen.getByText('Body paragraph 1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Held subject 1' })).toBeInTheDocument();
    // What a person must know sits behind a "?", not under a header.
    await user.click(screen.getByRole('button', { name: 'About Sender check failed' }));
    expect(await screen.findByText(/never linked to a customer/)).toBeInTheDocument();
  });

  it('names a reply from another address in full in the banner, as the PRD words it', async () => {
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);
    await user.click(within(list).getByText('Held subject 3'));
    const reason = (await screen.findAllByText("Reply from an address we didn't send to")).find((el) => el.closest('[role="status"]'));
    expect(reason).toBeTruthy();
  });

  it('links a reply to the conversation it replied to in one step, and the item leaves the list and the count', async () => {
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);
    await user.click(within(list).getByText('Held subject 3'));
    await user.click(screen.getByRole('button', { name: 'Link to a conversation' }));

    const dialog = await screen.findByRole('dialog', { name: 'Link to a conversation' });
    await user.click(within(dialog).getByRole('button', { name: /It replied to.*Your invoice/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/communication/emails/held-3/link', {}));
    await waitFor(() => expect(within(list).queryByText('Held subject 3')).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: 'Link to a conversation' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /Needs review/ })).toHaveTextContent('3'));
  });

  it('links to a conversation picked from the ones the person can see, found by searching', async () => {
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);
    await user.click(within(list).getByText('Held subject 2'));
    await user.click(screen.getByRole('button', { name: 'Link to a conversation' }));

    const dialog = await screen.findByRole('dialog', { name: 'Link to a conversation' });
    // No suggestion for mail that was not a reply.
    expect(within(dialog).queryByText('It replied to')).not.toBeInTheDocument();
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search conversations' }), 'quote');
    expect(within(dialog).queryByText('Your invoice')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Quote request/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/communication/emails/held-2/link', { thread_id: THREAD_A }));
  });

  it('says so when no conversation matches the search', async () => {
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);
    await user.click(within(list).getByText('Held subject 2'));
    await user.click(screen.getByRole('button', { name: 'Link to a conversation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Link to a conversation' });
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search conversations' }), 'zzz');
    expect(within(dialog).getByText('No conversation matches.')).toBeInTheDocument();
  });

  it('keeps the item and shows the server\'s own words when the link is refused', async () => {
    vi.mocked(api.patch).mockRejectedValue({ response: { status: 404, data: { error: 'Conversation not found' } } });
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);
    await user.click(within(list).getByText('Held subject 3'));
    await user.click(screen.getByRole('button', { name: 'Link to a conversation' }));
    await user.click(await screen.findByRole('button', { name: /It replied to/ }));

    expect(await screen.findByText('Conversation not found')).toBeInTheDocument();
    expect(within(list).getByText('Held subject 3')).toBeInTheDocument();
  });

  it('offers no link to a person who cannot file mail into a conversation', async () => {
    const user = userEvent.setup();
    render(READ_ONLY);
    const list = await openFolder(user);
    await user.click(within(list).getByText('Held subject 1'));

    expect(await screen.findByText('Body paragraph 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link to a conversation' })).not.toBeInTheDocument();
  });
});

describe('at phone width', () => {
  it('opens the folder from the menu sheet, keeps the whole width for the list and opens an item full screen', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: 'Open menu' }));
    const menu = await screen.findByRole('dialog', { name: 'Menu' });
    await user.click(within(menu).getByRole('button', { name: /Needs review/ }));

    // Choosing it closes the menu, and the list is what is on screen.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument());
    const list = await screen.findByRole('region', { name: 'Held messages' });
    expect(list.parentElement!.className).toMatch(/\bflex-1\b/);

    await user.click(within(list).getByText('Held subject 3'));
    const reader = await screen.findByRole('dialog', { name: 'Held subject 3' });
    expect(within(reader).getByText('Body paragraph 3')).toBeInTheDocument();
    await user.click(within(reader).getByRole('button', { name: 'Link to a conversation' }));
    expect(await screen.findByRole('dialog', { name: 'Link to a conversation' })).toBeInTheDocument();
  });
});
