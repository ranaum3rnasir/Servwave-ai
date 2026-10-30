/**
 * Roles & Permissions, PRD 2, S02.9 - a person's Permissions page replaces the Inherit / Allow / Deny dialog.
 *
 * Renders the REAL routed settings table (`settingsV2Routes`), the real Settings shell, the real Users & Teams page and
 * the real person page, with only the app chrome (the sign-in guard and the app layout) stubbed. The catalog, the
 * people list and the person's set are served in the shapes the real routes answer; labels, help text and presets are
 * read from the catalog fixture, never written here. Every viewer is a custom role built from the rules under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility, type AppAbility } from '@/lib/ability';
import { toast } from '@/components/ui/use-toast';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';
import { renderWithProviders } from './helpers';
import { FIXTURE_CATALOG, FIXTURE_SWITCHES, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

// `admin_box` is the server's answer to "is this person in the Admin box": base role Admin AND no custom role.
const person = (id: string, first: string, last: string, role: string, customRole: { key: string; label: string } | null = null) => ({
  id, email: `${first.toLowerCase()}@test.com`, first_name: first, last_name: last, role,
  custom_role_id: customRole ? `${customRole.key}-id` : null, custom_role: customRole, admin_box: role === 'ADMIN' && !customRole,
  is_active: true, has_login: true, phone: '+15551112222', phone_ext: null, department_id: null, department: null,
  enforce_clock_in_location: false, can_approve_clock_overrides: false, created_at: '', updated_at: '',
});

const USERS = [person('u1', 'Dee', 'Spatch', 'DISPATCHER'), person('u2', 'Anna', 'Admin', 'ADMIN'), person('u3', 'Mia', 'Manager', 'SALES')];
// A custom role copied from Admin keeps the Admin base role but is NOT the Admin box: it has switches to set.
const ADMIN_COPY = person('u4', 'Cory', 'Copy', 'ADMIN', { key: 'admin_copy', label: 'Admin Copy' });

const DISPATCHER = { key: 'DISPATCHER', label: 'Dispatcher', type: 'built_in' };
const ROLES = [
  { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 1, type: 'system' },
];

/** A person's set in the shape `GET /api/users/:id/permissions` answers. */
function personSet(over: Record<string, unknown> = {}) {
  return {
    user_id: 'u1', admin_box: false, editable: true, based_on: DISPATCHER, values: presetSet('DISPATCHER'), differences: [], difference_count: 0, ...over,
  };
}

/** Manage roles and permissions on, with the Users page open: the viewer of these screens. */
const manager: { ability: AppAbility; switches: Record<string, boolean> } = {
  ability: buildAbility([
    { action: 'manage_roles', subject: 'Role' },
    { action: 'read', subject: 'Role' },
    { action: 'read', subject: 'User' },
  ]),
  switches: { manage_roles_and_permissions: true, show_users_teams_page: true },
};

/** Edit users and the Users page, but not Manage roles and permissions. */
const userEditor: typeof manager = {
  ability: buildAbility([
    { action: 'read', subject: 'User' },
    { action: 'update', subject: 'User' },
    { action: 'read', subject: 'Role' },
  ]),
  switches: { manage_roles_and_permissions: false, show_users_teams_page: true },
};

function serve(viewer: typeof manager, answers: Record<string, unknown> = {}) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: false, values: viewer.switches, rules: [] } });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/users') return Promise.resolve({ data: { users: [...USERS, ...(answers.__withAdminCopy ? [ADMIN_COPY] : [])] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    const m = url.match(/^\/api\/users\/([^/]+)\/permissions$/);
    if (m) return Promise.resolve({ data: answers[m[1]!] ?? personSet({ user_id: m[1] }) });
    return Promise.resolve({ data: [] });
  });
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function open(path: string, viewer: typeof manager, answers: Record<string, unknown> = {}) {
  serve(viewer, answers);
  return renderWithProviders(
    <Suspense fallback={null}>
      <Where />
      <Routes>
        {settingsV2Routes()}
        <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path], ability: viewer.ability },
  );
}

