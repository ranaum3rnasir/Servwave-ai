/**
 * Roles & Permissions, PRD 2, S02.23 - the home address is every person's dashboard.
 *
 * Renders the REAL routed home route (`dashboardV2Routes`) with the real dashboard page, with only the app chrome
 * stubbed. The person is a custom role with every switch off and no rules at all: the page still opens, and nothing
 * sends them to another page ("first page you may open", "otherwise Leads" are gone).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen } from '@testing-library/react';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { dashboardV2Routes } from '@/pages/v2/routes/dashboard.routes';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockApi.get.mockImplementation((url: string) =>
    url === '/api/permission-switches/me'
      ? Promise.resolve({ data: { admin_box: false, values: {}, rules: [] } })
      : Promise.resolve({ data: {} }));
});

describe('the home address', () => {
  it('opens the dashboard for a role with every switch off and no rules, and stays there', async () => {
    renderWithProviders(
      <Suspense fallback={null}>
        <Where />
        <Routes>
          {dashboardV2Routes()}
          <Route path="*" element={<p>Somewhere else</p>} />
        </Routes>
      </Suspense>,
      { initialEntries: ['/'], ability: buildAbility([]) },
    );

    expect(await screen.findByRole('heading', { name: /Test/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Customize home page/ })).toBeInTheDocument();
    expect(screen.queryByText('Somewhere else')).toBeNull();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
  });
});
