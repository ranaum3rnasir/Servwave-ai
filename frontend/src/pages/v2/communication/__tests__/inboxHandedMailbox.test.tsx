/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.22 - a mailbox handed to a person shows in THEIR mailbox list on the ROUTED Email
// page (/communication/inbox renders this InboxPage) as "<owner>'s mailbox", under the original owner's name, with its own
// unread count, and a mailbox that was moved on to someone else is simply not in the previous holder's list. The page runs
// on the real mailbox-list and email-list queries; only the network layer answers. (The server's rule, that the holder
// reads all of it and replies from their own address, is proved against the real routes in the backend
// `permission-mailbox-handover-person-db.test.ts`.)
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { MailboxList } from '@/lib/api/communication';

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

const NOTHING: unknown[] = [];
const answer = vi.hoisted(() => ({ held: [] as { id: string; name: string; unread: number }[] }));

vi.mock('@/lib/axios', () => ({
  default: {
    get: (url: string, config?: { params?: Record<string, string> }) => {
      const selected = config?.params?.selected ?? 'mine';
      const body: MailboxList | { emails: never[] } = url.endsWith('/mailboxes')
        ? {
            scope: 'attached', selected, selected_label: null, selected_unread: 0, total_unread: 5,
            mine: { id: 'box-mine', unread: 3 }, held: answer.held, main: null, people: null,
          }
        : { emails: [] };
      return Promise.resolve({ data: body });
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

const renderPage = () => renderWithProviders(<InboxPage />, { ability, initialEntries: ['/communication/inbox'] });

beforeEach(() => {
  answer.held = [];
});

describe('the Email page: a mailbox handed to the person', () => {
  it('lists each one under its original owner\'s name, after "My mailbox", with its own unread count', async () => {
    answer.held = [
      { id: 'box-jane', name: 'Jane Smith', unread: 2 },
      { id: 'box-omar', name: 'Omar Other', unread: 0 },
    ];
    renderPage();

    const mailboxes = await screen.findByRole('list', { name: 'Mailboxes' });
    const jane = await within(mailboxes).findByRole('button', { name: /Jane Smith's mailbox/ });
    expect(jane).toHaveTextContent('2');
    expect(within(mailboxes).getByRole('button', { name: /Omar Other's mailbox/ })).toBeInTheDocument();
    const labels = within(mailboxes).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(labels[0]).toMatch(/^My mailbox/);
    expect(labels[1]).toMatch(/^Jane Smith's mailbox/);
  });

  it('shows nothing extra to a person who no longer holds it (it was moved on): only "My mailbox"', async () => {
    renderPage();

    const mailboxes = await screen.findByRole('list', { name: 'Mailboxes' });
    expect(await within(mailboxes).findByRole('button', { name: /My mailbox/ })).toBeInTheDocument();
    expect(within(mailboxes).getAllByRole('button')).toHaveLength(1);
    expect(within(mailboxes).queryByRole('button', { name: /'s mailbox/ })).toBeNull();
  });

  it('names no email provider', async () => {
    answer.held = [{ id: 'box-jane', name: 'Jane Smith', unread: 2 }];
    renderPage();
    const mailboxes = await screen.findByRole('list', { name: 'Mailboxes' });
    await within(mailboxes).findByRole('button', { name: /Jane Smith's mailbox/ });
    expect(mailboxes.textContent ?? '').not.toMatch(/resend|supabase|ctm|calltracking|render|twilio|stripe/i);
  });
});
