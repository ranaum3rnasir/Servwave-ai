/**
 * Roles & Permissions, PRD 2, S02.10 - differences, per-switch reset and "Reset all to <role>" on a person's page.
 *
 * Renders the REAL routed settings table (`settingsV2Routes`) and the real person page, with only the app chrome
 * stubbed. The person's set is served in the shape `GET /api/users/:id/permissions` answers, and a reset in the shape
 * `POST /api/users/:id/permissions/reset` answers. Labels and presets are read from the catalog fixture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { toast } from '@/components/ui/use-toast';
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

const manager = {
  ability: buildAbility([{ action: 'manage_roles', subject: 'Role' }, { action: 'read', subject: 'Role' }, { action: 'read', subject: 'User' }]),
  switches: { manage_roles_and_permissions: true, view_users: true },
};

function open(path: string, answers: Record<string, unknown> = {}) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: false, values: manager.switches, rules: [] } });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
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
const lineOf = (key: string) => screen.getByRole('switch', { name: catalogSwitch(key).label }).closest('[data-switch-line]') as HTMLElement;
const resetButtonIn = (el: HTMLElement) => within(el).queryByRole('button', { name: /^Reset to Dispatcher/ });
const resetAll = () => screen.queryByRole('button', { name: 'Reset all to Dispatcher' });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('differences from the based-on role', () => {
  it('highlights the switches that differ and offers "Reset to <role>" on them, and on no other', async () => {
    open(PAGE, { u1: personSet(flipped(A, B)) });

    await screen.findByRole('switch', { name: catalogSwitch(A).label });
    for (const key of [A, B]) {
      expect(lineOf(key), key).toHaveAttribute('data-differs', 'true');
      expect(resetButtonIn(lineOf(key)), key).toBeInTheDocument();
    }
    const equal = lineOf('view_customers');
    expect(equal).not.toHaveAttribute('data-differs');
    expect(resetButtonIn(equal)).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Reset to Dispatcher/ })).toHaveLength(2);
  });

  it('draws a switch with no stored value on the person at its resolved value, with no highlight', async () => {
    // A switch the product added later: the server resolves it to the role's value and lists no difference for it.
    const values = flipped(A);
    delete values[B];
    open(PAGE, { u1: personSet(values) });

    await screen.findByRole('switch', { name: catalogSwitch(A).label });
    expect(lineOf(B)).not.toHaveAttribute('data-differs');
    expect(resetButtonIn(lineOf(B))).toBeNull();
    expect(screen.getByText('1 change')).toBeInTheDocument();
  });

  it('highlights nothing and offers no reset when the person has no changes', async () => {
    open(PAGE);

    await screen.findByRole('switch', { name: catalogSwitch(A).label });
    expect(document.querySelector('[data-differs]')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /^Reset to / })).toHaveLength(0);
    expect(resetAll()).toBeNull();
  });
});

describe('Reset to <role> on one switch', () => {
  it('asks the server to reset that switch, then shows the role\'s value and one change fewer', async () => {
    const user = userEvent.setup();
    open(PAGE, { u1: personSet(flipped(A, B)) });
    await screen.findByText('2 changes');
    mockApi.post.mockResolvedValue({ data: personSet(flipped(B)) });

    await user.click(resetButtonIn(lineOf(A))!);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith('/api/users/u1/permissions/reset', { switch_keys: [A] });
    expect(await screen.findByText('1 change')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: catalogSwitch(A).label }).getAttribute('aria-checked')).toBe(String(ROLE[A]));
    expect(lineOf(A)).not.toHaveAttribute('data-differs');
    expect(lineOf(B)).toHaveAttribute('data-differs', 'true');
  });

  it('shows a server refusal as a plain message and leaves the switch as it was', async () => {
    const user = userEvent.setup();
    open(PAGE, { u1: personSet(flipped(A)) });
    await screen.findByText('1 change');
    const sentence = 'Reopen leads needs View leads on.';
    mockApi.post.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true, response: { status: 400, data: { error: 'The set breaks a rule', violations: [{ switch_key: A, message: sentence }] } },
    }));

    await user.click(resetButtonIn(lineOf(A))!);

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: sentence, variant: 'destructive' })));
    expect(screen.getByText('1 change')).toBeInTheDocument();
    expect(lineOf(A)).toHaveAttribute('data-differs', 'true');
  });

  it('puts back a switch changed on the page and not yet saved without writing anything to the server', async () => {
    const user = userEvent.setup();
    open(PAGE);
    await user.click(await screen.findByRole('switch', { name: catalogSwitch(A).label }));
    expect(await screen.findByText('1 change')).toBeInTheDocument();

    await user.click(resetButtonIn(lineOf(A))!);

    expect(mockApi.post).not.toHaveBeenCalled();
    expect(screen.getByText('No changes')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: catalogSwitch(A).label }).getAttribute('aria-checked')).toBe(String(ROLE[A]));
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });
});

describe('Reset all to <role>', () => {
  it('shows in the header only with at least one change, and brings the count to zero', async () => {
    const user = userEvent.setup();
    open(PAGE, { u1: personSet(flipped(A, B)) });
    await screen.findByText('2 changes');
    const header = screen.getByRole('heading', { name: /Dee Spatch/ }).closest('[data-person-header]') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'Reset all to Dispatcher' })).toBeInTheDocument();
    mockApi.post.mockResolvedValue({ data: personSet() });

    await user.click(resetAll()!);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/users/u1/permissions/reset', { all: true }));
    expect(await screen.findByText('No changes')).toBeInTheDocument();
    expect(resetAll()).toBeNull();
    expect(document.querySelector('[data-differs]')).toBeNull();
  });

  it('is missing when the person has no changes', async () => {
    open(PAGE);
    await screen.findByText('No changes');
    expect(resetAll()).toBeNull();
  });

  it('drops edits made on the page and not yet saved without writing to the server', async () => {
    const user = userEvent.setup();
    open(PAGE);
    await user.click(await screen.findByRole('switch', { name: catalogSwitch(A).label }));
    await screen.findByText('1 change');

    await user.click(resetAll()!);

    expect(mockApi.post).not.toHaveBeenCalled();
    expect(screen.getByText('No changes')).toBeInTheDocument();
    expect(resetAll()).toBeNull();
  });
});

describe('where the reset controls do not appear', () => {
  it('draws no reset control on the viewer\'s own page, where nothing can change', async () => {
    open('/settings/users/u3/permissions', { u3: personSet(flipped(A), { user_id: 'u3', editable: false }) });

    await screen.findByText(/can.t change their own access/i);
    expect(screen.queryAllByRole('button', { name: /^Reset / })).toHaveLength(0);
  });

  it('draws none on an admin person', async () => {
    open('/settings/users/u2/permissions', { u2: personSet({}, { user_id: 'u2', admin_box: true, editable: false, based_on: null }) });

    await screen.findByText('Full access');
    expect(screen.queryAllByRole('button', { name: /^Reset / })).toHaveLength(0);
  });
});
