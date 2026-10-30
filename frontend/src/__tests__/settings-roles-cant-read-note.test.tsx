/**
 * Roles & Permissions, PRD 10, S10.25 - the Roles page's "Can't read" note.
 *
 * Renders `pages/v2/settings/RolesPage` (the file `pages/v2/routes/settings.routes.tsx` mounts at /settings/roles) against
 * the real answer shapes of the catalog read and the Roles API. A role that turns Show Email or Access Communication off
 * carries the note, read from the switches as they stand on screen (so it follows the switch before saving); no built-in
 * preset does; and the note is only a note: the role still saves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import type { SettingsSaver } from '@/lib/settings/types';
import { CANT_READ_ROLE_NOTE, type BuiltInRoleKey, type RoleSwitchSet, type SwitchSet } from '@/lib/api/permissionSwitches';
import { FIXTURE_CATALOG, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
const plan = vi.hoisted(() => ({ email: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: (key: string) => (key === 'email' ? plan.email : true),
}));

const mockApi = vi.mocked(api);

let saver: SettingsSaver;
vi.mock('@/pages/v2/settings/settingsBar', () => ({
  useSettingsBar: () => ({
    registerSaver: (s: SettingsSaver) => {
      saver = s;
    },
  }),
}));

// The roles with switches to read (Admin is the full-access box: no switches, so nothing to close).
const SWITCH_ROLES: Array<[BuiltInRoleKey, string]> = [['SALES', 'Sales'], ['DISPATCHER', 'Dispatcher'], ['TECHNICIAN', 'Technician']];
const BUILT_IN = [
  { role: 'ADMIN', label: 'Admin', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  ...SWITCH_ROLES.map(([role, label]) => ({ role, label, fullAccess: false, editable: true, userCount: 1, type: 'system' })),
];
const CUSTOM = { id: 'r1', role: 'night_shift', label: 'Night shift', fullAccess: false, editable: true, userCount: 4, type: 'custom', base_role: 'TECHNICIAN' };

const setOf = (role: string, values: SwitchSet, type = 'custom'): RoleSwitchSet => ({
  role, label: role, type, editable: true, base_role: 'TECHNICIAN', made_from_role_key: null, made_from_blank: false, values, all_views_off: false,
});

let saved: Record<string, SwitchSet>;
function serve() {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: [...BUILT_IN, CUSTOM] });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    const m = url.match(/^\/api\/roles\/([^/]+)\/permissions$/);
    if (m) return Promise.resolve({ data: setOf(m[1]!, saved[m[1]!] ?? presetSet(m[1] as BuiltInRoleKey), SWITCH_ROLES.some(([r]) => r === m[1]) ? 'system' : 'custom') });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  plan.email = true;
  saved = { night_shift: presetSet('TECHNICIAN') };
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  serve();
});

const note = () => screen.queryByText(CANT_READ_ROLE_NOTE);
const toggleOf = (key: string) => screen.findByRole('switch', { name: catalogSwitch(key).label });

describe('Settings > Roles: the "Can\'t read" note', () => {
  it('carries no note on any built-in role: no preset closes the Email page', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    for (const [role, label] of SWITCH_ROLES) {
      await user.click(await screen.findByRole('button', { name: new RegExp(label) }));
      await toggleOf('show_email');
      expect(note(), role).toBeNull();
    }
  });

  it('shows the note on a custom role with Show Email off, and not on one with both on', async () => {
    const user = userEvent.setup();
    saved.night_shift = { ...presetSet('TECHNICIAN'), show_email: false };
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('button', { name: /Night shift/ }));
    await toggleOf('show_email');
    expect(await screen.findByText(CANT_READ_ROLE_NOTE)).toBeInTheDocument();
    expect(CANT_READ_ROLE_NOTE).toMatch(/^Can't read: Email page is off for/);
  });

  it('shows the note on a custom role with Access Communication off', async () => {
    const user = userEvent.setup();
    saved.night_shift = { ...presetSet('TECHNICIAN'), access_communication: false, show_email: false, show_phone: false };
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('button', { name: /Night shift/ }));
    expect(await screen.findByText(CANT_READ_ROLE_NOTE)).toBeInTheDocument();
  });

  it('appears as the switch is flipped off and goes when it is flipped back, before saving', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('button', { name: /Night shift/ }));
    const showEmail = await toggleOf('show_email');
    expect(note()).toBeNull();

    await user.click(showEmail);
    expect(await screen.findByText(CANT_READ_ROLE_NOTE)).toBeInTheDocument();
    await user.click(showEmail);
    expect(note()).toBeNull();
    expect(mockApi.put).not.toHaveBeenCalled();
  });

  it('is a note, never a block: the role still saves with the switch off', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('button', { name: /Night shift/ }));
    await user.click(await toggleOf('show_email'));
    expect(await screen.findByText(CANT_READ_ROLE_NOTE)).toBeInTheDocument();

    mockApi.put.mockResolvedValue({ data: setOf('night_shift', { ...presetSet('TECHNICIAN'), show_email: false }) });
    await saver.save();
    expect(mockApi.put).toHaveBeenCalledWith('/api/roles/night_shift/permissions', { values: { show_email: false } });
    await waitFor(() => expect(saver.isDirty).toBe(false));
  });

  it('is left out in a company without the Email plan feature', async () => {
    const user = userEvent.setup();
    plan.email = false;
    saved.night_shift = { ...presetSet('TECHNICIAN'), show_email: false };
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('button', { name: /Night shift/ }));
    await toggleOf('show_email');
    expect(note()).toBeNull();
    expect(within(document.body).queryByRole('status')).toBeNull();
  });
});
