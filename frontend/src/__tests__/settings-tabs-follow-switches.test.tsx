/**
 * Roles & Permissions, PRD 2, S02.5 - the Settings tabs follow switches, and the Users stub page is gone.
 *
 * Renders the REAL routed settings table (`settingsV2Routes`) and the real Settings shell, with only the app chrome
 * (the sign-in guard and the app layout) and the Users & Teams page stubbed. The Roles page is the real routed file,
 * served the real answer shapes of the Roles API. Every person here is a custom role built from the switches under
 * test (the compiled rules their switches give, and the "me" answer), never a built-in role name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen, within } from '@testing-library/react';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility, type AppAbility } from '@/lib/ability';
import type { BuiltInRoleKey, RoleSwitchSet } from '@/lib/api/permissionSwitches';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';
import { renderWithProviders } from './helpers';
import { FIXTURE_CATALOG, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/settings/UsersTeamsPage', () => ({ default: () => <p role="heading" aria-level={2}>Users and teams page</p> }));
vi.mock('@/pages/v2/settings/CompanyProfilePage', () => ({ default: () => <p role="heading" aria-level={2}>Company page</p> }));

const mockApi = vi.mocked(api);

const ROLES = [
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 3, type: 'system' },
  { id: 'r1', role: 'night_shift', label: 'Night shift', fullAccess: false, editable: true, userCount: 4, type: 'custom', base_role: 'TECHNICIAN' },
];

function roleSet(role: string): RoleSwitchSet {
  const entry = ROLES.find((r) => r.role === role)!;
  return {
    role, label: entry.label, type: entry.type as 'system' | 'custom', editable: true, base_role: entry.type === 'custom' ? 'TECHNICIAN' : role,
    made_from_role_key: null, made_from_blank: false, values: presetSet((entry.type === 'custom' ? 'TECHNICIAN' : role) as BuiltInRoleKey), all_views_off: false,
  };
}

/** The person: the rules their switches compile into, and their resolved switch values (the "me" answer). */
interface Person {
  ability: AppAbility;
  switches: Record<string, boolean>;
}

/** Manage roles and permissions on, and nothing that reads as "update User" or "read Organization". */
const rolesManager: Person = {
  ability: buildAbility([
    { action: 'manage_roles', subject: 'Role' },
    { action: 'read', subject: 'Role' },
    { action: 'update', subject: 'Role' },
  ]),
  switches: { manage_roles_and_permissions: true, show_users_teams_page: false },
};

/** Edit users and View users on, the old "update User" test would show the tab; Manage roles and Show Users off. */
const userEditor: Person = {
  ability: buildAbility([
    { action: 'read', subject: 'User' },
    { action: 'update', subject: 'User' },
    { action: 'read', subject: 'Role' },
  ]),
  switches: { manage_roles_and_permissions: false, show_users_teams_page: false },
};

/** Show Users & Teams page on and nothing else of the Users group beyond View. */
const usersViewer: Person = {
  ability: buildAbility([{ action: 'read', subject: 'User' }]),
  switches: { manage_roles_and_permissions: false, show_users_teams_page: true },
};

const nobody: Person = { ability: buildAbility([]), switches: {} };

function serve(person: Person) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: false, values: person.switches, rules: [] } });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    const m = url.match(/^\/api\/roles\/([^/]+)\/permissions$/);
    if (m) return Promise.resolve({ data: roleSet(m[1]!) });
    return Promise.resolve({ data: [] });
  });
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function open(path: string, person: Person) {
  serve(person);
  return renderWithProviders(
    <Suspense fallback={null}>
      <Where />
      <Routes>
        {settingsV2Routes()}
        <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path], ability: person.ability },
  );
}

const dashboard = () => screen.findByRole('heading', { name: 'Dashboard' });
const where = () => screen.getByTestId('where').textContent;
const calledUrls = () => mockApi.get.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  vi.clearAllMocks();
  // The single reader of the person's own switches keeps their last answer in storage; each case is a different person.
  localStorage.clear();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('Settings > Roles & Permissions follows Manage roles and permissions', () => {
  it('draws no Roles & Permissions tab for a custom role without it, and sends an address-typed visit to the dashboard', async () => {
    const first = open('/settings/roles', userEditor);

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
    expect(calledUrls().some((u) => u.startsWith('/api/roles'))).toBe(false);
    first.unmount();

    // The tab is also missing from the shell of a page the person can open.
    open('/settings/company', { ...nobody, ability: buildAbility([{ action: 'read', subject: 'Organization' }]) });
    await screen.findByRole('heading', { name: 'Company page' });
    expect(screen.queryByRole('link', { name: 'Roles & Permissions' })).toBeNull();
  });

  it('draws the tab for a custom role holding it, and opens the Roles page fully loaded, no read failing', async () => {
    const first = open('/settings/company', rolesManager);
    await screen.findByRole('heading', { name: 'Company page' });
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(await within(nav).findByRole('link', { name: 'Roles & Permissions' })).toHaveAttribute('href', '/settings/roles');
    first.unmount();

    // Open it by address as that person.
    open('/settings/roles', rolesManager);
    expect(await screen.findByRole('button', { name: /^Sales/ })).toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: catalogSwitch('view_customers').label })).toBeInTheDocument();
    expect(screen.queryByText(/can.t be shown right now/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();
    expect(where()).toBe('/settings/roles');
  });
});

