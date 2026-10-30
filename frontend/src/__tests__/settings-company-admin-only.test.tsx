/**
 * Roles & Permissions security, ticket 36b (M17) - setting up the company is the Admin flag's alone.
 *
 * Whatever a non-Admin holds (every switch, every rule a screen ever read, the old update-the-company rule included), the Settings
 * shell shows them none of the company's setup tabs, typing any of those addresses renders nothing, and the bare /settings opens
 * My Profile. They keep My Profile and Locations. An Admin sees and opens every one. Renders the REAL routed settings table
 * (`settingsV2Routes`) and the real Settings shell, with only the app chrome and the pages stubbed. Admin is the flag on the
 * signed-in person, never a switch or a role name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen, within } from '@testing-library/react';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';
import { renderWithProviders } from './helpers';
import { FIXTURE_CATALOG, FIXTURE_SWITCHES } from './support/permissionCatalogFixture';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/settings/CompanyProfilePage', () => ({ default: () => <p role="heading" aria-level={2}>Company page</p> }));
vi.mock('@/pages/v2/settings/BrandingPage', () => ({ default: () => <p role="heading" aria-level={2}>Branding page</p> }));
vi.mock('@/pages/v2/settings/SecurityPage', () => ({ default: () => <p role="heading" aria-level={2}>Security page</p> }));
vi.mock('@/pages/v2/settings/ListsPage', () => ({ default: () => <p role="heading" aria-level={2}>Lists page</p> }));
vi.mock('@/pages/v2/settings/JobSubStatusesPage', () => ({ default: () => <p role="heading" aria-level={2}>Sub-statuses page</p> }));
vi.mock('@/pages/v2/settings/DeclineReasonsPage', () => ({ default: () => <p role="heading" aria-level={2}>Decline reasons page</p> }));
vi.mock('@/pages/v2/settings/JobCancelReasonsPage', () => ({ default: () => <p role="heading" aria-level={2}>Cancel reasons page</p> }));
vi.mock('@/pages/v2/settings/PhoneSmsPage', () => ({ default: () => <p role="heading" aria-level={2}>Phone service page</p> }));
vi.mock('@/pages/v2/settings/PhoneNumbersSettingsPage', () => ({ default: () => <p role="heading" aria-level={2}>Caller ID page</p> }));
vi.mock('@/pages/v2/settings/InventorySettingsPage', () => ({ default: () => <p role="heading" aria-level={2}>Inventory page</p> }));
vi.mock('@/pages/v2/settings/ScheduleColorsPage', () => ({ default: () => <p role="heading" aria-level={2}>Schedule colors page</p> }));
vi.mock('@/pages/v2/settings/LocationsPage', () => ({ default: () => <p role="heading" aria-level={2}>Locations page</p> }));
vi.mock('@/pages/v2/settings/MyProfilePage', () => ({ default: () => <p role="heading" aria-level={2}>My profile page</p> }));
vi.mock('@/pages/v2/settings/ServwavePaymentsRoute', () => ({ default: () => <p role="heading" aria-level={2}>Payments page</p> }));
vi.mock('@/pages/v2/settings/UsersTeamsPage', () => ({ default: () => <p role="heading" aria-level={2}>Users page</p> }));
vi.mock('@/pages/v2/settings/RolesPage', () => ({ default: () => <p role="heading" aria-level={2}>Roles page</p> }));
vi.mock('@/pages/v2/settings/PersonPermissionsPage', () => ({ default: () => <p role="heading" aria-level={2}>Person permissions page</p> }));
vi.mock('@/pages/settings/TaxRatesPage', () => ({ default: () => <p role="heading" aria-level={2}>Tax rates page</p> }));
vi.mock('@/pages/settings/EmailSenderPage', () => ({ default: () => <p role="heading" aria-level={2}>Sender address page</p> }));

const mockApi = vi.mocked(api);

/** Every switch on: the most a non-Admin could hold. */
const everySwitch: Record<string, boolean> = Object.fromEntries(FIXTURE_SWITCHES.map((s) => [s.key, true]));
/** The most a non-Admin could hold: the old update-the-company rules, the reads, locations and the payout switch's rule. */
const everyRule = buildAbility([
  { action: 'read', subject: 'Organization' },
  { action: 'update', subject: 'Organization' },
  { action: 'update', subject: 'AppSetting' },
  { action: 'read', subject: 'Location' },
  { action: 'manage_payout_account', subject: 'Organization' },
]);