const where = () => screen.getByTestId('where').textContent;
const calledUrls = () => mockApi.get.mock.calls.map((c) => c[0] as string);
const PAGE = '/settings/users/u1/permissions';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('the Permissions action on Users & Teams', () => {
  it('shows on every non-admin row to a holder of Manage roles and permissions, and opens that person\'s page', async () => {
    const user = userEvent.setup();
    open('/settings/users', manager);

    await screen.findByText('Dee Spatch');
    // Two non-admin people, one admin: the admin row offers nothing.
    expect(await screen.findAllByRole('button', { name: 'Permissions' })).toHaveLength(2);
    const adminRow = screen.getByText('Anna Admin').closest('tr')!;
    expect(within(adminRow).queryByRole('button', { name: 'Permissions' })).toBeNull();

    await user.click(within(screen.getByText('Dee Spatch').closest('tr')!).getByRole('button', { name: 'Permissions' }));
    expect(await screen.findByRole('heading', { name: /Dee Spatch/ })).toBeInTheDocument();
    expect(where()).toBe(PAGE);
  });

  it('shows on a row whose role was copied from Admin (base role Admin, not the Admin box), and not on the Admin box', async () => {
    const user = userEvent.setup();
    open('/settings/users', manager, { __withAdminCopy: true, u4: personSet({ user_id: 'u4' }) });

    await screen.findByText('Cory Copy');
    const copyRow = screen.getByText('Cory Copy').closest('tr')!;
    expect(within(copyRow).getByRole('button', { name: 'Permissions' })).toBeInTheDocument();
    expect(within(screen.getByText('Anna Admin').closest('tr')!).queryByRole('button', { name: 'Permissions' })).toBeNull();

    await user.click(within(copyRow).getByRole('button', { name: 'Permissions' }));
    expect(where()).toBe('/settings/users/u4/permissions');
  });

  it('is missing for a custom role with Edit users but not Manage roles and permissions, who lands on the dashboard by address', async () => {
    const first = open('/settings/users', userEditor);
    await screen.findByText('Dee Spatch');
    expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Permissions' })).toBeNull();
    first.unmount();

    open(PAGE, userEditor);
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(where()).toBe('/');
    // The page and its reads are never mounted for them.
    expect(calledUrls().some((u) => u.includes('/permissions'))).toBe(false);
  });
});

describe('a person\'s Permissions page', () => {
  it('names the person, the role they are based on and the number of changes', async () => {
    const [a, b] = ['reopen_leads', 'export_customers'];
    const values = { ...presetSet('DISPATCHER'), [a]: !presetSet('DISPATCHER')[a], [b]: !presetSet('DISPATCHER')[b] };
    open(PAGE, manager, {
      u1: personSet({
        values,
        differences: [a, b].map((k) => ({ switch_key: k, value: values[k], role_value: presetSet('DISPATCHER')[k] })),
        difference_count: 2,
      }),
    });

    expect(await screen.findByRole('heading', { name: /Dee Spatch/ })).toBeInTheDocument();
    expect(await screen.findByText('Based on Dispatcher')).toBeInTheDocument();
    expect(screen.getByText('2 changes')).toBeInTheDocument();
  });

  it('draws the same editor as the Roles page: every switch of the catalog, with its label and help text, at the person\'s value', async () => {
    const key = 'reopen_leads';
    const values = { ...presetSet('DISPATCHER'), [key]: !presetSet('DISPATCHER')[key] };
    open(PAGE, manager, { u1: personSet({ values, differences: [{ switch_key: key, value: values[key], role_value: presetSet('DISPATCHER')[key] }], difference_count: 1 }) });

    await screen.findByRole('switch', { name: catalogSwitch(key).label });
    expect(screen.getByText('1 change')).toBeInTheDocument();
    for (const s of FIXTURE_SWITCHES) {
      expect(screen.getByRole('button', { name: `About ${s.label}` }), s.label).toBeInTheDocument();
      if (s.kind === 'toggle') expect(screen.getByRole('switch', { name: s.label }).getAttribute('aria-checked'), s.label).toBe(String(values[s.key]));
    }
    expect(screen.getByRole('region', { name: 'Data Scope' })).toBeInTheDocument();
  });

  it('opens a person migrated with an old Allow or Deny entry on zero changes and the preset\'s values', async () => {
    // The server fills a migrated person from their role's preset only, so its answer carries no differences.
    open(PAGE, manager);

    await screen.findByRole('switch', { name: catalogSwitch('reopen_leads').label });
    expect(screen.getByText('No changes')).toBeInTheDocument();
    const preset = presetSet('DISPATCHER');
    for (const s of FIXTURE_SWITCHES.filter((x) => x.kind === 'toggle')) {
      expect(screen.getByRole('switch', { name: s.label }).getAttribute('aria-checked'), s.label).toBe(String(preset[s.key]));
    }
  });

  it('draws no Inherit, Allow or Deny control anywhere', async () => {
    const { container } = open(PAGE, manager);
    await screen.findByRole('switch', { name: catalogSwitch('reopen_leads').label });
    expect(screen.queryByRole('radio', { name: /^(Inherit|Allow|Deny)$/ })).toBeNull();
    expect(container.textContent).not.toMatch(/\b(Inherit|Deny)\b/);
  });

  it('names no vendor anywhere on the page', async () => {
    const { container } = open(PAGE, manager);
    await screen.findByRole('switch', { name: catalogSwitch('reopen_leads').label });
    expect(container.textContent).not.toMatch(/\b(CTM|CallTracking|Supabase|Render|Stripe|Twilio|Resend|Vercel)\b/i);
  });
});

