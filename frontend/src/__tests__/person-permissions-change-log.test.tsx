/**
 * Roles & Permissions, PRD 2, S02.12 - the Change log tab on a person's Permissions page.
 *
 * Renders the REAL routed settings table (`settingsV2Routes`) and the real person page, with only the app chrome stubbed.
 * The person's set and the person's change log are served in the shapes the real routes answer; a switch's name and
 * the words of its values are read from the catalog fixture, never typed here. The viewer holds Manage roles and
 * permissions, the one switch that opens this page and its log.
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
import { renderWithProviders } from './helpers';
import { FIXTURE_CATALOG, catalogSwitch, presetSet } from './support/permissionCatalogFixture';
import { logEntry, logServer, reachEnd, installObserverDouble, watching } from './support/changeLogServer';
import type { ChangeLogEntry } from '@/lib/api/permissionChangeLog';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

const person = (id: string, first: string, last: string, role: string) => ({
  id, email: `${first.toLowerCase()}@test.com`, first_name: first, last_name: last, role,
  custom_role_id: null, custom_role: null, admin_box: role === 'ADMIN',
  is_active: true, has_login: true, phone: '+15551112222', phone_ext: null, department_id: null, department: null,
  enforce_clock_in_location: false, can_approve_clock_overrides: false, created_at: '', updated_at: '',
});
const USERS = [person('u1', 'Dee', 'Spatch', 'DISPATCHER'), person('u2', 'Anna', 'Admin', 'ADMIN'), person('u3', 'Mia', 'Manager', 'SALES')];
const DISPATCHER = { key: 'DISPATCHER', label: 'Dispatcher', type: 'built_in' };

const personSet = (over: Record<string, unknown> = {}) => ({
  user_id: 'u1', admin_box: false, editable: true, based_on: DISPATCHER, values: presetSet('DISPATCHER'), differences: [], difference_count: 0, ...over,
});

const manager = {
  ability: buildAbility([{ action: 'manage_roles', subject: 'Role' }, { action: 'read', subject: 'Role' }, { action: 'read', subject: 'User' }]),
  switches: { manage_roles_and_permissions: true, view_users: true },
};

let LOGS: Record<string, ReturnType<typeof logServer>> = {};
let SETS: Record<string, unknown> = {};

function open(path: string, logs: Record<string, ChangeLogEntry[]>, sets: Record<string, unknown> = {}) {
  LOGS = Object.fromEntries(Object.entries(logs).map(([id, entries]) => [id, logServer(entries)]));
  SETS = sets;
  mockApi.get.mockImplementation((url: string, config?: unknown) => {
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: false, values: manager.switches, rules: [] } });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    if (url === '/api/organization') return Promise.resolve({ data: { timezone: 'America/Chicago' } });
    if (url === '/api/roles') return Promise.resolve({ data: [] });
    if (url === '/api/users') return Promise.resolve({ data: { users: USERS } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    const log = url.match(/^\/api\/users\/([^/]+)\/permissions\/change-log$/);
    if (log) return Promise.resolve(LOGS[log[1]!]?.answer(config as never) ?? { data: { total: 0, has_more: false, entries: [] } });
    const set = url.match(/^\/api\/users\/([^/]+)\/permissions$/);
    if (set) return Promise.resolve({ data: SETS[set[1]!] ?? personSet({ user_id: set[1] }) });
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
const logCalls = (id: string) => mockApi.get.mock.calls.filter(([url]) => url === `/api/users/${id}/permissions/change-log`);
const rows = () => screen.queryAllByRole('listitem').filter((li) => li.hasAttribute('data-change-entry'));
const openLog = async (user: ReturnType<typeof userEvent.setup>) => user.click(await screen.findByRole('tab', { name: 'Change log' }));

installObserverDouble();

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe("the Change log tab on a person's Permissions page", () => {
  it('sits beside the switches, and reads the person\'s log only once it is opened', async () => {
    const user = userEvent.setup();
    open(PAGE, { u1: [logEntry()] });
    await screen.findByRole('switch', { name: catalogSwitch('reopen_leads').label });
    expect(logCalls('u1')).toHaveLength(0);

    await openLog(user);
    await waitFor(() => expect(logCalls('u1')).toHaveLength(1));
    expect(logCalls('u1')[0]![1]).toMatchObject({ params: { limit: 50, offset: 0 } });
    expect(await screen.findByRole('list', { name: 'Change log' })).toBeInTheDocument();
  });

  it('draws only the log under the tabs while it is open: the switch editor is out of the page, and back as it was left', async () => {
    const user = userEvent.setup();
    open(PAGE, { u1: [logEntry()] });
    const flipped = catalogSwitch('reopen_leads');
    await user.click(await screen.findByRole('switch', { name: flipped.label }));
    const editedTo = screen.getByRole('switch', { name: flipped.label }).getAttribute('aria-checked');

    await openLog(user);
    await screen.findByRole('list', { name: 'Change log' });
    // Kept mounted (the edit survives) but hidden, so the log is the first thing under the tabs rather than ~8,000px down.
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    const panel = document.querySelector('[role="tabpanel"][data-state="inactive"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel).not.toBeVisible();
    expect(screen.getByRole('list', { name: 'Change log' })).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    expect(screen.getByRole('switch', { name: flipped.label }).getAttribute('aria-checked')).toBe(editedTo);
    expect(screen.queryByRole('list', { name: 'Change log' })).not.toBeInTheDocument();
  });

  it('lists a role assignment with the role named, an edit, a per-switch reset and a Save as role, each with its reason', async () => {
    const [edit, back] = ['export_customers', 'reopen_leads'];
    const user = userEvent.setup();
    open(PAGE, {
      u1: [
        logEntry({ switch_key: null, switch_label: null, from: null, to: null, reason: 'save as role', role_label: 'Front desk' }),
        logEntry({ switch_key: back, from: true, to: false, reason: 'reset', created_at: '2026-03-05T15:15:00.000Z' }),
        logEntry({ switch_key: edit, from: false, to: true, reason: 'manual' }),
        logEntry({ switch_key: 'view_customers', from: true, to: false, reason: 'role assigned', role_label: 'Dispatcher', actor: null }),
      ],
    });
    await openLog(user);
    await screen.findByRole('list', { name: 'Change log' });

    const [saved, reset, manual, assigned] = rows();
    expect(saved!.textContent).toContain('Saved as the role Front desk');
    expect(saved!.textContent).toContain('Save as role');
    expect(saved!.textContent).not.toMatch(/→|\bOn\b|\bOff\b/);
    expect(within(reset!).getByText(catalogSwitch(back).label)).toBeInTheDocument();
    expect(reset!.textContent).toMatch(/On.*Off/);
    expect(reset!.textContent).toContain('Reset');
    // The company's clock (Central), with the year.
    expect(reset!.textContent).toMatch(/Mar 5, 2026.*9:15\s?AM/);
    expect(within(manual!).getByText(catalogSwitch(edit).label)).toBeInTheDocument();
    expect(manual!.textContent).toContain('Manual edit');
    expect(manual!.textContent).toContain('Dana Admin');
    expect(assigned!.textContent).toContain('Role assigned: Dispatcher');
    expect(assigned!.textContent).toContain('System');
  });

  it('shows only switch names and values: nothing else about the person is in the log', async () => {
    const user = userEvent.setup();
    open(PAGE, { u1: [logEntry({ switch_key: 'export_customers' })] });
    await openLog(user);
    const item = (await screen.findAllByRole('listitem')).find((li) => li.hasAttribute('data-change-entry'))!;
    expect(item.textContent).not.toMatch(/@|\+1555/);
  });

  it('says plainly that there are no changes yet', async () => {
    const user = userEvent.setup();
    open(PAGE, { u1: [] });
    await openLog(user);
    expect(await screen.findByText('No changes yet.')).toBeInTheDocument();
  });

  it('is there on the viewer\'s own page, which is read-only, and on an Admin person\'s page', async () => {
    const user = userEvent.setup();
    const own = open('/settings/users/u3/permissions', { u3: [logEntry()] }, { u3: personSet({ user_id: 'u3', editable: false }) });
    await openLog(user);
    expect(await screen.findByRole('list', { name: 'Change log' })).toBeInTheDocument();
    own.unmount();

    open('/settings/users/u2/permissions', { u2: [] }, { u2: personSet({ user_id: 'u2', admin_box: true, editable: false, based_on: null, values: {} }) });
    await screen.findByText('Full access');
    await openLog(user);
    expect(await screen.findByText('No changes yet.')).toBeInTheDocument();
  });

  it('loads older entries as the end is reached, three hundred of them over six pages, each once', async () => {
    const user = userEvent.setup();
    const all = Array.from({ length: 300 }, (_, i) => logEntry({ id: `p-${i}`, reason: 'role assigned', role_label: 'Sales' }));
    open(PAGE, { u1: all });
    await openLog(user);
    await waitFor(() => expect(rows()).toHaveLength(50));
    for (let page = 2; page <= 6; page++) {
      await reachEnd();
      await waitFor(() => expect(rows()).toHaveLength(page * 50));
    }
    expect(LOGS.u1!.offsets).toEqual([0, 50, 100, 150, 200, 250]);
    await screen.findByText('That’s every change.');
    expect(watching()).toBe(0);
  });

  it('starts over from the newest entries after a switch is put back to the role\'s value', async () => {
    const key = 'export_customers';
    const preset = presetSet('DISPATCHER');
    const values = { ...preset, [key]: !preset[key] };
    const user = userEvent.setup();
    open(PAGE, { u1: [logEntry()] }, {
      u1: personSet({ values, differences: [{ switch_key: key, value: values[key], role_value: preset[key] }], difference_count: 1 }),
    });
    await screen.findByRole('switch', { name: catalogSwitch(key).label });
    await openLog(user);
    await waitFor(() => expect(logCalls('u1')).toHaveLength(1));

    // The reset button lives on the Permissions tab (the editor is out of the page while the log is open).
    await user.click(screen.getByRole('tab', { name: 'Permissions' }));
    mockApi.post.mockResolvedValue({ data: personSet() });
    await user.click(screen.getByRole('button', { name: /^Reset to Dispatcher/ }));
    await openLog(user);
    await waitFor(() => expect(logCalls('u1').length).toBeGreaterThan(1));
    expect(logCalls('u1').every(([, config]) => (config as { params: { offset: number } }).params.offset === 0)).toBe(true);
  });
});
