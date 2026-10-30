/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.20 - the Email page's reading pane shows "Unverified sender" on a message linked to its
// customer by an address the sender's domain could not vouch for, and "Matches several customers" with a picker on a message from
// an address several customers share. The routed page runs with the REAL email, candidate and pick hooks; the server is answered at
// the network layer, so what is on screen is what the server sent and what the picker asks it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { Email, MailboxList } from '@/lib/api/communication';

const READER = [
  { action: 'read', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
] as const;
const reader = buildAbility([...READER]);
const attacher = buildAbility([...READER, { action: 'attach', subject: 'Communication' }]);

const NOTHING: unknown[] = [];

const mail = (over: Partial<Email> & { id: string; subject: string }): Email => ({
  account: 'system', from: { name: 'Pat Payer', email: 'pat@example.com' }, to: 'sam@mail.example.test', snippet: 'Are you open on Saturday?',
  body: ['Are you open on Saturday?'], at: '9:41 AM', ts: 1, unread: true, starred: false, folder: 'inbox', direction: 'in', ...over,
});

const ROWS: Email[] = [
  mail({
    id: 'unverified', subject: 'Unverified question', threadId: 't1', ts: 5, inboundAuth: 'NO_POLICY', unverifiedSender: true,
    customerId: 'cust-1',
  }),
  mail({
    id: 'verified', subject: 'Verified question', threadId: 't2', ts: 4, inboundAuth: 'PASS',
    customerId: 'cust-1',
  }),
  mail({ id: 'shared', subject: 'From a shared address', threadId: 't3', ts: 3, inboundAuth: 'PASS', matchesSeveralCustomers: true }),
  mail({ id: 'stranger', subject: 'From a stranger', threadId: 't4', ts: 2, inboundAuth: 'NO_POLICY' }),
];

const LIST: MailboxList = {
  scope: 'linked_to_me', selected: 'mine', selected_label: null, selected_unread: 4, total_unread: 4,
  mine: { id: 'box-mine', unread: 4 }, held: [], main: null, people: null,
};

/** The customers the server would offer for the shared address: far more than a page, so the picker has to be a search. */
const MATCHES = Array.from({ length: 120 }, (_, i) => ({ id: `cust-${i}`, name: `Shared Customer ${i}`, number: `C-${1000 + i}` }));
const PAGE = 50;

const calls = vi.hoisted(() => ({ gets: [] as { url: string; params?: Record<string, string> }[], patches: [] as { url: string; body: unknown }[] }));

vi.mock('@/lib/axios', () => ({
  default: {
    get: (url: string, config?: { params?: Record<string, string> }) => {
      calls.gets.push({ url, params: config?.params });
      if (url.endsWith('/mailboxes')) return Promise.resolve({ data: LIST });
      if (url.endsWith('/customer-candidates')) {
        const search = (config?.params?.search ?? '').toLowerCase();
        const found = MATCHES.filter((c) => c.name.toLowerCase().includes(search));
        return Promise.resolve({ data: { customers: found.slice(0, PAGE), total: found.length } });
      }
      return Promise.resolve({ data: { emails: ROWS } });
    },
    patch: (url: string, body: unknown) => {
      calls.patches.push({ url, body });
      return Promise.resolve({ data: { email: ROWS[2] } });
    },
  },
}));

vi.mock('@/lib/api/communication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/communication')>();
  return {
    ...actual,
    useEmailGroups: () => ({ data: NOTHING }),
    useForwardRules: () => ({ data: NOTHING }),
    useTeamMembers: () => ({ data: NOTHING }),
    useSendingIdentity: () => ({ data: undefined }),
    useMarkEmailThreadRead: () => ({ mutate: vi.fn() }),
    useMarkEmailThreadUnread: () => ({ mutate: vi.fn() }),
    useSendEmail: () => ({ mutate: vi.fn(), isPending: false }),
    useMyMailbox: () => ({ data: { mailbox: null } }),
  };
});

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
  useEntitlementsReady: () => true,
}));

import InboxPage from '@/pages/v2/communication/InboxPage';

beforeEach(() => {
  calls.gets.length = 0;
  calls.patches.length = 0;
});