function signedIn(isAdmin: boolean) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: '00000000-0000-0000-0000-000000000001', email: 'person@test.com', first_name: 'Test', last_name: 'Person', role: 'DISPATCHER', is_admin: isAdmin, org_features: ['phone', 'email'] },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })) as never);
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/permission-switches/me') return Promise.resolve({ data: { admin_box: isAdmin, values: everySwitch, rules: [] } });
    if (url === '/api/permission-switches/catalog') return Promise.resolve({ data: FIXTURE_CATALOG });
    return Promise.resolve({ data: [] });
  });
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function open(path: string) {
  return renderWithProviders(
    <Suspense fallback={null}>
      <Where />
      <Routes>
        {settingsV2Routes()}
        <Route path="*" element={<p role="heading" aria-level={1}>Dashboard</p>} />
      </Routes>
    </Suspense>,
    { initialEntries: [path], ability: everyRule },
  );
}

const where = () => screen.getByTestId('where').textContent;
const ADMIN_ONLY: Array<[label: string, path: string, page: string]> = [
  ['Company Profile', '/settings/company', 'Company page'],
  ['Branding & Templates', '/settings/branding', 'Branding page'],
  ['Lists', '/settings/lists', 'Lists page'],
  ['Job Sub-Statuses', '/settings/job-sub-statuses', 'Sub-statuses page'],
  ['Estimate Decline Reasons', '/settings/decline-reasons', 'Decline reasons page'],
  ['Job Cancel Reasons', '/settings/job-cancel-reasons', 'Cancel reasons page'],
  ['Tax Rates', '/settings/tax-rates', 'Tax rates page'],
  ['Phone & SMS', '/settings/phone-sms', 'Phone service page'],
  ['Caller ID', '/settings/phone-numbers', 'Caller ID page'],
  ['Sender Address', '/settings/email-sender', 'Sender address page'],
  ['Inventory', '/settings/inventory', 'Inventory page'],
  ['Schedule Colors', '/settings/schedule-colors', 'Schedule colors page'],
  ['Users & Teams', '/settings/users', 'Users page'],
  ['Roles & Permissions', '/settings/roles', 'Roles page'],
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('setting up the company is the Admin flag\'s alone', () => {
  it('shows a non-Admin none of the setup tabs, renders nothing at any of their addresses, and keeps My Profile and Locations', async () => {
    signedIn(false);
    const first = open('/settings/profile');
    await screen.findByRole('heading', { name: 'My profile page' });
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(await within(nav).findByRole('link', { name: 'My Profile' })).toBeInTheDocument();
    await vi.waitFor(() => expect(mockApi.get.mock.calls.map((c) => c[0])).toContain('/api/permission-switches/me'));
    expect(within(nav).getByRole('link', { name: 'Locations' })).toBeInTheDocument();
    // Login & Security is every person's own sign-in (their password and email code), so it is everyone's.
    expect(within(nav).getByRole('link', { name: 'Login & Security' })).toHaveAttribute('href', '/settings/security');
    // The payout switch's rule opens ServWave Payments (its second door), and nothing else.
    expect(within(nav).getByRole('link', { name: 'ServWave Payments' })).toBeInTheDocument();
    for (const [label] of ADMIN_ONLY) expect(within(nav).queryByRole('link', { name: label }), label).toBeNull();
    first.unmount();

    const anyPage = new RegExp(`^(${[...ADMIN_ONLY.map((r) => r[2]), 'Person permissions page', 'Dashboard'].join('|')})$`);
    for (const path of [...ADMIN_ONLY.map((r) => r[1]), '/settings/users/u1/permissions']) {
      const view = open(path);
      await screen.findByRole('navigation', { name: 'Settings' });
      await expect(screen.findByRole('heading', { name: anyPage }, { timeout: 300 }), path).rejects.toThrow();
      expect(where()).toBe(path);
      view.unmount();
    }
  });

  it('opens Login & Security for a non-Admin: their own password lives there', async () => {
    signedIn(false);
    open('/settings/security');
    expect(await screen.findByRole('heading', { name: 'Security page' })).toBeInTheDocument();
    expect(where()).toBe('/settings/security');
  });

  it('opens My Profile from the bare /settings for a non-Admin, and the company details for an Admin', async () => {
    signedIn(false);
    const nonAdmin = open('/settings');
    expect(await screen.findByRole('heading', { name: 'My profile page' })).toBeInTheDocument();
    expect(where()).toBe('/settings/profile');
    nonAdmin.unmount();

    signedIn(true);
    open('/settings');
    expect(await screen.findByRole('heading', { name: 'Company page' })).toBeInTheDocument();
    expect(where()).toBe('/settings/company');
  });

  it('shows an Admin every setup tab and opens every page', async () => {
    signedIn(true);
    const first = open('/settings/company');
    await screen.findByRole('heading', { name: 'Company page' });
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    for (const [label, path] of ADMIN_ONLY) {
      expect(await within(nav).findByRole('link', { name: label }), label).toHaveAttribute('href', path);
    }
    first.unmount();

    for (const [, path, page] of ADMIN_ONLY) {
      const view = open(path);
      expect(await screen.findByRole('heading', { name: page }), path).toBeInTheDocument();
      view.unmount();
    }
  });
});
