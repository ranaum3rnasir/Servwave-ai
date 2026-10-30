/**
 * Roles & Permissions, PRD 2, story 42 - the routed Settings > Roles page shows how many people are BASED ON each role.
 *
 * Renders `pages/v2/settings/RolesPage`, the file `pages/v2/routes/settings.routes.tsx` mounts at /settings/roles, with the
 * answer of GET /api/roles for a company where a custom role is based on Admin: the Administrator role counts only the
 * people in the Admin box, the custom role counts its own people, and nobody is shown under both. The page shows the
 * numbers it is given, in the side column from xl and in the picker below it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import type { BuiltInRoleKey } from '@/lib/api/permissionSwitches';
import { FIXTURE_CATALOG, presetSet } from './support/permissionCatalogFixture';

const mockApi = vi.mocked(api);

vi.mock('@/pages/v2/settings/settingsBar', () => ({
  useSettingsBar: () => ({ registerSaver: () => undefined }),
}));

// Ten people in the company: two in the Admin box, one on a copy of Admin, three on a copy of Dispatcher, and the rest on built-in roles.
const ROLES = [
  { role: 'ADMIN', label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 2, type: 'system' },
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 1, type: 'system' },
  { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 1, type: 'system' },
  { role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 2, type: 'system' },
  { id: 'c1', role: 'admin_copy', label: 'Admin copy', fullAccess: false, editable: true, userCount: 1, type: 'custom', base_role: 'ADMIN' },
  { id: 'c2', role: 'office_team', label: 'Office team', fullAccess: false, editable: true, userCount: 3, type: 'custom', base_role: 'DISPATCHER' },
];

const originalMatchMedia = window.matchMedia;
function windowWidth(px: number) {
  window.matchMedia = vi.fn((query: string) => {
    const widths = [...query.replace(/\s+/g, '').matchAll(/\((max|min)-width:([\d.]+)px\)/g)];
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
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    const m = url.match(/^\/api\/roles\/([^/]+)\/permissions$/);
    if (m) {
      const entry = ROLES.find((r) => r.role === m[1])!;
      const base = (entry.type === 'custom' ? entry.base_role : m[1]) as BuiltInRoleKey;
      return Promise.resolve({
        data: {
          role: m[1], label: entry.label, type: entry.type, editable: entry.editable, base_role: base,
          made_from_role_key: null, made_from_blank: false, values: presetSet(base), all_views_off: false,
        },
      });
    }
    return Promise.resolve({ data: [] });
  });
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

const countOf = (button: HTMLElement) => button.querySelectorAll('span')[1]?.textContent;

describe('the Roles page people counts', () => {
  it('shows each role in the side column with the number of people based on it', async () => {
    windowWidth(1600);
    renderWithProviders(<RolesPage />);
    // The Administrator entry is not a role on this page: Admin is a flag on the person.
    expect(await screen.findByRole('button', { name: /^Admin copy/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Administrator/ })).toBeNull();
    expect(countOf(screen.getByRole('button', { name: /^Admin copy/ }))).toBe('1');
    expect(countOf(screen.getByRole('button', { name: /^Office team/ }))).toBe('3');
    expect(countOf(screen.getByRole('button', { name: /^Dispatcher/ }))).toBe('1');
  });

  it('shows the same numbers in the picker below xl', async () => {
    windowWidth(900);
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    const picker = await screen.findByRole('combobox', { name: 'Role' });
    await waitFor(() => expect(picker).toHaveTextContent('Sales · 1 person'));
    await user.click(picker);
    const options = within(await screen.findByRole('listbox', { name: 'Role' })).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Admin copy · 1 person');
    expect(options).toContain('Office team · 3 people');
    expect(options).toContain('Dispatcher · 1 person');
  });
});
