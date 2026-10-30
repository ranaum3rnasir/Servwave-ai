/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slices S10.7 and S10.11 (scenario pass 3 fix) - the ROUTED Email page
// (/communication/inbox renders this InboxPage) at phone width.
//
// The REAL data hooks run; only the network layer is faked. jsdom applies no CSS, so width is simulated by answering the
// kit's own media queries, and what is asserted is what decides the layout: where the "Sending as" chip sits and whether it
// can wrap, whether the mailbox rail is inline (it squeezed the list to a sliver) or an overlay, and whether a long list of
// mailboxes scrolls inside its own box and keeps every full name readable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import api from '@/lib/axios';

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
  useEntitlementsReady: () => true,
}));

import InboxPage from '@/pages/v2/communication/InboxPage';

const LONG_ADDRESS = 'system.admin.support@mail.servwave.example';
const MAIL = {
  id: 'm1', threadId: 't1', account: 'user', from: { name: 'Maria Garcia', email: 'maria.garcia@example.com' },
  to: 'office@example.test', subject: 'Quote request', snippet: 'Can you quote it?', body: ['Can you quote it?'], at: 'May 1',
  ts: 1, unread: false, starred: false, folder: 'inbox', direction: 'in',
};

let heldMailboxes: { id: string; name: string; unread: number }[];

function answerNetwork() {
  vi.mocked(api.get).mockImplementation(async (url: string, config?: { params?: unknown }) => {
    if (url === '/api/communication/mailboxes') {
      const selected = (config?.params as { selected?: string } | undefined)?.selected ?? 'mine';
      return {
        data: {
          scope: 'linked_to_me', selected, selected_label: null, selected_unread: 0, total_unread: 0,
          mine: { id: 'box-mine', unread: 0 }, held: heldMailboxes, main: null, people: null,
        },
      };
    }
    if (url === '/api/communication/emails') return { data: { emails: [MAIL] } };
    if (url === '/api/communication/email-groups') return { data: { groups: [] } };
    if (url === '/api/communication/forward-rules') return { data: { rules: [] } };
    if (url === '/api/communication/team-members') return { data: { members: [] } };
    if (url === '/api/communication/sending-identity') return { data: { status: 'active', address: LONG_ADDRESS, name: 'Admin at Acme', sendingEnabled: true } };
    if (url === '/api/communication/my-mailbox') return { data: { mailbox: { status: 'active', address: LONG_ADDRESS } } };
    return { data: {} };
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
  heldMailboxes = [{ id: 'box-handed', name: 'Jane Smith', unread: 0 }];
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u1', email: 'jane@test.com', first_name: 'Jane', last_name: 'Smith', role: 'DISPATCHER', organization_id: 'org-1', org_features: ['email', 'phone'] },
      isAuthenticated: true, isLoading: false, error: null,
    })) as typeof useAuthStore,
  );
  answerNetwork();
});
afterEach(() => mockWidth('desktop'));

const render = () => renderWithProviders(<InboxPage />, { ability, initialEntries: ['/communication/inbox'] });
/** The chip's text, and the chip around it. */
const sendingAs = async () => {
  const text = await screen.findByText(new RegExp(`Sending as ${LONG_ADDRESS}`));
  return { text, chip: text.closest('[role="status"]') as HTMLElement };
};

describe('the "Sending as" chip in the Email page header', () => {
  it('shows the whole address and keeps it inside the screen: the chip drops under the title when it does not fit, and its own text breaks', async () => {
    mockWidth('phone');
    render();
    const { text, chip } = await sendingAs();

    expect(chip).toHaveTextContent(`Sending as ${LONG_ADDRESS}`);
    // The heading clips what overflows it, so the title row wraps instead of running on, and the chip never outgrows it.
    expect(chip.parentElement!.className).toMatch(/\bflex-wrap\b/);
    expect(chip.className).toMatch(/\bmax-w-full\b/);
    // Badge keeps its text on one line; the text inside the chip is allowed to break.
    expect(text.className).toMatch(/\bwhitespace-normal\b/);
  });
});

describe('the mailbox rail at phone width', () => {
  it('opens over the list as a menu overlay, not beside it, so the list keeps the whole width', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    render();
    await screen.findByText('Quote request');
    expect(screen.queryByRole('button', { name: /^Drafts/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open menu' }));

    const menu = await screen.findByRole('dialog', { name: 'Menu' });
    expect(within(menu).getByRole('button', { name: /^Drafts/ })).toBeInTheDocument();
    expect(within(menu).getByRole('list', { name: 'Mailboxes' })).toBeInTheDocument();
    // The list and its search are not in the rail's box.
    expect(within(menu).queryByPlaceholderText('Search mail')).toBeNull();
    expect(screen.getByPlaceholderText('Search mail')).toBeInTheDocument();
  });

  it('closes when a mailbox or a folder is picked, and its close X closes it too', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    render();
    await screen.findByText('Quote request');

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await user.click(await screen.findByRole('button', { name: /Jane Smith's mailbox/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await user.click(await screen.findByRole('button', { name: /^Sent/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull());

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await user.click(await screen.findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull());
  });

  it('stays beside the list on a desktop', async () => {
    mockWidth('desktop');
    render();
    await screen.findByText('Quote request');
    expect(screen.getByRole('button', { name: /^Drafts/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull();
  });
});

describe('a long list of mailboxes in the rail', () => {
  beforeEach(() => {
    heldMailboxes = Array.from({ length: 120 }, (_, n) => ({
      id: `box-${n}`, name: `Quality Assurance Communication Linked Person ${String(n).padStart(3, '0')}`, unread: 0,
    }));
  });

  it('scrolls inside its own box, so the folders under it stay in reach', async () => {
    render();
    const list = await screen.findByRole('list', { name: 'Mailboxes' });
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(121));
    expect(list.className).toMatch(/\bmax-h-/);
    expect(list.className).toMatch(/\boverflow-y-auto\b/);
    expect(screen.getByRole('button', { name: /^Drafts/ })).toBeInTheDocument();
  });

  it('gives every mailbox its full name on hover and focus, and lets it wrap instead of cutting it off', async () => {
    render();
    const list = await screen.findByRole('list', { name: 'Mailboxes' });
    const row = await within(list).findByRole('button', { name: /Person 119's mailbox/ });
    expect(row).toHaveAttribute('title', "Quality Assurance Communication Linked Person 119's mailbox");
    expect(within(row).getByText(/Person 119's mailbox/).className).not.toMatch(/\btruncate\b/);
  });
});
