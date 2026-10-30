/**
 * Roles & Permissions, PRD 9, slice S09.12 - the Schedule's "No crew" link is the Schedule, so it opens for the people
 * the Schedule opens for and for nobody else.
 *
 * Renders the REAL routed table (`moduleV2Routes`) with the REAL switch check (`RequirePageAccess`); only the app
 * chrome, the sign-in guard and the pages themselves are stubbed. The person's own switches are the one variable:
 * with Access Schedule on, the link reaches the Schedule with its filter in the address; with it off, the person is
 * sent to the dashboard like any other link to the Schedule, filter or not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen } from '@testing-library/react';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { moduleV2Routes } from '@/pages/v2/routes';
import { SCHEDULE_NO_CREW_PATH } from '@/lib/scheduleFilter';
import { renderWithProviders } from './helpers';
import { catalogToggle } from './support/backendSwitchCatalog';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));

vi.mock('@/pages/v2/schedule/SchedulePage', async () => {
  const { createElement } = await import('react');
  const { useLocation } = await import('react-router-dom');
  const Opened = () => {
    const location = useLocation();
    return createElement('p', { 'data-testid': 'schedule' }, `${location.pathname}${location.search}`);
  };
  return { default: Opened };
});
vi.mock('@/pages/v2/dashboard/DashboardPage', async () => {
  const { createElement } = await import('react');
  return { default: () => createElement('h1', { 'data-testid': 'dashboard' }, 'Dashboard') };
});

const mockApi = vi.mocked(api);

function signIn() {
  const state = {
    isAuthenticated: true,
    isLoading: false,
    user: { id: 'u1', role: 'ADMIN', organization_id: 'org1', org_features: ['jobs', 'leads'] },
  };
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state) as never);
}

function openLink(switches: Record<string, boolean>) {
  mockApi.get.mockImplementation((url: string) =>
    url === '/api/permission-switches/me'
      ? Promise.resolve({ data: { admin_box: false, values: switches, rules: [] } })
      : Promise.resolve({ data: {} }));
  return renderWithProviders(
    <Suspense fallback={null}>
      <Where />
      <Routes>
        {moduleV2Routes()}
        <Route path="*" element={<p>Nothing here</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [SCHEDULE_NO_CREW_PATH] },
  );
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  signIn();
});

const ACCESS_SCHEDULE = catalogToggle('Access Schedule').key;

describe('the "No crew" link to the Schedule', () => {
  it('opens the Schedule, filter and all, for a person with Access Schedule', async () => {
    openLink({ [ACCESS_SCHEDULE]: true });
    expect(await screen.findByTestId('schedule')).toHaveTextContent(SCHEDULE_NO_CREW_PATH);
  });

  it('sends a person without Access Schedule to the dashboard, as any link to the Schedule does', async () => {
    openLink({ [ACCESS_SCHEDULE]: false });
    expect(await screen.findByTestId('dashboard')).toBeTruthy();
    expect(screen.queryByTestId('schedule')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/');
  });
});
