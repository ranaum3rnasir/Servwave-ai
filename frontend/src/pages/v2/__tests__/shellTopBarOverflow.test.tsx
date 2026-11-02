/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 13: the top bar that fits a phone.
//
// The layout hands the shell a list of action descriptors and the SHELL decides what is inline and
// what moves into the one overflow menu below md. jsdom has no layout engine, so the width is
// chosen the only way the app itself chooses it: through the media-query hook, stubbed here by
// stubbing `window.matchMedia`. A phone matches every `max-width` query and no `min-width` one.
//
// What this pins, at phone width:
//   - Text messages, Inbox, the dialer and Help are NOT inline; they are items of the overflow menu;
//   - Notifications stays inline (it owns its own badge and sheet);
//   - the copilot pill is still in the bar, untouched, and never in the overflow menu;
//   - the account actions (Settings, Sign out) are NOT in the overflow menu: the navigation drawer
//     carries them (shellPhoneDrawer.test.tsx).
// And at desktop width the bar renders as it did before: the actions inline, no overflow button,
// no Help.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { communicationSectionAbility, seedMySwitches } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';

import V2AppLayout from '../V2AppLayout';

vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/communication/phone/OfficeSoftphoneWarmup', () => ({
  OfficeSoftphoneWarmup: () => null,
}));
// A stand-in with the real control's accessible name: the bell owns its own popover/sheet, which
// is not what this file is about. Where it renders (inline or not) is.
vi.mock('@/components/notifications/NotificationBell', () => ({
  NotificationBell: () => <button type="button" aria-label="Notifications" />,
}));
vi.mock('@/components/layout/GlobalSearch', () => ({
  default: ({ placeholder }: { placeholder?: string }) => <input aria-label="Search everything" placeholder={placeholder} />,
}));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
vi.mock('@/lib/api/communication', () => ({
  useUnreadCounts: () => ({ sms: 3, whatsapp: 0, email: 0 }),
}));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: { name: 'Test Org' } }) }));

const openPhoneTab = vi.fn();
vi.mock('@/lib/communication/phoneTabHandoff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/communication/phoneTabHandoff')>()),
  openPhoneTab: (...args: unknown[]) => openPhoneTab(...args),
}));

const REAL_MATCH_MEDIA = window.matchMedia;

/** Phone: every `max-width` query matches, every `min-width` (and height) one does not. */
function stubWidth(kind: 'phone' | 'desktop') {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: kind === 'phone' && query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <AbilityProvider ability={communicationSectionAbility()}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="/" element={<div>dashboard page</div>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const topBar = () => document.querySelector('[data-slot="topbar"]') as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  // Text messages and Inbox follow Show Text and Show Email (Roles & Permissions S08.17); both need Access Communication.
  seedMySwitches({ access_communication: true, show_text: true, show_email: true });
  openPhoneTab.mockReset();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'dispatch@test.com',
        first_name: 'Test',
        last_name: 'Dispatcher',
        role: 'ADMIN',
        org_features: ['phone', 'email'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
      logout: vi.fn(),
    } as never),
  );
});
afterEach(() => {
  window.matchMedia = REAL_MATCH_MEDIA;
});

describe('top bar at phone width', () => {
  beforeEach(() => stubWidth('phone'));

  it('moves Text messages, Inbox and the dialer out of the bar and keeps Notifications inline', () => {
    renderShell();
    const bar = within(topBar());

    expect(bar.queryByRole('button', { name: 'Text messages' })).toBeNull();
    expect(bar.queryByRole('button', { name: 'Inbox' })).toBeNull();
    expect(bar.queryByRole('button', { name: /open dialer/i })).toBeNull();
    // The account chip moves too; the bar would not fit 320 px with it.
    expect(bar.queryByRole('button', { name: /Test Dispatcher/ })).toBeNull();

    expect(bar.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(bar.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
    expect(bar.getByRole('button', { name: /^More/ })).toBeInTheDocument();
    // The full search field gives way to a search button.
    expect(bar.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(bar.queryByRole('textbox', { name: 'Search everything' })).toBeNull();
  });

  it('leaves the copilot pill in the bar, outside the overflow menu', async () => {
    renderShell();
    const pill = within(topBar()).getByRole('button', { name: 'Open Servy, the AI copilot' });
    expect(pill).toHaveAttribute('data-slot', 'topbar-pill');

    await userEvent.setup().click(within(topBar()).getByRole('button', { name: /^More/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText(/Servy/)).toBeNull();
  });

  it('holds Text messages, Inbox, the dialer and Help in the overflow menu, but not the account actions', async () => {
    renderShell();
    const user = userEvent.setup();
    await user.click(within(topBar()).getByRole('button', { name: /^More/ }));
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem').map((el) => el.textContent?.trim());

    expect(items).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Text messages/),
      expect.stringMatching(/^Inbox/),
      'Dialer',
      'Help & support',
    ]));
    // Settings and Sign Out live in the navigation drawer's account block.
    expect(items).not.toContain('Settings');
    expect(items).not.toContain('Sign Out');
    // The unread count travels with its action into the menu.
    expect(within(menu).getByRole('menuitem', { name: /Text messages/ })).toHaveTextContent('3');

    await user.click(within(menu).getByRole('menuitem', { name: 'Dialer' }));
    expect(openPhoneTab).toHaveBeenCalledTimes(1);
  });

  it('points Help at ServWave support', async () => {
    renderShell();
    await userEvent.setup().click(within(topBar()).getByRole('button', { name: /^More/ }));
    const help = within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Help & support' });
    expect(help.closest('a') ?? help).toHaveAttribute('href', expect.stringMatching(/^mailto:support@servwave\.com/));
  });

  it('tells a screen reader that something in the overflow menu is unread', () => {
    renderShell();
    expect(within(topBar()).getByRole('button', { name: /^More/ })).toHaveAccessibleName(/unread/i);
  });
});

describe('top bar at desktop width (unchanged)', () => {
  beforeEach(() => stubWidth('desktop'));

  it('renders every action inline, with no overflow button and no Help', () => {
    renderShell();
    const bar = within(topBar());

    expect(bar.getByRole('button', { name: 'Text messages' })).toBeInTheDocument();
    expect(bar.getByRole('button', { name: 'Inbox' })).toBeInTheDocument();
    expect(bar.getByRole('button', { name: /open dialer/i })).toBeInTheDocument();
    expect(bar.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(bar.getByRole('button', { name: /Test Dispatcher/ })).toBeInTheDocument();
    expect(bar.getByRole('textbox', { name: 'Search everything' })).toBeInTheDocument();
    expect(bar.getByRole('button', { name: 'Open Servy, the AI copilot' })).toBeInTheDocument();

    expect(bar.queryByRole('button', { name: /^More/ })).toBeNull();
    expect(bar.queryByRole('button', { name: 'Search' })).toBeNull();
    expect(bar.queryByRole('button', { name: 'Open navigation' })).toBeNull();
    expect(screen.queryByText('Help & support')).toBeNull();
  });

  it('keeps the desktop order: pill, comms, dialer, Notifications, account', () => {
    renderShell();
    const names = within(topBar())
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '');
    const order = ['Open Servy, the AI copilot', 'Text messages', 'Inbox', 'Open dialer', 'Notifications'];
    const at = order.map((n) => names.indexOf(n));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(names[names.length - 1]).toMatch(/Test Dispatcher/);
  });
});
