/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import DemoOnlyRoute from '../DemoOnlyRoute';
import { getDestination } from '../layout/nav-registry';

/** Point the mocked auth store at a specific signed-in user (or none). */
function mockAuthUser(user: Record<string, unknown> | null) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: any) => unknown) =>
    selector({ user, isAuthenticated: true, isLoading: false, error: null })
  );
}

function renderAt(path: string, navKey?: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<DemoOnlyRoute navKey={navKey} />}>
          <Route path="/marketing" element={<div>MARKETING PAGE</div>} />
        </Route>
        <Route path="/" element={<div>DASHBOARD</div>} />
      </Routes>
    </MemoryRouter>
  );
}

/**
 * The allowlisted org - admitted onto the mock Marketing screen. Written
 * out rather than read back off the registry so the test pins the actual id;
 * deriving it would pass against an empty allowlist.
 */
const NORTHWIND_ORG_ID = '11111111-2222-4333-8444-555555555555';

describe('DemoOnlyRoute', () => {
  it('renders the demo-only page for a demo org', () => {
    mockAuthUser({ id: 'u1', role: 'ADMIN', org_is_demo: true });
    renderAt('/marketing');
    expect(screen.getByText('MARKETING PAGE')).toBeInTheDocument();
  });

  it('redirects a real org away from the demo-only page', () => {
    mockAuthUser({ id: 'u1', role: 'ADMIN' }); // org_is_demo absent → false
    renderAt('/marketing');
    expect(screen.queryByText('MARKETING PAGE')).toBeNull();
    expect(screen.getByText('DASHBOARD')).toBeInTheDocument();
  });

  it('fails closed and redirects when there is no user/org flag', () => {
    mockAuthUser(null);
    renderAt('/marketing');
    expect(screen.queryByText('MARKETING PAGE')).toBeNull();
    expect(screen.getByText('DASHBOARD')).toBeInTheDocument();
  });

  it('admits a real org that the destination allowlists', () => {
    mockAuthUser({ id: 'u1', role: 'ADMIN', organization_id: NORTHWIND_ORG_ID });
    renderAt('/marketing', 'marketing');
    expect(screen.getByText('MARKETING PAGE')).toBeInTheDocument();
  });

  it('still redirects a real org that is NOT on the allowlist', () => {
    mockAuthUser({ id: 'u1', role: 'ADMIN', organization_id: 'some-other-org' });
    renderAt('/marketing', 'marketing');
    expect(screen.queryByText('MARKETING PAGE')).toBeNull();
    expect(screen.getByText('DASHBOARD')).toBeInTheDocument();
  });

  it('ignores the allowlist when no navKey is supplied', () => {
    mockAuthUser({ id: 'u1', role: 'ADMIN', organization_id: NORTHWIND_ORG_ID });
    renderAt('/marketing'); // no navKey → no destination → no allowlist
    expect(screen.queryByText('MARKETING PAGE')).toBeNull();
    expect(screen.getByText('DASHBOARD')).toBeInTheDocument();
  });

  it('keeps Marketing allowlisted for the pilot org in the nav registry', () => {
    // Guards the sidebar lock and this route guard together: both read the same
    // registry entry, so an id dropped here silently re-locks the screen.
    expect(getDestination('marketing')?.demoOnly).toBe(true);
    expect(getDestination('marketing')?.demoOnlyUnlockOrgIds).toContain(NORTHWIND_ORG_ID);
  });
});
