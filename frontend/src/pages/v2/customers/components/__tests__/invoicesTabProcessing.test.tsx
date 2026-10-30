import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { InvoicesTab, type CustomerInvoice } from '../detailTabs';

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', timezone: 'America/Los_Angeles' }, isLoading: false, isError: false }),
  };
});

function invoice(over: Partial<CustomerInvoice> = {}): CustomerInvoice {
  return {
    id: 'inv-1', invoice_number: 'I00392', status: 'SENT', kind: 'STANDARD',
    total_amount: 300, amount_due: 225.25, due_date: null, created_at: '2026-07-01T12:00:00.000Z',
    job_number: 'J00609', job_id: 'job-1', payments: [], ...over,
  } as CustomerInvoice;
}

// Payments go-live slice 28 conductor ruling D1: every staff invoice list badges bank money in flight.
describe('Customer Invoices tab - bank payment processing (D1)', () => {
  it('badges the invoice that has a payment clearing, and only that one', () => {
    renderWithProviders(
      <InvoicesTab invoices={[invoice({ processing_amount: 100 }), invoice({ id: 'inv-2', invoice_number: 'I00393', processing_amount: 0 })]} />,
    );
    expect(screen.getAllByTestId('processing-badge')).toHaveLength(1);
    expect(screen.getByText('Processing $100.00')).toBeInTheDocument();
  });

  it('shows no badge when the payload predates the field', () => {
    renderWithProviders(<InvoicesTab invoices={[invoice()]} />);
    expect(screen.queryByTestId('processing-badge')).not.toBeInTheDocument();
  });
});
