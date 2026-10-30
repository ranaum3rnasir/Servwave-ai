/**
 * Roles & Permissions P1/A1 - the per-person settings (who a person can be put on a record as, the stock view, ...) are
 * edited on the person's profile, not on the Permissions pages.
 *
 * Two halves: the switch editor on a person's Permissions page draws none of them, and the profile section draws them from
 * the catalog's `settings` list, saves one at once as that person's own value, and is read-only when the set is not editable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';
import { PersonSettingsSection } from '@/pages/v2/settings/components/personSettingsSection';
import { renderWithProviders } from './helpers';
import { FIXTURE_CATALOG, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);
const SETTINGS = ['can_own_leads', 'can_be_dispatcher', 'can_be_on_crew', 'inventory_view'];
const ROLE = presetSet('DISPATCHER');
const DISPATCHER = { key: 'DISPATCHER', label: 'Dispatcher', type: 'built_in' };

const personSet = (over: Record<string, unknown> = {}) => ({
  user_id: 'u1', admin_box: false, editable: true, based_on: DISPATCHER, values: ROLE, differences: [], difference_count: 0, ...over,
});

function serve(person: ReturnType<typeof personSet>) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: false, values: { manage_roles_and_permissions: true, view_users: true }, rules: [] } });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    if (url === '/api/users') return Promise.resolve({ data: { users: [] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/users/u1/permissions') return Promise.resolve({ data: person });
    return Promise.resolve({ data: [] });
  });
  mockApi.put.mockImplementation((_url: string, body: unknown) =>
    Promise.resolve({ data: { ...person, values: { ...person.values, ...(body as { values: object }).values } } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the Permissions page', () => {
  it('draws none of the per-person settings among its switches', async () => {
    serve(personSet());
    renderWithProviders(
      <Suspense fallback={null}>
        <Routes>
          {settingsV2Routes()}
          <Route path="*" element={<p>Dashboard</p>} />
        </Routes>
      </Suspense>,
      {
        initialEntries: ['/settings/users/u1/permissions'],
        ability: buildAbility([{ action: 'manage_roles', subject: 'Role' }, { action: 'read', subject: 'Role' }, { action: 'read', subject: 'User' }]),
      },
    );

    await screen.findByRole('switch', { name: catalogSwitch('view_customers').label });
    for (const key of SETTINGS) {
      expect(screen.queryByText(catalogSwitch(key).label), key).toBeNull();
    }
  });
});

describe('the person settings on the profile', () => {
  it('draws each setting from the catalog list, at the person\'s value', async () => {
    serve(personSet());
    renderWithProviders(<PersonSettingsSection userId="u1" />);

    const owns = await screen.findByRole('switch', { name: catalogSwitch('can_own_leads').label });
    expect(owns).toHaveAttribute('aria-checked', String(ROLE.can_own_leads === true));
    expect(screen.getByRole('radiogroup', { name: catalogSwitch('inventory_view').label })).toBeInTheDocument();
    // A key that is not on the catalog's settings list is not drawn here.
    expect(screen.queryByText(catalogSwitch('view_customers').label)).toBeNull();
  });

  it('saves one change at once as that person\'s own value', async () => {
    serve(personSet());
    renderWithProviders(<PersonSettingsSection userId="u1" />);

    const crew = await screen.findByRole('switch', { name: catalogSwitch('can_be_on_crew').label });
    await userEvent.click(crew);

    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(1));
    expect(mockApi.put).toHaveBeenCalledWith('/api/users/u1/permissions', { values: { can_be_on_crew: !ROLE.can_be_on_crew } });
  });

  it('saves a stock-view choice by its value', async () => {
    serve(personSet());
    renderWithProviders(<PersonSettingsSection userId="u1" />);

    const group = await screen.findByRole('radiogroup', { name: catalogSwitch('inventory_view').label });
    await userEvent.click(group.querySelector(`button[role="radio"][aria-checked="false"]`) as HTMLElement);

    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(1));
    expect(mockApi.put.mock.calls[0]![1]).toEqual({ values: { inventory_view: ROLE.inventory_view === 'field' ? 'counter' : 'field' } });
  });

  it('is read-only when the set is not editable (one\'s own set)', async () => {
    serve(personSet({ editable: false }));
    renderWithProviders(<PersonSettingsSection userId="u1" />);

    await screen.findByText(catalogSwitch('can_own_leads').label);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('draws nothing for a person with the Full access box', async () => {
    serve(personSet({ admin_box: true }));
    const { container } = renderWithProviders(<PersonSettingsSection userId="u1" />);

    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/users/u1/permissions'));
    expect(container.querySelector('[aria-label="Settings"]')).toBeNull();
  });
});
