/**
 * "+ Add tax rate" inside a tax-rate dropdown — an org can define a custom rate without leaving the
 * document it is editing. The rate is persisted to the organization's own list
 * (POST /api/org-tax-rates) AND applied to the open document in one go.
 *
 * Hosted on EstimateReceiptCard because that is a real caller of the shared <ReceiptCard> tax
 * select, wired to a live onTaxRateChange.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { EstimateReceiptCard, type EstimateReceiptCardEstimate } from '@/components/estimates/EstimateReceiptCard';
import * as estimatesApi from '@/lib/api/estimates';
import * as orgTaxRatesApi from '@/lib/api/org-tax-rates';

vi.mock('@/lib/api/estimates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/estimates')>('@/lib/api/estimates');
  return { ...actual, updateEstimate: vi.fn().mockResolvedValue({}) };
});

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return {
    ...actual,
    fetchStateTaxRates: vi
      .fn()
      .mockResolvedValue([{ id: 't1', state_code: 'TX', state_name: 'Texas', tax_rate: 0.0625 }]),
  };
});

vi.mock('@/lib/api/org-tax-rates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/org-tax-rates')>('@/lib/api/org-tax-rates');
  return {
    ...actual,
    createOrgTaxRate: vi.fn().mockResolvedValue({
      id: 'org-rate-1',
      name: 'Hoboken Combined',
      rate: 0.08375,
      created_at: '',
      updated_at: '',
    }),
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
    job_id: null,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

async function openAddDialog() {
  const user = userEvent.setup();
  renderWithProviders(<EstimateReceiptCard estimate={estimate()} canEditNow />);

  await user.click(await screen.findByRole('combobox', { name: 'Tax jurisdiction' }));
  await user.click(await screen.findByRole('option', { name: '+ Add tax rate' }));
  expect(await screen.findByTestId('add-tax-rate-dialog')).toBeInTheDocument();
  return user;
}

describe('Add tax rate from the tax-rate dropdown', () => {
  it('saves the new rate to the org list and applies it to the open estimate', async () => {
    const user = await openAddDialog();

    await user.type(screen.getByLabelText('Name'), 'Hoboken Combined');
    await user.type(screen.getByLabelText('Tax rate %'), '8.375');
    await user.click(screen.getByTestId('add-tax-rate-submit'));

    // Percent in the field, fraction on the wire.
    await waitFor(() =>
      expect(orgTaxRatesApi.createOrgTaxRate).toHaveBeenCalledWith({
        name: 'Hoboken Combined',
        rate: 0.08375,
      }),
    );

    await waitFor(() =>
      expect(estimatesApi.updateEstimate).toHaveBeenCalledWith(
        'est-1',
        expect.objectContaining({ tax_rate: 0.08375 }),
      ),
    );
  });

  it('does not change the estimate tax rate just by opening the dialog', async () => {
    await openAddDialog();
    expect(estimatesApi.updateEstimate).not.toHaveBeenCalled();
  });

  it('keeps Save disabled until both a name and a rate are entered', async () => {
    const user = await openAddDialog();
    const save = screen.getByTestId('add-tax-rate-submit');

    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Name'), 'Hoboken Combined');
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Tax rate %'), '8.375');
    expect(save).toBeEnabled();
  });
});
