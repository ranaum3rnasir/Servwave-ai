/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 35: on a tablet or an unfolded foldable (md up to lg, normal height) the sidebar is
// the 60 px icon rail, and expanding it opens the full sidebar as an overlay over the rail and the
// page instead of pushing the page.
//
// jsdom has no layout engine, so the width is chosen the way the app chooses it: through the
// media-query hook, stubbed with `window.matchMedia`. The stub is live (it keeps its listeners), so
// a test can resize the "window" and watch the shell react.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { MEDIA } from '@/ui-kit/lib/breakpoints';

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
vi.mock('@/lib/api/timeclock', () => ({
  useIsClockedIn: () => ({ isClockedIn: false, sinceTs: null, zoneLabel: null }),
  useRecordPunch: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const REAL_MATCH_MEDIA = window.matchMedia;

type Win = { width: number; height: number };
const TABLET: Win = { width: 820, height: 1180 };
const FOLDABLE: Win = { width: 884, height: 1104 };
const DESKTOP: Win = { width: 1280, height: 800 };
const PHONE: Win = { width: 390, height: 844 };
const LANDSCAPE_PHONE: Win = { width: 838, height: 390 };

/**
 * A live matchMedia for the named breakpoint queries: it evaluates the exact strings in `MEDIA`
 * against the current window and notifies listeners when `resize` changes the answer.
 */
function liveScreen(initial: Win) {
  let win = initial;
  const listeners = new Set<{ query: string; fn: () => void; last: boolean }>();
  const evaluate = (query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    const maxH = /max-height:\s*([\d.]+)px/.exec(query);
    if (max && win.width > Number(max[1])) return false;
    if (min && win.width < Number(min[1])) return false;
    if (maxH && win.height > Number(maxH[1])) return false;
    return Boolean(max || min || maxH);
  };
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() { return evaluate(query); },
    media: query,
    onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: (_: string, fn: () => void) => listeners.add({ query, fn, last: evaluate(query) }),
    removeEventListener: (_: string, fn: () => void) => {
      for (const l of listeners) if (l.fn === fn && l.query === query) listeners.delete(l);
    },
    dispatchEvent: vi.fn(),
  }));
  return {
    resize(next: Win) {
      win = next;
      act(() => {
        for (const l of [...listeners]) {
          const now = evaluate(l.query);
          if (now !== l.last) { l.last = now; l.fn(); }
        }
      });
    },
  };
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
const app = () => document.querySelector('[data-slot="app-shell"]') as HTMLElement;
const inFlowSidebar = () => document.querySelector('[data-slot="app-body"] > aside[data-slot="sidebar"]') as HTMLElement | null;
const railToggle = () => within(inFlowSidebar()!).getByRole('button', { name: 'Expand sidebar' });

beforeEach(() => {
  localStorage.clear();
  logout.mockReset();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
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

describe('the named queries the rail tier relies on', () => {
  it('md up to lg is the tier: 768 up to 1023.98', () => {
    expect(MEDIA.md).toBe('(min-width: 768px)');
    expect(MEDIA.belowLg).toBe('(max-width: 1023.98px)');
  });
});

describe.each<[string, Win]>([['iPad Mini', TABLET], ['an unfolded foldable', FOLDABLE]])('the rail on %s', (_name, size) => {
  beforeEach(() => { liveScreen(size); });

  it('starts as the 60 px icon rail in the flow, with no overlay mounted', () => {
    renderShell();
    expect(app()).toHaveClass('is-rail');
    const rail = inFlowSidebar();
    expect(rail).not.toBeNull();
    expect(rail).toHaveAttribute('data-mode', 'rail');
    // Only the rail exists: a closed overlay is not rendered, so nothing is left to paint over it
    // and nothing of it is in the accessibility tree or the tab order.
    expect(document.querySelectorAll('aside[data-slot="sidebar"]')).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-slot="nav-overlay"]')).toBeNull();
    // The phone drawer's opener belongs to phones.
    expect(within(topBar()).queryByRole('button', { name: 'Open navigation' })).toBeNull();
    // The wide top bar and its avatar menu are untouched.
    expect(within(topBar()).getByRole('button', { name: /Test Admin/ })).toBeInTheDocument();
    expect(railToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands over the rail and the page as a dialog without changing the page layout', async () => {
    renderShell();
    const user = userEvent.setup();
    await user.click(railToggle());

    const overlay = await screen.findByRole('dialog', { name: 'Navigation' });
    // Portalled out of the content column (and out of the frame): positioned against the window.
    expect(app().contains(overlay)).toBe(false);
    expect(document.querySelector('[data-slot="app-canvas"]')!.contains(overlay)).toBe(false);
    // The full sidebar, laid out expanded.
    const sidebar = overlay.querySelector('aside[data-slot="sidebar"]')!;
    expect(sidebar).toHaveAttribute('data-mode', 'expanded');
    expect(within(overlay).getByRole('link', { name: /Customers/ })).toBeInTheDocument();
    // The page does not move: the frame is still the rail layout under the overlay.
    expect(app()).toHaveClass('is-rail');
    expect(inFlowSidebar()).toHaveAttribute('data-mode', 'rail');
    // The avatar menu already carries the account actions at this width.
    expect(within(overlay).queryByRole('region', { name: 'Account' })).toBeNull();
  });

  it('moves focus in, traps Tab, closes on Escape and gives focus back to the rail toggle', async () => {
    renderShell();
    const user = userEvent.setup();
    await user.click(railToggle());
    const overlay = await screen.findByRole('dialog', { name: 'Navigation' });
    await waitFor(() => expect(overlay.contains(document.activeElement)).toBe(true));

    for (let i = 0; i < 40; i++) {
      await user.tab();
      expect(overlay.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(overlay.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.querySelectorAll('aside[data-slot="sidebar"]')).toHaveLength(1);
    await waitFor(() => expect(railToggle()).toHaveFocus());
  });

  it('closes when a destination is picked', async () => {
    renderShell();
    const user = userEvent.setup();
    await user.click(railToggle());
    const overlay = await screen.findByRole('dialog', { name: 'Navigation' });
    await user.click(within(overlay).getByRole('link', { name: /Customers/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes from the collapse control inside it', async () => {
    renderShell();
    const user = userEvent.setup();
    await user.click(railToggle());
    const overlay = await screen.findByRole('dialog', { name: 'Navigation' });
    await user.click(within(overlay).getByRole('button', { name: 'Collapse sidebar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('expands Create New inside the overlay as a list, and a pick closes the overlay', async () => {
    renderShell();
    const user = userEvent.setup();
    await user.click(railToggle());
    const overlay = await screen.findByRole('dialog', { name: 'Navigation' });
    await user.click(within(overlay).getByRole('button', { name: 'Create New' }));
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(within(overlay).getByRole('button', { name: 'New Lead' }));
    expect(await screen.findByText('new lead page')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('is shut again, not remembered as open, after a round trip to the wide layout', async () => {
    const screenSize = liveScreen(size);
    renderShell();
    const user = userEvent.setup();
    await user.click(railToggle());
    await screen.findByRole('dialog', { name: 'Navigation' });

    // Widen to lg: the overlay goes away with the layout that had it.
    screenSize.resize(DESKTOP);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(app()).not.toHaveClass('is-rail');
    // Back to the tablet: the rail, shut.
    screenSize.resize(size);
    await waitFor(() => expect(app()).toHaveClass('is-rail'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('lg and up is unchanged', () => {
  beforeEach(() => { liveScreen(DESKTOP); });

  it('keeps the full inline sidebar, and the toggle collapses it to the rail in place, never as an overlay', async () => {
    renderShell();
    expect(app()).not.toHaveClass('is-rail');
    expect(inFlowSidebar()).toHaveAttribute('data-mode', 'expanded');
    expect(within(topBar()).queryByRole('button', { name: 'Open navigation' })).toBeNull();

    const user = userEvent.setup();
    await user.click(within(inFlowSidebar()!).getByRole('button', { name: 'Collapse sidebar' }));
    expect(app()).toHaveClass('is-rail');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(railToggle());
    expect(app()).not.toHaveClass('is-rail');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('phones are unchanged', () => {
  it('a portrait phone still gets the drawer with the account block', async () => {
    liveScreen(PHONE);
    renderShell();
    expect(document.querySelector('aside[data-slot="sidebar"]')).toBeNull();
    const user = userEvent.setup();
    await user.click(within(topBar()).getByRole('button', { name: 'Open navigation' }));
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(within(drawer).getByRole('region', { name: 'Account' })).toBeInTheDocument();
  });

  it('a landscape phone (wide, but short) still gets the drawer, not the rail', async () => {
    liveScreen(LANDSCAPE_PHONE);
    renderShell();
    expect(document.querySelector('aside[data-slot="sidebar"]')).toBeNull();
    expect(app()).not.toHaveClass('is-rail');
    expect(within(topBar()).getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
  });
});
