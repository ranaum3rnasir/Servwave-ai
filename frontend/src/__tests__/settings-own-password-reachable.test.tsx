/**
 * Roles & Permissions security, ticket 36b (M17), finding F1: My Profile's password link lands on a page that renders for a person
 * who is not an Admin.
 *
 * Renders the REAL routed settings table (`settingsV2Routes`), the real Settings shell and the real My Profile page; only the app
 * chrome and the Login & Security page are stubbed (the page's own content is proved by settings-security-own-sign-in.test.tsx).
 * A non-Admin follows "Change your password in Login & Security" and reaches the page, so a person who changes their own
 * password is never sent to a blank address.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useUpdateMe } from '@/lib/api/users';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/settings/SecurityPage', () => ({ default: () => <p role="heading" aria-level={2}>Security page</p> }));
vi.mock('@/lib/api/users', () => ({ useUpdateMe: vi.fn() }));
vi.mock('@/components/timeclock/MyTimeLog', () => ({ default: () => null, MyTimeLog: () => null }));

const mockApi = vi.mocked(api);

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  vi.mocked(useUpdateMe).mockReturnValue({ mutateAsync: vi.fn() } as unknown as ReturnType<typeof useUpdateMe>);
  const state = {
    user: { id: 'u1', email: 'tech@test.com', first_name: 'Jane', last_name: 'Smith', role: 'TECHNICIAN', is_admin: false, organization_id: 'o1', phone: '', phone_ext: '', has_login: true },
    applyUserPatch: vi.fn(),
  };
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) => selector(state)) as never);
  mockApi.get.mockResolvedValue({ data: { admin_box: false, values: {}, rules: [] } });
});

describe('a person who is not an Admin changes their own password', () => {
  it('follows the link on My Profile to Login & Security and finds the page', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Suspense fallback={null}>
        <Where />
        <Routes>
          {settingsV2Routes()}
          <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
        </Routes>
      </Suspense>,
      { initialEntries: ['/settings/profile'], ability: buildAbility([{ action: 'read', subject: 'Organization' }]) },
    );

    await user.click(await screen.findByRole('link', { name: /Change your password in Login/ }));

    expect(await screen.findByRole('heading', { name: 'Security page' })).toBeInTheDocument();
    expect(screen.getByTestId('where').textContent).toBe('/settings/security');
  });
});
