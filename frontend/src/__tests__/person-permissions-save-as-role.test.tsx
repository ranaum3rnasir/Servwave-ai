/**
 * Roles & Permissions, PRD 2, S02.11 - Save as role on a person's Permissions page.
 *
 * Renders the REAL routed settings table (`settingsV2Routes`) and the real person page, with only the app chrome
 * stubbed. The person's set is served in the shape `GET /api/users/:id/permissions` answers, and Save as role in the
 * shape `POST /api/users/:id/permissions/save-as-role` answers (the new role, then the person's set on it). Labels and
 * presets are read from the catalog fixture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';
import type { SwitchSet } from '@/lib/api/shared/switchTypes';
import { renderWithProviders } from './helpers';
import { FIXTURE_CATALOG, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

const person = (id: string, first: string, last: string, role: string) => ({
  id, email: `${first.toLowerCase()}@test.com`, first_name: first, last_name: last, role,
  is_active: true, has_login: true, phone: '+15551112222', phone_ext: null, department_id: null, department: null,
  enforce_clock_in_location: false, can_approve_clock_overrides: false, created_at: '', updated_at: '',
});
const USERS = [person('u1', 'Dee', 'Spatch', 'DISPATCHER'), person('u2', 'Anna', 'Admin', 'ADMIN'), person('u3', 'Mia', 'Manager', 'SALES')];

const DISPATCHER = { key: 'DISPATCHER', label: 'Dispatcher', type: 'built_in' };
const [A, B] = ['reopen_leads', 'export_customers'];
const ROLE = presetSet('DISPATCHER');
const flipped = (...keys: string[]): SwitchSet => ({ ...ROLE, ...Object.fromEntries(keys.map((k) => [k, !ROLE[k]])) });

/** A person's set in the shape the people read answers: the differences are derived from the values against the role. */
function personSet(values: SwitchSet = ROLE, over: Record<string, unknown> = {}) {
  const differences = Object.keys(values).filter((k) => values[k] !== ROLE[k]).map((k) => ({ switch_key: k, value: values[k], role_value: ROLE[k] }));
  return { user_id: 'u1', admin_box: false, editable: true, based_on: DISPATCHER, values, differences, difference_count: differences.length, ...over };
}

/** What the server answers once the person is saved as a role: the role, and the person's set now based on it. */
function savedAs(label: string, values: SwitchSet) {
  const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    role: { id: `id-${key}`, role: key, label, description: '', base_role: 'DISPATCHER', made_from_role_key: 'DISPATCHER', fullAccess: false, editable: true, type: 'custom' },
    ...personSet(values, { based_on: { key, label, type: 'custom' }, differences: [], difference_count: 0 }),
  };
}

const manager = {
  ability: buildAbility([{ action: 'manage_roles', subject: 'Role' }, { action: 'read', subject: 'Role' }, { action: 'read', subject: 'User' }]),
  switches: { manage_roles_and_permissions: true, view_users: true },
};

let roles: Array<Record<string, unknown>> = [];

function open(path: string, answers: Record<string, unknown> = {}) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: false, values: manager.switches, rules: [] } });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    if (url === '/api/roles') return Promise.resolve({ data: roles });
    if (url === '/api/users') return Promise.resolve({ data: { users: USERS } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    const m = url.match(/^\/api\/users\/([^/]+)\/permissions$/);
    if (m) return Promise.resolve({ data: answers[m[1]!] ?? personSet() });
    return Promise.resolve({ data: [] });
  });
  return renderWithProviders(
    <Suspense fallback={null}>
      <Routes>
        {settingsV2Routes()}
        <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path], ability: manager.ability },
  );
}

const PAGE = '/settings/users/u1/permissions';
const saveAsRole = () => screen.queryByRole('button', { name: 'Save as role' });

