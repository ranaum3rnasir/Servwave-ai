/**
 * Roles & Permissions alignment, AL-05 (P11): a person without See prices gets every price left out of what the server
 * sends, and the screens draw no place for one: no column, no total, no tile, and never "$NaN" or "$0.00" where a figure
 * should have been.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { buildAbility, canSeePrices } from '@/lib/ability';
import { formatCurrency, formatCurrencyWhole } from '@/lib/utils';
import { PriceFreeLines } from '@/components/money/PriceFreeLines';
import { buildInvoiceColumns, INVOICE_PRICE_COLUMN_IDS, toInvoiceExportRow, type InvoiceListItem } from '@/pages/v2/invoices/invoicesColumns';
import { buildEstimateColumns } from '@/pages/v2/estimates/estimatesColumns';
import { buildPaymentColumns, PAYMENT_PRICE_COLUMN_IDS, toPaymentExportRow } from '@/pages/v2/payments/components/paymentsColumns';
import { paymentsRegistryFor } from '@/lib/filters/registries/payments';

describe('the price ability', () => {
  it('is held only through the Prices grant, never through View on a record', () => {
    expect(canSeePrices(buildAbility([{ action: 'read', subject: 'Invoice' }] as never))).toBe(false);
    expect(canSeePrices(buildAbility([{ action: 'read', subject: 'Prices' }] as never))).toBe(true);
  });
});

describe('a price the server left out', () => {
  it('draws nothing, never "$NaN", while a real zero is still "$0.00"', () => {
    expect(formatCurrency(Number(undefined))).toBe('');
    expect(formatCurrency('abc')).toBe('');
    expect(formatCurrencyWhole(Number(undefined))).toBe('');
    expect(formatCurrency(0)).toBe('$0.00');
  });
});

describe('the priced line grids', () => {
  it('give way to a list of what the work is and how many, with no figure on it', () => {
    const { container } = render(
      <PriceFreeLines
        title="Scope of work"
        lines={[{ id: 'l1', description: 'Replace hinge', quantity: '2.00' }]}
        scopes={[{ id: 's1', title: 'Fit the door', body: 'Square it up' }]}
      />,
    );
    expect(screen.getByText('Replace hinge')).toBeInTheDocument();
    expect(screen.getByText('× 2')).toBeInTheDocument();
    expect(screen.getByText('Fit the door')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$|NaN/);
  });
});

describe('the lists', () => {
  it('lose the estimate Total column and the invoice money columns, which the page filters by id', () => {
    const estimateIds = buildEstimateColumns({ sorting: [], onToggleSort: () => {} }).map((c) => c.id);
    expect(estimateIds).toContain('total');
    const invoiceIds = buildInvoiceColumns([], () => {}, () => {}, 'America/New_York').map((c) => String(c.id));
    for (const id of INVOICE_PRICE_COLUMN_IDS) expect(invoiceIds, id).toContain(id);
    expect(invoiceIds.filter((id) => !INVOICE_PRICE_COLUMN_IDS.has(id))).toEqual(
      expect.arrayContaining(['invoice_number', 'customer', 'status', 'due_date']),
    );
  });

  it('write an invoice export row without a price when the person cannot see prices', () => {
    const inv = {
      invoice_number: 'I-1', customer: { first_name: 'A', last_name: 'B', company_name: null }, job: null, status: 'SENT', due_date: null,
      created_at: '2026-10-01T00:00:00.000Z',
    } as unknown as InvoiceListItem;
    const row = toInvoiceExportRow(inv, 'America/New_York', false);
    expect(Object.keys(row)).toEqual(expect.arrayContaining(['Invoice #', 'Status']));
    for (const label of ['Subtotal', 'Discount', 'Tax', 'Deposit Credit', 'Total', 'Amount Due']) expect(row, label).not.toHaveProperty(label);
  });

  it('write a payment export row without Amount, Fee or Net, and offer no Amount facet', () => {
    const columnIds = buildPaymentColumns({ sorting: [], onToggleSort: () => {}, timeZone: 'America/New_York' }).map((c) => String(c.id));
    for (const id of PAYMENT_PRICE_COLUMN_IDS) expect(columnIds, id).toContain(id);
    const row = toPaymentExportRow(
      { date: '2026-10-01T00:00:00.000Z', restricted: false, customer_name: 'A', invoice_number: 'I-1', method_label: 'Card', status: 'Succeeded' } as never,
      'America/New_York',
      false,
    );
    for (const label of ['Amount', 'Fee', 'Net']) expect(row, label).not.toHaveProperty(label);
    expect(paymentsRegistryFor(false).map((f) => f.key)).not.toContain('amount');
    expect(paymentsRegistryFor(true).map((f) => f.key)).toContain('amount');
  });
});
