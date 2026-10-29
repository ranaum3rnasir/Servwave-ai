/**
 * MarkSentDialog - the deposit preview.
 *
 * markSent() runs the SAME commitFirstSend ceremony as send(), so it charges what
 * `resolveDepositAmount` returns - which prefers the estimate's own deposit_type/deposit_value over
 * the org defaults. This dialog used to compute its preview from the org columns alone (the
 * identical divergence fixed in SendEstimateDialog), so an estimate overridden to 70% under a 50%
 * org default told the user 50% and then billed 70%.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { MarkSentDialog } from '@/components/estimates/MarkSentDialog';

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn(), patch: vi.fn(), get: vi.fn() },
}));

const mockOrg = vi.fn();
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => mockOrg(),
}));

const TOTAL = 106.63;

function renderDialog(props: Partial<React.ComponentProps<typeof MarkSentDialog>> = {}) {
  return renderWithProviders(
    <MarkSentDialog
      open
      onOpenChange={() => {}}
      estimateId="est-1"
      estimateNumber="J00229-2"
      totalAmount={TOTAL}
      onSuccess={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOrg.mockReturnValue({
    data: {
      deposit_default_type: 'PERCENTAGE',
      deposit_default_percentage: 50,
      accepted_payment_methods: ['EXTERNAL_CARD'],
    },
  });
});

describe('MarkSentDialog deposit preview', () => {
  it('shows the estimate override, not the org default', () => {
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });
    expect(screen.getByText(/70%/)).toBeInTheDocument();
    expect(screen.getByText('$74.64')).toBeInTheDocument(); // not $53.32
  });

  it('falls back to the org default when the estimate has no override', () => {
    renderDialog();
    expect(screen.getByText(/50%/)).toBeInTheDocument();
    expect(screen.getByText('$53.32')).toBeInTheDocument();
  });

  it('caps a FIXED override at the estimate total', () => {
    renderDialog({ depositType: 'FIXED', depositValue: 500 });
    expect(screen.getByText('$106.63')).toBeInTheDocument();
    expect(screen.getByText(/100%/)).toBeInTheDocument();
  });
});