async function nameTheRole(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(saveAsRole()!);
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), name);
  return dialog;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  roles = [];
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('Save as role', () => {
  it('asks for a name, creates the role from the person, and shows "Based on <new role>" with no changes', async () => {
    const user = userEvent.setup();
    open(PAGE, { u1: personSet(flipped(A, B)) });
    await screen.findByText('2 changes');
    const answer = savedAs('Dispatcher plus', flipped(A, B));
    mockApi.post.mockResolvedValue({ data: answer });

    const dialog = await nameTheRole(user, 'Dispatcher plus');
    await user.click(within(dialog).getByRole('button', { name: 'Create role' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith('/api/users/u1/permissions/save-as-role', { label: 'Dispatcher plus' });
    expect(await screen.findByText('Based on Dispatcher plus')).toBeInTheDocument();
    expect(screen.getByText('No changes')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-differs]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reset / })).toBeNull();
    // The person keeps every value they had.
    expect(screen.getByRole('switch', { name: catalogSwitch(A).label }).getAttribute('aria-checked')).toBe(String(!ROLE[A]));
  });

  it('shows the server\'s plain reason for a colliding name inside the dialog and leaves the person as they were', async () => {
    const user = userEvent.setup();
    open(PAGE, { u1: personSet(flipped(A)) });
    await screen.findByText('1 change');
    const reason = 'A role named "Dispatcher plus" already exists. Choose another name.';
    mockApi.post.mockRejectedValue(Object.assign(new Error('Request failed with status code 409'), { isAxiosError: true, response: { status: 409, data: { error: reason } } }));

    const dialog = await nameTheRole(user, 'Dispatcher plus');
    await user.click(within(dialog).getByRole('button', { name: 'Create role' }));

    expect(await within(dialog).findByText(reason)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBe(dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Based on Dispatcher')).toBeInTheDocument();
    expect(screen.getByText('1 change')).toBeInTheDocument();
  });

  it('offers no Create role until a name is typed', async () => {
    const user = userEvent.setup();
    open(PAGE);
    await screen.findByText('No changes');

    await user.click(saveAsRole()!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Create role' })).toBeDisabled();
  });

  it('is offered with no changes too, since a person on a built-in role can still become a role of their own', async () => {
    open(PAGE);
    await screen.findByText('No changes');
    expect(saveAsRole()).toBeInTheDocument();
  });

  it('is turned off while edits are waiting to be saved, so the role is never made from values the page does not hold yet', async () => {
    const user = userEvent.setup();
    open(PAGE);
    await user.click(await screen.findByRole('switch', { name: catalogSwitch(A).label }));
    await screen.findByText('1 change');

    expect(saveAsRole()).toBeDisabled();
  });
});

describe('where Save as role does not appear', () => {
  it('is missing on an admin person', async () => {
    open('/settings/users/u2/permissions', { u2: personSet({}, { user_id: 'u2', admin_box: true, editable: false, based_on: null }) });

    await screen.findByText('Full access');
    expect(saveAsRole()).toBeNull();
  });

  it('is missing on the viewer\'s own page', async () => {
    open('/settings/users/u3/permissions', { u3: personSet(flipped(A), { user_id: 'u3', editable: false }) });

    await screen.findByText(/can.t change their own access/i);
    expect(saveAsRole()).toBeNull();
  });
});

describe('the new role on the Roles page', () => {
  it('is listed and names the role it was made from', async () => {
    roles = [
      { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1, type: 'system' },
      { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 0, type: 'system' },
      { ...savedAs('Dispatcher plus', ROLE).role, userCount: 1, made_from_blank: false },
    ];
    const set = { role: 'dispatcher-plus', label: 'Dispatcher plus', type: 'custom', editable: true, base_role: 'DISPATCHER', made_from_role_key: 'DISPATCHER', made_from_blank: false, values: ROLE, all_views_off: false };
    open('/settings/roles');
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: false, values: manager.switches, rules: [] } });
      if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
      if (url === '/api/roles') return Promise.resolve({ data: roles });
      if (url === '/api/roles/dispatcher-plus/permissions') return Promise.resolve({ data: set });
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    await user.click((await screen.findAllByText('Dispatcher plus'))[0]!);

    expect(await screen.findByText('Made from Dispatcher')).toBeInTheDocument();
  });
});
