/**
 * #2031 slice 2 — one deposit resolver, used by every surface.
 *
 * The receipt card used to answer "what is the deposit?" for itself: pre-send it read the
 * estimate's own override only (so an estimate with no override showed 0%, while the send dialog
 * previewed and the server charged the organisation default), and post-send it read the frozen
 * send_config unconditionally (so the deposit went on presenting itself as simply due at the old
 * amount however far the total had since moved).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { EstimateReceiptCard, type EstimateReceiptCardEstimate } from '@/components/estimates/EstimateReceiptCard';

vi.mock('@/lib/api/estimates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/estimates')>('@/lib/api/estimates');
  return { ...actual, updateEstimate: vi.fn().mockResolvedValue({}) };
});

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return { ...actual, fetchStateTaxRates: vi.fn().mockResolvedValue([]) };
});

vi.mock('@/lib/api/organization', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/organization')>('@/lib/api/organization');
  return {
    ...actual,
    useOrganization: () => ({
      data: {
        deposit_default_type: 'PERCENTAGE',
        deposit_default_percentage: 25,
        deposit_default_fixed_amount: 0,
      },
    }),
  };
});

function estimate(overrides: Partial<EstimateReceiptCardEstimate> = {}): EstimateReceiptCardEstimate {
  return {
    id: 'est-1',
    subtotal: 2200,
    discount_amount: 0,
    discount_type: null,
    discount_value: null,
    discount_name: null,
    tax_rate: 0,
    tax_amount: 0,
    total_amount: 2200,
    deposit_type: null,
    deposit_value: null,
    send_config: null,
    line_items: [],
    scopes: [],
    ...overrides,
  };
}

/** The "Deposit due now" row, as the salesperson reads it. */
function depositRow(): HTMLElement {
  return screen.getByText('Deposit due now').closest('div')!.parentElement as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the deposit the receipt card shows', () => {
  it("is the organisation's default when the estimate carries no override", () => {
    renderWithProviders(<EstimateReceiptCard estimate={estimate()} canEditNow />);

    // 25% of $2,200 — the figure the send dialog previews and the server charges. The card used
    // to read the absent override as 0%.
    expect(within(depositRow()).getByText('25%')).toBeInTheDocument();
    expect(within(depositRow()).getByText('$550.00')).toBeInTheDocument();
  });

  it('is the estimate\'s own override when it carries one, not the organisation default', () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({ deposit_type: 'PERCENTAGE', deposit_value: 70 })}
        canEditNow
      />,
    );

    expect(within(depositRow()).getByText('$1,540.00')).toBeInTheDocument();
  });

  it('shows a FIXED override to the cent rather than round-tripping it through a percent', () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({ total_amount: 1000, subtotal: 1000, deposit_type: 'FIXED', deposit_value: 333.33 })}
        canEditNow
      />,
    );

    expect(within(depositRow()).getByText('$333.33')).toBeInTheDocument();
  });

  it('holds the figure the customer was presented after the total is edited', () => {
    // Ran's photograph: sent at $2,380.40 with a 50% deposit, then the line items were removed.
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({
          subtotal: 0,
          total_amount: 0,
          send_config: { deposit_percentage: 50, deposit_amount: 1190.2 },
        })}
        canEditNow
      />,
    );

    // Held, not silently recalculated to $0 — the customer holds a live link for this amount.
    expect(within(depositRow()).getByText('$1,190.20')).toBeInTheDocument();
  });
});

/**
 * #2031 slice 3 — stop concealing a deposit that exceeds the total.
 *
 * "Balance on completion" was clamped with Math.max(0, …), which turned an impossible state into
 * a plausible-looking $0.00 and hid the mismatch from the person best placed to fix it.
 */
describe('a deposit that no longer reconciles with the total', () => {
  const SENT_THEN_EMPTIED = estimate({
    subtotal: 0,
    total_amount: 0,
    send_config: { deposit_percentage: 50, deposit_amount: 1190.2 },
  });

  it('is named as a problem rather than shown as a zero balance', () => {
    renderWithProviders(<EstimateReceiptCard estimate={SENT_THEN_EMPTIED} canEditNow />);

    expect(screen.getByRole('status')).toHaveTextContent(
      /deposit of \$1,190\.20 is more than the \$0\.00 total/i,
    );
    expect(screen.queryByText('Balance on completion')).not.toBeInTheDocument();
  });

  it('names both figures when the total moved without falling below the deposit', () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({
          subtotal: 1500,
          total_amount: 1500,
          send_config: { deposit_percentage: 50, deposit_amount: 1100 },
        })}
        canEditNow
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(/\$1,100\.00/);
    expect(screen.getByRole('status')).toHaveTextContent(/\$1,500\.00/);
  });

  it('leaves a consistent deposit exactly as it renders today', () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({
          send_config: { deposit_percentage: 25, deposit_amount: 550 },
        })}
        canEditNow
      />,
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Balance on completion')).toBeInTheDocument();
    expect(within(depositRow()).getByText('$550.00')).toBeInTheDocument();
  });
});
