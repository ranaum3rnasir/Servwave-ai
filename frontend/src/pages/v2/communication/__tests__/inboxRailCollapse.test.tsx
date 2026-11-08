/// <reference types="@testing-library/jest-dom/vitest" />
// #1343 - the v2 inbox (the page actually routed at /communication/inbox; the
// legacy src/pages/communication/InboxPage.tsx is dead code, imported by
// nothing but its own test) auto-collapsed the folder rail on EVERY message
// open with no viewport check at all. PR #1391 fixed only the legacy page;
// this locks the same fix on the live v2 page so the regression can't recur
// silently on the route users actually hit.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { Email, EmailGroup, ForwardRule, TeamMember } from '@/lib/api/communication';

const readAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

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
    useSendingIdentity: () => ({ data: undefined }),
    useMarkEmailThreadRead: () => ({ mutate: vi.fn() }),
    useSendEmail: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import InboxPage from '@/pages/v2/communication/InboxPage';

function renderInbox() {
  return renderWithProviders(<InboxPage />, { ability: readAbility });
}

describe('v2 InboxPage — folder rail auto-collapse (#1343)', () => {
  it('keeps the folder rail open when a message is opened on desktop', async () => {
    // setup.ts mocks matchMedia to `matches: false` for every query, which is
    // the >=lg desktop branch of `useMediaQuery('(max-width: 1023.98px)')`.
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByText('AC still not cooling'));

    expect(await screen.findAllByText(/Following up on the visit from last week/)).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: /^Drafts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse menu' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open menu' })).not.toBeInTheDocument();
  });

  it('still collapses and reopens the rail from the manual toggles on desktop', async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByText('AC still not cooling'));

    await user.click(screen.getByRole('button', { name: 'Collapse menu' }));
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Drafts/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('button', { name: /^Drafts/ })).toBeInTheDocument();
  });
});

describe('v2 InboxPage — narrow viewport rail auto-collapse (#1343)', () => {
  // Full MediaQueryList stub - useMediaQuery calls addEventListener, so a
  // partial stub throws.
  function mockMatchMedia(matchesFor: (query: string) => boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: matchesFor(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  beforeEach(() => {
    mockMatchMedia((q) => q === '(max-width: 1023.98px)');
  });

  // window.matchMedia is a plain writable property, so an un-restored override
  // would leak the narrow branch into every later test in this file.
  afterEach(() => {
    mockMatchMedia(() => false);
  });

  it('collapses the rail when a message is opened below lg', async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(await screen.findByText('AC still not cooling'));

    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Drafts/ })).not.toBeInTheDocument();
  });
});
