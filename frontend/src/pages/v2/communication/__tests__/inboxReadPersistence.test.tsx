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
}));

const EMAILS_FIXTURE: Email[] = [
  {
    id: 'e_inbox_1',
    account: 'system',
    from: { name: 'Dana Lee', email: 'dana@example.com' },
    to: 'emanuel@example.com',
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
    // isLive requires a from address - see InboxPage's `isLive` derivation.
    useSendingIdentity: () => ({ data: { address: 'ops@example.com', sendingEnabled: true } }),
    useMarkEmailThreadRead: () => ({ mutate: hoisted.markThreadReadMutate }),
    useMarkEmailThreadUnread: () => ({ mutate: vi.fn() }),
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
});
