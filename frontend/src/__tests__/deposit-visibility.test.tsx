// A deposit invoice was indistinguishable from an ordinary one in the list: same
// "Paid" chip, same Total column, no marker. The API has always sent `kind`; the
// list simply never read it. Combined with the (correct) exclusion of deposits
// from every revenue figure, that made a screen full of paid deposits read as a
// screen full of earned revenue.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { flexRender, type ColumnDef } from '@tanstack/react-table';

import { renderWithProviders } from './helpers';
import { buildInvoiceColumns, type InvoiceListItem } from '@/pages/v2/invoices/invoicesColumns';
import { invoicesRegistry } from '@/lib/filters/registries/invoices';
import { WIDGETS } from '@/components/dashboard/widgetRegistry';

const ROW: InvoiceListItem = {
  id: 'i1', invoice_number: '597033', status: 'PAID', kind: 'STANDARD',
  subtotal: 100, discount_amount: 0, tax_amount: 0, deposit_credit: 0,
  total_amount: 100, amount_due: 0,
  due_date: null, sent_at: null, paid_at: null, created_at: '2026-09-15T00:00:00.000Z',
  customer: { id: 'c1', first_name: 'A', last_name: 'B', company_name: null },
  job: null,
};

/** Render just the Invoice # cell for one row, without mounting the whole page. */
function renderInvoiceNumberCell(row: InvoiceListItem) {
  const columns = buildInvoiceColumns([], vi.fn(), vi.fn(), 'America/New_York');
  const col = columns.find((c) => c.id === 'invoice_number') as ColumnDef<InvoiceListItem, unknown>;
  const cell = (col.cell as (ctx: unknown) => unknown)({ row: { original: row } });
  renderWithProviders(<>{flexRender(() => cell, {})}</>);
}

describe('a deposit is visibly a deposit in the invoice list', () => {
  it('badges a DEPOSIT row', () => {
    renderInvoiceNumberCell({ ...ROW, kind: 'DEPOSIT' });

    expect(screen.getByText('Deposit')).toBeInTheDocument();
    expect(screen.getByText('597033')).toBeInTheDocument();
  });

  it('leaves an ordinary invoice unbadged, so the marker means something', () => {
    renderInvoiceNumberCell({ ...ROW, kind: 'STANDARD' });

    expect(screen.queryByText('Deposit')).toBeNull();
    expect(screen.getByText('597033')).toBeInTheDocument();
  });

  it('offers a Type facet so deposits can be isolated or excluded', () => {
    const kindFacet = invoicesRegistry.find((f) => f.key === 'kind');

    expect(kindFacet).toBeDefined();
    expect(kindFacet!.label).toBe('Type');
    expect(kindFacet!.options?.map((o) => o.value)).toEqual(['STANDARD', 'DEPOSIT', 'PLAN']);
    // "Invoice", not "Standard": the label a contractor reads for the ordinary
    // case should be the word they already use for it.
    expect(kindFacet!.options?.find((o) => o.value === 'STANDARD')?.label).toBe('Invoice');
  });
});

describe('the revenue KPI drops the abbreviation', () => {
  const widget = WIDGETS['kpi.revenue_mtd']!;

  it('keeps the widget id, so a customized home page survives the rename', () => {
    expect(widget.id).toBe('kpi.revenue_mtd');
  });

  it('is titled and labelled in words, not "MTD"', () => {
    expect(widget.title).toBe('Monthly Revenue');

    renderWithProviders(
      <>{widget.render({
        data: { kpis: { revenue_mtd: { invoiced: 0, collected: 3484, target: 55000, pct_of_goal: 6, vs_last_month_pct: -94 } } } as never,
        range: '30d',
        navigate: vi.fn(),
      })}</>,
    );

    expect(screen.getByText('Monthly Revenue')).toBeInTheDocument();
    expect(screen.queryByText(/MTD/)).toBeNull();
  });
});
