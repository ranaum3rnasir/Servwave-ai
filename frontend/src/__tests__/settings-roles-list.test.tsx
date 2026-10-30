/**
 * Roles & Permissions, PRD 2, S02.4 - the routed Settings > Roles page keeps its roles list small however many roles
 * a company has.
 *
 * Renders `pages/v2/settings/RolesPage`, the file `pages/v2/routes/settings.routes.tsx` mounts at /settings/roles,
 * with 120 custom roles beside the four built-in ones. The window width is answered through `matchMedia`, exactly as
 * a narrow or a wide window would, so only ONE list is ever mounted: a picker below xl, the side column from xl.
 * jsdom has no layout, so a scrolling column is asserted by its container, never by pixel heights.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import type { SettingsSaver } from '@/lib/settings/types';
import type { BuiltInRoleKey } from '@/lib/api/permissionSwitches';
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

// The server still answers with the Administrator entry; the page does not list it, because Admin is a flag on the person.
const ADMIN = { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1, type: 'system' };
const BUILT_IN = [
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 3, type: 'system' },
  { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 2, type: 'system' },
  { role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 5, type: 'system' },
];

/** `count` custom roles, handed over in REVERSE name order so a sorted list is the page's doing. */
function customRoles(count: number) {
  const names = Array.from({ length: count }, (_, i) => `Crew ${String(i + 1).padStart(3, '0')}`);
  return names.reverse().map((label, i) => ({
    id: `c${i}`, role: `crew_${label.slice(-3)}`, label, fullAccess: false, editable: true, userCount: i % 7, type: 'custom', base_role: 'TECHNICIAN',
  }));
}

let ROLES: Array<Record<string, unknown>> = [];

function serve(roles: Array<Record<string, unknown>>) {
  ROLES = roles;
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    const m = url.match(/^\/api\/roles\/([^/]+)\/permissions$/);
    if (m) {
      const entry = ROLES.find((r) => r.role === m[1])!;
      const custom = entry.type === 'custom';
      return Promise.resolve({
        data: {
          role: m[1], label: entry.label, type: entry.type, editable: entry.editable, base_role: custom ? 'TECHNICIAN' : m[1],
          made_from_role_key: null, made_from_blank: false, values: presetSet((custom ? 'TECHNICIAN' : m[1]) as BuiltInRoleKey), all_views_off: false,
        },
      });
    }
    return Promise.resolve({ data: [] });
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
  serve([ADMIN, ...BUILT_IN, ...customRoles(120)]);
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

/** A column button's role name: its first span, the count being the second. */
const nameOf = (button: HTMLElement) => button.querySelector('span')?.textContent ?? '';
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
const namesIn = (listbox: HTMLElement) => within(listbox).getAllByRole('option').map((o) => o.textContent ?? '');

/** The role names a list shows, in order, with the count taken off the end. */
const sortedCustom = () => customRoles(120).map((r) => r.label as string).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

describe('Roles list below xl: one picker', () => {
  it('is a single picker showing the selected role and its people count, with no list of role buttons', async () => {
    windowWidth(900);
    renderWithProviders(<RolesPage />);
    const picker = await screen.findByRole('combobox', { name: 'Role' });
    await waitFor(() => expect(picker).toHaveTextContent(`${BUILT_IN[0]!.label} · ${people(BUILT_IN[0]!.userCount)}`));
    // Not a wall of names: not one role has a button of its own, and the xl column's group is not mounted.
    expect(screen.queryByRole('group', { name: 'Roles' })).toBeNull();
    const roleButtons = screen.queryAllByRole('button').filter((b) => ROLES.some((r) => (b.textContent ?? '').startsWith(r.label as string)));
    expect(roleButtons).toHaveLength(0);
  });

  it('lists the three editable built-in roles first, then the custom roles by name, each with its count, and never the Administrator entry', async () => {
    windowWidth(900);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('combobox', { name: 'Role' }));
    const options = namesIn(await screen.findByRole('listbox', { name: 'Role' }));
    const expected = [
      ...BUILT_IN.map((r) => `${r.label} · ${people(r.userCount)}`),
      ...sortedCustom().map((label) => {
        const r = ROLES.find((x) => x.label === label)!;
        return `${label} · ${people(r.userCount as number)}`;
      }),
    ];
    expect(options).toEqual(expected);
    expect(options.join(' ')).not.toMatch(/Administrator/);
  });

  it('narrows to the roles whose name matches what is typed in the search box', async () => {
    windowWidth(900);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('combobox', { name: 'Role' }));
    await user.type(await screen.findByRole('searchbox', { name: 'Search options' }), 'crew 07');
    const listbox = await screen.findByRole('listbox', { name: 'Role' });
    // The role being edited stays at the top of the list whatever is typed (the design system's picker rule).
    await waitFor(() => expect(namesIn(listbox).map((n) => n.split(' · ')[0])).toEqual([
      BUILT_IN[0]!.label,
      ...sortedCustom().filter((n) => n.toLowerCase().includes('crew 07')),
    ]));
    // The count in a row is not part of what the search reads: "people" matches no role.
    await user.clear(screen.getByRole('searchbox', { name: 'Search options' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search options' }), 'people');
    await waitFor(() => expect(within(screen.getByRole('listbox', { name: 'Role' })).queryAllByRole('option').filter((o) => o.textContent?.includes('Crew'))).toHaveLength(0));
    expect(screen.getByText('No role matches.')).toBeInTheDocument();
  });

  it('loads the role picked from the picker and shows it as the selected one', async () => {
    windowWidth(900);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: /^Dispatcher/ }));
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/roles/DISPATCHER/permissions'));
    expect(await screen.findByRole('combobox', { name: 'Role' })).toHaveTextContent(`Dispatcher · ${people(2)}`);
    expect(await screen.findByRole('switch', { name: catalogSwitch('view_customers').label })).toBeInTheDocument();
  });

  it('works the same on a phone, where the picker opens as a full-screen sheet', async () => {
    windowWidth(390);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: /^Technician/ }));
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/roles/TECHNICIAN/permissions'));
  });

  it('asks before moving to another role while edits are unsaved, and stays on the role when the answer is no', async () => {
    windowWidth(900);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: /^Sales/ }));
    await user.click(await screen.findByRole('switch', { name: catalogSwitch('reopen_leads').label }));
    await waitFor(() => expect(saver.isDirty).toBe(true));
    // The settings shell publishes the page's dirty state to the guard; do the same here.
    useSettingsGuard.setState({ isDirty: true });

    await user.click(screen.getByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: /^Technician/ }));
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/roles/TECHNICIAN/permissions');
    useSettingsGuard.getState().cancelPending();
    expect(screen.getByRole('combobox', { name: 'Role' })).toHaveTextContent(/^Sales/);
    expect(saver.isDirty).toBe(true);
  });
});

