/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.11 - the "Sending as" line on the ROUTED customer page's compose window
// (/customers/:id renders pages/v2/customers/CustomerDetailPage; the older twin under pages/ is not routed).
//
// The REAL data hooks run; only the network layer is faked. An email written from the customer's page goes out from the
// sender's OWN address; a person with no address of their own reads the address-needed sentence and Send is disabled with
// its reason readable by a screen reader.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';

import CustomerDetailPage from '../CustomerDetailPage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000005';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: CUSTOMER_ID }) };
});

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
  useEntitlementsReady: () => true,
}));

const NEEDED_SENTENCE = "You don't have an email address yet. An admin needs to set one before you can send email.";
const OWN_ADDRESS = 'jane.smith.acme@mail.example.test';
const OWN_NAME = 'Jane Smith at Acme';
type Identity = { status: 'active' | 'address_needed'; address: string | null; name: string | null; sendingEnabled: boolean };
let identity: Identity = { status: 'active', address: OWN_ADDRESS, name: OWN_NAME, sendingEnabled: true };

const CUSTOMER_DETAIL = {
  customer: {
    id: CUSTOMER_ID, customer_number: 'C00005', first_name: 'Rita', last_name: 'Banks', company_name: null,
    email: 'rita@example.test', phone: '5551230000', phone_ext: null, secondary_phone: null, ad_source: 'Referral',
    allow_billing: false, tax_exempt: false, payment_type: null, extra_emails: [], custom_fields: {},
    created_at: '2026-01-01T00:00:00.000Z', archived_at: null, is_active: true, tags: [], service_locations: [],
    _count: { leads: 0, jobs: 0 }, jobs: [], activity_notes: [], orphan_invoices: [], invoices: [],
  },
  summary: {
    financials: { lifetime_revenue: 0, total_invoiced: 0, past_due_balance: 0, due_balance: 0, paid_invoice_count: 0, unpaid_invoice_count: 0 },
    estimates: { total: 0, pending: 0, approved: 0, total_value: 0 },
    deposits: { collected: 0, pending: 0 },
    leads: { open: 0, active: 0 },
    tasks: { open: 0 },
  },
};

const ability = buildAbility([{ action: 'manage', subject: 'all' }]);

beforeEach(() => {
  vi.clearAllMocks();
  identity = { status: 'active', address: OWN_ADDRESS, name: OWN_NAME, sendingEnabled: true };
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u1', email: 'jane@test.com', first_name: 'Jane', last_name: 'Smith', role: 'ADMIN', organization_id: 'org-1', org_features: ['email', 'phone', 'leads'] },
      isAuthenticated: true, isLoading: false, error: null,
    })) as typeof useAuthStore,
  );
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url === '/api/communication/sending-identity') return { data: identity };
    if (url === '/api/organization') return { data: { id: 'org-1', timezone: 'America/Chicago' } };
    if (url.startsWith('/api/customers/')) return { data: CUSTOMER_DETAIL };
    if (url === '/api/leads') return { data: { leads: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } } };
    return { data: {} };
  });
});

async function openCompose() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderWithProviders(<CustomerDetailPage />, { ability, initialEntries: [`/customers/${CUSTOMER_ID}`] });
  await user.click(await screen.findByRole('button', { name: 'rita@example.test' }));
  return user;
}

describe('the customer page: "Sending as" in the compose window', () => {
  it('shows the sender\'s own address and the name the recipient sees, and Send is enabled', async () => {
    await openCompose();
    const line = (await screen.findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(OWN_ADDRESS, { exact: false })).toBeInTheDocument());
    expect(within(line).getByText(OWN_NAME)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Send$/ })).toBeEnabled();
  });

  it('reads the address-needed sentence for a person with no address, with Send disabled and the reason readable', async () => {
    identity = { status: 'address_needed', address: null, name: null, sendingEnabled: true };
    await openCompose();
    const line = (await screen.findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(NEEDED_SENTENCE)).toBeInTheDocument());
    const send = screen.getByRole('button', { name: /^Send$/ });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(NEEDED_SENTENCE);
  });
});
