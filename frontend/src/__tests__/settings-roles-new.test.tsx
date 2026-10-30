/**
 * Roles & Permissions, PRD 2, S02.6 - New role from any role or from blank, with the all-View-off warning.
 *
 * Renders `pages/v2/settings/RolesPage`, the file `pages/v2/routes/settings.routes.tsx` mounts at /settings/roles,
 * against the real answer shapes of the Roles API (the list, a role's switch read and the create answer). The window
 * width is answered through `matchMedia`, so only the list for that width is mounted. Switch values are read from the
 * catalog fixture's presets, never written here.
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
import { FIXTURE_CATALOG, FIXTURE_SWITCHES, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

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

/** What the server holds: the list entries, and each role's switch read. */
let ROLES: Entry[] = [];
let SETS: Record<string, RoleSwitchSet> = {};

const allOff = (): SwitchSet => Object.fromEntries(FIXTURE_SWITCHES.map((s) => [s.key, s.kind === 'toggle' ? false : s.kind === 'list' ? [] : s.choices![0]!]));
const viewKeys = () => FIXTURE_SWITCHES.filter((s) => s.key.startsWith('view_')).map((s) => s.key);

function addCustom(label: string, extra: Partial<RoleSwitchSet> & { values?: SwitchSet } = {}, baseRole: BuiltInRoleKey = 'TECHNICIAN') {
  const role = label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  ROLES.push({ id: `id_${role}`, role, label, fullAccess: false, editable: true, userCount: 0, type: 'custom', base_role: baseRole });
  SETS[role] = {
    role, label, type: 'custom', editable: true, base_role: baseRole, made_from_role_key: baseRole, made_from_blank: false,
    values: presetSet(baseRole), all_views_off: false, ...extra,
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

/** The server's create answer, which also puts the new role on the list and gives it its switch read. */
function serveCreate(created: { label: string; from?: string; blank?: boolean }) {
  mockApi.post.mockImplementation((url: string) => {
    if (url !== '/api/roles') return Promise.reject(new Error(`unexpected POST ${url}`));
    const source = created.from ? SETS[created.from]! : undefined;
    const role = addCustom(created.label, {
      made_from_role_key: created.blank ? null : created.from ?? null,
      made_from_blank: !!created.blank || !!source?.made_from_blank,
      values: created.blank ? allOff() : { ...source!.values },
      base_role: source?.base_role ?? 'TECHNICIAN',
    }, (source?.base_role ?? 'TECHNICIAN') as BuiltInRoleKey);
    const entry = ROLES.find((r) => r.role === role)!;
    return Promise.resolve({ data: { ...entry, made_from_role_key: SETS[role]!.made_from_role_key, made_from_blank: SETS[role]!.made_from_blank, all_views_off: created.blank ?? false } });
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

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New role' }));
  return screen.findByRole('dialog', { name: 'New role' });
}

/** Choose the starting point by its name from the searchable picker, then name the role and create it. */
async function createFrom(user: ReturnType<typeof userEvent.setup>, start: string, name: string) {
  const dialog = await openDialog(user);
  await user.type(within(dialog).getByLabelText('Name'), name);
  await user.click(within(dialog).getByRole('combobox', { name: 'Starting point' }));
  await user.click(await screen.findByRole('option', { name: start }));
  await user.click(within(dialog).getByRole('button', { name: 'Create role' }));
}

const switchState = (label: string) => screen.getByRole('switch', { name: label }).getAttribute('aria-checked') === 'true';

describe('New role control', () => {
  it('sits above the role list at a wide window, outside the part of the list that scrolls', async () => {
    windowWidth(WIDE);
    renderWithProviders(<RolesPage />);
    const button = await screen.findByRole('button', { name: 'New role' });
    expect(button.closest('[data-roles-scroll]')).toBeNull();
    expect(button.closest('[data-roles-column]')).not.toBeNull();
  });

  it('is beside the picker at a narrow window', async () => {
    windowWidth(NARROW);
    renderWithProviders(<RolesPage />);
    const picker = await screen.findByRole('combobox', { name: 'Role' });
    const button = screen.getByRole('button', { name: 'New role' });
    expect(button.parentElement!.contains(picker)).toBe(true);
  });

  it('does not offer the old coming-soon text', async () => {
    windowWidth(WIDE);
    renderWithProviders(<RolesPage />);
    await screen.findByRole('button', { name: 'New role' });
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });
});

describe('New role dialog', () => {
  it('creates a role from a built-in role and opens it selected with that role\'s values', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    serveCreate({ label: 'Second dispatcher', from: 'DISPATCHER' });
    renderWithProviders(<RolesPage />);
    await createFrom(user, 'Dispatcher', 'Second dispatcher');

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/roles', { label: 'Second dispatcher', clone_grants_from: 'DISPATCHER' }));
    const created = await screen.findByRole('button', { name: /Second dispatcher/ });
    await waitFor(() => expect(created).toHaveAttribute('aria-current', 'true'));
    expect(screen.queryByRole('dialog')).toBeNull();
    // The editor shows the new role's values, which are the Dispatcher preset.
    const preset = presetSet('DISPATCHER');
    for (const key of ['view_customers', 'create_customers', 'edit_stock'] as const) {
      expect(await screen.findByRole('switch', { name: catalogSwitch(key).label })).toHaveAttribute('aria-checked', String(preset[key] === true));
    }
  });

  it('creates a role from a custom role', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    addCustom('Office manager', { values: { ...presetSet('SALES'), create_customers: true } }, 'SALES');
    serveCreate({ label: 'Office lead', from: 'office_manager' });
    renderWithProviders(<RolesPage />);
    await createFrom(user, 'Office manager', 'Office lead');

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/roles', { label: 'Office lead', clone_grants_from: 'office_manager' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Office lead/ })).toHaveAttribute('aria-current', 'true'));
    await waitFor(() => expect(switchState(catalogSwitch('create_customers').label)).toBe(true));
  });

  it('creates a role from blank with every switch off', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    serveCreate({ label: 'Front desk', blank: true });
    renderWithProviders(<RolesPage />);
    await createFrom(user, 'Blank (everything off)', 'Front desk');

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/roles', { label: 'Front desk', blank: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Front desk/ })).toHaveAttribute('aria-current', 'true'));
    const switches = await screen.findAllByRole('switch');
    await waitFor(() => expect(screen.getAllByRole('switch').filter((s) => s.getAttribute('aria-checked') === 'true')).toHaveLength(0));
    expect(switches.length).toBeGreaterThan(10);
  });

  it('keeps Create role off until a name and a starting point are chosen', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    const dialog = await openDialog(user);
    const create = within(dialog).getByRole('button', { name: 'Create role' });
    expect(create).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Name'), 'Front desk');
    expect(create).toBeDisabled();
    await user.click(within(dialog).getByRole('combobox', { name: 'Starting point' }));
    await user.click(await screen.findByRole('option', { name: 'Sales' }));
    expect(create).toBeEnabled();
  });

  it('shows the server\'s plain reason when the name collides, and keeps the dialog open', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    const reason = '"Sales" collides with a system role name';
    mockApi.post.mockRejectedValue({ response: { status: 400, data: { error: reason } } });
    renderWithProviders(<RolesPage />);
    await createFrom(user, 'Technician', 'Sales');

    const dialog = await screen.findByRole('dialog', { name: 'New role' });
    expect(await within(dialog).findByText(reason)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Sales');
  });

  it('shows the server\'s reason for a name another role already has', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    const reason = 'A role with this name already exists';
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: reason } } });
    renderWithProviders(<RolesPage />);
    await createFrom(user, 'Technician', 'Night shift');
    expect(await within(await screen.findByRole('dialog', { name: 'New role' })).findByText(reason)).toBeInTheDocument();
  });

  it('clears the last refusal when the dialog is opened again', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'A role with this name already exists' } } });
    renderWithProviders(<RolesPage />);
    await createFrom(user, 'Technician', 'Night shift');
    const dialog = await screen.findByRole('dialog', { name: 'New role' });
    await within(dialog).findByText('A role with this name already exists');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await openDialog(user);
    expect(screen.queryByText('A role with this name already exists')).toBeNull();
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });
});

