/**
 * Payments go-live slice 28: the Refund dialog's list of earlier refunds says which of them have
 * not landed or did not go through, and reads the reason as words rather than the stored code.
 */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { RefundInvoiceDialog } from '@/components/invoices/RefundInvoiceDialog';

const refund = (o: Record<string, unknown>) => ({
  id: 'r', invoice_id: 'inv-1', amount: 10, method: 'ACH', created_at: '2026-07-03T00:00:00.000Z',
  reason_category: 'CUSTOMER_REQUEST', state: 'SUCCEEDED', ...o,
});

function open(refunds: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderWithProviders(<RefundInvoiceDialog open onOpenChange={() => {}} invoiceId="inv-1" netPaid={300} refunds={refunds as any} />);
  return within(screen.getByTestId('refund-invoice-dialog'));
}

describe('earlier refunds in the Refund dialog', () => {
  it('labels a refund still on its way Pending and one that did not go through Failed', () => {
    const dialog = open([
      refund({ id: 'a', state: 'PENDING', amount: 20 }),
      refund({ id: 'b', state: 'FAILED', amount: 30 }),
      refund({ id: 'c', state: 'SUCCEEDED', amount: 40 }),
    ]);

    expect(dialog.getByText('Pending')).toBeInTheDocument();
    expect(dialog.getByText('Failed')).toBeInTheDocument();
    // A refund that landed carries no label.
    expect(dialog.getAllByText(/Pending|Failed|Succeeded/)).toHaveLength(2);
  });

  it('reads the reason in words, never the raw code', () => {
    const dialog = open([refund({ reason_category: 'CUSTOMER_REQUEST' }), refund({ id: 'e', reason_category: 'ERROR' })]);

    expect(dialog.getAllByText(/Customer request/).length).toBeGreaterThan(0);
    expect(dialog.getAllByText(/Billing error/).length).toBeGreaterThan(0);
    expect(dialog.queryByText(/CUSTOMER_REQUEST/)).not.toBeInTheDocument();
  });

  it('reads the method in words, never the raw code', () => {
    const dialog = open([
      refund({ id: 'f', method: 'EXTERNAL_CARD' }),
      refund({ id: 'g', method: 'BANK_TRANSFER' }),
      refund({ id: 'h', method: 'ACH' }),
      refund({ id: 'i', method: 'CASH_APP' }),
    ]);

    expect(dialog.getByText('Card (outside ServWave)')).toBeInTheDocument();
    expect(dialog.getByText('Bank transfer')).toBeInTheDocument();
    expect(dialog.getByText('Bank (ACH)')).toBeInTheDocument();
    expect(dialog.getByText('Cash App')).toBeInTheDocument();
    expect(dialog.queryByText(/EXTERNAL|BANK TRANSFER|CASH APP/)).not.toBeInTheDocument();
  });
});
