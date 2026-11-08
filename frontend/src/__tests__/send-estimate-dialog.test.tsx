// Payments Phase 2, Task 2.5 — JIT accept-cards banner (StripePaymentsBanner) mounted near
// the top of SendEstimateDialog's body. This file covers the banner integration only (admin
// CTA + navigation, non-admin copy, hidden once charges are enabled) — SendEstimateDialog's
// own send/deposit/payment-method behavior predates this task and isn't re-tested here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { SendEstimateDialog } from '@/components/estimates/SendEstimateDialog';
import { buildAbility } from '@/lib/ability';
import type { Organization } from '@/lib/api/organization';
import api from '@/lib/axios';

const mockApi = vi.mocked(api);

const ADMIN_ABILITY = buildAbility([{ action: 'update', subject: 'Organization' }]);
const ORG = { id: 'org-1', name: 'Acme HVAC', stripe_charges_enabled: false, platform_fee_bps: 50 } as Organization;

const hoisted = vi.hoisted(() => ({
  org: undefined as unknown as Organization,
}));

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => ({ data: hoisted.org }) };
});

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function baseProps(overrides: Partial<React.ComponentProps<typeof SendEstimateDialog>> = {}) {
  return {
    open: true,
    onOpenChange: vi.fn(),
    estimateId: 'est-1',
    estimateNumber: 'E00042',
    totalAmount: 1000,
    customerEmail: 'jane@customer.com',
    alreadySent: false,
    onSuccess: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.org = undefined as unknown as Organization;
  mockApi.post.mockResolvedValue({ data: { estimate: {} } });
});

describe('SendEstimateDialog — customer contact redaction (#1997)', () => {
  it('customerEmail undefined (redacted): "To" is read-only with the neutral placeholder, no address, Send enabled', () => {
    renderWithProviders(<SendEstimateDialog {...baseProps({ customerEmail: undefined })} />);

    const to = screen.getByLabelText('To') as HTMLInputElement;
    expect(to).toHaveValue('');
    expect(to).toHaveAttribute('readonly');
    expect(to).toHaveAttribute('placeholder', "Sent to the customer's saved email address");
    expect(screen.queryByText('Enter a valid email address')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Send/ })).toBeEnabled();
  });

  it('customerEmail undefined (redacted): sends with no recipient_override so the backend falls back to the stored address', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SendEstimateDialog {...baseProps({ customerEmail: undefined })} />);

    await user.click(screen.getByRole('button', { name: /^Send/ }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0][1] as Record<string, unknown>;
    expect('recipient_override' in body).toBe(false);
    expect('cc_emails' in body).toBe(false);
  });

  it('customerEmail undefined (redacted): CC input is disabled with a neutral hint instead of accepting an address', () => {
    renderWithProviders(<SendEstimateDialog {...baseProps({ customerEmail: undefined })} />);

    const cc = screen.getByLabelText(/CC/) as HTMLInputElement;
    expect(cc).toBeDisabled();
    expect(cc).toHaveAttribute('placeholder', 'Not available for this customer');
  });

  it('customerEmail null (genuinely no email on file): unchanged pre-existing behaviour — editable, empty, flagged invalid', () => {
    renderWithProviders(<SendEstimateDialog {...baseProps({ customerEmail: null })} />);

    const to = screen.getByLabelText('To') as HTMLInputElement;
    expect(to).toHaveValue('');
    expect(to).not.toHaveAttribute('readonly');
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
  });
});

describe('SendEstimateDialog — JIT accept-cards banner (Task 2.5)', () => {
  it('admin: shows the banner when card payments are not yet enabled, and Set up navigates to /settings/payments', async () => {
    hoisted.org = { ...ORG, stripe_charges_enabled: false };
    const user = userEvent.setup();
    renderWithProviders(<SendEstimateDialog {...baseProps()} />, { ability: ADMIN_ABILITY });

    expect(screen.getByText('Get paid faster — accept card payments.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    expect(mockNavigate).toHaveBeenCalledWith('/settings/payments');
  });

  it("non-admin: shows informational copy instead of a CTA the user can't act on", () => {
    hoisted.org = { ...ORG, stripe_charges_enabled: false };
    renderWithProviders(<SendEstimateDialog {...baseProps()} />);

    expect(screen.getByText('Card payments aren’t set up — ask your admin.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up' })).not.toBeInTheDocument();
  });

  it('renders no banner once card payments are already enabled', () => {
    hoisted.org = { ...ORG, stripe_charges_enabled: true };
    renderWithProviders(<SendEstimateDialog {...baseProps()} />, { ability: ADMIN_ABILITY });

    expect(screen.queryByText(/Get paid faster/)).not.toBeInTheDocument();
  });
});