describe('Roles list from xl: the side column', () => {
  it('lists the built-in roles first and the custom roles by name under their own headings, inside a scroll container', async () => {
    windowWidth(1400);
    renderWithProviders(<RolesPage />);
    const list = await screen.findByRole('group', { name: 'Roles' });
    // One picker is the narrow layout; the wide one has none.
    expect(screen.queryByRole('combobox', { name: 'Role' })).toBeNull();
    // The column scrolls by itself, so neither the page nor the editor grows with the number of roles.
    const scroller = list.closest('[data-roles-scroll]')!;
    expect(scroller).not.toBeNull();
    expect(scroller).toHaveClass('overflow-y-auto');

    const builtIn = await within(list).findByRole('group', { name: 'Built-in roles' });
    const custom = within(list).getByRole('group', { name: 'Custom roles' });
    expect(within(builtIn).getAllByRole('button').map(nameOf)).toEqual(BUILT_IN.map((r) => r.label));
    expect(within(custom).getAllByRole('button').map(nameOf)).toEqual(sortedCustom());
    // Each role shows the number of people on it.
    expect(within(within(builtIn).getByRole('button', { name: /^Sales/ })).getByText('3')).toBeInTheDocument();
    // Built-in group comes before the custom group in the page.
    expect(builtIn.compareDocumentPosition(custom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has a search box above the list once the company has more than eight roles, and it narrows the list', async () => {
    windowWidth(1400);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    const search = await screen.findByRole('searchbox', { name: 'Search roles' });
    const list = screen.getByRole('group', { name: 'Roles' });
    expect(search.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.type(search, 'crew 07');
    await waitFor(() =>
      expect(within(list).getAllByRole('button').map(nameOf)).toEqual(sortedCustom().filter((n) => n.toLowerCase().includes('crew 07'))),
    );
    // A heading goes with its last row.
    expect(within(list).queryByRole('group', { name: 'Built-in roles' })).toBeNull();

    await user.clear(search);
    await user.type(search, 'zzz');
    expect(await screen.findByText('No role matches.')).toBeInTheDocument();
  });

  it('has no search box for a company with eight roles or fewer', async () => {
    windowWidth(1400);
    serve([ADMIN, ...BUILT_IN, ...customRoles(4)]);
    renderWithProviders(<RolesPage />);
    await screen.findByRole('group', { name: 'Roles' });
    expect(screen.queryByRole('searchbox', { name: 'Search roles' })).toBeNull();
  });

  it('loads the role picked in the column', async () => {
    windowWidth(1400);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('button', { name: /^Dispatcher/ }));
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/roles/DISPATCHER/permissions'));
    expect(await screen.findByRole('switch', { name: catalogSwitch('view_customers').label })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Dispatcher/ })).toHaveAttribute('aria-current', 'true');
  });

  it('asks before moving to another role while edits are unsaved, and stays on the role when the answer is no', async () => {
    windowWidth(1400);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('button', { name: /^Sales/ }));
    await user.click(await screen.findByRole('switch', { name: catalogSwitch('reopen_leads').label }));
    await waitFor(() => expect(saver.isDirty).toBe(true));
    useSettingsGuard.setState({ isDirty: true });

    await user.click(screen.getByRole('button', { name: /^Technician/ }));
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/roles/TECHNICIAN/permissions');
    useSettingsGuard.getState().cancelPending();
    expect(screen.getByRole('button', { name: /^Sales/ })).toHaveAttribute('aria-current', 'true');
  });

  it('keeps the selected role in view: scrolled to when it loads, when it changes and when a search is cleared', async () => {
    windowWidth(1400);
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? '');
    };
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await user.click(await screen.findByRole('button', { name: /^Technician/ }));
    await waitFor(() => expect(scrolled.at(-1)).toMatch(/^Technician/));

    const search = screen.getByRole('searchbox', { name: 'Search roles' });
    await user.type(search, 'crew 07');
    scrolled.length = 0;
    await user.clear(search);
    await waitFor(() => expect(scrolled.at(-1)).toMatch(/^Technician/));
  });
});
