/**
 * Roles & Permissions security, M8 / D3 (ticket 36) - the phone service and phone numbers are Admin-only.
 *
 * A non-Admin holding Company settings sees neither the Phone & SMS tab nor the Caller ID tab, and typing either address
 * renders nothing (the server refuses every route behind them). An Admin sees and opens both. Renders the REAL routed
 * settings table (`settingsV2Routes`) and the real Settings shell, with only the app chrome and the pages stubbed. Admin is the
 * flag on the signed-in person, never a switch or a role name.
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
vi.mock('@/pages/v2/settings/PhoneSmsPage', () => ({ default: () => <p role="heading" aria-level={2}>Phone service page</p> }));
vi.mock('@/pages/v2/settings/PhoneNumbersSettingsPage', () => ({ default: () => <p role="heading" aria-level={2}>Caller ID page</p> }));
vi.mock('@/pages/v2/settings/CompanyProfilePage', () => ({ default: () => <p role="heading" aria-level={2}>Company page</p> }));
vi.mock('@/pages/v2/settings/MyProfilePage', () => ({ default: () => <p role="heading" aria-level={2}>My profile page</p> }));

const mockApi = vi.mocked(api);

/** Every switch on: the most a non-Admin could hold. */
const everySwitch: Record<string, boolean> = Object.fromEntries(FIXTURE_SWITCHES.map((s) => [s.key, true]));
/** Company settings and the company read, the way a holder of the Company settings switch compiles. */
const companySettingsHolder = buildAbility([
  { action: 'read', subject: 'Organization' },
  { action: 'update', subject: 'Organization' },
  { action: 'update', subject: 'AppSetting' },
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
    { initialEntries: [path], ability: companySettingsHolder },
  );
}

const where = () => screen.getByTestId('where').textContent;
const PAGES = ['Phone service page', 'Caller ID page', 'Dashboard'];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('the phone service and phone numbers are Admin-only', () => {
  it('shows a non-Admin neither tab, and renders nothing at either address', async () => {
    signedIn(false);
    const first = open('/settings/profile');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(await within(nav).findByRole('link', { name: 'My Profile' })).toBeInTheDocument();
    await vi.waitFor(() => expect(mockApi.get.mock.calls.map((c) => c[0])).toContain('/api/permission-switches/me'));
    expect(within(nav).queryByRole('link', { name: 'Phone & SMS' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Caller ID' })).toBeNull();
    first.unmount();

    const paths = ['/settings/phone-sms', '/settings/phone-numbers'];
    const anyPage = new RegExp(`^(${PAGES.join('|')})$`);
    // First the same addresses for an Admin, which DO draw a page: this loads each lazy page, so what follows is
    // judged against pages that would appear at once (no timer to wait out a cold chunk).
    signedIn(true);
    for (const path of paths) {
      const admin = open(path);
      expect(await screen.findByRole('heading', { name: anyPage }), path).toBeInTheDocument();
      admin.unmount();
    }
    signedIn(false);
    for (const path of paths) {
      const view = open(path);
      await screen.findByRole('navigation', { name: 'Settings' });
      expect(screen.queryByRole('heading', { name: anyPage }), path).toBeNull();
      expect(where()).toBe(path);
      view.unmount();
    }
  });

  it('shows an Admin both tabs and opens both pages', async () => {
    signedIn(true);
    const first = open('/settings/company');
    await screen.findByRole('heading', { name: 'Company page' });
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(await within(nav).findByRole('link', { name: 'Phone & SMS' })).toHaveAttribute('href', '/settings/phone-sms');
    expect(within(nav).getByRole('link', { name: 'Caller ID' })).toHaveAttribute('href', '/settings/phone-numbers');
    first.unmount();

    const phone = open('/settings/phone-sms');
    expect(await screen.findByRole('heading', { name: 'Phone service page' })).toBeInTheDocument();
    phone.unmount();
    open('/settings/phone-numbers');
    expect(await screen.findByRole('heading', { name: 'Caller ID page' })).toBeInTheDocument();
  });
});
