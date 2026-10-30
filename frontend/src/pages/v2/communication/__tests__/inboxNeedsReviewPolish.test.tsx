/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.18 (design-screenshot polish) - what the Needs review folder got wrong on the ROUTED
// Email page (/communication/inbox renders this InboxPage), against the REAL data hooks: only the network layer is faked, by URL.
//   1. a held item showed a clock time with no day, so a four-day-old item and a new one looked alike;
//   2. the page title stayed "Inbox" over a folder that holds mail which is NOT in the inbox;
//   3. the list badge and the reader banner worded one reason two ways;
//   4. the reader's To line printed the random token of a reply address;
//   5. the link dialog's footer sat on the scroll area with nothing between them;
//   6. on a phone the page header ate the screen, and the menu sheet showed the desktop collapse icon instead of a close X.
// Phone width is simulated by answering the kit's own media queries.
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

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
  useEntitlementsReady: () => true,
}));

import InboxPage from '@/pages/v2/communication/InboxPage';

/** Wednesday 14 Oct 2026, noon on the default company clock (US Eastern). */
const NOW = new Date('2026-10-14T16:00:00.000Z');
const at = (iso: string) => new Date(iso).getTime();

const THREAD_A = '11111111-1111-4111-8111-111111111111';
const REPLY_LOCAL_PART = 'reply-sample-local-part';
const LONG_ADDRESS = 'system.admin.support@mail.servwave.example';

type Reason = 'failed_authentication' | 'automatic' | 'sender_mismatch' | 'unknown_reply';
const held = (n: number, reason: Reason, ts: number, extra: Record<string, unknown> = {}) => ({
  id: `held-${n}`, account: 'user', from: { name: `Sender ${n}`, email: `sender${n}@example.com` }, to: 'office@example.test',
  subject: `Held subject ${n}`, snippet: `Snippet ${n}`, body: [`Body paragraph ${n}`], at: '2:07 AM', ts,
  unread: true, starred: false, folder: 'needs_review', direction: 'in', reviewReason: reason, reviewMailboxId: 'box-mine', linkTo: null, ...extra,
});

const CONVERSATIONS = Array.from({ length: 130 }, (_, n) => ({
  id: `c${n}`, threadId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, account: 'user',
  from: { name: `Person ${n}`, email: `person${n}@example.com` }, to: 'office@example.test', subject: `Conversation ${n}`,
  snippet: 's', body: ['s'], at: 'May 1', ts: 1000 + n, unread: false, starred: false, folder: 'inbox', direction: 'in',
}));

let all: ReturnType<typeof held>[];

function answerNetwork() {
  vi.mocked(api.get).mockImplementation(async (url: string, config?: { params?: unknown }) => {
    const params = (config?.params ?? {}) as Record<string, unknown>;
    if (url === '/api/communication/mailboxes') {
      return {
        data: {
          scope: 'linked_to_me', selected: params.selected ?? 'mine', selected_label: null, selected_unread: 0, total_unread: 0,
          mine: { id: 'box-mine', unread: 0 }, held: [], main: null, people: null,
          needs_review: { selected: all.length, total: all.length },
        },
      };
    }
    if (url === '/api/communication/emails/unmatched') {
      const limit = Number(params.limit); const offset = Number(params.offset);
      return { data: { emails: all.slice(offset, offset + limit), total: all.length, limit, offset, selected: params.mailbox } };
    }
    if (url === '/api/communication/emails') return { data: { emails: CONVERSATIONS } };
    if (url === '/api/communication/email-groups') return { data: { groups: [] } };
    if (url === '/api/communication/forward-rules') return { data: { rules: [] } };
    if (url === '/api/communication/team-members') return { data: { members: [] } };
    if (url === '/api/communication/sending-identity') return { data: { status: 'active', address: LONG_ADDRESS, name: 'Me at Acme', sendingEnabled: true } };
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
  // Only the clock: timers stay real so the page and the user events run as they do.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  all = [held(1, 'automatic', at('2026-10-14T14:07:00.000Z'))];
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u1', email: 'jane@test.com', first_name: 'Jane', last_name: 'Smith', role: 'DISPATCHER', organization_id: 'org-1', org_features: ['email', 'phone'] },
      isAuthenticated: true, isLoading: false, error: null,
    })) as typeof useAuthStore,
  );
  answerNetwork();
});
afterEach(() => {
  vi.useRealTimers();
  mockWidth('desktop');
});

