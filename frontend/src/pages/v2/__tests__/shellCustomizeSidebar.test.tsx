/// <reference types="@testing-library/jest-dom/vitest" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { CURRENT_LAYOUT_VERSION } from '@/components/layout/nav-registry';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';

import V2AppLayout from '../V2AppLayout';

/**
 * The v2 sidebar does not edit itself.
 *
 * It used to mirror the legacy sidebar's Customize mode - drag to reorder, an X
 * to unpin, an "Add shortcut" picker, and a flattening of expandable groups so
 * the reorder list stayed flat. All of that is gone from this shell; the mode
 * still lives in `components/layout/Sidebar.tsx`, which is where the per-user
 * localStorage layout gets written.
 *
 * What must NOT go with it is the read: both shells share that one stored
 * layout, so an order the user set in the legacy sidebar has to survive here.
 * That is the last test below, and it is the reason this file still exists.
 */

vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/communication/phone/Dialer', () => ({ GlobalDialer: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/GlobalSearch', () => ({ default: () => null }));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
vi.mock('@/lib/api/communication', () => ({
  useUnreadCounts: () => ({ sms: 0, whatsapp: 0, email: 0 }),
}));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: undefined }) }));

const USER_ID = '00000000-0000-0000-0000-000000000001';
const LAYOUT_KEY = `servwave:nav-layout:${USER_ID}`;
const VERSION_KEY = `servwave:nav-layout-version:${USER_ID}`;

// Matches the Sidebar spec's fixture: a real (non-demo) org ADMIN whose
// entitlements have loaded and are empty, so `entitlementsReady` is true and a
// gated module reads as deliberately unentitled rather than pending.
const REAL_ORG_ADMIN = {
  id: USER_ID,
  email: 'admin@test.com',
  first_name: 'Test',
  last_name: 'Admin',
  role: 'ADMIN',
  org_features: [] as string[],
};

function mockAuthUser(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({ user, isAuthenticated: true, isLoading: false, error: null } as never),
  );
}

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <AbilityProvider ability={buildAbility([{ action: 'manage', subject: 'all' }])}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="/" element={<div>page</div>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const storedLayout = (): string[] => JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null');

/**
 * Every DESTINATION row's label, in the order the column renders them. Scoped
 * to the nav, so the footer's AI launcher - which is not a pinnable key - stays
 * out of it.
 */
function renderedRows(): string[] {
  const nav = document.querySelector('[data-slot="sidebar-nav"]');
  return Array.from(nav?.querySelectorAll('[data-slot="sidebar-item"]') ?? []).map(
    (row) => row.getAttribute('title') ?? '',
  );
}

describe('v2 shell - the sidebar is not editable here', () => {
  beforeEach(() => {
    localStorage.clear();
    mockAuthUser(REAL_ORG_ADMIN);
  });

  it('offers no Customize toggle, and no toolbar block to hold one', () => {
    renderShell();
    expect(screen.queryByRole('button', { name: /Customize/ })).toBeNull();
    // The toolbar existed only for that one control, so it is not rendered at
    // all. The kit primitive itself stays - it is kit API, not this shell's.
    expect(document.querySelector('[data-slot="sidebar-toolbar"]')).toBeNull();
  });

  it('renders no edit affordances at all - no grip, no unpin, no Add shortcut', () => {
    renderShell();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();

    expect(document.querySelector('[data-slot="sidebar-edit-row"]')).toBeNull();
    expect(document.querySelector('[data-slot="sidebar-drag-handle"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Dashboard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reorder Dashboard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add shortcut' })).toBeNull();
    // The picker was the toggle's only other surface; with no toggle there is
    // no dialog to open.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('writes nothing to the shared per-user layout', () => {
    renderShell();
    // Rendering is a read. A shell that cannot edit the layout must not touch
    // it either, or it would overwrite what the legacy sidebar stored.
    expect(storedLayout()).toBeNull();
  });

  it('keeps the group the old edit mode used to flatten away', () => {
    // Flattening a group into its children was an editing-only concession -
    // the reorder list had to stay flat. With no editing, Inventory is an
    // expandable group again, exactly as it is in the legacy sidebar.
    // Opening it and what it then shows belong to sidebarNavGroups.test.tsx.
    mockAuthUser({ ...REAL_ORG_ADMIN, org_features: ['inventory'] });
    renderShell();

    expect(screen.getByRole('button', { name: 'Inventory' }))
      .toHaveAttribute('aria-expanded', 'false');
  });

  it('still renders a layout the user already saved, in its saved order', () => {
    // The whole reason the read path survives: this order can only have been
    // set in the legacy sidebar, and this shell has to honour it. Stamped at
    // the current version so `loadLayout`'s one-time migration does not append
    // the destinations shipped since - that is nav-layout's behaviour, not this
    // column's, and it would bury the order under rows the fixture never set.
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(['jobs', 'dashboard', 'schedule', 'invoices']));
    localStorage.setItem(VERSION_KEY, String(CURRENT_LAYOUT_VERSION));
    renderShell();

    const rows = renderedRows();
    expect(rows).toEqual(['Jobs', 'Dashboard', 'Schedule', 'Invoices']);
    // An unpinned destination stays unpinned - reading the layout means reading
    // all of it, not just the order.
    expect(rows).not.toContain('Leads');
  });
});
