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
import { renderWithProviders } from './helpers';

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
    for (const p of ['servwave-payments', 'lists', 'roles', 'job-sub-statuses', 'tax-rates']) visitPage(`/settings/${p}`);
    const labels = useNavHistory.getState().visits.map((v) => v.label);
    expect(labels).toEqual([
      'Settings · ServWave Payments',
      'Settings · Lists',
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

// O3 (payments go-live 33b fix round): the bare hop through /settings is not a step in the trail, so a visitor sent
// there ends with the trail they would have had opening Company Profile directly. (The Payout account page used to be
// the page that bounced a refused visitor; V7-01 retired it as a nav row and its address is now a redirect, so the
// refused-page case went with it. The bare hop is still covered here.)
describe('settings breadcrumb after the bare /settings hop', () => {
  it('names only where the visitor now is', () => {
    renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="/settings/company" replace />} />
          <Route path="/settings/company" element={<p>company page</p>} />
        </Route>
      </Routes>,
      { ability: NOBODY, initialEntries: ['/settings'] },
    );
    expect(useNavHistory.getState().visits.map((v) => v.label)).toEqual(['Settings · Company Profile']);
  });
});
