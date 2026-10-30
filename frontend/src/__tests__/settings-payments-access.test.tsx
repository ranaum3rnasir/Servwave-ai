/**
 * Payments go-live slice 35 (carried from the slice 22 staging acceptance): Settings > Payments for someone who may
 * change company settings shows a no-access state, never a form whose loads were refused and
 * whose switches claim "Unavailable" (a refund-only user included: the attention list moved to the Payments page in P8).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import SettingsLayout from '@/pages/v2/settings/SettingsLayout';
import PaymentsListsRoute from '@/pages/v2/settings/PaymentsListsRoute';
import { renderWithProviders } from './helpers';

const mockApi = vi.mocked(api);

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div />,
}));

const NOTHING = buildAbility([{ action: 'read', subject: 'Invoice' }]);
const REFUND_ONLY = buildAbility([{ action: 'refund', subject: 'Invoice' }, { action: 'read', subject: 'Invoice' }]);
const COMPANY_ADMIN = buildAbility([
  { action: 'update', subject: 'Organization' },
  { action: 'read', subject: 'Organization' },
]);

const renderAt = (ability: ReturnType<typeof buildAbility>) =>
  renderWithProviders(
    <Routes>
      <Route path="/settings" element={<SettingsLayout />}>
        <Route path="/settings/payments" element={<PaymentsListsRoute />} />
      </Route>
    </Routes>,
    { ability, initialEntries: ['/settings/payments'] },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(() => Promise.reject({ isAxiosError: true, response: { status: 403, data: { error: 'Insufficient permissions' } } }));
});

describe('Settings > Payments reached by URL', () => {
  it('shows a no-access state, not the form, to someone who may not edit settings', async () => {
    renderAt(NOTHING);
    expect(await screen.findByText(/not authorized|don.t have access|no access/i)).toBeInTheDocument();
    expect(screen.queryByText('Accepted Payment Methods')).not.toBeInTheDocument();
    expect(screen.queryByText(/Unavailable/)).not.toBeInTheDocument();
  });

  it('shows no Discard / Save bar above the no-access state', async () => {
    renderAt(NOTHING);
    await screen.findByText(/not authorized|don.t have access|no access/i);
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /discard/i })).not.toBeInTheDocument();
  });

  // P8: the attention list left Settings, so a refund-only user has nothing here: the no-access state, and no bar.
  it('shows a refund-only user the no-access state and no Discard / Save bar', async () => {
    renderAt(REFUND_ONLY);
    expect(await screen.findByText(/not authorized|don.t have access|no access/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Payments needing attention' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /discard/i })).not.toBeInTheDocument();
  });

  it('still offers the bar to someone who can edit company settings', async () => {
    mockApi.get.mockResolvedValue({ data: { id: 'o1', accepted_payment_methods: ['CASH'], source_options: [], job_type_options: [] } });
    renderAt(COMPANY_ADMIN);
    expect(await screen.findByRole('button', { name: /save changes/i })).toBeInTheDocument();
  });
});
