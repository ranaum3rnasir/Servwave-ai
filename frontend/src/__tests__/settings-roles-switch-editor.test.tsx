/**
 * Roles & Permissions, PRD 2, S02.1 - the routed Settings > Roles page draws the whole switch catalog.
 *
 * Renders `pages/v2/settings/RolesPage`, the file `pages/v2/routes/settings.routes.tsx` mounts at /settings/roles,
 * against the real answer shapes of the catalog read and the Roles API. Labels, help text, presets and order are read
 * from the catalog fixture, never written here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import type { SettingsSaver } from '@/lib/settings/types';
import type { BuiltInRoleKey } from '@/lib/api/permissionSwitches';
import type { RoleSwitchSet } from '@/lib/api/shared/switchTypes';
import { FIXTURE_CATALOG, FIXTURE_LAYOUT, FIXTURE_DRAWN_SWITCHES, FIXTURE_SWITCHES, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

const mockApi = vi.mocked(api);

let saver: SettingsSaver;
vi.mock('@/pages/v2/settings/settingsBar', () => ({
  useSettingsBar: () => ({
    registerSaver: (s: SettingsSaver) => {
      saver = s;
    },
  }),
}));

const ROLES = [
  { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 3, type: 'system' },
  { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 2, type: 'system' },
  { role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 5, type: 'system' },
  { id: 'r1', role: 'night_shift', label: 'Night shift', fullAccess: false, editable: true, userCount: 4, type: 'custom', base_role: 'TECHNICIAN' },
];

function roleSet(role: string, values = presetSet((ROLES.find((r) => r.role === role)?.type === 'custom' ? 'TECHNICIAN' : role) as BuiltInRoleKey)): RoleSwitchSet {
  const entry = ROLES.find((r) => r.role === role)!;
  return {
    role, label: entry.label, type: entry.type as 'system' | 'custom', editable: entry.editable, base_role: entry.type === 'custom' ? 'TECHNICIAN' : role,
    made_from_role_key: null, made_from_blank: false, values, all_views_off: false,
  };
}

function serve(opts: { catalogFails?: boolean; saved?: Record<string, RoleSwitchSet> } = {}) {
  const saved = opts.saved ?? {};
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/permission-switches/catalog') {
      return opts.catalogFails ? Promise.reject(new Error('Request failed with status code 500')) : Promise.resolve({ data: FIXTURE_CATALOG });
    }
    const m = url.match(/^\/api\/roles\/([^/]+)\/permissions$/);
    if (m) return Promise.resolve({ data: saved[m[1]!] ?? roleSet(m[1]!) });
    return Promise.resolve({ data: [] });
  });
}

const openRole = async (name: RegExp | string) => {
  await userEvent.click(await screen.findByRole('button', { name }));
};

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  serve();
});

describe('Settings > Roles, the roles list', () => {
  it('lists every role of the company with the number of people on it', async () => {
    renderWithProviders(<RolesPage />);
    // Every role but the Administrator entry, which is not a role on this page (Admin is a flag on the person).
    for (const r of ROLES.filter((x) => !x.fullAccess)) {
      const button = await screen.findByRole('button', { name: new RegExp(r.label.replace(/[()]/g, '.')) });
      expect(within(button).getByText(String(r.userCount))).toBeInTheDocument();
    }
  });

  it('does not list the Administrator entry: Admin is a flag on the person, not a role to edit here', async () => {
    renderWithProviders(<RolesPage />);
    await screen.findByRole('button', { name: /^Sales/ });
    expect(screen.queryByRole('button', { name: /^Administrator/ })).toBeNull();
    expect(screen.queryByText('Full access')).toBeNull();
  });
});

describe('Settings > Roles, a role picked', () => {
  it('draws every switch of the catalog, each at the value the role holds', async () => {
    renderWithProviders(<RolesPage />);
    await openRole(/^Dispatcher/);
    const preset = presetSet('DISPATCHER');
    await screen.findByRole('switch', { name: catalogSwitch('view_customers').label });
    expect(FIXTURE_DRAWN_SWITCHES.length).toBeGreaterThan(0);
    for (const s of FIXTURE_DRAWN_SWITCHES) {
      expect(screen.getByRole('button', { name: `About ${s.label}` }), s.label).toBeInTheDocument();
      if (s.kind === 'toggle') {
        expect(screen.getByRole('switch', { name: s.label }).getAttribute('aria-checked'), s.label).toBe(String(preset[s.key]));
      }
    }
  });

  it('draws the two switches registered on the company record, and settable for a role', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openRole(/^Dispatcher/);
    for (const key of ['manage_payout_account', 'view_payments']) {
      const control = await screen.findByRole('switch', { name: catalogSwitch(key).label });
      expect(control).toBeEnabled();
      await user.click(control);
    }
    await waitFor(() => expect(saver.isDirty).toBe(true));
    mockApi.put.mockResolvedValue({ data: roleSet('DISPATCHER') });
    await saver.save();
    expect(mockApi.put).toHaveBeenCalledWith('/api/roles/DISPATCHER/permissions', {
      values: { manage_payout_account: !presetSet('DISPATCHER').manage_payout_account, view_payments: !presetSet('DISPATCHER').view_payments },
    });
  });

  it('says changes apply to people given the role from now on', async () => {
    renderWithProviders(<RolesPage />);
    await openRole(/^Sales/);
    expect(await screen.findByText(/Changes reach everyone on this role, except people who hold their own value for a switch\./)).toBeInTheDocument();
  });

  it('retires the Sensitive list, the Job Milestones list, the grid and the separate Data Scope tab', async () => {
    renderWithProviders(<RolesPage />);
    await openRole(/^Sales/);
    await screen.findByRole('region', { name: 'Money' });
    expect(screen.queryByText('Sensitive')).toBeNull();
    expect(screen.queryByText('Job Milestones')).toBeNull();
    // The only tabs are the editor and the Change log (S02.12): Data Scope is not a tab of its own.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Permissions', 'Change log']);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it('names no vendor anywhere on the page', async () => {
    const { container } = renderWithProviders(<RolesPage />);
    await openRole(/^Sales/);
    await screen.findByRole('region', { name: 'Money' });
    expect(container.textContent).not.toMatch(/\b(CTM|CallTracking|Supabase|Render|Stripe|Twilio|Resend|Vercel)\b/i);
  });
});

describe('Settings > Roles, editing and saving', () => {
  it('sends only the switches that changed, through the role write, and clears the edit when it is saved', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openRole(/^Sales/);
    const key = 'reopen_leads';
    const label = catalogSwitch(key).label;
    const was = presetSet('SALES')[key];
    expect(saver.isDirty).toBe(false);

    await user.click(await screen.findByRole('switch', { name: label }));
    await waitFor(() => expect(saver.isDirty).toBe(true));

    mockApi.put.mockResolvedValue({ data: roleSet('SALES', { ...presetSet('SALES'), [key]: !was }) });
    await saver.save();
    expect(mockApi.put).toHaveBeenCalledTimes(1);
    expect(mockApi.put).toHaveBeenCalledWith('/api/roles/SALES/permissions', { values: { [key]: !was } });
    await waitFor(() => expect(saver.isDirty).toBe(false));
    expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe(String(!was));
  });

  it('tells the admin how many people a save reached and how many keep their own value, and the line goes when the role is edited again', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openRole(/^Sales/);
    const key = 'reopen_leads';
    await user.click(await screen.findByRole('switch', { name: catalogSwitch(key).label }));
    await waitFor(() => expect(saver.isDirty).toBe(true));
    mockApi.put.mockResolvedValue({ data: { ...roleSet('SALES', { ...presetSet('SALES'), [key]: !presetSet('SALES')[key] }), reaches: 3, keep_own: 1 } });
    await saver.save();

    expect(await screen.findByRole('status')).toHaveTextContent('Reaches 3 people; 1 keeps their own value.');
    await user.click(screen.getByRole('switch', { name: catalogSwitch(key).label }));
    await waitFor(() => expect(saver.isDirty).toBe(true));
    expect(screen.queryByText(/Reaches 3 people/)).toBeNull();
  });

  it('sends a changed choice as the value the server stores', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openRole(/^Sales/);
    const scope = await screen.findByRole('radiogroup', { name: catalogSwitch('communication_scope').label });
    await user.click(within(scope).getByRole('radio', { name: 'All' }));
    mockApi.put.mockResolvedValue({ data: roleSet('SALES') });
    await saver.save();
    expect(mockApi.put).toHaveBeenCalledWith('/api/roles/SALES/permissions', { values: { communication_scope: 'all' } });
  });

  it('is not dirty again when an edit is put back, and Discard restores the saved set', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openRole(/^Technician/);
    // A switch nothing else needs: turning a View off clears what needs it, and putting the View back does not.
    const label = catalogSwitch('reopen_leads').label;
    const control = await screen.findByRole('switch', { name: label });
    const was = control.getAttribute('aria-checked');

    await user.click(control);
    await waitFor(() => expect(saver.isDirty).toBe(true));
    await user.click(screen.getByRole('switch', { name: label }));
    await waitFor(() => expect(saver.isDirty).toBe(false));

    await user.click(screen.getByRole('switch', { name: label }));
    await waitFor(() => expect(saver.isDirty).toBe(true));
    saver.discard();
    await waitFor(() => expect(screen.getByRole('switch', { name: label }).getAttribute('aria-checked')).toBe(was));
    expect(saver.isDirty).toBe(false);
    expect(mockApi.put).not.toHaveBeenCalled();
  });

  it('asks before moving to another role while edits are unsaved, and stays put if the answer is no', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openRole(/^Sales/);
    await user.click(await screen.findByRole('switch', { name: catalogSwitch('reopen_leads').label }));
    await waitFor(() => expect(saver.isDirty).toBe(true));
    // The settings shell publishes the page's dirty state to the guard; do the same here.
    useSettingsGuard.setState({ isDirty: true });

    await user.click(screen.getByRole('button', { name: /^Technician/ }));
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/roles/TECHNICIAN/permissions');

    useSettingsGuard.getState().cancelPending();
    expect(screen.getByRole('switch', { name: catalogSwitch('reopen_leads').label })).toBeInTheDocument();
    expect(saver.isDirty).toBe(true);
  });

  it('moves to the other role, with its own values, once the answer is yes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openRole(/^Sales/);
    await user.click(await screen.findByRole('switch', { name: catalogSwitch('reopen_leads').label }));
    useSettingsGuard.setState({ isDirty: true });

    await user.click(screen.getByRole('button', { name: /^Technician/ }));
    useSettingsGuard.getState().resolvePending();
    await waitFor(() => expect(saver.isDirty).toBe(false));
    const technician = presetSet('TECHNICIAN');
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: catalogSwitch('reopen_leads').label }).getAttribute('aria-checked')).toBe(String(technician.reopen_leads)),
    );
  });
});

describe('Settings > Roles, Data Scope in each scoped row', () => {
  it('draws a scope control in each scoped row and the "Follows the leads and jobs" line on the rows that have none', async () => {
    renderWithProviders(<RolesPage />);
    await openRole(/^Dispatcher/);
    await screen.findByRole('region', { name: 'Money' });
    const rows = FIXTURE_LAYOUT.groups.flatMap((g) => g.modules);
    for (const scoped of rows.filter((m) => m.scope)) {
      expect(within(screen.getByRole('group', { name: scoped.label })).getByRole('radiogroup', { name: catalogSwitch(scoped.scope!).label })).toBeInTheDocument();
    }
    for (const m of rows.filter((r) => r.scopeNote)) {
      expect(within(screen.getByRole('group', { name: m.label })).getByText(m.scopeNote!)).toBeInTheDocument();
    }
    expect(screen.queryByText(/appl(y|ies) at all/i)).toBeNull();
  });

  it('shows what Sales holds as Through own leads, and one click on Attached saves it as attached', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await openRole(/^Sales/);
    const jobs = catalogSwitch('jobs_scope');
    const kept = jobs.keptValueHelp!.through_own_leads!;
    const row = await screen.findByRole('group', { name: 'Jobs' });
    expect(within(row).getByText(kept.meaning)).toBeInTheDocument();

    await user.click(within(within(row).getByRole('radiogroup', { name: jobs.label })).getByRole('radio', { name: 'Attached' }));
    await waitFor(() => expect(saver.isDirty).toBe(true));
    expect(within(row).queryByText(kept.meaning)).toBeNull();

    mockApi.put.mockResolvedValue({ data: roleSet('SALES', { ...presetSet('SALES'), jobs_scope: 'attached' }) });
    await saver.save();
    expect(mockApi.put).toHaveBeenCalledWith('/api/roles/SALES/permissions', { values: { jobs_scope: 'attached' } });
    // Saved, the kept value is gone from the row and Attached stays chosen.
    await waitFor(() => expect(saver.isDirty).toBe(false));
    expect(within(within(row).getByRole('radiogroup', { name: jobs.label })).getByRole('radio', { name: 'Attached' })).toBeChecked();
  });
});

describe('Settings > Roles, when the catalog cannot be read', () => {
  it('says so plainly instead of drawing nothing, spinning or crashing, and offers no Save', async () => {
    serve({ catalogFails: true });
    renderWithProviders(<RolesPage />);
    await openRole(/^Sales/);
    expect(await screen.findByText(/permissions can.t be shown right now/i)).toBeInTheDocument();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(saver.isDirty).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^Dispatcher/ }));
  });
});
