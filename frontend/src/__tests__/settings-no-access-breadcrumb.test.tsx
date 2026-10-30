// A settings page the visitor has no switch for (the nav hides it) still names itself in the breadcrumb trail.
// It used to record the bare word "Settings" for every such page, so walking through four of them read
// "Settings > Settings > Settings > Settings" (payments go-live slice 33b, from the slice 35 acceptance).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { buildAbility } from '@/lib/ability';
import SettingsLayout from '@/pages/v2/settings/SettingsLayout';
import { useNavHistory } from '@/pages/v2/navHistory.store';
import PayoutAccountPage from '@/pages/v2/settings/PayoutAccountPage';
import { renderWithProviders } from './helpers';

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useStripeStatus: () => ({ data: undefined, isLoading: true, isError: false }) };
});

const NOBODY = buildAbility([]);

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  useNavHistory.getState().clear();
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u-1', email: 'a@test.com', first_name: 'T', last_name: 'U', role: 'SALES', organization_id: 'org-1', org_features: [] },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never);
});

function visitPage(path: string) {
  const view = renderWithProviders(
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route path="/settings/:page" element={<p>page</p>} />
      </Route>
    </Routes>,
    { ability: NOBODY, initialEntries: [path] },
  );
  view.unmount();
}

describe('settings breadcrumb on a page the visitor cannot see in the nav', () => {
  it('names each page instead of repeating "Settings"', () => {
    for (const p of ['payments', 'roles', 'job-sub-statuses', 'tax-rates']) visitPage(`/settings/${p}`);
    const labels = useNavHistory.getState().visits.map((v) => v.label);
    expect(labels).toEqual([
      'Settings · Payments & Lists',
      'Settings · Roles & Permissions',
      'Settings · Job Sub-Statuses',
      'Settings · Tax Rates',
    ]);
  });

  it('keeps the bare "Settings" for a page the list does not know', () => {
    visitPage('/settings/no-such-page');
    expect(useNavHistory.getState().visits.map((v) => v.label)).toEqual(['Settings']);
  });
});

// O3 (payments go-live 33b fix round): a page that sends a refused visitor back to Settings must not stay in the
// trail, and neither must the bare hop through /settings. The visitor ends with the trail they would have had
// opening Company Profile directly.
describe('settings breadcrumb after a no-access redirect', () => {
  const arriveIn = (path: string) => {
    renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="/settings/company" replace />} />
          <Route path="/settings/company" element={<p>company page</p>} />
          <Route path="/settings/payout-account" element={<PayoutAccountPage />} />
        </Route>
      </Routes>,
      { ability: NOBODY, initialEntries: [path] },
    );
    return useNavHistory.getState().visits.map((v) => v.label);
  };

  it.each(['/settings/payout-account'])(
    'names only where the visitor now is after being refused at %s',
    (path) => {
      expect(arriveIn(path)).toEqual(['Settings · Company Profile']);
    },
  );
});
