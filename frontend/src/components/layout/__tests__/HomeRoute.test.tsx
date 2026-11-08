/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import HomeRoute from '../HomeRoute';

// Render the `/` landing through HomeRoute, with stub destination routes for the
// pages SALES is allowed to land on. The stubs let us assert *which* route the
// ability-aware redirect chose.
function renderHomeAt(ability: ReturnType<typeof buildAbility>) {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<HomeRoute />} />
      <Route path="/leads" element={<div>Leads Screen</div>} />
      <Route path="/schedule" element={<div>Schedule Screen</div>} />
      <Route path="/customers" element={<div>Clients Screen</div>} />
    </Routes>,
    { initialEntries: ['/'], ability }
  );
}

describe('HomeRoute', () => {
  it('renders the dashboard when the ability can read Dashboard (Admin/Dispatcher)', () => {
    const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
    renderHomeAt(ability);
    // DashboardPage renders its own content; the stub destinations must NOT show.
    expect(screen.queryByText('Leads Screen')).toBeNull();
    expect(screen.queryByText('Schedule Screen')).toBeNull();
    expect(screen.queryByText('Clients Screen')).toBeNull();
  });

  it('redirects SALES (no read Dashboard) to the first allowed nav item — Leads', () => {
    // SALES-shaped: no read Dashboard, no assign Job (Schedule), no read Task.
    // First allowed item in the sidebar's display order is Leads.
    const salesAbility = buildAbility([
      { action: 'read', subject: 'Lead' },
      { action: 'read', subject: 'Estimate' },
      { action: 'read', subject: 'Invoice' },
    ]);
    renderHomeAt(salesAbility);
    expect(screen.getByText('Leads Screen')).toBeInTheDocument();
  });

  it('redirects to the first allowed nav item respecting display order (Schedule before Leads)', () => {
    // Grants Schedule (read Job — Task 10 widened the nav gate from assign to read, so a
    // technician's own-scoped OWN_JOB read is enough to see their calendar) AND Leads;
    // Schedule comes first in DEFAULT_LAYOUT_KEYS, so the redirect must pick Schedule.
    const ability = buildAbility([
      { action: 'read', subject: 'Job' },
      { action: 'read', subject: 'Lead' },
    ]);
    renderHomeAt(ability);
    expect(screen.getByText('Schedule Screen')).toBeInTheDocument();
  });

  it('falls back to /leads when no nav item is allowed', () => {
    // Empty ability → nothing in the nav passes the filter → safe fallback.
    const ability = buildAbility([]);
    renderHomeAt(ability);
    expect(screen.getByText('Leads Screen')).toBeInTheDocument();
  });
});
