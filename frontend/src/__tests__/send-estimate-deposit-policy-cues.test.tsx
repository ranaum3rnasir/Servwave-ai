/**
 * Payments go-live slice 27 (slice 21 follow-ups) - three cues on the estimate send dialog.
 *
 * 1. The chosen deposit-policy option carries a check mark, not only a light fill, so it reads at
 *    3:1 without relying on colour.
 * 2. A resend opens with the methods the estimate was last sent with, not the org defaults, so the
 *    methods and the stored policy beside them agree.
 * 3. The locked-policy note is worded for the estimate's state: a won estimate cannot be recalled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { SendEstimateDialog } from '@/components/estimates/SendEstimateDialog';

vi.mock('@/lib/axios', () => ({ default: { post: vi.fn(), patch: vi.fn(), get: vi.fn() } }));

const mockOrg = vi.fn();
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => mockOrg() }));
vi.mock('@/components/payments/PaymentsSetupBanner', () => ({ PaymentsSetupBanner: () => null }));

const ORG = {
  deposit_default_type: 'PERCENTAGE',
  deposit_default_percentage: 50,
  accepted_payment_methods: ['CHECK', 'CASH', 'CARD', 'ACH'],
  stripe_charges_enabled: true,
  card_offered_by_default: true,
  bank_offered_by_default: true,
  deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
};

function renderDialog(props: Partial<React.ComponentProps<typeof SendEstimateDialog>> = {}) {
  return renderWithProviders(
    <SendEstimateDialog
      open
      onOpenChange={() => {}}
      estimateId="est-1"
      estimateNumber="C00001-1"
      totalAmount={1000}
      customerEmail="payer@example.test"
      alreadySent={false}
      onSuccess={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOrg.mockReturnValue({ data: { ...ORG } });
});

describe('the chosen deposit-policy option', () => {
  it('carries a check mark, and the other option does not', async () => {
    renderDialog();
    const required = screen.getByRole('radio', { name: /require the deposit before approval/i });
    const later = screen.getByRole('radio', { name: /allow approval now, deposit paid later/i });

    expect(within(required).getByTestId('policy-selected-check')).toBeInTheDocument();
    expect(within(later).queryByTestId('policy-selected-check')).not.toBeInTheDocument();

    await userEvent.setup().click(later);
    expect(within(later).getByTestId('policy-selected-check')).toBeInTheDocument();
    expect(within(required).queryByTestId('policy-selected-check')).not.toBeInTheDocument();
  });
});

describe('the methods a resend starts from', () => {
  it('ticks the methods the estimate was last sent with, not the org defaults', () => {
    renderDialog({ alreadySent: true, sentMethods: ['CHECK'] });

    expect(screen.getByRole('checkbox', { name: /check/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /cash/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /card/i })).not.toBeChecked();
  });

  it('a first send still starts from the org defaults', () => {
    renderDialog({ alreadySent: false, sentMethods: ['CHECK'] });

    expect(screen.getByRole('checkbox', { name: /cash/i })).toBeChecked();
  });
});

describe('the locked-policy note', () => {
  it('tells a sent estimate to be recalled to Draft', () => {
    renderDialog({ alreadySent: true, locked: true, estimateStatus: 'SENT' });
    expect(screen.getByText(/recall it to draft to change it/i)).toBeInTheDocument();
  });

  it('does not tell a won estimate to be recalled', () => {
    renderDialog({ alreadySent: true, locked: true, estimateStatus: 'WON' });
    expect(screen.queryByText(/recall it to draft/i)).not.toBeInTheDocument();
    expect(screen.getByText(/approved, so the deposit policy can no longer change/i)).toBeInTheDocument();
  });
});