const open = async (user: ReturnType<typeof userEvent.setup>, subject: string) => {
  await user.click(await screen.findByText(subject));
  return screen.findByRole('toolbar', { name: 'Message actions' });
};

describe('the Email page marks a message from an unverified sender', () => {
  it('shows "Unverified sender" on the open message the server marked, and on no other', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InboxPage />, { ability: reader, initialEntries: ['/communication/inbox'] });

    await open(user, 'Unverified question');
    expect(await screen.findByText('Unverified sender')).toBeInTheDocument();

    await open(user, 'Verified question');
    await waitFor(() => expect(screen.queryByText('Unverified sender')).not.toBeInTheDocument());

    // An unverified sender that no customer has is not marked: nothing was linked.
    await open(user, 'From a stranger');
    expect(screen.queryByText('Unverified sender')).not.toBeInTheDocument();
  });
});

describe('the Email page says a message matches several customers', () => {
  it('says so, with no picker, to a person without the attach switch', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InboxPage />, { ability: reader, initialEntries: ['/communication/inbox'] });

    await open(user, 'From a shared address');
    expect(await screen.findByText('Matches several customers')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose customer' })).not.toBeInTheDocument();
  });

  it('says nothing on a message that matches one customer or none', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InboxPage />, { ability: attacher, initialEntries: ['/communication/inbox'] });

    await open(user, 'Verified question');
    expect(screen.queryByText('Matches several customers')).not.toBeInTheDocument();
    await open(user, 'From a stranger');
    expect(screen.queryByText('Matches several customers')).not.toBeInTheDocument();
  });

  it('offers the picker to a person with the attach switch, and links the customer they pick', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InboxPage />, { ability: attacher, initialEntries: ['/communication/inbox'] });

    await open(user, 'From a shared address');
    await user.click(await screen.findByRole('button', { name: 'Choose customer' }));

    const dialog = await screen.findByRole('dialog', { name: 'Choose customer' });
    await user.click(await within(dialog).findByRole('button', { name: /^Shared Customer 7C-1007$/ }));

    await waitFor(() => expect(calls.patches).toEqual([{ url: '/api/communication/emails/shared/customer', body: { customer_id: 'cust-7' } }]));
    // The picker closes once the customer is linked.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose customer' })).not.toBeInTheDocument());
  });

  it('asks the server for no candidates once the pick is made: the message is linked, so that request could only be refused', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InboxPage />, { ability: attacher, initialEntries: ['/communication/inbox'] });

    await open(user, 'From a shared address');
    await user.click(await screen.findByRole('button', { name: 'Choose customer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose customer' });
    const button = await within(dialog).findByRole('button', { name: /^Shared Customer 7C-1007$/ });

    const asked = () => calls.gets.filter((g) => g.url.endsWith('/emails/shared/customer-candidates')).length;
    const askedBeforePick = asked();
    await user.click(button);
    await waitFor(() => expect(calls.patches).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose customer' })).not.toBeInTheDocument());
    // Let any refetch the pick set off reach the network before looking.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(asked()).toBe(askedBeforePick);
  });

  it('is a search, never a wall: a hundred and twenty customers show a page of them, the total, and narrow with the search', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InboxPage />, { ability: attacher, initialEntries: ['/communication/inbox'] });

    await open(user, 'From a shared address');
    await user.click(await screen.findByRole('button', { name: 'Choose customer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose customer' });

    const list = await within(dialog).findByRole('list', { name: 'Customers' });
    expect(within(list).getAllByRole('button')).toHaveLength(PAGE);
    expect(within(dialog).getByText('Showing 50 of 120. Search to narrow them.')).toBeInTheDocument();
    // The list keeps to a scroll of its own.
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toContain('max-h-72');

    await user.type(within(dialog).getByRole('searchbox', { name: 'Search customers' }), 'Customer 119');
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Customers' })).getAllByRole('button')).toHaveLength(1));
    expect(within(dialog).getByRole('button', { name: /Shared Customer 119/ })).toBeInTheDocument();
    expect(within(dialog).queryByText(/Showing/)).not.toBeInTheDocument();
    expect(calls.gets.some((g) => g.url.endsWith('/emails/shared/customer-candidates') && g.params?.search === 'Customer 119')).toBe(true);
  });
});
