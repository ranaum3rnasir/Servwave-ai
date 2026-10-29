/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 22: a real navigation drawer on phones, with the account block at its top.
//
// jsdom has no layout engine, so the width and height are chosen the way the app chooses them:
// through the media-query hook, stubbed with `window.matchMedia`. A phone matches every `max-width`
// query; a landscape phone matches only the short-height query (it is wide, but not tall).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';

import V2AppLayout from '../V2AppLayout';

vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({
  NotificationBell: () => <button type="button" aria-label="Notifications" />,
}));
vi.mock('@/components/layout/GlobalSearch', () => ({
  default: ({ placeholder }: { placeholder?: string }) => <input aria-label="Search everything" placeholder={placeholder} />,
}));
vi.mock('@/lib/api/communication', () => ({
  useUnreadCounts: () => ({ sms: 0, whatsapp: 0, email: 0 }),
}));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: { name: 'Test Org' } }) }));

// The real ClockInOutMenu runs; only its server hooks are controlled.
const clock = { isClockedIn: false, sinceTs: null as number | null, zoneLabel: null as string | null };
const mutateAsync = vi.fn().mockResolvedValue({});
vi.mock('@/lib/api/timeclock', () => ({
  useIsClockedIn: () => clock,
  useRecordPunch: () => ({ mutateAsync, isPending: false }),
}));

const REAL_MATCH_MEDIA = window.matchMedia;

type Screen = 'phone' | 'landscape' | 'desktop';

function stubScreen(kind: Screen) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      (kind === 'phone' && query.includes('max-width')) ||
      (kind === 'landscape' && query.includes('max-height')),
    media: query,
    onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
}

const logout = vi.fn();

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <AbilityProvider ability={buildAbility([{ action: 'manage', subject: 'all' }])}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="/" element={<div>dashboard page</div>} />
              <Route path="/leads/new" element={<div>new lead page</div>} />
              <Route path="/settings/company" element={<div>settings page</div>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const topBar = () => document.querySelector('[data-slot="topbar"]') as HTMLElement;
const trigger = () => within(topBar()).getByRole('button', { name: 'Open navigation' });

beforeEach(() => {
  localStorage.clear();
  logout.mockReset();
  mutateAsync.mockClear();
  clock.isClockedIn = false;
  clock.sinceTs = null;
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'tech@test.com',
        first_name: 'Test',
        last_name: 'Technician',
        role: 'ADMIN',
        org_features: ['phone', 'email'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
      logout,
    } as never),
  );
});
afterEach(() => {
  window.matchMedia = REAL_MATCH_MEDIA;
});

