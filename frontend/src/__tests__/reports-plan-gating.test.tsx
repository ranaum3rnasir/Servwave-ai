// SRVW-160 - per-plan report gating: `inventory-usage` is invisible to PRO/Starter,
// fully working for SCALE, and the Operations tab's empty state stops blaming the
// user's ROLE for what is a PLAN block.
//
// The user is an ADMIN with `manage all` ON PURPOSE: CASL cannot express this gate
// (defineAbilityFor short-circuits every admin to a superuser), so an admin is
// exactly the case that used to slip through.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import ReportsPage from '@/pages/ReportsPage';
import ReportRoute from '@/pages/reports/ReportRoute';
import type { InventoryUsagePayload } from '@/lib/reports/inventory-usage-data';

const hoisted = vi.hoisted(() => ({
  useInventoryUsage: vi.fn(),
}));

vi.mock('@/lib/reports/inventory-usage-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports/inventory-usage-data')>();
  return { ...actual, useInventoryUsage: hoisted.useInventoryUsage };
});

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const PRO_FEATURES = ['customers', 'jobs', 'estimates', 'invoices', 'payments', 'scheduling', 'leads'];
const SCALE_FEATURES = [...PRO_FEATURES, 'inventory'];

const PAYLOAD: InventoryUsagePayload = {
  from: '2025-07-17T00:00:00.000Z',
  to: '2026-07-17T00:00:00.000Z',
  items: [],
};

/**
 * org_features is set EXPLICITLY on every fixture below, never omitted: useFeature/
 * useHasFeature fail OPEN while it is undefined ("unknown ≠ denied", so a cached
 * pre-entitlements payload cannot grey out a paid org). Omitting it would make an
 * unentitled fixture look entitled and quietly void these assertions.
 */
function mockOrgFeatures(features: string[] | undefined, plan: string) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: unknown) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        org_plan: plan,
        org_features: features,
        org_is_demo: false,
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.useInventoryUsage.mockReturnValue({ data: PAYLOAD, isLoading: false, isError: false });
});

describe('ReportsPage - a PRO org loses the Inventory Usage card AND gets a plan-neutral empty state', () => {
  it('hides the card and stops blaming the role', () => {
    mockOrgFeatures(PRO_FEATURES, 'PRO');
    renderWithProviders(<ReportsPage />, { ability: adminAbility });

    fireEvent.click(screen.getByRole('button', { name: 'Operations' }));

    expect(screen.queryByText('Inventory Usage')).toBeNull();
    expect(screen.getByText('No Operations reports available.')).toBeInTheDocument();
    expect(screen.queryByText(/for your role/i)).toBeNull();
  });
});

describe('ReportsPage - a SCALE org still sees the Inventory Usage card', () => {
  it('renders the card linking to /reports/inventory-usage, no empty state', () => {
    mockOrgFeatures(SCALE_FEATURES, 'SCALE');
    renderWithProviders(<ReportsPage />, { ability: adminAbility });

    fireEvent.click(screen.getByRole('button', { name: 'Operations' }));

    const link = screen.getByRole('link', { name: /Inventory Usage/i });
    expect(link).toHaveAttribute('href', '/reports/inventory-usage');
    expect(screen.queryByText('No Operations reports available.')).toBeNull();
  });
});

describe('ReportsPage - fails OPEN while org_features is undefined (cached auth payload)', () => {
  it('still shows the Inventory Usage card', () => {
    mockOrgFeatures(undefined, 'SCALE');
    renderWithProviders(<ReportsPage />, { ability: adminAbility });

    fireEvent.click(screen.getByRole('button', { name: 'Operations' }));

    expect(screen.getByRole('link', { name: /Inventory Usage/i })).toBeInTheDocument();
  });
});

describe('ReportsPage - the Main tab is untouched for a PRO org (mainCards over-hide lock)', () => {
  it('still shows the live main cards', () => {
    mockOrgFeatures(PRO_FEATURES, 'PRO');
    renderWithProviders(<ReportsPage />, { ability: adminAbility });

    for (const label of ['Jobs', 'Estimates', 'Invoices', 'Payments', 'Aging invoices', 'Activity', 'Timesheets']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe('ReportRoute - direct URL on a PRO org renders honest plan copy, not KPI zeros', () => {
  it('shows plan-blocked copy, not the report or "coming soon"', () => {
    mockOrgFeatures(PRO_FEATURES, 'PRO');
    renderWithProviders(
      <Routes>
        <Route path="/reports/:slug" element={<ReportRoute />} />
      </Routes>,
      { initialEntries: ['/reports/inventory-usage'] },
    );

    expect(screen.queryByText('Units consumed')).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(screen.getByText('Inventory is available on the Scale plan.')).toBeInTheDocument();
  });
});

describe('ReportRoute - direct URL on a SCALE org still renders the full report', () => {
  it('renders the built report, no plan copy', async () => {
    mockOrgFeatures(SCALE_FEATURES, 'SCALE');
    renderWithProviders(
      <Routes>
        <Route path="/reports/:slug" element={<ReportRoute />} />
      </Routes>,
      { initialEntries: ['/reports/inventory-usage'] },
    );

    expect(await screen.findByRole('heading', { name: 'Inventory Usage' })).toBeInTheDocument();
    expect(screen.queryByText(/available on the/i)).toBeNull();
  });
});
