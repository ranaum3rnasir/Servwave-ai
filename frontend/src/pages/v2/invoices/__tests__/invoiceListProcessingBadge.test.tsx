/**
 * Payments go-live slice 28: an invoice with bank money still clearing says so in the list, so
 * nobody chases a customer who has already paid. The amount is derived (the invoice has no
 * "processing" status); the badge appears only while a payment is processing.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CellContext } from '@tanstack/react-table';
import type { ReactElement } from 'react';

import { buildInvoiceColumns, type InvoiceListItem } from '../invoicesColumns';

function statusCell(inv: Partial<InvoiceListItem>) {
  const col = buildInvoiceColumns([], () => {}, () => {}, 'America/New_York').find((c) => c.id === 'status')!;
  const cell = col.cell as (ctx: CellContext<InvoiceListItem, unknown>) => ReactElement;
  return render(cell({ row: { original: inv } } as unknown as CellContext<InvoiceListItem, unknown>));
}

describe('invoices list status column', () => {
  it('badges the bank money in flight next to the status', () => {
    statusCell({ status: 'SENT', due_date: null, processing_amount: 60 });

    expect(screen.getByText('Processing $60.00')).toBeInTheDocument();
  });

  it('shows no badge when nothing is processing', () => {
    statusCell({ status: 'SENT', due_date: null, processing_amount: 0 });

    expect(screen.queryByText(/Processing/)).not.toBeInTheDocument();
  });

  it('shows no badge on a row from a payload without the field', () => {
    statusCell({ status: 'SENT', due_date: null });

    expect(screen.queryByText(/Processing/)).not.toBeInTheDocument();
  });
});