describe('Settings > Users & Teams follows Show Users & Teams page', () => {
  it('shows the tab and opens the page for a person with the switch on, even without Edit users', async () => {
    open('/settings/users', usersViewer);

    expect(await screen.findByRole('heading', { name: 'Users and teams page' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(await within(nav).findByRole('link', { name: 'Users & Teams' })).toHaveAttribute('href', '/settings/users');
    expect(where()).toBe('/settings/users');
  });

  it('draws no tab and sends the visit to the dashboard without the switch, even for a person who can edit users', async () => {
    const first = open('/settings/users', userEditor);

    expect(await dashboard()).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Users and teams page' })).toBeNull();
    expect(where()).toBe('/');
    first.unmount();

    open('/settings/company', userEditor);
    await screen.findByRole('heading', { name: 'Company page' });
    // The switch answer is read; wait for it, then the tab must still be missing.
    await vi.waitFor(() => expect(calledUrls()).toContain('/api/permission-switches/me'));
    expect(screen.queryByRole('link', { name: 'Users & Teams' })).toBeNull();
  });

  it('treats a failed switch read as the switch being off', async () => {
    mockApi.get.mockImplementation((url: string) =>
      url === '/api/permission-switches/me' ? Promise.reject(new Error('Request failed with status code 500')) : Promise.resolve({ data: [] }));
    renderWithProviders(
      <Suspense fallback={null}>
        <Where />
        <Routes>
          {settingsV2Routes()}
          <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
        </Routes>
      </Suspense>,
      { initialEntries: ['/settings/users'], ability: usersViewer.ability },
    );

    expect(await dashboard()).toBeInTheDocument();
  });

  it('draws nothing and does not redirect while the switch answer is on its way', async () => {
    let answer: (value: unknown) => void = () => {};
    mockApi.get.mockImplementation((url: string) =>
      url === '/api/permission-switches/me'
        ? new Promise((resolve) => { answer = resolve; })
        : Promise.resolve({ data: [] }));
    renderWithProviders(
      <Suspense fallback={null}>
        <Where />
        <Routes>
          {settingsV2Routes()}
          <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
        </Routes>
      </Suspense>,
      { initialEntries: ['/settings/users'], ability: usersViewer.ability },
    );

    await vi.waitFor(() => expect(calledUrls()).toContain('/api/permission-switches/me'));
    expect(where()).toBe('/settings/users');
    expect(screen.queryByRole('heading', { name: 'Users and teams page' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull();

    answer({ data: { admin_box: false, values: usersViewer.switches } });
    expect(await screen.findByRole('heading', { name: 'Users and teams page' })).toBeInTheDocument();
    expect(where()).toBe('/settings/users');
  });

  it('decides from the last answer at first paint, then follows the fresh one when the switch was turned off since', async () => {
    const userId = '00000000-0000-0000-0000-000000000001';
    localStorage.setItem(`servwave_my_switches:${userId}`, JSON.stringify({ admin_box: false, values: { show_users_teams_page: true } }));
    let answer: (value: unknown) => void = () => {};
    mockApi.get.mockImplementation((url: string) =>
      url === '/api/permission-switches/me'
        ? new Promise((resolve) => { answer = resolve; })
        : Promise.resolve({ data: [] }));
    renderWithProviders(
      <Suspense fallback={null}>
        <Where />
        <Routes>
          {settingsV2Routes()}
          <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
        </Routes>
      </Suspense>,
      { initialEntries: ['/settings/users'], ability: usersViewer.ability },
    );

    // The cached answer holds the switch: the page shell is drawn before the server has answered.
    expect(await screen.findByRole('heading', { name: 'Users and teams page' })).toBeInTheDocument();

    answer({ data: { admin_box: false, values: { show_users_teams_page: false } } });
    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
  });
});

describe('the old Users stub address', () => {
  it('goes to Users & Teams for a holder of Show Users & Teams page', async () => {
    open('/users', usersViewer);

    expect(await screen.findByRole('heading', { name: 'Users and teams page' })).toBeInTheDocument();
    expect(where()).toBe('/settings/users');
    expect(screen.queryByText('User management coming soon.')).toBeNull();
  });

  it('goes to the dashboard for anyone else, with no "not authorized" screen and no stub text', async () => {
    open('/users', userEditor);

    expect(await dashboard()).toBeInTheDocument();
    expect(where()).toBe('/');
    expect(screen.queryByText('User management coming soon.')).toBeNull();
  });
});