describe('A company with 120 roles', () => {
  const CREW = Array.from({ length: 120 }, (_, i) => `Crew ${String(i + 1).padStart(3, '0')}`);
  beforeEach(() => {
    // Handed over in reverse, so the order the picker shows is the page's doing.
    for (const label of [...CREW].reverse()) addCustom(label);
  });

  it('offers the blank start and every role in the same order as the role list, and finds one by typing', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    serveCreate({ label: 'Crew copy', from: 'crew_087' });
    renderWithProviders(<RolesPage />);
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('combobox', { name: 'Starting point' }));

    const listbox = await screen.findByRole('listbox');
    const names = within(listbox).getAllByRole('option').map((o) => o.textContent ?? '');
    expect(names).toEqual(['Blank (everything off)', ...BUILT_IN.map((r) => r.label), ...CREW]);

    await user.type(screen.getByPlaceholderText('Search starting points'), 'crew 087');
    const option = await screen.findByRole('option', { name: 'Crew 087' });
    expect(screen.getAllByRole('option').length).toBeLessThan(5);
    await user.click(option);
    await user.type(within(dialog).getByLabelText('Name'), 'Crew copy');
    await user.click(within(dialog).getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/roles', { label: 'Crew copy', clone_grants_from: 'crew_087' }));
  });

  it('scrolls the new role into view in the column once it is created', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this.textContent ?? '');
    });
    serveCreate({ label: 'Crew zzz', from: 'DISPATCHER' });
    renderWithProviders(<RolesPage />);
    await screen.findByRole('button', { name: /Crew 001/ });
    scrolled.length = 0;
    await createFrom(user, 'Dispatcher', 'Crew zzz');

    await waitFor(() => expect(scrolled.some((t) => t.startsWith('Crew zzz'))).toBe(true));
    expect(screen.getByRole('button', { name: /Crew zzz/ })).toHaveAttribute('aria-current', 'true');
  });

  it('shows the new role even when a search in the column would have hidden it', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    serveCreate({ label: 'Roofing', from: 'DISPATCHER' });
    renderWithProviders(<RolesPage />);
    await user.type(await screen.findByRole('searchbox', { name: 'Search roles' }), 'crew 05');
    await createFrom(user, 'Dispatcher', 'Roofing');
    expect(await screen.findByRole('button', { name: /Roofing/ })).toHaveAttribute('aria-current', 'true');
  });

  it('selects the new role in the picker at a narrow window', async () => {
    windowWidth(NARROW);
    const user = userEvent.setup();
    serveCreate({ label: 'Crew copy', from: 'SALES' });
    renderWithProviders(<RolesPage />);
    await createFrom(user, 'Sales', 'Crew copy');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Role' })).toHaveTextContent('Crew copy'));
  });
});

