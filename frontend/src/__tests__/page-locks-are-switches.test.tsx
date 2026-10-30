/**
 * Roles & Permissions, PRD 2, S02.29 - the pages that used to be locked to role names open on switches.
 *
 * Renders the REAL routed table (`moduleV2Routes`) with the REAL sign-in and role guards: only the app chrome, the
 * plan check and the pages themselves are stubbed. The people here hold a custom role, so the built-in role they sit
 * on (their base role) is the variable: a switch must open the page on any of them, and no base role may open it
 * without the switch. Switch keys are looked up in the backend catalog by the label a person sees, so a renamed
 * switch fails here instead of silently testing nothing.
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

vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/components/RequireFeature', () => ({ default: () => <Outlet /> }));

const stub = vi.hoisted(() => async () => {
  const { createElement } = await import('react');
  const { useLocation } = await import('react-router-dom');
  const Opened = () => createElement('p', { 'data-testid': 'opened' }, useLocation().pathname);
  return { default: Opened };
});
vi.mock('@/pages/v2/invoices/StandaloneInvoiceFormPage', stub);
vi.mock('@/pages/v2/customers/CustomerFormPage', stub);
vi.mock('@/pages/v2/invoices/InvoiceDetailPage', stub);
vi.mock('@/pages/v2/invoices/InvoicesPage', stub);
vi.mock('@/pages/v2/payments/PaymentsPage', stub);
vi.mock('@/pages/v2/automations/AutomationsHomePage', stub);
vi.mock('@/pages/v2/automations/AutomationBuilderPage', stub);
vi.mock('@/pages/v2/reports/ReportsPage', stub);
vi.mock('@/pages/v2/reports/ReportRoute', stub);
vi.mock('@/pages/v2/reports/MarketingAnalyticsPage', stub);
vi.mock('@/pages/v2/dashboard/DashboardPage', async () => {
  const { createElement } = await import('react');
  return { default: () => createElement('h1', null, 'Dashboard') };
});

const mockApi = vi.mocked(api);

type BaseRole = 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';
const BASE_ROLES: BaseRole[] = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'];

/** A page and the switches that open it, by the label a person sees. */
const PAGES: Array<{ name: string; path: string; opens: string[] }> = [
  { name: 'Reports', path: '/reports', opens: ['Access Reports'] },
  { name: 'a report page', path: '/reports/revenue', opens: ['Access Reports'] },
  { name: 'Billing', path: '/reports/unpaid-invoices', opens: ['Access Billing'] },
  // The standalone New Customer form (S02.26); a customer's edit form is the same page and keeps its own rule.
  { name: 'New customer', path: '/customers/new', opens: ['Create customers', 'Show Customers page'] },
  { name: 'New invoice', path: '/invoices/new', opens: ['Standalone invoices', 'Show Invoices page'] },
  { name: 'Payments', path: '/payments', opens: ['View payments and payouts', 'Show Payments page'] },
  { name: 'Automations', path: '/automations', opens: ['View automations', 'Show Automations page'] },
  { name: 'an automation', path: '/automations/abc', opens: ['View automations'] },
  { name: 'New automation', path: '/automations/new', opens: ['Create automations'] },
  { name: 'Marketing', path: '/marketing', opens: ['Access Marketing'] },
];

const key = (label: string) => catalogToggle(label).key;

function signIn(role: BaseRole, orgIsDemo = true) {
  const state = {
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'u1', role, organization_id: 'org1', org_is_demo: orgIsDemo },
  };
  // The role guard reads the whole store; the switch reader and the demo check read one field through a selector.
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state) as never);
}

function serve(values: Record<string, boolean>) {
  mockApi.get.mockImplementation((url: string) =>
    url === '/api/permission-switches/me'
      ? Promise.resolve({ data: { admin_box: false, values, rules: [] } })
      : Promise.resolve({ data: {} }));
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function open(path: string, values: Record<string, boolean>) {
  serve(values);
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

const dashboard = () => screen.findByRole('heading', { name: 'Dashboard' });
const where = () => screen.getByTestId('where').textContent;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe.each(PAGES)('$name ($path)', ({ path, opens }) => {
  const allOn = () => Object.fromEntries(opens.map((label) => [key(label), true]));

  describe.each(BASE_ROLES)('a custom role on %s', (role) => {
    it('opens with its switch on', async () => {
      signIn(role);
      open(path, allOn());

      expect(await screen.findByTestId('opened')).toHaveTextContent(path);
      expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
    });

    it.each(opens)('goes to the dashboard with %s off', async (off) => {
      signIn(role);
      open(path, { ...allOn(), [key(off)]: false });

      expect(await dashboard()).toBeInTheDocument();
      expect(where()).toBe('/');
    });
  });
});

describe('Marketing keeps its rollout limit on top of the switch', () => {
  it('sends a company outside the rollout to the dashboard even with Access Marketing on', async () => {
    signIn('ADMIN', false);
    open('/marketing', { [key('Access Marketing')]: true });

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });
});
