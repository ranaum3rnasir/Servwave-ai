// Payments go-live slice 32c: a voided invoice keeps its stored amount_due as history, but the
// customer Invoices tab (table and phone cards) never prints it as owed,
// and it does not call it "Paid" either. A sent invoice beside it still shows its amount.
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from './helpers';

const phoneMode = vi.hoisted(() => ({ value: false }));
vi.mock('@/pages/v2/_shared/useRecordCards', () => ({ useRecordCards: () => phoneMode.value }));

const { InvoicesTab } = await import('@/pages/v2/customers/components/detailTabs');
type CustomerInvoice = Parameters<typeof InvoicesTab>[0]['invoices'][number];

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const custInvoice = (over: Partial<CustomerInvoice>): CustomerInvoice => ({
  id: 'x', invoice_number: 'I-X', status: 'SENT', kind: 'STANDARD', total_amount: '300.00', amount_due: '0',
  due_date: null, created_at: '2026-06-01T00:00:00.000Z', job_number: null, job_id: null, payments: [], ...over,
});
const VOIDED = custInvoice({ id: 'v', invoice_number: 'I-VOID', status: 'VOIDED', amount_due: '227.22' });
const SENT = custInvoice({ id: 's', invoice_number: 'I-SENT', status: 'SENT', amount_due: '123.45' });

describe('customer Invoices tab Amount Due', () => {
  it('table view: a voided invoice prints no amount and no Paid badge; a sent one prints its amount', () => {
    phoneMode.value = false;
    renderWithProviders(<InvoicesTab invoices={[VOIDED, SENT]} />);

    const voidedRow = screen.getByText('I-VOID').closest('tr') as HTMLElement;
    const sentRow = screen.getByText('I-SENT').closest('tr') as HTMLElement;
    expect(within(sentRow).getByText('$123.45')).toBeInTheDocument();
    expect(within(voidedRow).queryByText('$227.22')).toBeNull();
    expect(within(voidedRow).queryByText('Paid')).toBeNull();
  });

  it('card view: a voided invoice prints no amount and no Paid badge; a sent one prints its amount', () => {
    phoneMode.value = true;
    renderWithProviders(<InvoicesTab invoices={[VOIDED, SENT]} />);

    expect(screen.getByText('$123.45')).toBeInTheDocument();
    expect(screen.queryByText('$227.22')).toBeNull();
    expect(screen.queryByText('Paid')).toBeNull();
  });
});
