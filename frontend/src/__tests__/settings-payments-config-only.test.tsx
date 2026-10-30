/**
 * Payments go-live P8 - Settings holds configuration only. "Payments needing attention" (a list someone watches) and
 * the ServWave Payments area (payments, payouts, documents, disputes) left Settings for the Payments page, so:
 *
 *  - Payments & Lists is for people who may change the organization's settings, and for nobody else. A person who can
 *    only refund no longer has a Settings page to find the attention list in (it is on the Payments page now), so the
 *    menu entry is gone for them and the address shows the no-access page.
 *  - Settings > Payments & Lists renders every configuration card for an org editor and no attention card, whatever
 *    else the editor may do, and asks the server for no attention list.
 *  - The Settings menu has no "ServWave Payments" row, not even for someone who may view payments.
 *
 * (Replaces the slice 22 file that proved a refund-only person reached the list through Settings.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { buildAbility } from '@/lib/ability';
import SettingsLayout from '@/pages/v2/settings/SettingsLayout';
import PaymentsListsRoute from '@/pages/v2/settings/PaymentsListsRoute';
import { renderWithProviders } from './helpers';

vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div data-testid="connect-account-onboarding" />,
}));

const mockApi = vi.mocked(api);

const REFUNDER = buildAbility([
  { action: 'read', subject: 'Invoice' },
  { action: 'refund', subject: 'Invoice' },
  { action: 'read', subject: 'Organization' },
]);
const NEITHER = buildAbility([
  { action: 'read', subject: 'Invoice' },
  { action: 'read', subject: 'Organization' },
]);
const ORG_MANAGER = buildAbility([
  { action: 'read', subject: 'Organization' },
  { action: 'update', subject: 'Organization' },
]);
const ORG_MANAGER_WHO_REFUNDS = buildAbility([
  { action: 'read', subject: 'Organization' },
  { action: 'update', subject: 'Organization' },
  { action: 'refund', subject: 'Invoice' },
  { action: 'read', subject: 'Invoice' },
  { action: 'view_payments', subject: 'Organization' },
]);
const PAYMENTS_VIEWER = buildAbility([
  { action: 'read', subject: 'Organization' },
  { action: 'view_payments', subject: 'Organization' },
]);

function signedIn() {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: 'u-22', email: 'office@example.test', first_name: 'Office', last_name: 'User',
        role: 'DISPATCHER', org_is_demo: true, organization_id: 'org-22', org_features: ['online_payments'],
      },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never);
}

function serve() {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/organization') {
      return Promise.resolve({ data: { id: 'org-22', accepted_payment_methods: ['CASH'], source_options: [], job_type_options: [] } });
    }
    return Promise.resolve({ data: {} });
  });
}

function renderSettings(ability: ReturnType<typeof buildAbility>, path = '/settings/payments') {
  return renderWithProviders(
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route path="/settings/payments" element={<PaymentsListsRoute />} />
        <Route path="/settings/payout-account" element={<p>payout account page</p>} />
      </Route>
    </Routes>,
    { ability, initialEntries: [path] },
  );
}

const sideNav = () => screen.getByRole('navigation', { name: 'Settings' });

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  signedIn();
  serve();
});

describe('Payments & Lists is for people who change company settings', () => {
  it('a person who may refund but not change settings has no Payments & Lists entry in the menu', () => {
    renderSettings(REFUNDER);
    expect(within(sideNav()).queryByRole('link', { name: 'Payments & Lists' })).not.toBeInTheDocument();
  });

  it('and the address shows the no-access page, with no attention list and no Discard / Save bar', async () => {
    renderSettings(REFUNDER);
    expect(await screen.findByText(/not authorized|don.t have access|no access/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Payments needing attention' })).not.toBeInTheDocument();
    expect(screen.queryByText('Accepted Payment Methods')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /discard/i })).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/payments-needing-attention');
  });

  it('a person with neither permission still gets no menu entry', () => {
    renderSettings(NEITHER);
    expect(within(sideNav()).queryByRole('link', { name: 'Payments & Lists' })).not.toBeInTheDocument();
  });

  it('a person who manages org settings keeps the full page with every configuration card, and no attention card', async () => {
    renderSettings(ORG_MANAGER);
    expect(within(sideNav()).getByRole('link', { name: 'Payments & Lists' })).toBeInTheDocument();
    expect(await screen.findByText('Accepted Payment Methods')).toBeInTheDocument();
    expect(screen.getByText('Default Deposit')).toBeInTheDocument();
    expect(screen.getByText('Tips')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Payments needing attention' })).not.toBeInTheDocument();
  });

  it('even an org manager who may also refund sees no attention card, and nothing asks for the list', async () => {
    renderSettings(ORG_MANAGER_WHO_REFUNDS);
    expect(await screen.findByText('Accepted Payment Methods')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Payments needing attention' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Refund/ })).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/payments-needing-attention');
  });
});

describe('a read-only Settings page', () => {
  const OWNER = buildAbility([
    { action: 'read', subject: 'Organization' },
    { action: 'manage_payout_account', subject: 'Organization' },
  ]);

  it('shows no Discard / Save bar on the payout account page', async () => {
    renderSettings(OWNER, '/settings/payout-account');
    expect(await screen.findByText('payout account page')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /discard/i })).not.toBeInTheDocument();
  });
});

describe('the Settings menu', () => {
  it('has no ServWave Payments row, not even for someone who may view payments', () => {
    renderSettings(PAYMENTS_VIEWER);
    expect(within(sideNav()).queryByRole('link', { name: 'ServWave Payments' })).not.toBeInTheDocument();
    expect(sideNav()).not.toHaveTextContent('ServWave Payments');
  });

  it('has none for an org manager either', () => {
    renderSettings(ORG_MANAGER_WHO_REFUNDS);
    expect(sideNav()).not.toHaveTextContent('ServWave Payments');
  });
});
