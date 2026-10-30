/**
 * Roles & Permissions security, M8 / D3 (ticket 36) - the payment instructions are Admin-only.
 *
 * Settings > ServWave Payments: a holder of Company settings who is not an Admin has the rest of the payment settings (the
 * accepted methods, the deposit, tips) and saves them, but sees no Bank-transfer instructions card and never sends the field,
 * because the server refuses it. An Admin sees the card and saves the text. Admin is the flag on the signed-in person.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';

let registeredSave: (() => Promise<void> | void) | null = null;
vi.mock('@/pages/v2/settings/settingsBar', async (orig) => ({
  ...(await orig<typeof import('@/pages/v2/settings/settingsBar')>()),
  useSettingsBar: () => ({
    registerSaver: (fns: { save: () => Promise<void> | void }) => {
      registeredSave = fns.save;
    },
  }),
}));
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div />,
  ConnectAccountManagement: () => <div />,
  ConnectNotificationBanner: () => <div />,
}));

const { default: ServwavePaymentsPage } = await import('@/pages/v2/settings/ServwavePaymentsPage');

const mockApi = vi.mocked(api);
const ability = buildAbility([
  { action: 'update', subject: 'Organization' },
  { action: 'manage_payout_account', subject: 'Organization' },
]);

const ORG = {
  id: 'o1',
  stripe_connected: true,
  stripe_charges_enabled: true,
  accepted_payment_methods: ['CARD', 'ACH', 'CASH'],
  card_offered_by_default: true,
  bank_offered_by_default: true,
  tips_enabled: false,
  tip_presets: [10, 15, 20],
  deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
  bank_transfer_instructions: 'Wire to account 000-TEST',
  source_options: [],
  job_type_options: [],
  deposit_default_type: 'PERCENTAGE',
  deposit_default_percentage: 40,
  deposit_default_fixed_amount: 0,
};

function signedIn(isAdmin: boolean) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u-1', email: 'person@test.com', first_name: 'Test', last_name: 'Person', role: 'DISPATCHER', is_admin: isAdmin },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })) as never);
}

async function renderPage() {
  mockApi.get.mockImplementation((url: string) => (url === '/api/organization' ? Promise.resolve({ data: ORG }) : Promise.resolve({ data: {} })));
  const user = userEvent.setup();
  renderWithProviders(<ServwavePaymentsPage />, { ability });
  await screen.findByDisplayValue('40');
  return user;
}

const lastPatch = () => mockApi.patch.mock.calls.at(-1)![1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  registeredSave = null;
  mockApi.patch.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('Bank-transfer instructions are an Admin\'s alone', () => {
  it('hides the card from a non-Admin, who still saves the rest of the payment settings without the field', async () => {
    signedIn(false);
    const user = await renderPage();

    expect(screen.queryByRole('heading', { name: 'Bank-transfer instructions' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Instructions customers see')).not.toBeInTheDocument();
    expect(document.getElementById('sec-bank')).toBeNull();
    // The rest of the settings is there and saves.
    expect(screen.getByRole('heading', { name: 'Accepted payment methods' })).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Credit card' }));
    await registeredSave?.();
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/organization', expect.anything()));
    expect(lastPatch()).toEqual({ card_offered_by_default: false });
  });

  it('shows an Admin the card with the saved text, and saves a change to it', async () => {
    signedIn(true);
    const user = await renderPage();

    const field = screen.getByLabelText('Instructions customers see');
    expect(field).toHaveValue('Wire to account 000-TEST');
    await user.clear(field);
    await user.type(field, 'Wire to account 111-TEST');
    await registeredSave?.();
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/organization', expect.anything()));
    expect(lastPatch()).toEqual({ bank_transfer_instructions: 'Wire to account 111-TEST' });
  });
});
