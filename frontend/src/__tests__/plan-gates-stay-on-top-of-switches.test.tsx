/**
 * Roles & Permissions, PRD 7, S07.21 - a switch never opens a feature the company's plan lacks.
 *
 * Renders the REAL routed table (`moduleV2Routes`) with the REAL plan check (`RequireFeature`) and the REAL switch
 * check (`RequirePageAccess`); only the app chrome, the sign-in guard and the pages themselves are stubbed. The person
 * holds every switch that opens the page (looked up in the backend catalog by the label a person sees), so the plan
 * is the only variable: a company without the feature is sent to the upgrade page whatever the switches say, and a
 * company with it reaches the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen } from '@testing-library/react';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { moduleV2Routes } from '@/pages/v2/routes';
import { renderWithProviders } from './helpers';
import { catalogToggle } from './support/backendSwitchCatalog';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));

const stub = vi.hoisted(() => async () => {
  const { createElement } = await import('react');
  const { useLocation } = await import('react-router-dom');
  const Opened = () => createElement('p', { 'data-testid': 'opened' }, useLocation().pathname);
  return { default: Opened };
});
vi.mock('@/pages/v2/service-plans/ServicePlansPage', stub);
vi.mock('@/pages/v2/automations/AutomationsHomePage', stub);
vi.mock('@/pages/v2/automations/AutomationBuilderPage', stub);
vi.mock('@/pages/v2/inventory/InventoryPage', stub);
vi.mock('@/pages/v2/auth-public/UpgradePage', async () => {
  const { createElement } = await import('react');
  const { useLocation } = await import('react-router-dom');
  const Upgrade = () => createElement('p', { 'data-testid': 'upgrade' }, new URLSearchParams(useLocation().search).get('feature'));
  return { default: Upgrade };
});
vi.mock('@/pages/v2/dashboard/DashboardPage', async () => {
  const { createElement } = await import('react');
  return { default: () => createElement('h1', null, 'Dashboard') };
});

const mockApi = vi.mocked(api);

/** A module's pages, the plan feature that unlocks it, and the switches that open each page. */
const MODULES: Array<{ name: string; feature: string; pages: Array<{ path: string; opens: string[] }> }> = [
  {
    name: 'Service Plans',
    feature: 'service_plans',
    pages: [{ path: '/service-plans', opens: ['View service plans'] }],
  },
  {
    name: 'Automations',
    feature: 'automations',
    pages: [
      { path: '/automations', opens: ['View automations'] },
      { path: '/automations/new', opens: ['Create automations'] },
      { path: '/automations/abc', opens: ['View automations'] },
    ],
  },
  {
    name: 'Inventory',
    feature: 'inventory',
    pages: [{ path: '/inventory', opens: ['View stock'] }],
  },
];

const key = (label: string) => catalogToggle(label).key;
const ALL_FEATURES = ['customers', 'jobs', 'service_plans', 'automations', 'inventory'];

function signIn(features: string[]) {
  const state = {
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'u1', role: 'ADMIN', organization_id: 'org1', org_features: features },
  };
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state) as never);
}

function open(path: string, opens: string[]) {
  const values = Object.fromEntries(opens.map((label) => [key(label), true]));
  mockApi.get.mockImplementation((url: string) =>
    url === '/api/permission-switches/me'
      ? Promise.resolve({ data: { admin_box: false, values, rules: [] } })
      : Promise.resolve({ data: {} }));
  return renderWithProviders(
    <Suspense fallback={null}>
      <Where />
      <Routes>
        {moduleV2Routes()}
        <Route path="*" element={<p>Nothing here</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path] },
  );
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe.each(MODULES)('$name', ({ feature, pages }) => {
  describe.each(pages)('$path', ({ path, opens }) => {
    it('opens for a company on a plan with the feature, with the switches on', async () => {
      signIn(ALL_FEATURES);
      open(path, opens);

      expect(await screen.findByTestId('opened')).toHaveTextContent(path);
    });

    it('sends a company without the feature to the upgrade page, with every switch on', async () => {
      signIn(ALL_FEATURES.filter((f) => f !== feature));
      open(path, opens);

      expect(await screen.findByTestId('upgrade')).toHaveTextContent(feature);
      expect(screen.queryByTestId('opened')).toBeNull();
      expect(screen.getByTestId('where')).toHaveTextContent('/upgrade');
    });
  });
});
