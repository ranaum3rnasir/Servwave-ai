/**
 * Payments go-live P8 - the old Settings > ServWave Payments address still lands where it should. Email links and bell
 * notifications from before the move point at /settings/servwave-payments?tab=..., so that address becomes a redirect to
 * the Payments page and the page's own guard decides who may stay.
 *
 * Renders the REAL routed table (`moduleV2Routes`) with only the app chrome and the pages stubbed, like
 * hidden-routes-go-home.test.tsx, so the only thing deciding where a person ends up is the routes' own guards.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen } from '@testing-library/react';
import { Outlet, Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { moduleV2Routes } from '@/pages/v2/routes';
import { renderWithProviders } from './helpers';
import { catalogToggle } from './support/backendSwitchCatalog';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/components/DemoOnlyRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/payments/PaymentsPage', async () => {
  const { createElement } = await import('react');
  const { useLocation } = await import('react-router-dom');
  const Opened = () => {
    const { pathname, search } = useLocation();
    return createElement('p', { 'data-testid': 'opened' }, `${pathname}${search}`);
  };
  return { default: Opened };
});
vi.mock('@/pages/v2/dashboard/DashboardPage', async () => {
  const { createElement } = await import('react');
  return { default: () => createElement('h1', null, 'Dashboard') };
});

const mockApi = vi.mocked(api);
const key = (label: string) => catalogToggle(label).key;
const ALLOWED = () => ({ [key('View payments and payouts')]: true, [key('Show Payments page')]: true });

function open(path: string, values: Record<string, boolean>) {
  mockApi.get.mockImplementation((url: string) =>
    url === '/api/permission-switches/me'
      ? Promise.resolve({ data: { admin_box: false, values, rules: [] } })
      : Promise.resolve({ data: {} }));
  return renderWithProviders(
    <Suspense fallback={null}>
      <Routes>
        {moduleV2Routes()}
        <Route path="*" element={<p>Nothing here</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path] },
  );
}


beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('/settings/servwave-payments', () => {
  it.each([
    ['?tab=payments', '/payments?tab=payments'],
    ['?tab=payouts', '/payments?tab=payouts'],
    ['?tab=documents', '/payments?tab=documents'],
    ['?tab=disputes', '/payments?tab=payments&chip=disputed'],
    ['', '/payments'],
    ['?tab=nonsense', '/payments'],
  ])('%s lands on %s', async (search, target) => {
    open(`/settings/servwave-payments${search}`, ALLOWED());
    expect(await screen.findByTestId('opened')).toHaveTextContent(new RegExp(`^${target.replace(/[?]/g, '\\?')}$`));
  });

  it('a person without the Payments page switches ends on the dashboard, not on a blank page', async () => {
    open('/settings/servwave-payments?tab=payouts', {});
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByTestId('opened')).toBeNull();
  });

  it('View payments and payouts without Show Payments page also ends on the dashboard', async () => {
    open('/settings/servwave-payments', { [key('View payments and payouts')]: true, [key('Show Payments page')]: false });
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('does not render the Settings shell on the way', async () => {
    open('/settings/servwave-payments?tab=documents', ALLOWED());
    await screen.findByTestId('opened');
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
  });
});
