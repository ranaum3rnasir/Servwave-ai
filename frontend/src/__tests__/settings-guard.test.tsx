import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import Sidebar from '@/components/layout/Sidebar';
import { useSettingsGuard } from '@/stores/settingsGuard.store';

// #113 — the unsaved-changes guard must catch the left app Sidebar (not just the
// settings nav / Header menu). The Sidebar routes its navigations through the
// shared guard's requestLeave, so a dirty settings form intercepts the click and
// opens the "Discard unsaved changes?" dialog instead of silently leaving.

const allowAll = buildAbility([{ action: 'manage', subject: 'all' }]);

// Probe that reports the current pathname so tests can assert whether the Sidebar
// click actually navigated.
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="pathname">{loc.pathname}</div>;
}

function renderSidebar(initial = '/settings/company') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AbilityProvider ability={allowAll}>
        <MemoryRouter initialEntries={[initial]}>
          <Sidebar collapsed={false} />
          <Routes>
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </AbilityProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('#113 — Sidebar routes through the unsaved-changes guard', () => {
  it('intercepts a Sidebar nav click while a settings form is dirty (no navigation, leave pending)', async () => {
    const user = userEvent.setup();
    useSettingsGuard.setState({ isDirty: true });
    renderSidebar('/settings/company');

    expect(screen.getByTestId('pathname')).toHaveTextContent('/settings/company');

    // Click a flat Sidebar item (Leads → /leads).
    await user.click(screen.getByRole('link', { name: 'Leads' }));

    // Navigation was blocked: still on the settings route.
    expect(screen.getByTestId('pathname')).toHaveTextContent('/settings/company');
    // The guard stashed the intended navigation so the shell can confirm it.
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();
  });

  it('navigates normally when the settings form is clean (guard is a no-op)', async () => {
    const user = userEvent.setup();
    // isDirty stays false (default from beforeEach).
    renderSidebar('/settings/company');

    await user.click(screen.getByRole('link', { name: 'Leads' }));

    await waitFor(() =>
      expect(screen.getByTestId('pathname')).toHaveTextContent('/leads')
    );
    expect(useSettingsGuard.getState().pendingLeave).toBeNull();
  });

  it('completes the stashed navigation once the pending leave is resolved (Discard)', async () => {
    const user = userEvent.setup();
    useSettingsGuard.setState({ isDirty: true });
    renderSidebar('/settings/company');

    await user.click(screen.getByRole('link', { name: 'Leads' }));
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();

    // Simulate the shell's Discard button confirming the pending leave.
    act(() => {
      useSettingsGuard.getState().resolvePending();
    });

    await waitFor(() =>
      expect(screen.getByTestId('pathname')).toHaveTextContent('/leads')
    );
    expect(useSettingsGuard.getState().pendingLeave).toBeNull();
  });
});
