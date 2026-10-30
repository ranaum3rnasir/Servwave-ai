/**
 * Roles & Permissions security, AL-18 (ticket 28) - Users & Teams and Roles & Permissions are Admin-only.
 *
 * The one Settings page test the spec allows: a non-Admin who opens Settings sees neither tab, whatever switches they hold,
 * and typing either address (or a person's Permissions page) renders nothing. An Admin sees and opens both.
 *
 * Renders the REAL routed settings table (`settingsV2Routes`) and the real Settings shell, with only the app chrome (the
 * sign-in guard and the app layout) and the two big pages stubbed. Admin is the flag on the signed-in person (the auth store),
 * never a switch or a role name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen, within } from '@testing-library/react';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility, type AppAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';
import { renderWithProviders } from './helpers';
import { FIXTURE_CATALOG, FIXTURE_SWITCHES } from './support/permissionCatalogFixture';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/settings/UsersTeamsPage', () => ({ default: () => <p role="heading" aria-level={2}>Users and teams page</p> }));
vi.mock('@/pages/v2/settings/RolesPage', () => ({ default: () => <p role="heading" aria-level={2}>Roles page</p> }));
vi.mock('@/pages/v2/settings/PersonPermissionsPage', () => ({ default: () => <p role="heading" aria-level={2}>Person permissions page</p> }));
vi.mock('@/pages/v2/settings/MyProfilePage', () => ({ default: () => <p role="heading" aria-level={2}>My profile page</p> }));
vi.mock('@/pages/v2/settings/CompanyProfilePage', () => ({ default: () => <p role="heading" aria-level={2}>Company page</p> }));

const mockApi = vi.mocked(api);

/** Every switch on, and every rule a user or role screen ever read: the most a non-Admin could hold. */
const everySwitch: Record<string, boolean> = Object.fromEntries(FIXTURE_SWITCHES.map((s) => [s.key, true]));
const everyRule: AppAbility = buildAbility([
  { action: 'read', subject: 'Organization' },
  { action: 'read', subject: 'User' },
  { action: 'create', subject: 'User' },
  { action: 'invite', subject: 'User' },
  { action: 'update', subject: 'User' },
  { action: 'delete', subject: 'User' },
  { action: 'manage_roles', subject: 'Role' },
  { action: 'read', subject: 'Role' },
  { action: 'update', subject: 'Role' },
]);

function signedIn(isAdmin: boolean) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: '00000000-0000-0000-0000-000000000001', email: 'person@test.com', first_name: 'Test', last_name: 'Person', role: 'DISPATCHER', is_admin: isAdmin },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })) as never);
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: isAdmin, values: everySwitch, rules: [] } });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    return Promise.resolve({ data: [] });
  });
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function open(path: string) {
  return renderWithProviders(
    <Suspense fallback={null}>
      <Where />
      <Routes>
        {settingsV2Routes()}
        <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path], ability: everyRule },
  );
}

const where = () => screen.getByTestId('where').textContent;
const calledUrls = () => mockApi.get.mock.calls.map((c) => c[0] as string);
const PAGES = ['Users and teams page', 'Roles page', 'Person permissions page', 'Dashboard'];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('Users & Teams and Roles & Permissions are Admin-only', () => {
  it('shows a non-Admin neither tab, and renders nothing at either address or a person\'s Permissions page, whatever their switches', async () => {
    signedIn(false);
    const first = open('/settings/profile');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    // The tabs this person may see are drawn (My Profile), so the two missing ones are missing, not still loading.
    expect(await within(nav).findByRole('link', { name: 'My Profile' })).toBeInTheDocument();
    await vi.waitFor(() => expect(calledUrls()).toContain('/api/permission-switches/me'));
    expect(within(nav).queryByRole('link', { name: 'Users & Teams' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Roles & Permissions' })).toBeNull();
    first.unmount();

    for (const path of ['/settings/users', '/settings/roles', '/settings/users/u1/permissions']) {
      const view = open(path);
      // The shell is there; the page is not (given the time a lazy page takes to arrive), and nothing redirected the address.
      await screen.findByRole('navigation', { name: 'Settings' });
      const anyPage = new RegExp(`^(${PAGES.join('|')})$`);
      await expect(screen.findByRole('heading', { name: anyPage }, { timeout: 600 }), path).rejects.toThrow();
      expect(where()).toBe(path);
      view.unmount();
    }
  });

  it('shows an Admin both tabs and opens both pages', async () => {
    signedIn(true);
    const first = open('/settings/company');
    await screen.findByRole('heading', { name: 'Company page' });
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'Users & Teams' })).toHaveAttribute('href', '/settings/users');
    expect(within(nav).getByRole('link', { name: 'Roles & Permissions' })).toHaveAttribute('href', '/settings/roles');
    first.unmount();

    const users = open('/settings/users');
    expect(await screen.findByRole('heading', { name: 'Users and teams page' })).toBeInTheDocument();
    users.unmount();
    const roles = open('/settings/roles');
    expect(await screen.findByRole('heading', { name: 'Roles page' })).toBeInTheDocument();
    roles.unmount();
    open('/settings/users/u1/permissions');
    expect(await screen.findByRole('heading', { name: 'Person permissions page' })).toBeInTheDocument();
  });
});