const render = () => renderWithProviders(<InboxPage />, { ability: FULL, initialEntries: ['/communication/inbox'] });
const openFolder = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: /Needs review/ }));
  return screen.findByRole('region', { name: 'Held messages' });
};
const rowOf = (list: HTMLElement, subject: string) => within(list).getByText(subject).closest('button')!;

describe('the day of a held item', () => {
  it('reads as the Email page reads older mail: today a time, yesterday "Yesterday", this week a weekday, older a date', async () => {
    all = [
      held(1, 'automatic', at('2026-10-14T14:07:00.000Z')), // today, 10:07 AM
      held(2, 'automatic', at('2026-10-13T18:00:00.000Z')), // yesterday
      held(3, 'automatic', at('2026-10-11T18:00:00.000Z')), // three days ago, a Sunday
      held(4, 'automatic', at('2026-10-08T18:00:00.000Z')), // six days ago, a Thursday: still this week
      held(5, 'automatic', at('2026-10-07T18:00:00.000Z')), // a week ago: a date
      held(6, 'automatic', at('2025-10-04T18:00:00.000Z')), // last year: a date with its year
    ];
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);

    expect(rowOf(list, 'Held subject 1')).toHaveTextContent('10:07 AM');
    expect(rowOf(list, 'Held subject 2')).toHaveTextContent('Yesterday');
    expect(rowOf(list, 'Held subject 3')).toHaveTextContent('Sun');
    expect(rowOf(list, 'Held subject 4')).toHaveTextContent('Thu');
    expect(rowOf(list, 'Held subject 5')).toHaveTextContent('Oct 7');
    expect(rowOf(list, 'Held subject 6')).toHaveTextContent('Oct 4, 2025');
    // The stored clock string is not what is shown any more.
    expect(rowOf(list, 'Held subject 2')).not.toHaveTextContent('2:07 AM');
  });

  it('puts the day in front of the time in the reader, so an old item is dated there too', async () => {
    all = [held(1, 'automatic', at('2026-10-11T18:00:00.000Z')), held(2, 'automatic', at('2026-10-14T14:07:00.000Z'))];
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);

    await user.click(within(list).getByText('Held subject 1'));
    expect(await screen.findByText(/Sun, 2:00 PM/)).toBeInTheDocument();

    await user.click(within(list).getByText('Held subject 2'));
    expect(await screen.findByText(/- 10:07 AM/)).toBeInTheDocument();
    expect(screen.queryByText(/Sun, 2:00 PM/)).not.toBeInTheDocument();
  });
});

describe('the page title', () => {
  it('follows the Needs review folder, and goes back to Inbox for every other folder', async () => {
    const user = userEvent.setup();
    render();
    const title = () => screen.getByRole('heading', { level: 1 });
    await screen.findByRole('button', { name: /Needs review/ });
    expect(title()).toHaveTextContent(/^Inbox/);

    await openFolder(user);
    expect(title()).toHaveTextContent(/^Needs review/);
    expect(title()).not.toHaveTextContent(/Inbox/);

    await user.click(screen.getByRole('button', { name: /^Sent/ }));
    expect(title()).toHaveTextContent(/^Inbox/);
  });
});

describe('one wording for a reason', () => {
  const ALL_REASONS: [Reason, string][] = [
    ['failed_authentication', 'Sender check failed'],
    ['automatic', 'Automatic mail'],
    ['sender_mismatch', "Reply from an address we didn't send to"],
    ['unknown_reply', "Reply to an email we can't match"],
  ];

  it.each(ALL_REASONS)('says %s the same way in the list badge and in the reader banner', async (reason, words) => {
    all = [held(1, reason, at('2026-10-14T14:07:00.000Z'))];
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);

    expect(rowOf(list, 'Held subject 1')).toHaveTextContent(words);
    await user.click(within(list).getByText('Held subject 1'));
    const banner = (await screen.findAllByText(words)).map((el) => el.closest('[role="status"]')).find(Boolean);
    expect(banner).toBeTruthy();
    // The two old short forms are gone.
    expect(rowOf(list, 'Held subject 1')).not.toHaveTextContent(/Reply from another address|Reply we can't match/);
  });
});

