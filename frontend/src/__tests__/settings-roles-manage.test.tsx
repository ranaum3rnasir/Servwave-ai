/**
 * Roles & Permissions, PRD 2, S02.7 - Built-in roles permanent; rename and archive custom roles.
 *
 * Renders `pages/v2/settings/RolesPage`, the file `pages/v2/routes/settings.routes.tsx` mounts at /settings/roles,
 * against the real answer shapes of the Roles API (the list, a role's switch read, the rename answer and the plain
 * refusals of rename and archive). The window width is answered through `matchMedia`, so only the list for that width is
 * mounted: rename and archive must be reachable from the selected role at every width.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import type { SettingsSaver } from '@/lib/settings/types';
import type { BuiltInRoleKey, RoleSwitchSet } from '@/lib/api/permissionSwitches';
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

type Entry = Record<string, unknown> & { role: string; label: string; type: string; description?: string };

/** What the server holds: the list entries, and each role's switch read. */
let ROLES: Entry[] = [];
let SETS: Record<string, RoleSwitchSet> = {};

function addCustom(label: string, description = '', baseRole: BuiltInRoleKey = 'TECHNICIAN') {
  const role = label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  ROLES.push({ id: `id_${role}`, role, label, description, fullAccess: false, editable: true, userCount: 0, type: 'custom', base_role: baseRole });
  SETS[role] = {
    role, label, type: 'custom', editable: true, base_role: baseRole, made_from_role_key: baseRole, made_from_blank: false,
    values: presetSet(baseRole), all_views_off: false,
  };
  return role;
}

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
    if (m) return Promise.resolve({ data: SETS[m[1]!] });
    return Promise.resolve({ data: [] });
  });
}

/** The server's rename: the label (and description) change on the list and on the role's own read. */
function serveRename() {
  mockApi.patch.mockImplementation((url: string, body: { label?: string; description?: string }) => {
    const role = url.replace('/api/roles/', '');
    const entry = ROLES.find((r) => r.role === role)!;
    if (body.label !== undefined) entry.label = body.label;
    if (body.description !== undefined) entry.description = body.description;
    if (body.label !== undefined) SETS[role]!.label = body.label;
    return Promise.resolve({ data: { ...entry } });
  });
}