describe('The all-View-off warning', () => {
  const WARNING = /can.t open any records/i;

  it('shows on a role with View off on every module, which can still be saved', async () => {
    windowWidth(WIDE);
    const values = { ...allOff(), manage_payout_account: true };
    const role = addCustom('Settings only', { values, made_from_blank: true, made_from_role_key: null, all_views_off: true });
    mockApi.put.mockImplementation(((_url: string, body: { values: SwitchSet }) => Promise.resolve({ data: { ...SETS[role]!, values: { ...values, ...body.values } } })) as never);
    renderWithProviders(<RolesPage />);
    await user_pick(/Settings only/);

    const banner = await screen.findByText(WARNING);
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/dashboard/i);
    expect(banner.textContent).toMatch(/Access/);

    // Still savable: turn one non-View switch on and save.
    await userEvent.click(screen.getByRole('switch', { name: catalogSwitch('access_schedule').label }));
    await saver.save();
    expect(mockApi.put).toHaveBeenCalledWith(`/api/roles/${role}/permissions`, { values: { access_schedule: true } });
  });

  it('is not shown on a role with a View on', async () => {
    windowWidth(WIDE);
    renderWithProviders(<RolesPage />);
    await user_pick(/Sales/);
    await screen.findByRole('switch', { name: catalogSwitch('view_customers').label });
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('appears as soon as the last View is turned off, and goes when one is turned on again', async () => {
    windowWidth(WIDE);
    const user = userEvent.setup();
    const onlyOne = Object.fromEntries(viewKeys().map((k) => [k, k === 'view_stock']));
    addCustom('One view', { values: { ...allOff(), ...onlyOne } });
    renderWithProviders(<RolesPage />);
    await user_pick(/One view/);
    const stock = await screen.findByRole('switch', { name: catalogSwitch('view_stock').label });
    expect(screen.queryByText(WARNING)).toBeNull();

    await user.click(stock);
    expect(await screen.findByText(WARNING)).toBeInTheDocument();
    await user.click(stock);
    await waitFor(() => expect(screen.queryByText(WARNING)).toBeNull());
  });
});

describe('A custom role\'s header names the role it was made from', () => {
  it('names a built-in source role', async () => {
    windowWidth(WIDE);
    addCustom('Second dispatcher', { made_from_role_key: 'DISPATCHER' }, 'DISPATCHER');
    renderWithProviders(<RolesPage />);
    await user_pick(/Second dispatcher/);
    expect(await screen.findByText('Made from Dispatcher')).toBeInTheDocument();
  });

  it('names the built-in Administrator when that is what the role was copied from', async () => {
    windowWidth(WIDE);
    addCustom('Everything but billing', { made_from_role_key: 'ADMIN' }, 'SALES');
    renderWithProviders(<RolesPage />);
    await user_pick(/Everything but billing/);
    expect(await screen.findByText('Made from Administrator (Owner)')).toBeInTheDocument();
  });

  it('names a custom source role', async () => {
    windowWidth(WIDE);
    const source = addCustom('Office manager', {}, 'SALES');
    addCustom('Office lead', { made_from_role_key: source }, 'SALES');
    renderWithProviders(<RolesPage />);
    await user_pick(/Office lead/);
    expect(await screen.findByText('Made from Office manager')).toBeInTheDocument();
  });

  it('says a role made from blank started empty', async () => {
    windowWidth(WIDE);
    addCustom('Front desk', { made_from_blank: true, made_from_role_key: null, values: allOff() });
    renderWithProviders(<RolesPage />);
    await user_pick(/Front desk/);
    expect(await screen.findByText('Made from a blank start')).toBeInTheDocument();
  });

  it('says nothing for a built-in role', async () => {
    windowWidth(WIDE);
    renderWithProviders(<RolesPage />);
    await user_pick(/Dispatcher/);
    await screen.findByRole('switch', { name: catalogSwitch('view_customers').label });
    expect(screen.queryByText(/^Made from/)).toBeNull();
  });
});

async function user_pick(name: RegExp) {
  await userEvent.click(await screen.findByRole('button', { name }));
}
