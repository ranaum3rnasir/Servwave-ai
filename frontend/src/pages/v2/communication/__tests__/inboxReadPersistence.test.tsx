/// <reference types="@testing-library/jest-dom/vitest" />
// #2049 (Lead amendment L1) - `openEmail`'s read-state persistence used to gate on
// `ability.can('update', 'Communication')`, so a TECHNICIAN or any role holding
// `access_inbox` + `read Communication` but not `update` never fired the (now
// permitted, per slice 1's backend re-gate) `thread-read` PATCH when they opened an
// email — their inbox looked read locally but the server marker, and therefore the
// badge on reload/another device, never moved. The gate now keys on
// `read Communication`, matching the backend route's own gate.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { Email, EmailGroup, ForwardRule, TeamMember } from '@/lib/api/communication';

const hoisted = vi.hoisted(() => ({
  markThreadReadMutate: vi.fn(),
  markThreadUnreadMutate: vi.fn(),
  identity: { status: 'active', address: 'ops@example.com', name: 'Ops', sendingEnabled: true } as Record<string, unknown>,
}));

const EMAILS_FIXTURE: Email[] = [
  {
    id: 'e_inbox_1',
    account: 'system',
    from: { name: 'Dana Lee', email: 'dana@example.com' },
    to: 'sam@example.com',
    subject: 'AC still not cooling',
    snippet: 'Following up on the visit from last week...',
    body: ['Following up on the visit from last week.'],
    at: '9:41 AM',
    ts: 3,
    unread: true,
    starred: false,
    folder: 'inbox',
  },
];
const GROUPS_FIXTURE: EmailGroup[] = [];
const FORWARDS_FIXTURE: ForwardRule[] = [];
const MEMBERS_FIXTURE: TeamMember[] = [];

vi.mock('@/lib/api/communication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/communication')>();
  return {
    ...actual,
    useEmails: () => ({ data: EMAILS_FIXTURE }),
    useEmailGroups: () => ({ data: GROUPS_FIXTURE }),
    useForwardRules: () => ({ data: FORWARDS_FIXTURE }),
    useTeamMembers: () => ({ data: MEMBERS_FIXTURE }),
    useSendingIdentity: () => ({ data: hoisted.identity }),
    useMarkEmailThreadRead: () => ({ mutate: hoisted.markThreadReadMutate }),
    useMarkEmailThreadUnread: () => ({ mutate: hoisted.markThreadUnreadMutate }),
    useSendEmail: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import InboxPage from '@/pages/v2/communication/InboxPage';

function renderInbox(rules: Parameters<typeof buildAbility>[0]) {
  return renderWithProviders(<InboxPage />, { ability: buildAbility(rules) });
}

describe('v2 InboxPage — email read-state persistence gate (#2049 L1)', () => {
  beforeEach(() => {
    hoisted.markThreadReadMutate.mockClear();
    hoisted.markThreadUnreadMutate.mockClear();
    hoisted.identity = { status: 'active', address: 'ops@example.com', name: 'Ops', sendingEnabled: true };
  });

  it('fires the thread-read mutation for a viewer with read + access_inbox but NOT update', async () => {
    const user = userEvent.setup();
    renderInbox([
      { action: 'read', subject: 'Communication' },
      { action: 'access_inbox', subject: 'Communication' },
    ]);

    await user.click(await screen.findByText('AC still not cooling'));

    expect(hoisted.markThreadReadMutate).toHaveBeenCalledWith('e_inbox_1');
  });

  it('never fires the thread-read mutation for a viewer with no read access', async () => {
    renderInbox([{ action: 'access_inbox', subject: 'Communication' }]);

    expect(await screen.findByText("You don't have access to the inbox.")).toBeInTheDocument();
    expect(screen.queryByText('AC still not cooling')).not.toBeInTheDocument();
    expect(hoisted.markThreadReadMutate).not.toHaveBeenCalled();
  });

  // PRD 10 (S10.11): the sending identity is the person's OWN address. A person with none yet ("address needed") cannot
  // send, but they can still read the main mailbox, so reading must still persist.
  it('still fires the thread-read mutation for a person who has no sending address yet', async () => {
    hoisted.identity = { status: 'address_needed', address: null, name: null, sendingEnabled: true };
    const user = userEvent.setup();
    renderInbox([
      { action: 'read', subject: 'Communication' },
      { action: 'access_inbox', subject: 'Communication' },
    ]);

    await user.click(await screen.findByText('AC still not cooling'));

    expect(hoisted.markThreadReadMutate).toHaveBeenCalledWith('e_inbox_1');
  });

  it('still persists Mark as unread for a person who has no sending address yet', async () => {
    hoisted.identity = { status: 'address_needed', address: null, name: null, sendingEnabled: true };
    const user = userEvent.setup();
    renderInbox([
      { action: 'read', subject: 'Communication' },
      { action: 'access_inbox', subject: 'Communication' },
    ]);

    await user.click(await screen.findByText('AC still not cooling'));
    await user.click(await screen.findByRole('button', { name: /mark as unread/i }));

    expect(hoisted.markThreadUnreadMutate).toHaveBeenCalledWith('e_inbox_1');
  });
});
