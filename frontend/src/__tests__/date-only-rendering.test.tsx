/**
 * Date-only fields must be read back in UTC.
 *
 * `invoices.due_date` is a calendar day, stored at UTC midnight. Rendering it
 * with a local-time renderer (`new Date(due_date).toLocaleDateString()`) shows
 * the PREVIOUS day to every viewer west of UTC - so a US contractor saw an
 * invoice fall due a day earlier than it does, on the list, on the detail page
 * and on the customer-facing public page.
 *
 * This is the mirror image of the `paid_at` bug fixed in #1249/PR #1250: there a
 * date-only value was written into an instant column, here an instant renderer
 * is pointed at a date-only column.
 *
 * The timezone is pinned rather than inherited. Under an ambient TZ of UTC
 * (which is what CI runs) the buggy and the fixed renderer agree on every
 * assertion in this file, and the guard would be vacuous.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import InvoicesPage from '@/pages/InvoicesPage';

const mockApi = vi.mocked(api);

// The 1st of the month at UTC midnight is July 31st in every US timezone - the
// worst case, and the one a month-end due date actually hits.
const DUE_DATE = '2026-08-01T00:00:00.000Z';

const INVOICE_LIST_FIXTURE = {
  invoices: [
    {
      id: 'i0000000-0000-0000-0000-000000000001',
      invoice_number: 'I00001',
      status: 'SENT',
      kind: 'STANDARD',
      subtotal: 100,
      discount_amount: 0,
      tax_amount: 10,
      deposit_credit: 0,
      total_amount: 110,
      amount_due: 110,
      due_date: DUE_DATE,
      sent_at: '2026-07-15T12:00:00.000Z',
      paid_at: null,
      created_at: '2026-07-15T12:00:00.000Z',
      customer: {
        id: 'c0000000-0000-0000-0000-000000000001',
        first_name: 'John',
        last_name: 'Doe',
        company_name: null,
      },
      job: null,
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  stats: {
    due: { total: 1500, count: 2 },
    overdue: { total: 500, count: 1 },
    collected_this_month: { total: 2000, count: 3 },
    unsent: 1,
    need_invoices: 4,
  },
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('date-only fields render as the stored calendar day', () => {
  // vi.stubEnv, not a manual save/restore: TZ is normally unset, and assigning the
  // saved `undefined` back writes the STRING "undefined", which Node reads as an
  // invalid zone and silently falls back to UTC - poisoning the ambient timezone for
  // every later test file in the same worker. unstubAllEnvs deletes the key properly.
  beforeAll(() => {
    vi.stubEnv('TZ', 'America/New_York');
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({ data: INVOICE_LIST_FIXTURE });
  });

  it('shows an invoice due date as Aug 1, not Jul 31', async () => {
    renderWithProviders(<InvoicesPage />);

    await waitFor(() => expect(screen.getByText('I00001')).toBeInTheDocument());

    expect(screen.getByText('August 1, 2026')).toBeInTheDocument();
    expect(screen.queryByText(/July 31, 2026|7\/31\/2026/)).not.toBeInTheDocument();
  });
});