describe('saving a person\'s switches', () => {
  it('sends only the switches that changed, through the person write, and shows the stored answer', async () => {
    const user = userEvent.setup();
    const key = 'reopen_leads';
    const was = presetSet('DISPATCHER')[key];
    open(PAGE, manager);

    await user.click(await screen.findByRole('switch', { name: catalogSwitch(key).label }));
    const values = { ...presetSet('DISPATCHER'), [key]: !was };
    mockApi.put.mockResolvedValue({ data: personSet({ values, differences: [{ switch_key: key, value: !was, role_value: was }], difference_count: 1 }) });
    await user.click(await screen.findByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(1));
    expect(mockApi.put).toHaveBeenCalledWith('/api/users/u1/permissions', { values: { [key]: !was } });
    expect(await screen.findByText('1 change')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: catalogSwitch(key).label }).getAttribute('aria-checked')).toBe(String(!was));
  });

  it('shows a server refusal as a plain message and keeps the edit', async () => {
    const user = userEvent.setup();
    const key = 'reopen_leads';
    open(PAGE, manager);

    await user.click(await screen.findByRole('switch', { name: catalogSwitch(key).label }));
    const sentence = 'Reopen leads needs View leads on.';
    mockApi.put.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true, response: { status: 400, data: { error: 'The set breaks a rule', violations: [{ switch_key: key, message: sentence }] } },
    }));
    await user.click(await screen.findByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: sentence, variant: 'destructive' })));
    expect(screen.getByRole('switch', { name: catalogSwitch(key).label }).getAttribute('aria-checked')).toBe(String(!presetSet('DISPATCHER')[key]));
  });
});

describe('an admin person and the viewer\'s own page', () => {
  it('shows an admin person as one Full access box with no switches', async () => {
    open('/settings/users/u2/permissions', manager, { u2: personSet({ user_id: 'u2', admin_box: true, editable: false, based_on: null, values: {} }) });

    expect(await screen.findByText('Full access')).toBeInTheDocument();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Data Scope' })).toBeNull();
  });

  it('draws no editable control on the viewer\'s own page and says people cannot change their own access', async () => {
    open('/settings/users/u3/permissions', manager, { u3: personSet({ user_id: 'u3', editable: false }) });

    expect(await screen.findByText(/can.t change their own access/i)).toBeInTheDocument();
    const label = await screen.findByText(catalogSwitch('reopen_leads').label);
    // Read-only draws each value as words beside its label, and no control that could change it.
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(label.closest('div')!.parentElement).toHaveTextContent(presetSet('DISPATCHER').reopen_leads ? 'On' : 'Off');
    expect(mockApi.put).not.toHaveBeenCalled();
  });
});

describe('the page at phone width', () => {
  it('lets the header wrap and keeps every column able to shrink, so nothing pushes the page sideways', async () => {
    open(PAGE, manager);
    const heading = await screen.findByRole('heading', { name: /Dee Spatch/ });
    const header = heading.closest('[data-person-header]')!;
    expect(header).toHaveClass('flex-wrap');
    expect(header.parentElement).toHaveClass('min-w-0');
    expect(heading.parentElement).toHaveClass('min-w-0');
  });
});
