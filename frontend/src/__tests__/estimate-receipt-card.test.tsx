/**
 * EstimateReceiptCard — the Estimate workspace's wrapper around the shared `<ReceiptCard>`.
 * Covers the review-fix M1/B8 wiring: the Discount row's %/$ mode toggle and the Deposit-due-now
 * box's %/$ mode toggle both genuinely persist `discount_type`/`discount_value` and
 * `deposit_type`/`deposit_value` via `updateEstimate()` — no fake/read-only controls, and no
 * precision loss round-tripping a FIXED deposit through a rounded implied percent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { EstimateReceiptCard, type EstimateReceiptCardEstimate } from '@/components/estimates/EstimateReceiptCard';
import * as estimatesApi from '@/lib/api/estimates';
import * as invoicesApi from '@/lib/api/invoices';

vi.mock('@/lib/api/estimates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/estimates')>('@/lib/api/estimates');
  return {
    ...actual,
    updateEstimate: vi.fn().mockResolvedValue({}),
  };
});

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    fetchStateTaxRates: vi.fn().mockResolvedValue([]),
  };
});

function estimate(overrides: Partial<EstimateReceiptCardEstimate> = {}): EstimateReceiptCardEstimate {
  return {
    id: 'est-1',
    subtotal: 1000,
    discount_amount: 0,
    discount_type: null,
    discount_value: null,
    discount_name: null,
    tax_rate: 0,
    tax_amount: 0,
    total_amount: 1000,
    deposit_type: null,
    deposit_value: null,
    send_config: null,
    line_items: [],
    scopes: [],
    ...overrides,
  };
}

const TAX_RATES = [{ id: 't1', state_code: 'TX', state_name: 'Texas', tax_rate: 0.0825 }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateReceiptCard — discount %/$ toggle (review fix M1)', () => {
  it('persists discount_type PERCENTAGE + the current draft value when the % mode is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({ discount_type: 'FIXED_AMOUNT', discount_value: 50, discount_amount: 50 })}
        canEditNow
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Discount as a percentage' }));

    await waitFor(() => {
      expect(estimatesApi.updateEstimate).toHaveBeenCalledWith(
        'est-1',
        expect.objectContaining({ discount_type: 'PERCENTAGE', discount_value: 50 }),
      );
    });
  });

  it('persists discount_value typed under FIXED_AMOUNT mode', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({ discount_type: 'FIXED_AMOUNT', discount_value: 50, discount_amount: 50 })}
        canEditNow
      />,
    );

    const input = screen.getByLabelText('Discount value');
    await user.clear(input);
    await user.type(input, '75');
    await user.tab();

    await waitFor(() => {
      expect(estimatesApi.updateEstimate).toHaveBeenCalledWith(
        'est-1',
        expect.objectContaining({ discount_type: 'FIXED_AMOUNT', discount_value: 75 }),
      );
    });
  });

  it('seeds the toggle from discount_type/discount_value, not hardcoded to FIXED_AMOUNT', () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({ discount_type: 'PERCENTAGE', discount_value: 15, discount_amount: 150 })}
        canEditNow
      />,
    );

    // Seeded from the raw percent (15), not the computed dollar discount_amount (150).
    expect(screen.getByLabelText('Discount value')).toHaveValue(15);
    expect(screen.getByRole('button', { name: 'Discount as a percentage' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not render the discount toggle/editor at all when canEditNow is false (no fake control)', () => {
    renderWithProviders(<EstimateReceiptCard estimate={estimate({ discount_amount: 50 })} canEditNow={false} />);

    expect(screen.queryByLabelText('Discount value')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Discount type' })).not.toBeInTheDocument();
  });
});

describe('EstimateReceiptCard — deposit %/$ toggle (review fix M1/B8)', () => {
  it('persists deposit_type FIXED (carrying over the current raw value) when the $ mode is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({ total_amount: 1000, deposit_type: 'PERCENTAGE', deposit_value: 50 })}
        canEditNow
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Deposit as a dollar amount' }));

    await waitFor(() => {
      expect(estimatesApi.updateEstimate).toHaveBeenCalledWith('est-1', { deposit_type: 'FIXED', deposit_value: 50 });
    });
  });

  it('persists a typed fixed-dollar deposit amount via deposit_type FIXED', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({ total_amount: 1000, deposit_type: 'FIXED', deposit_value: 300 })}
        canEditNow
      />,
    );

    const input = screen.getByLabelText('Deposit amount');
    await user.clear(input);
    await user.type(input, '450');
    await user.tab();

    await waitFor(() => {
      expect(estimatesApi.updateEstimate).toHaveBeenCalledWith('est-1', { deposit_type: 'FIXED', deposit_value: 450 });
    });
  });

  it('displays the raw FIXED deposit_value directly, without losing precision through a rounded implied percent', () => {
    // $333.33 on a $1,000 total used to round-trip through Math.round(33.333%) = 33% → $330.00.
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({ total_amount: 1000, deposit_type: 'FIXED', deposit_value: 333.33 })}
        canEditNow={false}
      />,
    );

    // Both the inline label and the hero figure show the un-rounded raw value.
    expect(screen.getAllByText('$333.33').length).toBeGreaterThan(0);
    expect(screen.queryByText('$330.00')).not.toBeInTheDocument();
  });

  it('does not render any deposit editing controls when the estimate is locked (canEditNow false)', () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({ total_amount: 1000, deposit_type: 'PERCENTAGE', deposit_value: 50 })}
        canEditNow={false}
      />,
    );

    expect(screen.queryByRole('group', { name: 'Deposit type' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Deposit amount')).not.toBeInTheDocument();
  });

  it('does not render deposit editing controls once the estimate has been sent (frozen, §G)', () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({
          total_amount: 1000,
          deposit_type: 'FIXED',
          deposit_value: 300,
          send_config: { deposit_percentage: 30, deposit_amount: 300 },
        })}
        canEditNow
      />,
    );

    expect(screen.queryByRole('group', { name: 'Deposit type' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Deposit amount')).not.toBeInTheDocument();
  });
});

describe('EstimateReceiptCard - job-anchored tax (E3, job-owns-tax-discount)', () => {
  beforeEach(() => {
    vi.mocked(invoicesApi.fetchStateTaxRates).mockResolvedValue(TAX_RATES);
  });

  afterEach(() => {
    // Restore the suite-wide default so the other describes keep their empty tax-rate list.
    vi.mocked(invoicesApi.fetchStateTaxRates).mockResolvedValue([]);
  });

  // E3 retired the job-anchored tax lock: a job-anchored estimate is a quote, the job is the
  // work, and they may legitimately differ - so the jurisdiction select is interactive either way.
  it('renders an interactive jurisdiction select when the estimate is attached to a job', async () => {
    renderWithProviders(
      <EstimateReceiptCard estimate={estimate({ job_id: 'job-1', tax_rate: 0.0825, tax_amount: 82.5 })} canEditNow />,
    );

    expect(await screen.findByRole('combobox', { name: 'Tax jurisdiction' })).toBeInTheDocument();
  });

  it('renders an interactive jurisdiction select when the estimate is NOT attached to a job', async () => {
    renderWithProviders(
      <EstimateReceiptCard estimate={estimate({ job_id: null, tax_rate: 0.0825, tax_amount: 82.5 })} canEditNow />,
    );

    expect(await screen.findByRole('combobox', { name: 'Tax jurisdiction' })).toBeInTheDocument();
  });

  it('sends tax_rate on a job-attached estimate when the jurisdiction is changed', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateReceiptCard estimate={estimate({ job_id: 'job-1', tax_rate: 0.0825, tax_amount: 82.5 })} canEditNow />,
    );

    const trigger = await screen.findByRole('combobox', { name: 'Tax jurisdiction' });
    await user.click(trigger);
    // "No tax (0%)" is always present and is a genuinely different option from the current 8.25%.
    await user.click(await screen.findByRole('option', { name: 'No tax (0%)' }));

    await waitFor(() => expect(estimatesApi.updateEstimate).toHaveBeenCalled());
    const bodies = vi.mocked(estimatesApi.updateEstimate).mock.calls.map(([, body]) => body as Record<string, unknown>);
    expect(bodies.some((body) => body.tax_rate === 0)).toBe(true);
  });
});

// #2053 AC12 — the breakdown rows never contradict the bold Subtotal, even when a fabricated
// estimate's optional-unselected lines total MORE than the server subtotal (so a regression that
// forgets the filter cannot hide behind equal numbers).
describe('EstimateReceiptCard — breakdown rows exclude optional-unselected lines/scopes (#2053 AC12)', () => {
  it("the Line items / Scope of work rows sum to the bold Subtotal, not the server's larger figure", async () => {
    renderWithProviders(
      <EstimateReceiptCard
        estimate={estimate({
          // Server subtotal is selection-correct (175); the fabricated line_items/scopes below
          // total 475 if the filter is forgotten — a regression cannot hide behind equal numbers.
          subtotal: 175,
          total_amount: 175,
          line_items: [
            {
              id: 'li-1', estimate_id: 'est-1', sequence: 1, description: 'Base', quantity: 1,
              unit_price: 100, unit_cost: null, markup_percent: null, is_taxable: true,
              line_total: 100, discount_type: null, discount_value: null, discount_amount: 0,
              item_type: 'SERVICE', price_book_item_id: null, is_optional: false, is_selected: true,
            },
            {
              id: 'li-2', estimate_id: 'est-1', sequence: 2, description: 'Add-on selected', quantity: 1,
              unit_price: 75, unit_cost: null, markup_percent: null, is_taxable: true,
              line_total: 75, discount_type: null, discount_value: null, discount_amount: 0,
              item_type: 'SERVICE', price_book_item_id: null, is_optional: true, is_selected: true,
            },
            {
              id: 'li-3', estimate_id: 'est-1', sequence: 3, description: 'Add-on unselected', quantity: 1,
              unit_price: 100, unit_cost: null, markup_percent: null, is_taxable: true,
              line_total: 100, discount_type: null, discount_value: null, discount_amount: 0,
              item_type: 'SERVICE', price_book_item_id: null, is_optional: true, is_selected: false,
            },
          ],
          scopes: [
            { id: 'sc-1', title: 'Optional scope', body: '', flat_price: 200, is_taxable: true, is_optional: true, is_selected: false },
          ],
        })}
        canEditNow
      />,
    );

    // Line items row = 100 + 75 (selected) = 175; add-on unselected (100) and the scope (200) are
    // excluded. Scope of work row is $0 (its only scope is unselected).
    expect(await screen.findByText('Line items')).toBeInTheDocument();
    const lineItemsRow = screen.getByText('Line items').closest('div');
    expect(lineItemsRow).toHaveTextContent('$175.00');
    expect(screen.getByText('Subtotal').closest('div')).toHaveTextContent('$175.00');
  });
});
