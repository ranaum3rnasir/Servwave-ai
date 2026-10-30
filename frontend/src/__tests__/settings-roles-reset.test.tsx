/**
 * Roles & Permissions, PRD 2, S02.8 - Reset a role to its starting values.
 *
 * Renders `pages/v2/settings/RolesPage`, the file `pages/v2/routes/settings.routes.tsx` mounts at /settings/roles,
 * against the real answer shapes of the Roles API. The server's reset is played by a small stand-in that does what the
 * catalog says (a built-in role and a custom role go to the preset they start from, a blank-made role to all off), so
 * what is on screen after a reset is read from the catalog fixture, never typed here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import type { SettingsSaver } from '@/lib/settings/types';
import type { BuiltInRoleKey, RoleSwitchSet, SwitchSet } from '@/lib/api/permissionSwitches';
import { FIXTURE_CATALOG, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

const mockApi = vi.mocked(api);

let saver: SettingsSaver;
vi.mock('@/pages/v2/settings/settingsBar', () => ({
  useSettingsBar: () => ({
    registerSaver: (s: SettingsSaver) => {
      saver = s;
    },
  }),
}));

const BUILT_IN = [
  { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1, type: 'system' },
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 3, type: 'system' },
  { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 2, type: 'system' },
  { role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 5, type: 'system' },
];

type Entry = Record<string, unknown> & { role: string; label: string; type: string };

let ROLES: Entry[] = [];
let SETS: Record<string, RoleSwitchSet> = {};

/** A switch that needs nothing and that nothing needs: an experiment on a role flips it away from the role's preset. */
const FLIPPED = catalogSwitch('record_pickup_for_someone_else');
/** A second such switch, for the edit made on screen and not saved. */
const EDITED = catalogSwitch('pick_up_staged_items');
/** A switch the blank draft can have on by itself. */
const ON_IN_DRAFT = catalogSwitch('view_customers');

const allOff = (): SwitchSet =>
  Object.fromEntries(FIXTURE_CATALOG.switches.map((s) => [s.key, s.kind === 'toggle' ? false : s.presets.TECHNICIAN]));

function addCustom(label: string, opts: { baseRole?: BuiltInRoleKey; blank?: boolean; madeFrom?: string } = {}) {
  const baseRole = opts.baseRole ?? 'TECHNICIAN';
  const role = label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  ROLES.push({ id: `id_${role}`, role, label, description: '', fullAccess: false, editable: true, userCount: 0, type: 'custom', base_role: baseRole });
  SETS[role] = {
    role, label, type: 'custom', editable: true, base_role: baseRole, made_from_role_key: opts.madeFrom ?? (opts.blank ? null : baseRole),
    made_from_blank: !!opts.blank, values: opts.blank ? allOff() : presetSet(baseRole), all_views_off: false,
  };
  return role;
}

/** What the role holds once an admin has flipped `FLIPPED` away from the preset it started from, so a reset has something to undo. */
function experiment(role: string) {
  const set = SETS[role]!;
  set.values = { ...set.values, [FLIPPED.key]: !presetSet(set.base_role as BuiltInRoleKey)[FLIPPED.key] };
}

/** The switch as the editor draws it: its on or off state, read from the page. */
const stateOf = (name: string) => screen.getByRole('switch', { name }).getAttribute('aria-checked');

function serve() {
  ROLES = [...BUILT_IN];
  SETS = Object.fromEntries(BUILT_IN.map((r) => [r.role, {
    role: r.role, label: r.label, type: 'system', editable: r.editable, base_role: r.role, made_from_role_key: null, made_from_blank: false,
    values: presetSet(r.role as BuiltInRoleKey), all_views_off: false,
  } as RoleSwitchSet]));
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES.map((r) => ({ ...r })) });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    const m = url.match(/^\/api\/roles\/([^/]+)\/permissions$/);
    if (m) return Promise.resolve({ data: structuredClone(SETS[m[1]!]) });
    return Promise.resolve({ data: [] });
  });
  mockApi.post.mockImplementation((url: string) => {
    const m = url.match(/^\/api\/roles\/([^/]+)\/reset$/);
    if (!m) return Promise.resolve({ data: {} });
    const set = SETS[m[1]!]!;
    set.values = set.made_from_blank ? allOff() : presetSet(set.base_role as BuiltInRoleKey);
    return Promise.resolve({ data: structuredClone(set) });
  });
}

