import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import RolesPage from '@/pages/settings/RolesPage';
import SettingsLayout from '@/pages/settings/SettingsLayout';
import { buildAbility } from '@/lib/ability';
import { useSettingsGuard } from '@/stores/settingsGuard.store';

const mockApi = vi.mocked(api);

// Admin can do everything — exercises the role list + the dirty-guard dialog.
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const SUBJECTS = ['Customer', 'Lead', 'Estimate', 'Job', 'Invoice', 'Inventory', 'ServicePlan'];
const emptyMatrix = () =>
  Object.fromEntries(SUBJECTS.map((s) => [s, { read: false, create: false, update: false, delete: false }]));

const vm = (role: string) => ({
  role,
  editable: true,
  matrix: emptyMatrix(),
  // SRVW-140 - `viewReports` is the honest control for `read Report`, split out of
  // "See financial data" (which now writes the `read Pricing` grant canSeePricing keys on).
  sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
  // SRVW-139 - the 5 toggle bundles (Dashboard/Account Settings/Notifications/Modify Done
  // Jobs/Cancel Jobs), rendered in their own "Access" card after Sensitive.
  toggles: { dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: false, cancelJobs: false },
  scope: Object.fromEntries(SUBJECTS.map((s) => [s, 'All'])),
  general: { description: `${role} role` },
});

const ROLES = [
  { role: 'SALES', label: 'Sales', fullAccess: false, editable: true, userCount: 3, type: 'system' },
  { role: 'DISPATCHER', label: 'Dispatcher', fullAccess: false, editable: true, userCount: 2, type: 'system' },
];

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/roles') return Promise.resolve({ data: ROLES });
    const m = url.match(/\/api\/roles\/(\w+)\/permissions/);
    if (m) return Promise.resolve({ data: vm(m[1]) });
    return Promise.resolve({ data: [] });
  });
});

describe('RolesPage — core flow (#115)', () => {
  it('loads the first role and its permission matrix', async () => {
    renderWithProviders(<RolesPage />);
    expect(await screen.findByRole('tab', { name: 'Permissions' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Data Scope' })).toBeInTheDocument();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/roles/SALES/permissions'));
  });

  it('switches the selected role and loads the other matrix', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByRole('tab', { name: 'Permissions' });

    await user.click(screen.getByRole('button', { name: /Dispatcher/ }));
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/roles/DISPATCHER/permissions'));
  });

  it('renders the Service Plans module row in the permission matrix', async () => {
    renderWithProviders(<RolesPage />);
    await screen.findByRole('tab', { name: 'Permissions' });
    expect(await screen.findByRole('cell', { name: 'Service Plans' })).toBeInTheDocument();
  });

  it('toggling a permission cell updates the matrix', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByRole('tab', { name: 'Permissions' });

    const firstSwitch = screen.getAllByRole('switch')[0];
    expect(firstSwitch).toHaveAttribute('aria-checked', 'false');
    await user.click(firstSwitch);
    expect(firstSwitch).toHaveAttribute('aria-checked', 'true');
  });

  // SRVW-140 - `read Report` lost its only control when "See financial data" was repointed at
  // the pricing grant, so it needs an honest one of its own. Without it the 13
  // canDo('read','Report') routes and the 8 Report nav entries become permanently uneditable.
  it('renders View reports alongside See financial data in the Sensitive card', async () => {
    renderWithProviders(<RolesPage />);
    await screen.findByRole('tab', { name: 'Permissions' });

    expect(await screen.findByText('See financial data')).toBeInTheDocument();
    expect(screen.getByText('View reports')).toBeInTheDocument();
    expect(screen.getByText('Record & refund payments')).toBeInTheDocument();
  });

  it('toggling View reports changes only that key on the draft view model', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RolesPage />);
    await screen.findByRole('tab', { name: 'Permissions' });

    const row = (await screen.findByText('View reports')).closest('div')!;
    const toggle = within(row).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    // The sibling sensitive switches are untouched.
    const financialsRow = screen.getByText('See financial data').closest('div')!;
    expect(within(financialsRow).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    const paymentsRow = screen.getByText('Record & refund payments').closest('div')!;
    expect(within(paymentsRow).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });
});

describe('RolesPage — intra-page role switch guard (#113 AC2)', () => {
  // The "Discard unsaved changes?" dialog lives in SettingsLayout, not RolesPage,
  // so render the layout with a nested route to RolesPage (both share the global
  // settingsGuard store). This is the case a router blocker could NEVER catch:
  // switching roles is intra-page state (setSelected), not a route change.
  function renderSettingsWithRoles() {
    return renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route path="roles" element={<RolesPage />} />
        </Route>
      </Routes>,
      { initialEntries: ['/settings/roles'], ability: adminAbility },
    );
  }

  it('prompts when switching roles with unsaved changes (and Keep editing stays put)', async () => {
    const user = userEvent.setup();
    renderSettingsWithRoles();

    // Wait for the first role (Sales) + its matrix to load.
    await screen.findByRole('tab', { name: 'Permissions' });
    expect(await screen.findByRole('heading', { name: 'Sales' })).toBeInTheDocument();

    // Toggle the first permission cell → the page becomes dirty.
    const firstSwitch = screen.getAllByRole('switch')[0];
    await user.click(firstSwitch);

    // Click a different role → RolesPage.tsx routes setSelected through requestLeave.
    await user.click(screen.getByRole('button', { name: /Dispatcher/ }));

    // AC2: the intra-page role switch still prompts.
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();

    // Keep editing → dialog closes and Sales is still the selected role
    // (setSelected never ran, so the detail heading stays "Sales").
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await waitFor(() =>
      expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Sales' })).toBeInTheDocument();
  });
});
