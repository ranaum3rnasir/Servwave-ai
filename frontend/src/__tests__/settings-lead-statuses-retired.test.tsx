/**
 * Lead statuses are fixed (walkthrough lead-statuses PRD, D12), so the Settings > Lead Statuses
 * page is gone. An old bookmark to `/settings/lead-statuses` must land on the settings home, not
 * fall through to the app's catch-all and bounce to the dashboard.
 *
 * Renders the REAL routed settings table (`settingsV2Routes`), with only the chrome (guards,
 * layouts) and the settings home page stubbed, so the redirect under test is the shipped one.
 */
import { describe, it, expect, vi } from 'vitest';
import { Suspense } from 'react';
import { screen } from '@testing-library/react';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import { renderWithProviders } from './helpers';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/settings/SettingsLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/settings/CompanyProfilePage', () => ({ default: () => <h1>Company home</h1> }));

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderAt(path: string) {
  return renderWithProviders(
    <Suspense fallback={null}>
      <Where />
      <Routes>
        {settingsV2Routes()}
        <Route path="*" element={<h1>Dashboard</h1>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path] },
  );
}

describe('the retired Lead Statuses settings page', () => {
  it('sends the old /settings/lead-statuses URL to the settings home', async () => {
    renderAt('/settings/lead-statuses');

    expect(await screen.findByRole('heading', { name: 'Company home' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/company');
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
  });
});
