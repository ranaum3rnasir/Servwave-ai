/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.7 - the Email page against the REAL mailbox-list and email-list queries.
// inboxMailboxes.test.tsx stubs both hooks and answers at once, so it cannot see what a real query does while the next
// answer is loading: the list keeps showing the previous answer, and the page must not read that as "the server refused
// the mailbox" and send the person back to their own.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { MailboxList } from '@/lib/api/communication';

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

const NOTHING: unknown[] = [];
const calls: { url: string; params: Record<string, string> }[] = [];

const WIDE = (selected: string): MailboxList => ({
  scope: 'all', selected, selected_label: selected === 'box-handed' ? "Jane Smith's mailbox" : null,
  selected_unread: 2, total_unread: 9, mine: { id: 'box-mine', unread: 1 },
  held: [{ id: 'box-handed', name: 'Jane Smith', unread: 2 }], main: { id: 'box-main', unread: 2 }, people: null,
});

// Every answer arrives late, as it does over a network, so there is a stretch where the new key has no answer yet.
vi.mock('@/lib/axios', () => ({
  default: {
    get: (url: string, config?: { params?: Record<string, string> }) => {
      const params = config?.params ?? {};
      calls.push({ url, params });
      const body = url.endsWith('/mailboxes') ? WIDE(params.selected ?? 'mine') : { emails: [] };
      return new Promise((resolve) => setTimeout(() => resolve({ data: body }), 60));
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

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

beforeEach(() => { calls.length = 0; });

describe('the Email page: choosing a mailbox while the next answer loads', () => {
  it('keeps the mailbox the person clicked and lists its mail, instead of snapping back to "My mailbox"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<><InboxPage /><Where /></>, { ability, initialEntries: ['/communication/inbox'] });

    await user.click(await screen.findByRole('button', { name: /Jane Smith's mailbox/ }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('?mailbox=box-handed'));

    // Wait past the late answers: the address must still name the mailbox, and its mail must have been asked for.
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/emails') && c.params.mailbox === 'box-handed')).toBe(true));
    expect(screen.getByTestId('where')).toHaveTextContent('/communication/inbox?mailbox=box-handed');
    expect(screen.getByRole('button', { name: /Jane Smith's mailbox/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('asks for no mail of the new mailbox before it knows whether the server lets the person open it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<><InboxPage /><Where /></>, { ability, initialEntries: ['/communication/inbox'] });
    await user.click(await screen.findByRole('button', { name: /Main mailbox/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/emails') && c.params.mailbox === 'box-main')).toBe(true));
    expect(screen.getByTestId('where')).toHaveTextContent('?mailbox=box-main');
  });
});
