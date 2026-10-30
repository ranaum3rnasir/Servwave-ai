/**
 * Roles & Permissions, PRD 2, S02.2 - dependencies on the routed Settings > Roles page.
 *
 * Renders `pages/v2/settings/RolesPage` (the file `pages/v2/routes/settings.routes.tsx` mounts at /settings/roles)
 * against the real answer shapes of the catalog read and the Roles API. Which switch needs which, and every label, is
 * read from the catalog fixture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import type { SettingsSaver } from '@/lib/settings/types';
import type { RoleSwitchSet, SwitchSet } from '@/lib/api/permissionSwitches';
import { FIXTURE_CATALOG, FIXTURE_SWITCHES, catalogSwitch } from './support/permissionCatalogFixture';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

let saver: SettingsSaver;
vi.mock('@/pages/v2/settings/settingsBar', () => ({
  useSettingsBar: () => ({
    registerSaver: (s: SettingsSaver) => {
      saver = s;
    },
  }),
}));

const ROLES = [{ id: 'r1', role: 'night_shift', label: 'Night shift', fullAccess: false, editable: true, userCount: 4, type: 'custom', base_role: 'TECHNICIAN' }];

const everythingOn = (): SwitchSet =>
  Object.fromEntries(FIXTURE_SWITCHES.map((s) => [s.key, s.kind === 'toggle' ? true : s.kind === 'choice' ? s.choices![0]! : 'all_accepted']));

const roleSet = (values: SwitchSet): RoleSwitchSet => ({
  role: 'night_shift', label: 'Night shift', type: 'custom', editable: true, base_role: 'TECHNICIAN',
  made_from_role_key: null, made_from_blank: false, values, all_views_off: false,
});

function serve(values: SwitchSet) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    if (url === '/api/roles/night_shift/permissions') return Promise.resolve({ data: roleSet(values) });
    return Promise.resolve({ data: [] });
  });
}

const toggleOf = (key: string) => screen.findByRole('switch', { name: catalogSwitch(key).label });

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('Settings > Roles, a requirement turned off', () => {
  it('clears and greys what needed it, and saves the role with those switches off', async () => {
    const user = userEvent.setup();
    serve(everythingOn());
    renderWithProviders(<RolesPage />);

    await user.click(await toggleOf('view_customers'));
    const dependents = FIXTURE_SWITCHES.filter((s) => s.requires.includes('view_customers'));
    expect(dependents.length).toBeGreaterThan(0);
    for (const d of dependents) {
      const control = await toggleOf(d.key);
      expect(control, d.label).toBeDisabled();
      expect(document.getElementById(control.getAttribute('aria-describedby')!)!.textContent, d.label).toBe('Requires View');
    }

    mockApi.put.mockResolvedValue({ data: roleSet(everythingOn()) });
    await saver.save();
    const sent = (mockApi.put.mock.calls[0]![1] as { values: SwitchSet }).values;
    expect(sent.view_customers).toBe(false);
    for (const d of dependents) expect(sent[d.key], d.label).toBe(false);
    // Only what changed goes: nothing of another row.
    expect(Object.keys(sent).sort()).toEqual(
      ['view_customers', ...dependents.map((d) => d.key), 'change_customer_created_date'].sort(),
    );
  });
});

describe('Settings > Roles, the eligibility settings', () => {
  it('draws a role with Create leads and Create jobs on and all three eligibility settings off with no note and no grey, does not draw the settings, and saves it unchanged', async () => {
    const user = userEvent.setup();
    const eligibility = ['can_own_leads', 'can_be_dispatcher', 'can_be_on_crew'];
    const values: SwitchSet = { ...everythingOn(), ...Object.fromEntries(eligibility.map((k) => [k, false])) };
    serve(values);
    renderWithProviders(<RolesPage />);

    for (const key of ['create_leads', 'create_jobs']) expect(await toggleOf(key)).toBeEnabled();
    // They are per-person settings (P1): edited on the person's profile, never drawn on the Roles page.
    for (const key of eligibility) expect(screen.queryByRole('switch', { name: catalogSwitch(key).label })).toBeNull();
    expect(screen.queryAllByText(/^Requires /)).toHaveLength(0);

    await user.click(await toggleOf('show_phone'));
    mockApi.put.mockResolvedValue({ data: roleSet({ ...values, show_phone: false }) });
    await saver.save();
    expect(mockApi.put).toHaveBeenCalledWith('/api/roles/night_shift/permissions', { values: { show_phone: false } });
    await waitFor(() => expect(saver.isDirty).toBe(false));
  });
});

describe('Settings > Roles, a set the server refuses', () => {
  const refuse = (data: unknown, message = 'Request failed with status code 400') =>
    Object.assign(new Error(message), { response: { status: 400, data } });

  it('shows the server\'s own plain sentence for it, and keeps the edits so they can be put right', async () => {
    const user = userEvent.setup();
    serve(everythingOn());
    renderWithProviders(<RolesPage />);
    await user.click(await toggleOf('show_phone'));
    const sentence = `${catalogSwitch('show_phone').label} needs ${catalogSwitch('access_communication').label} on.`;
    mockApi.put.mockRejectedValue(refuse({ error: sentence, violations: [{ switchKey: 'show_phone', message: sentence, needs: ['access_communication'] }] }));

    await expect(saver.save()).rejects.toBeDefined();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: sentence, variant: 'destructive' }));
    expect(saver.isDirty).toBe(true);
  });

  it('says every violation when the server names several', async () => {
    const user = userEvent.setup();
    serve(everythingOn());
    renderWithProviders(<RolesPage />);
    await user.click(await toggleOf('show_phone'));
    const messages = ['First thing is off.', 'Second thing is off.'];
    mockApi.put.mockRejectedValue(refuse({ violations: messages.map((message) => ({ switchKey: 'x', message, needs: [] })) }));

    await expect(saver.save()).rejects.toBeDefined();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: messages.join(' ') }));
  });

  it('shows no raw error text when the server fails without an answer of its own', async () => {
    const user = userEvent.setup();
    serve(everythingOn());
    renderWithProviders(<RolesPage />);
    await user.click(await toggleOf('show_phone'));
    mockApi.put.mockRejectedValue(Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: '<html>Internal Server Error</html>' } }));

    await expect(saver.save()).rejects.toBeDefined();
    const shown = JSON.stringify(vi.mocked(toast).mock.calls);
    expect(shown).not.toMatch(/status code|Internal Server Error|<html/i);
    expect(vi.mocked(toast).mock.calls[0]![0]).toEqual(expect.objectContaining({ variant: 'destructive', description: expect.any(String) }));
  });
});