describe('the To line of the reader', () => {
  it('names a reply address by what it is, never by its random token, and keeps the time in its own piece', async () => {
    all = [held(1, 'sender_mismatch', at('2026-10-13T18:00:00.000Z'), { to: `${REPLY_LOCAL_PART}@reply.servwave.com`, toReplyAddress: true })];
    const user = userEvent.setup();
    const { container } = render();
    const list = await openFolder(user);
    await user.click(within(list).getByText('Held subject 1'));

    const line = (await screen.findByText(/^To /, { selector: 'span' })).parentElement!;
    expect(line).toHaveTextContent('To our reply address');
    expect(container.ownerDocument.body.innerHTML).not.toContain(REPLY_LOCAL_PART);
    // The address clips, the time never does (a phone is 390 px wide).
    const time = within(line).getByText(/Yesterday, 2:00 PM/);
    expect(time.className).toMatch(/\bflex-none\b/);
    expect(within(line).getByText(/^To /).className).toMatch(/\btruncate\b/);
  });

  it('still shows the address of an ordinary recipient', async () => {
    all = [held(1, 'automatic', at('2026-10-14T14:07:00.000Z'), { to: 'dana.ops@mail.example.test' })];
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);
    await user.click(within(list).getByText('Held subject 1'));
    expect(await screen.findByText('To dana.ops@mail.example.test')).toBeInTheDocument();
  });
});

describe('the link dialog footer', () => {
  it('sits under the scroll area behind a divider of its own, not on the last row', async () => {
    all = [held(1, 'sender_mismatch', at('2026-10-14T14:07:00.000Z'))];
    const user = userEvent.setup();
    render();
    const list = await openFolder(user);
    await user.click(within(list).getByText('Held subject 1'));
    await user.click(await screen.findByRole('button', { name: 'Link to a conversation' }));

    const dialog = await screen.findByRole('dialog', { name: 'Link to a conversation' });
    const footer = await within(dialog).findByText(/Showing the newest 100 of 130\./);
    const scroller = within(dialog).getByRole('list', { name: 'Conversations' });
    expect(scroller.className).toMatch(/\boverflow-y-auto\b/);
    expect(scroller).not.toContainElement(footer);
    expect(footer.className).toMatch(/\bborder-t\b/);
    expect(footer.className).toMatch(/\bpt-/);
  });
});

describe('at phone width', () => {
  it('shows the menu sheet with a close X and without the desktop collapse icon', async () => {
    mockWidth('phone');
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: 'Open menu' }));
    const menu = await screen.findByRole('dialog', { name: 'Menu' });

    expect(within(menu).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(within(menu).queryByRole('button', { name: 'Collapse menu' })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument());
  });

  it('keeps the desktop collapse icon on a desktop', async () => {
    render();
    expect(await screen.findByRole('button', { name: 'Collapse menu' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('gives the address strip one row (the whole address and Copy, its label for a screen reader only) so the list gets the screen', async () => {
    mockWidth('phone');
    render();
    const address = await screen.findByText(LONG_ADDRESS, { selector: 'span' });
    const strip = address.parentElement!;
    expect(strip.className).not.toMatch(/\bflex-wrap\b/);
    expect(address.className).toMatch(/\bflex-1\b/);
    expect(screen.getByText('Your email address').className).toMatch(/\bsr-only\b/);
    // Every control stays reachable.
    expect(within(strip).getByRole('button', { name: 'Copy your email address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Compose/ })).toBeInTheDocument();
  });

  it('keeps the whole address strip, label included, on a desktop', async () => {
    render();
    const address = await screen.findByText(LONG_ADDRESS, { selector: 'span' });
    expect(address.parentElement!.className).toMatch(/\bflex-wrap\b/);
    expect(screen.getByText('Your email address').className).not.toMatch(/\bsr-only\b/);
  });
});
