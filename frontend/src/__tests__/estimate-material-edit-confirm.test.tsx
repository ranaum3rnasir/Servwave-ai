/**
 * #2030 slice 5 — the first material edit after a send prompts, once per version.
 *
 * Editing a SENT estimate already invalidates the customer's link and voids a pending signature.
 * The server has always done both. This makes them visible to the person about to cause them —
 * once, because the link is already dead by the second edit and repeating it is noise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { EstimateReceiptCard, type EstimateReceiptCardEstimate } from '@/components/estimates/EstimateReceiptCard';
import * as estimatesApi from '@/lib/api/estimates';

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
    useOrganization: () => ({ data: { deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50 } }),
  };
});

function estimate(over: Partial<EstimateReceiptCardEstimate> = {}): EstimateReceiptCardEstimate {
  return {
    id: 'est-1',
    status: 'SENT',
    version: 1,
    signature_data: null,
    subtotal: 1000,
    discount_amount: 0,
    discount_type: null,
    discount_value: null,
    discount_name: null,
    tax_rate: 0,
    tax_amount: 0,
    total_amount: 1000,
    deposit_type: 'PERCENTAGE',
    deposit_value: 50,
    send_config: null,
    line_items: [],
    scopes: [],
    ...over,
  };
}

/** Change the deposit — a material edit by the server's own definition. */
async function editDeposit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox'));
  await user.click(await screen.findByRole('option', { name: '25%' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe('editing a sent estimate', () => {
  it('asks before the first material edit, naming the link invalidation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateReceiptCard estimate={estimate()} canEditNow />);

    await editDeposit(user);

    expect(await screen.findByText('Edit this sent estimate?')).toBeInTheDocument();
    expect(screen.getByText(/link .* will stop working/i)).toBeInTheDocument();
    // Nothing has been written yet — the question comes BEFORE the PATCH.
    expect(estimatesApi.updateEstimate).not.toHaveBeenCalled();
  });

  it('names the signature void when the customer has already signed', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateReceiptCard estimate={estimate({ status: 'PENDING', signature_data: 'data:image/png;base64,AAA' })} canEditNow />,
    );

    await editDeposit(user);

    expect(await screen.findByText(/signature .* voided/i)).toBeInTheDocument();
  });

  it('omits the signature clause when there is nothing to void', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateReceiptCard estimate={estimate()} canEditNow />);

    await editDeposit(user);
    await screen.findByText('Edit this sent estimate?');

    expect(screen.queryByText(/signature/i)).not.toBeInTheDocument();
  });

  it('leaves the estimate untouched when the salesperson declines', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateReceiptCard estimate={estimate()} canEditNow />);

    await editDeposit(user);
    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(estimatesApi.updateEstimate).not.toHaveBeenCalled();
  });

  it('goes ahead once confirmed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateReceiptCard estimate={estimate()} canEditNow />);

    await editDeposit(user);
    await user.click(await screen.findByRole('button', { name: /edit anyway/i }));

    await waitFor(() =>
      expect(estimatesApi.updateEstimate).toHaveBeenCalledWith('est-1', {
        deposit_type: 'PERCENTAGE',
        deposit_value: 25,
      }),
    );
  });

  it('does not ask again for the same version', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateReceiptCard estimate={estimate()} canEditNow />);

    await editDeposit(user);
    await user.click(await screen.findByRole('button', { name: /edit anyway/i }));
    await waitFor(() => expect(estimatesApi.updateEstimate).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: '33%' }));

    await waitFor(() => expect(estimatesApi.updateEstimate).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Edit this sent estimate?')).not.toBeInTheDocument();
  });

  it('never asks about a draft — nothing is out with a customer to break', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateReceiptCard estimate={estimate({ status: 'DRAFT' })} canEditNow />);

    await editDeposit(user);

    await waitFor(() => expect(estimatesApi.updateEstimate).toHaveBeenCalled());
    expect(screen.queryByText('Edit this sent estimate?')).not.toBeInTheDocument();
  });

  it('introduces no Save button — fields still commit on their own', () => {
    renderWithProviders(<EstimateReceiptCard estimate={estimate()} canEditNow />);

    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
  });
});
