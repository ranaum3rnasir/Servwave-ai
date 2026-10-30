/**
 * V7-01a - the Settings shell after the sidebar change: row order, the page picker, the unsaved-changes guard on the
 * new rows, and the two retired addresses (Payments & Lists, Payout account & verification) landing on ServWave
 * Payments with their query string and hash kept.
 *
 * The redirects render the REAL route table (`moduleV2Routes`) with only the chrome and the pages stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense, useEffect } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Routes, Route, useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { buildAbility } from '@/lib/ability';
import SettingsLayout from '@/pages/v2/settings/SettingsLayout';
import { useSettingsBar } from '@/pages/v2/settings/settingsBar';
import { moduleV2Routes } from '@/pages/v2/routes';
import { renderWithProviders } from './helpers';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/settings/ListsPage', async () => {
  const { createElement } = await import('react');
  const { useLocation: useLoc } = await import('react-router-dom');
  const Body = () => {
    const { pathname, search, hash } = useLoc();
    return createElement('p', { 'data-testid': 'landed' }, `${pathname}${search}${hash}`);
  };
  return { default: Body };
});
vi.mock('@/pages/v2/settings/ServwavePaymentsRoute', async () => {
  const { createElement } = await import('react');
  const { useLocation: useLoc } = await import('react-router-dom');
  const Body = () => {
    const { pathname, search, hash } = useLoc();
    return createElement('p', { 'data-testid': 'landed' }, `${pathname}${search}${hash}`);
  };
  return { default: Body };
});

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const PAYOUT_ONLY = buildAbility([
  { action: 'read', subject: 'Organization' },
  { action: 'manage_payout_account', subject: 'Organization' },
]);

function mockOrg() {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: 'u-1', email: 'admin@test.com', first_name: 'Test', last_name: 'Admin',
        role: 'ADMIN', org_is_demo: true, organization_id: 'org-demo', org_features: ['phone', 'email'],
      },
      isAuthenticated: true, isLoading: false, error: null,
    })) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  mockOrg();
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function DirtyPage() {
  const { registerSaver } = useSettingsBar();
  useEffect(() => {
    registerSaver({ save: () => {}, discard: () => {}, isDirty: true });
  }, [registerSaver]);
  return <Where />;
}

function renderShell(ability = ADMIN, start = '/settings/branding', page = <Where />) {
  return renderWithProviders(
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route path="/settings/branding" element={page} />
        <Route path="/settings/servwave-payments" element={<Where />} />
        <Route path="/settings/lists" element={<Where />} />
      </Route>
    </Routes>,
    { ability, initialEntries: [start] },
  );
}

const sideNav = () => screen.getByRole('navigation', { name: 'Settings' });

describe('Settings sidebar', () => {
  it('lists the Advanced group in the order the design gives', () => {
    renderShell();
    const labels = within(sideNav()).getAllByRole('link').map((a) => a.textContent);
    const start = labels.indexOf('ServWave Payments');
    expect(labels.slice(start)).toEqual([
      'ServWave Payments',
      'Lists',
      'Job Sub-Statuses',
      'Estimate Decline Reasons',
      'Job Cancel Reasons',
      'Tax Rates',
      'Phone & SMS',
      'Caller ID',
      'Sender Address',
      'Inventory',
      'Schedule Colors',
    ]);
    expect(labels).not.toContain('Payments & Lists');
    expect(labels).not.toContain('Payout account & verification');
  });

  it('marks the row of the page the visitor is on', () => {
    renderShell(ADMIN, '/settings/lists');
    expect(within(sideNav()).getByRole('link', { name: 'Lists' })).toHaveAttribute('aria-current', 'page');
    expect(within(sideNav()).getByRole('link', { name: 'ServWave Payments' })).not.toHaveAttribute('aria-current');
  });

  it('the page picker below the wide breakpoint lists both new pages', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole('combobox', { name: 'Settings page' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toContain('ServWave Payments');
    expect(options).toContain('Lists');
  });

  it('the picker offers a payout-only person ServWave Payments and not Lists', async () => {
    const user = userEvent.setup();
    renderShell(PAYOUT_ONLY);
    await user.click(screen.getByRole('combobox', { name: 'Settings page' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toContain('ServWave Payments');
    expect(options).not.toContain('Lists');
  });

  it('asks before leaving an edited page for Lists', async () => {
    const user = userEvent.setup();
    renderShell(ADMIN, '/settings/branding', <DirtyPage />);
    await screen.findByTestId('where');
    await user.click(await screen.findByRole('link', { name: 'Lists' }));
    expect(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/branding');
  });
});

describe('the retired addresses', () => {
  const mockApi = vi.mocked(api);
  function open(path: string) {
    mockApi.get.mockResolvedValue({ data: { admin_box: false, values: {}, rules: [] } });
    return renderWithProviders(
      <Suspense fallback={null}>
        <Routes>
          {moduleV2Routes()}
          <Route path="*" element={<p>Nothing here</p>} />
        </Routes>
      </Suspense>,
      { initialEntries: [path], ability: ADMIN },
    );
  }

  it('/settings/payments?onboarding=return lands on ServWave Payments with the query kept', async () => {
    open('/settings/payments?onboarding=return');
    expect(await screen.findByTestId('landed')).toHaveTextContent(/^\/settings\/servwave-payments\?onboarding=return$/);
  });

  it('/settings/payments with no query lands clean', async () => {
    open('/settings/payments');
    expect(await screen.findByTestId('landed')).toHaveTextContent(/^\/settings\/servwave-payments$/);
  });

  it('/settings/payout-account lands on the payout card hash', async () => {
    open('/settings/payout-account');
    expect(await screen.findByTestId('landed')).toHaveTextContent(/^\/settings\/servwave-payments#payout-account$/);
  });

  it('draws the Settings shell only once, at the final address', async () => {
    open('/settings/payments');
    await screen.findByTestId('landed');
    expect(screen.getAllByRole('navigation', { name: 'Settings' })).toHaveLength(1);
  });
});
