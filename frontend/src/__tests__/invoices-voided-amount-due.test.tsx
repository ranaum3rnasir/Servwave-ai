// Payments go-live slice 32c: a voided invoice's row in the routed Invoices list shows nothing as
// due (voiding keeps the stored amount_due as history), matching the Due tile that leaves voided
// invoices out. A SENT row beside it still prints its amount.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from './helpers';

const mockApi = vi.mocked(api);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const row = (over: Record<string, unknown>) => ({
  kind: 'STANDARD', subtotal: '0', discount_amount: '0', tax_amount: '0', deposit_credit: '0',
  due_date: null, sent_at: '2026-06-01T00:00:00.000Z', paid_at: null, created_at: '2026-06-01T00:00:00.000Z',
  job: null,
  customer: { id: 'c1', first_name: 'Dana', last_name: 'Deposit', company_name: null },
  ...over,
});

const VOIDED = row({ id: 'a1', invoice_number: 'I-VOID', status: 'VOIDED', total_amount: '300.00', amount_due: '227.22' });
const SENT = row({ id: 'a2', invoice_number: 'I-SENT', status: 'SENT', total_amount: '400.00', amount_due: '123.45' });

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  mockApi.get.mockReset();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/invoices') {
      return Promise.resolve({
        data: {
          invoices: [VOIDED, SENT], total: 2, page: 1, pageSize: 25,
          stats: { due: { total: 123.45, count: 1 }, overdue: { total: 0, count: 0 }, collected_this_month: { total: 0, count: 0 }, unsent: 0, need_invoices: 0, deposits_held: 0 },
        },
      });
    }
    if (url === '/api/jobs') return Promise.resolve({ data: { jobs: [] } });
    return Promise.resolve({ data: {} });
  });
});

const { default: InvoicesPage } = await import('@/pages/v2/invoices/InvoicesPage');

describe('Invoices list Amount Due cell', () => {
  it('shows no amount due on a voided invoice, and still shows it on a sent one', async () => {
    renderWithProviders(<InvoicesPage />);

    const voidedRow = (await screen.findByText('I-VOID')).closest('tr') as HTMLElement;
    const sentRow = (await screen.findByText('I-SENT')).closest('tr') as HTMLElement;

    await waitFor(() => expect(within(sentRow).getByText('$123.45')).toBeInTheDocument());
    expect(within(voidedRow).queryByText('$227.22')).toBeNull();
    expect(within(voidedRow).getByText('$300.00')).toBeInTheDocument();
  });

  it('right-aligns the voided dash under the right-aligned header, and leaves the no-job dash left-aligned', async () => {
    renderWithProviders(<InvoicesPage />);

    const voidedRow = (await screen.findByText('I-VOID')).closest('tr') as HTMLElement;
    const table = voidedRow.closest('table') as HTMLElement;
    const heads = Array.from(table.querySelectorAll('th')).map((h) => h.textContent ?? '');
    const cellDash = (label: string) => {
      const idx = heads.findIndex((h) => h.includes(label));
      expect(idx).toBeGreaterThanOrEqual(0);
      return voidedRow.querySelectorAll('td')[idx].querySelector('span');
    };
    expect(cellDash('Amount Due')?.className).toContain('text-right');
    expect(cellDash('Job')?.className).not.toContain('text-right');
  });
});