describe.each<Screen>(['phone', 'landscape'])('navigation drawer on a %s', (kind) => {
  beforeEach(() => stubScreen(kind));

  it('is shut until the trigger is tapped: not in the accessibility tree at all', () => {
    renderShell();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).toBeNull();
    expect(document.querySelector('aside[data-slot="sidebar"]')).toBeNull();
    expect(trigger()).toBeInTheDocument();
  });

  it('opens as a dialog, moves focus in, traps Tab, and gives focus back on Escape', async () => {
    renderShell();
    const user = userEvent.setup();
    await user.click(trigger());

    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));

    for (let i = 0; i < 40; i++) {
      await user.tab();
      expect(drawer.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(drawer.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.querySelector('aside[data-slot="sidebar"]')).toBeNull();
    await waitFor(() => expect(trigger()).toHaveFocus());
  });

  it('closes when a destination is picked', async () => {
    renderShell();
    const user = userEvent.setup();
    await user.click(trigger());
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });
    await user.click(within(drawer).getByRole('link', { name: /Customers/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('carries the account block at its top: clock in, Settings, Sign Out', async () => {
    renderShell();
    const user = userEvent.setup();
    await user.click(trigger());
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });

    const account = within(drawer).getByRole('region', { name: 'Account' });
    expect(account).toHaveTextContent('Test Technician');
    expect(within(account).getByRole('button', { name: /Clock In/ })).toBeInTheDocument();
    // First thing in the drawer, ahead of Create New and the destinations.
    const controls = [...drawer.querySelectorAll('a, button')];
    const firstOutsideAccount = controls.findIndex((c) => !account.contains(c));
    const lastInsideAccount = controls.map((c) => account.contains(c)).lastIndexOf(true);
    expect(lastInsideAccount).toBeLessThan(firstOutsideAccount);

    await user.click(within(account).getByRole('button', { name: 'Sign Out' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('opens Settings from the drawer and closes it', async () => {
    renderShell();
    const user = userEvent.setup();
    await user.click(trigger());
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });
    await user.click(within(drawer).getByRole('button', { name: 'Settings' }));
    expect(await screen.findByText('settings page')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the running timer and clocks out through the existing confirm', async () => {
    clock.isClockedIn = true;
    clock.sinceTs = Date.now() - 65_000;
    renderShell();
    const user = userEvent.setup();
    await user.click(trigger());
    const account = within(await screen.findByRole('dialog', { name: 'Navigation' })).getByRole('region', { name: 'Account' });

    expect(account).toHaveTextContent(/On the clock/);
    expect(account).toHaveTextContent(/00:01:0\d/);

    await user.click(within(account).getByRole('button', { name: /Clock Out/ }));
    expect(account).toHaveTextContent(/End your shift after/);
    await user.click(within(account).getByRole('button', { name: 'Clock Out' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ type: 'OUT' })));
  });

  it('expands Create New inside the drawer as a list, not a side popover', async () => {
    renderShell();
    const user = userEvent.setup();
    await user.click(trigger());
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });

    const create = within(drawer).getByRole('button', { name: 'Create New' });
    expect(create).toHaveAttribute('aria-expanded', 'false');
    await user.click(create);
    expect(create).toHaveAttribute('aria-expanded', 'true');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeNull();
    const row = within(drawer).getByRole('button', { name: 'New Lead' });
    expect(drawer.contains(row)).toBe(true);

    await user.click(row);
    expect(await screen.findByText('new lead page')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('top-bar overflow menu on a phone', () => {
  beforeEach(() => stubScreen('phone'));

  it('no longer carries the account actions: the drawer does', async () => {
    renderShell();
    await userEvent.setup().click(within(topBar()).getByRole('button', { name: /^More/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Sign Out' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Settings' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Help & support' })).toBeInTheDocument();
  });
});

describe('the "on the clock" dot on the trigger', () => {
  beforeEach(() => stubScreen('phone'));

  it('is absent while clocked out', () => {
    renderShell();
    expect(trigger()).not.toHaveAccessibleDescription();
    expect(trigger().querySelector('[data-slot="topbar-nav-status"]')).toBeNull();
  });

  it('shows while clocked in, with an accessible description', () => {
    clock.isClockedIn = true;
    clock.sinceTs = Date.now();
    renderShell();
    expect(trigger().querySelector('[data-slot="topbar-nav-status"]')).not.toBeNull();
    expect(trigger()).toHaveAccessibleDescription('On the clock');
    expect(trigger()).toHaveAccessibleName('Open navigation');
  });
});

describe('desktop is unchanged', () => {
  beforeEach(() => stubScreen('desktop'));

  it('keeps the inline sidebar, the account chip menu, the side Create New menu and no drawer trigger', async () => {
    renderShell();
    expect(within(topBar()).queryByRole('button', { name: 'Open navigation' })).toBeNull();
    expect(document.querySelector('aside[data-slot="sidebar"]')).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Account' })).toBeNull();

    const user = userEvent.setup();
    await user.click(within(topBar()).getByRole('button', { name: /Test Technician/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Sign Out' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Create New' }));
    expect(await screen.findByRole('menuitem', { name: 'New Lead' })).toBeInTheDocument();
  });
});
