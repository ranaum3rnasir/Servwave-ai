/**
 * Payments go-live P8 - the old Settings > ServWave Payments address still lands where it should. Email links and bell
 * notifications from before the move point at /settings/servwave-payments?tab=..., so that address becomes a redirect to
 * the Payments page and the page's own guard decides who may stay.
 *
 * Since V7-01 the bare address (and an unknown ?tab=) is the ServWave Payments settings page itself; only the four old
 * tab values redirect. That redirect now runs inside the Settings shell route, so the settings BODY must never be drawn
 * on the way (asserted below).
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
import { buildAbility } from '@/lib/ability';

const bodyRenders = vi.hoisted(() => ({ count: 0 }));

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
vi.mock('@/pages/v2/settings/ServwavePaymentsPage', async () => {
  const { createElement } = await import('react');
  // Counts every render of the body, so a test can prove it never mounted during a redirect.
  return {
    default: () => {
      bodyRenders.count += 1;
      return createElement('p', { 'data-testid': 'settings-body' }, 'ServWave Payments settings body');
    },
  };
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
    { initialEntries: [path], ability: buildAbility([{ action: 'manage', subject: 'all' }]) },
  );
}


beforeEach(() => {
  vi.clearAllMocks();
  bodyRenders.count = 0;
  localStorage.clear();
});

describe('/settings/servwave-payments', () => {
  it.each([
    ['?tab=payments', '/payments?tab=payments'],
    ['?tab=payouts', '/payments?tab=payouts'],
    ['?tab=documents', '/payments?tab=documents'],
    ['?tab=disputes', '/payments?tab=payments&chip=disputed'],
  ])('%s lands on %s', async (search, target) => {
    open(`/settings/servwave-payments${search}`, ALLOWED());
    expect(await screen.findByTestId('opened')).toHaveTextContent(new RegExp(`^${target.replace(/[?]/g, '\\?')}$`));
  });

  it.each(['', '?tab=nonsense'])('%s renders the settings page, not the Payments page', async (search) => {
    open(`/settings/servwave-payments${search}`, ALLOWED());
    expect(await screen.findByTestId('settings-body')).toBeInTheDocument();
    expect(screen.queryByTestId('opened')).toBeNull();
  });

  it('a person without the Payments page switches ends on the dashboard, not on a blank page', async () => {
    open('/settings/servwave-payments?tab=payouts', {});
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByTestId('opened')).toBeNull();
  });

  it('View payments and payouts without Show Payments page also ends on the dashboard', async () => {
    open('/settings/servwave-payments?tab=payouts', { [key('View payments and payouts')]: true, [key('Show Payments page')]: false });
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('never mounts the settings body during the ?tab= hop, and the shell is gone once it lands', async () => {
    open('/settings/servwave-payments?tab=documents', ALLOWED());
    await screen.findByTestId('opened');
    expect(bodyRenders.count).toBe(0);
    expect(screen.queryByTestId('settings-body')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
  });
});