/** The server's archive of a role nobody is on: it leaves the list. */
function serveArchive() {
  mockApi.post.mockImplementation((url: string) => {
    const role = url.replace('/api/roles/', '').replace('/archive', '');
    ROLES = ROLES.filter((r) => r.role !== role);
    return Promise.resolve({ data: { ok: true } });
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

const originalScrollIntoView = Element.prototype.scrollIntoView;
beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  serve();
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

const WIDE = 1400;
const NARROW = 700;

/** Pick a role by its name at either width: a row in the side column, or an option of the picker. */
async function pick(user: ReturnType<typeof userEvent.setup>, width: number, name: string) {
  if (width === WIDE) {
    await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
  } else {
    await user.click(await screen.findByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: new RegExp(name) }));
  }
  await screen.findByRole('heading', { name });
}

const rolesNamed = (width: number) =>
  width === WIDE
    ? within(screen.getByRole('group', { name: 'Roles' })).queryAllByRole('button').map((b) => b.textContent ?? '')
    : [];

describe.each([['a wide window', WIDE], ['a narrow window', NARROW]] as const)('Built-in roles on %s', (_name, width) => {
  it.each(BUILT_IN.map((r) => r.label))('%s has no rename or archive action', async (label) => {
    windowWidth(width);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    if (label !== BUILT_IN[0]!.label) await pick(user, width, label);
    await screen.findByRole('heading', { name: label });
    expect(screen.queryByRole('button', { name: /^(rename|archive)$/i })).toBeNull();
  });

  it.each(['Sales', 'Dispatcher', 'Technician'])('keeps the switches of %s editable and saveable', async (label) => {
    windowWidth(width);
    const user = userEvent.setup();
    mockApi.put.mockImplementation(((_url: string, body: { values: Record<string, unknown> }) => Promise.resolve({ data: { ...SETS[label.toUpperCase()]!, values: { ...SETS[label.toUpperCase()]!.values, ...body.values } } })) as never);
    renderWithProviders(<RolesPage />);
    await pick(user, width, label);
    const entry = catalogSwitch('create_customers');
    const toggle = await screen.findByRole('switch', { name: entry.label });
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    await saver.save();
    expect(mockApi.put).toHaveBeenCalledWith(`/api/roles/${label.toUpperCase()}/permissions`, { values: { create_customers: !presetSet(label.toUpperCase() as BuiltInRoleKey).create_customers } });
  });

  it('shows Administrator as the one Full access box', async () => {
    windowWidth(width);
    renderWithProviders(<RolesPage />);
    expect(await screen.findByText('Full access')).toBeInTheDocument();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
  });
});

describe.each([['a wide window', WIDE], ['a narrow window', NARROW]] as const)('Rename and archive of a custom role on %s', (_name, width) => {
  it('are offered for the selected custom role, outside the list of roles', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    addCustom('Night desk');
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    const rename = await screen.findByRole('button', { name: 'Rename' });
    const archive = screen.getByRole('button', { name: 'Archive' });
    for (const control of [rename, archive]) {
      expect(control.closest('[data-roles-scroll]')).toBeNull();
      expect(control.closest('[data-roles-column]')).toBeNull();
    }
    // One pair for the selected role, never one per role.
    expect(screen.getAllByRole('button', { name: 'Rename' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Archive' })).toHaveLength(1);
  });

  it('follow the role picked, and go when a built-in role is picked', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    addCustom('Night desk');
    addCustom('Day desk');
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    await screen.findByRole('button', { name: 'Rename' });
    await pick(user, width, 'Day desk');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByLabelText('Name')).toHaveValue('Day desk');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await pick(user, width, 'Dispatcher');
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('rename: the dialog starts with the role\'s name and description, and saving shows the new name everywhere', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    addCustom('Night desk', 'Answers calls after six');
    serveRename();
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    expect(await screen.findByText('Answers calls after six')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename role' });
    const name = within(dialog).getByLabelText('Name');
    expect(name).toHaveValue('Night desk');
    expect(within(dialog).getByLabelText('Description')).toHaveValue('Answers calls after six');
    await user.clear(name);
    await user.type(name, 'Late desk');
    await user.clear(within(dialog).getByLabelText('Description'));
    await user.type(within(dialog).getByLabelText('Description'), 'Covers evenings');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/roles/night_desk', { label: 'Late desk', description: 'Covers evenings' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Late desk' })).toBeInTheDocument();
    expect(screen.getByText('Covers evenings')).toBeInTheDocument();
    if (width === WIDE) expect(rolesNamed(width).some((t) => t.startsWith('Late desk'))).toBe(true);
    else expect(screen.getByRole('combobox', { name: 'Role' })).toHaveTextContent('Late desk');
    expect(screen.queryByText('Night desk')).toBeNull();
  });

  it('rename: keeps Save off until the name has a letter, and until something changed', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    addCustom('Night desk');
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename role' });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('Name'));
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Name'), 'Late desk');
    expect(save).toBeEnabled();
  });

  it.each([
    [400, '"Technician" is the name of a built-in role. Choose another name.'],
    [409, 'A role named "Day desk" already exists. Choose another name.'],
  ])('rename: shows the server\'s plain reason for a %i, keeps the dialog open and the old name', async (status, reason) => {
    windowWidth(width);
    const user = userEvent.setup();
    addCustom('Night desk');
    mockApi.patch.mockRejectedValue({ response: { status, data: { error: reason } } });
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename role' });
    await user.clear(within(dialog).getByLabelText('Name'));
    await user.type(within(dialog).getByLabelText('Name'), 'Day desk');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(reason);
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Day desk');
    // The server's answer is the only place the reason is shown: no second message from a toast.
    expect(screen.getAllByText(reason)).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'Night desk' })).toBeInTheDocument();
  });

  it('rename: clears the last refusal when the dialog is opened again', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    addCustom('Night desk');
    mockApi.patch.mockRejectedValue({ response: { status: 409, data: { error: 'A role named "Day desk" already exists. Choose another name.' } } });
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    await user.click(await screen.findByRole('button', { name: 'Rename' }));
    let dialog = await screen.findByRole('dialog', { name: 'Rename role' });
    await user.type(within(dialog).getByLabelText('Name'), ' 2');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByRole('alert');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    dialog = await screen.findByRole('dialog', { name: 'Rename role' });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Night desk');
  });

  it('archive: the confirm names the role; confirming removes it from the list and the picker and moves to another role', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    addCustom('Night desk');
    serveArchive();
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog', { name: /Archive Night desk\?/ });
    expect(mockApi.post).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Archive role' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/roles/night_desk/archive'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Night desk' })).toBeNull();
    // The page falls back to the first role instead of an empty detail.
    expect(await screen.findByText('Full access')).toBeInTheDocument();
    if (width === WIDE) {
      expect(rolesNamed(width).some((t) => t.startsWith('Night desk'))).toBe(false);
    } else {
      await user.click(screen.getByRole('combobox', { name: 'Role' }));
      const options = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
      expect(options.some((t) => t.startsWith('Night desk'))).toBe(false);
      expect(options.length).toBe(BUILT_IN.length);
    }
  });

  it('archive: stops reading the archived role, so the server never has to refuse a read of it', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    addCustom('Night desk');
    serveArchive();
    // The server forgets the role's set once it is archived, and answers a read of it with the 404 the console showed.
    const archivedReads: string[] = [];
    const served = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation((url: string, ...rest: unknown[]) => {
      if (url === '/api/roles/night_desk/permissions' && !ROLES.some((r) => r.role === 'night_desk')) {
        archivedReads.push(url);
        return Promise.reject({ response: { status: 404, data: { error: 'Unknown role' } } });
      }
      return (served as (u: string, ...r: unknown[]) => Promise<unknown>)(url, ...rest) as never;
    });
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog', { name: /Archive Night desk\?/ });
    await user.click(within(dialog).getByRole('button', { name: 'Archive role' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Full access')).toBeInTheDocument();
    expect(archivedReads).toEqual([]);
  });

  it('archive: shows the server\'s plain refusal when people are on the role, and the role stays', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    const reason = 'Cannot archive: 2 people are still on this role. Move them to another role first.';
    addCustom('Night desk');
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: reason } } });
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('dialog', { name: /Archive Night desk\?/ });
    await user.click(within(dialog).getByRole('button', { name: 'Archive role' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(reason);
    expect(screen.getAllByText(reason)).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Night desk' })).toBeInTheDocument();
    if (width === WIDE) expect(rolesNamed(width).some((t) => t.startsWith('Night desk'))).toBe(true);
  });

  it('archive: asks again with no leftover refusal when the dialog is opened again', async () => {
    windowWidth(width);
    const user = userEvent.setup();
    addCustom('Night desk');
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'Cannot archive: 1 person is still on this role. Move them to another role first.' } } });
    renderWithProviders(<RolesPage />);
    await pick(user, width, 'Night desk');
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    let dialog = await screen.findByRole('dialog', { name: /Archive Night desk\?/ });
    await user.click(within(dialog).getByRole('button', { name: 'Archive role' }));
    await within(dialog).findByRole('alert');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    dialog = await screen.findByRole('dialog', { name: /Archive Night desk\?/ });
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });
});

describe('Rename and archive in a company with many roles', () => {
  const CREW = Array.from({ length: 120 }, (_, i) => `Crew ${String(i + 1).padStart(3, '0')}`);
  beforeEach(() => {
    for (const label of CREW) addCustom(label);
  });

  it('are one pair for the selected role, not a control on each of the 120 rows', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await pick(user, WIDE, 'Crew 087');
    expect(screen.getAllByRole('button', { name: 'Rename' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Archive' })).toHaveLength(1);
    expect(within(screen.getByRole('group', { name: 'Roles' })).queryByRole('button', { name: /Rename|Archive/ })).toBeNull();
  });
});