const originalMatchMedia = window.matchMedia;
function windowWidth(px: number) {
  window.matchMedia = vi.fn((query: string) => {
    const q = query.replace(/\s+/g, '');
    const widths = [...q.matchAll(/\((max|min)-width:([\d.]+)px\)/g)];
    const matches = widths.length > 0 && widths.every(([, k, v]) => (k === 'max' ? px <= Number(v) : px >= Number(v)));
    return {
      matches, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    };
  }) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  serve();
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

const WIDE = 1400;
const NARROW = 700;

async function pick(user: ReturnType<typeof userEvent.setup>, width: number, name: string) {
  if (width === WIDE) {
    await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
  } else {
    await user.click(await screen.findByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: new RegExp(name) }));
  }
  await screen.findByRole('heading', { name });
}

const resetCalls = () => mockApi.post.mock.calls.filter(([url]) => String(url).endsWith('/reset'));

async function openReset(user: ReturnType<typeof userEvent.setup>, title: RegExp) {
  await user.click(await screen.findByRole('button', { name: 'Reset to default' }));
  return screen.findByRole('dialog', { name: title });
}

describe.each([['a wide window', WIDE], ['a narrow window', NARROW]] as const)('Reset to default on %s', (_name, width) => {
  it.each([['Sales', 'SALES'], ['Dispatcher', 'DISPATCHER'], ['Technician', 'TECHNICIAN']] as const)(
    'a built-in role (%s): the confirm names its own preset, cancelling sends nothing, confirming restores the preset',
    async (label, key) => {
      windowWidth(width);
      const user = userEvent.setup();
      experiment(key);
      renderWithProviders(<RolesPage />);
      await pick(user, width, label);
      const preset = presetSet(key);
      await screen.findByRole('switch', { name: FLIPPED.label });
      expect(stateOf(FLIPPED.label)).toBe(String(!preset[FLIPPED.key]));

      const dialog = await openReset(user, new RegExp(`Reset to the ${label} preset`));
      expect(resetCalls()).toHaveLength(0);
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(resetCalls()).toHaveLength(0);
      expect(stateOf(FLIPPED.label)).toBe(String(!preset[FLIPPED.key]));

      const again = await openReset(user, new RegExp(`Reset to the ${label} preset`));
      await user.click(within(again).getByRole('button', { name: `Reset to the ${label} preset` }));
      await waitFor(() => expect(resetCalls()).toEqual([[`/api/roles/${key}/reset`]]));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(() => expect(stateOf(FLIPPED.label)).toBe(String(preset[FLIPPED.key])));
    },
  );

  it('has no Administrator role to reset: it is not listed', async () => {
    windowWidth(width);
    renderWithProviders(<RolesPage />);
    await screen.findByRole('heading', { name: 'Sales' });
    expect(screen.queryByText('Full access')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Administrator/ })).toBeNull();
  });

  it('a custom role resets to the preset of the built-in role it started from', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    const role = addCustom('Night desk', { baseRole: 'DISPATCHER' });
    experiment(role);
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    const dialog = await openReset(user, /Reset to the Dispatcher preset/);
    expect(resetCalls()).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Reset to the Dispatcher preset' }));
    await waitFor(() => expect(resetCalls()).toEqual([['/api/roles/night_desk/reset']]));
    const preset = presetSet('DISPATCHER');
    await waitFor(() => expect(stateOf(FLIPPED.label)).toBe(String(preset[FLIPPED.key])));
  });

  it('a role made from another custom role names the built-in preset that role carries', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    addCustom('Day desk', { baseRole: 'SALES' });
    addCustom('Night desk', { baseRole: 'SALES', madeFrom: 'day_desk' });
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    await openReset(user, /Reset to the Sales preset/);
  });

  it('a role made from blank resets to all off', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    const role = addCustom('Blank desk', { blank: true });
    SETS[role]!.values = { ...SETS[role]!.values, [ON_IN_DRAFT.key]: true };
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Blank desk');
    expect(await screen.findByRole('switch', { name: ON_IN_DRAFT.label })).toBeChecked();
    const dialog = await openReset(user, /Reset to all off/);
    expect(within(dialog).queryByText(/preset/i)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Reset to all off' }));
    await waitFor(() => expect(resetCalls()).toEqual([['/api/roles/blank_desk/reset']]));
    await waitFor(() => expect(screen.getByRole('switch', { name: ON_IN_DRAFT.label })).not.toBeChecked());
  });

  it('says people on the role follow the reset except where they hold their own value, and asks nothing about them', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Sales');
    const dialog = await openReset(user, /Reset to the Sales preset/);
    expect(within(dialog).getByText(/people on the role follow, except where a person holds their own value/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reset to the Sales preset' }));
    await waitFor(() => expect(resetCalls()).toHaveLength(1));
    // Only the role's own reset was sent: no call reaches a person's switches.
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('shows the server\'s plain refusal inside the confirm, once, and the role stays as it was', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    const reason = 'The Administrator role is full-access and cannot be edited';
    experiment('DISPATCHER');
    mockApi.post.mockRejectedValue({ response: { status: 400, data: { error: reason } } });
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Dispatcher');
    const dialog = await openReset(user, /Reset to the Dispatcher preset/);
    await user.click(within(dialog).getByRole('button', { name: 'Reset to the Dispatcher preset' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(reason);
    expect(screen.getAllByText(reason)).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The role stays as it was: the switches behind the confirm still hold the experiment.
    expect(stateOf(FLIPPED.label)).toBe(String(!presetSet('DISPATCHER')[FLIPPED.key]));
    // Asked again, the confirm starts without the last refusal.
    const again = await openReset(user, /Reset to the Dispatcher preset/);
    expect(within(again).queryByRole('alert')).toBeNull();
  });

  it('a failure with no answer of its own gets a plain sentence, never the transport\'s text', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    mockApi.post.mockRejectedValue(new Error('Network Error'));
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Sales');
    const dialog = await openReset(user, /Reset to the Sales preset/);
    await user.click(within(dialog).getByRole('button', { name: 'Reset to the Sales preset' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not reset the role. Try again in a moment.');
    expect(screen.queryByText(/Network Error/)).toBeNull();
  });
});

describe('Reset with edits not saved yet', () => {
  it('a clean role\'s confirm says nothing about unsaved edits', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await pick(user, WIDE, 'Dispatcher');
    const dialog = await openReset(user, /Reset to the Dispatcher preset/);
    expect(within(dialog).queryByText(/unsaved/i)).toBeNull();
  });

  it('says the unsaved edits are discarded, and confirming drops them with the stored values', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    experiment('DISPATCHER');
    renderWithProviders(<RolesPage />);
    await pick(user, WIDE, 'Dispatcher');
    // An edit on screen that was never saved, on a switch the experiment did not touch.
    await user.click(await screen.findByRole('switch', { name: EDITED.label }));
    await waitFor(() => expect(saver.isDirty).toBe(true));

    const dialog = await openReset(user, /Reset to the Dispatcher preset/);
    expect(within(dialog).getByText(/unsaved changes to this role will be discarded/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reset to the Dispatcher preset' }));

    await waitFor(() => expect(resetCalls()).toHaveLength(1));
    await waitFor(() => expect(saver.isDirty).toBe(false));
    const preset = presetSet('DISPATCHER');
    expect(stateOf(EDITED.label)).toBe(String(preset[EDITED.key]));
    expect(stateOf(FLIPPED.label)).toBe(String(preset[FLIPPED.key]));
    // Nothing is left to save: the reset is the saved state now.
    await saver.save();
    expect(mockApi.put).not.toHaveBeenCalled();
  });

  it('cancelling keeps the unsaved edits', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    experiment('DISPATCHER');
    renderWithProviders(<RolesPage />);
    await pick(user, WIDE, 'Dispatcher');
    await user.click(await screen.findByRole('switch', { name: EDITED.label }));
    await waitFor(() => expect(saver.isDirty).toBe(true));
    const dialog = await openReset(user, /Reset to the Dispatcher preset/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(saver.isDirty).toBe(true);
    expect(stateOf(EDITED.label)).toBe(String(!presetSet('DISPATCHER')[EDITED.key]));
  });

  it('a refused reset keeps the unsaved edits', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'Nope.' } } });
    renderWithProviders(<RolesPage />);
    await pick(user, WIDE, 'Dispatcher');
    await user.click(await screen.findByRole('switch', { name: EDITED.label }));
    await waitFor(() => expect(saver.isDirty).toBe(true));
    const dialog = await openReset(user, /Reset to the Dispatcher preset/);
    await user.click(within(dialog).getByRole('button', { name: 'Reset to the Dispatcher preset' }));
    await within(dialog).findByRole('alert');
    expect(saver.isDirty).toBe(true);
  });
});

describe('Reset in a company with many roles', () => {
  it('is one control for the selected role, not one on each of the 120 rows', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    for (let i = 1; i <= 120; i++) addCustom(`Crew ${String(i).padStart(3, '0')}`);
    renderWithProviders(<RolesPage />);
    await pick(user, WIDE, 'Crew 087');
    const reset = await screen.findByRole('button', { name: 'Reset to default' });
    expect(screen.getAllByRole('button', { name: 'Reset to default' })).toHaveLength(1);
    expect(reset.closest('[data-roles-scroll]')).toBeNull();
    expect(reset.closest('[data-roles-column]')).toBeNull();
  });
});
