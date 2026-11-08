/**
 * The Work Order dialog a dispatcher opens from a job (#2028 slice 3, validation round).
 *
 * THE FOURTH SURFACE. `ViewWorkOrderDialog` renders the shared `EstimateDocumentView` with
 * `documentLabel="Work Order"` and is mounted from `JobDetailPage`, so slice 3's sectioning
 * reached it along with the public page and the two PDF templates — but it had no test anywhere
 * in the repo, so nothing said what a dispatcher now sees.
 *
 * These pin what it renders TODAY, post-slice. It passes `lineItems` and `scopeNotes` and never
 * passes `scopes`, so its sectioning is decided by those two alone. The dialog is rendered whole,
 * through the app's own query/router harness, rather than the raw document component underneath
 * it: the props it chooses to pass are half of what is being pinned here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { ViewWorkOrderDialog } from '@/components/jobs/ViewWorkOrderDialog';
import { printedRowAmounts, printedTotal, sectionHeadings, sumAmounts } from './estimate-document-dom';

const LINE_ITEMS = [
  {
    id: 'li-1',
    description: 'Commercial keypad\nSurface mount, weather rated',
    item_type: 'MATERIAL',
    quantity: 2,
    unit_price: 200,
    is_taxable: true,
    line_total: 400,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
  },
  {
    id: 'li-2',
    description: 'Install labour',
    item_type: 'SERVICE',
    quantity: 3,
    unit_price: 150,
    is_taxable: true,
    // Stored PRE-discount, as calculateTotals persists it: the net 405 is what the subtotal holds.
    line_total: 450,
    discount_type: 'PERCENTAGE',
    discount_value: 10,
    discount_amount: 45,
  },
];

/** subtotal = 400 + (450 − 45) = 805; tax at 6.625% = 53.33; total = 858.33. */
const ESTIMATE = {
  id: 'est-1',
  estimate_number: 'E00042',
  scope_notes: null as string | null,
  line_items: LINE_ITEMS,
  subtotal: 805,
  tax_rate: 0.06625,
  tax_amount: 53.33,
  total_amount: 858.33,
  discount_type: null,
  discount_value: null,
  discount_name: null,
  discount_amount: null,
};

function openDialog(over: Record<string, unknown> = {}) {
  vi.mocked(api.get).mockResolvedValue({ data: { estimate: { ...ESTIMATE, ...over } } });
  return renderWithProviders(
    <ViewWorkOrderDialog
      open
      onOpenChange={() => {}}
      estimateId="est-1"
      customerName="Jane Doe"
      companyName="Doe Holdings"
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the Work Order a dispatcher opens from a job', () => {
  it('is titled as a Work Order, not as an estimate', async () => {
    openDialog();

    expect(await screen.findByRole('heading', { name: 'Work Order E00042' })).toBeInTheDocument();
    expect(screen.getByText(/Prepared for Jane Doe/)).toBeInTheDocument();
    expect(screen.queryByText(/Estimate E00042/)).toBeNull();
  });

  it('draws the job’s priced work as one unheaded list, with no scope section', async () => {
    openDialog();
    await screen.findByText('Commercial keypad');

    // The dialog never passes `scopes`, and this estimate carries no narrative either, so the
    // line-item section is the only one there is — and a lone section is drawn with no heading
    // over it (Ran, 2026-09-13), which returns this dialog to the unheaded list it drew before
    // #2028 slice 3. Intended: "Line Items" over the only list on a Work Order says nothing a
    // dispatcher cannot see.
    expect(sectionHeadings()).toEqual([]);
    expect(screen.getByText('Install labour')).toBeInTheDocument();
  });

  it('prints a total the dispatcher can reconcile against the rows above it', async () => {
    openDialog();
    await screen.findByText('Commercial keypad');

    const rows = printedRowAmounts();
    // Two rows, and the discounted one contributes its NET — the struck-through 450 above it is
    // what the work would have cost, not what this work order charges.
    expect(rows).toEqual([400, 405]);
    expect(screen.getByText('$450.00')).toBeInTheDocument();

    const subtotal = printedTotal('Subtotal');
    const tax = printedTotal(/^Tax/);
    const total = printedTotal('Total');
    expect(subtotal).toBe(sumAmounts(rows));
    expect(total).toBeCloseTo((subtotal ?? 0) + (tax ?? 0), 2);
  });

  it('heads the narrative "Scope of Work" above the line items when the job carries one', async () => {
    openDialog({ scope_notes: 'Crew to use the loading dock entrance.' });
    await screen.findByText('Commercial keypad');

    // With no `scopes` passed, the scope section is the narrative ALONE — a headed paragraph and
    // no priced rows — and the line items keep their own heading below it.
    expect(sectionHeadings()).toEqual(['Scope of Work', 'Line Items']);
    const scopeCard = document.querySelectorAll('h3')[0].parentElement!;
    expect(scopeCard.textContent).toContain('Crew to use the loading dock entrance.');
    expect(scopeCard.querySelector('.space-y-3')).toBeNull();

    // The narrative is prose, not a priced row: it moves neither the rows nor the subtotal.
    expect(printedRowAmounts()).toEqual([400, 405]);
    expect(printedTotal('Subtotal')).toBe(805);
  });

  it('fetches the work order only while it is open', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { estimate: ESTIMATE } });
    renderWithProviders(
      <ViewWorkOrderDialog
        open={false}
        onOpenChange={() => {}}
        estimateId="est-1"
        customerName="Jane Doe"
      />,
    );

    expect(api.get).not.toHaveBeenCalled();
  });
});
