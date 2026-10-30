/**
 * Mobile slice 25 (rubric A11Y-03): the controls the audit found unnamed now have a name a screen
 * reader announces. The Roles page's switches said "switch" with no hint of which module or verb,
 * and a tag chip's remove button said only "button".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '../helpers';
import RolesPage from '@/pages/v2/settings/RolesPage';
import { TagInput } from '@/components/leads/TagInput';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { FIXTURE_CATALOG, FIXTURE_DRAWN_SWITCHES, catalogSwitch, presetSet } from '../support/permissionCatalogFixture';

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') {
      return Promise.resolve({
        data: [{ role: 'TECHNICIAN', label: 'Technician', fullAccess: false, editable: true, userCount: 2, type: 'system' }],
      });
    }
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    if (/^\/api\/roles\/\w+\/permissions$/.test(url)) {
      return Promise.resolve({
        data: { role: 'TECHNICIAN', label: 'Technician', type: 'system', editable: true, base_role: 'TECHNICIAN', made_from_role_key: null, made_from_blank: false, values: presetSet('TECHNICIAN'), all_views_off: false },
      });
    }
    if (url === '/api/tags') return Promise.resolve({ data: { tags: [] } });
    return Promise.resolve({ data: [] });
  });
});

describe('Roles controls are named (v2 RolesPage, the routed one)', () => {
  it('names every switch of the catalog by its label', async () => {
    renderWithProviders(<RolesPage />);
    await screen.findByRole('switch', { name: catalogSwitch('view_customers').label });
    // The per-person settings are in the catalog but edited on the person's profile, never drawn by this page.
    for (const s of FIXTURE_DRAWN_SWITCHES.filter((x) => x.kind === 'toggle')) {
      expect(screen.getByRole('switch', { name: s.label })).toBeInTheDocument();
    }
  });

  it('leaves no switch, option or help icon on the page without a name', async () => {
    renderWithProviders(<RolesPage />);
    await screen.findByRole('switch', { name: catalogSwitch('view_customers').label });
    const controls = [...screen.getAllByRole('switch'), ...screen.getAllByRole('radio'), ...screen.getAllByRole('checkbox'), ...screen.getAllByRole('radiogroup')];
    expect(controls.length).toBeGreaterThan(10);
    for (const control of [...controls, ...screen.getAllByRole('button')]) expect(control).toHaveAccessibleName();
  });
});

describe('a tag chip remove button is named', () => {
  it('says which tag it removes', () => {
    renderWithProviders(
      <TagInput entityType="LEAD" entityId="lead-1" tags={[{ id: 't1', name: 'VIP', color: '#0f766e' }]} />,
    );
    expect(screen.getByRole('button', { name: 'Remove tag VIP' })).toBeInTheDocument();
  });
});
