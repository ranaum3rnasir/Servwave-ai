/**
 * Mobile slice 59 (rubric CMP-01, VP-10): the statement page on a phone.
 *
 * Below md the four-column ledger table (411 px wide, in a 277 px box at 320) becomes a stacked
 * list: one entry per ledger line, the date and running balance under the description and the
 * signed amount. From md up the table is untouched. The layout is JS-chosen (useIsBelow), so one
 * variant mounts.
 *
 * This is the v2 page the routes serve (`pages/v2/customers/StatementPage`); the older
 * statement-page.test.tsx imports the legacy page, which no route reaches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import StatementPage from '@/pages/v2/customers/StatementPage';
import { MEDIA } from '@/ui-kit/lib/breakpoints';

const mockApi = vi.mocked(api);

const STATEMENT = {
  scope: 'customer',
  customer: { id: 'cust-1' },
  members: [],
  lines: [
    { type: 'invoice', date: '2026-02-01T12:00:00.000Z', invoice_id: 'inv-1', invoice_number: 'I00001', amount: 500, running_balance: 500 },
    { type: 'payment', date: '2026-02-05T12:00:00.000Z', invoice_id: 'inv-1', invoice_number: 'I00001', amount: 200, running_balance: 300 },
  ],
  totals: { billed: 500, paid: 200, refunded: 0, credited: 0, balance: 300 },
};

const originalMatchMedia = window.matchMedia;
function answerMedia(matches: (query: string) => boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderStatement() {
  return renderWithProviders(
    <Routes>
      <Route path="/customers/:customerId/statement" element={<StatementPage />} />
    </Routes>,
    { initialEntries: ['/customers/cust-1/statement'] },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: STATEMENT });
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('StatementPage - phone (below md)', () => {
  beforeEach(() => answerMedia((q) => q === MEDIA.belowMd));

  it('lists the ledger as stacked entries, not a table', async () => {
    renderStatement();
    const list = await screen.findByRole('list', { name: 'Statement activity' });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    const entries = within(list).getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    expect(within(entries[0]!).getByText('Invoice')).toBeInTheDocument();
    expect(within(entries[0]!).getByText(/I00001/)).toBeInTheDocument();
    expect(within(entries[0]!).getByText('$500.00', { selector: '[data-slot="amount"]' })).toBeInTheDocument();
    expect(within(entries[0]!).getByText('$500.00', { selector: '[data-slot="running-balance"]' })).toBeInTheDocument();
    // A payment reduces the balance: signed, with the running balance under it.
    expect(within(entries[1]!).getByText('Payment')).toBeInTheDocument();
    expect(within(entries[1]!).getByText('−$200.00')).toBeInTheDocument();
    expect(within(entries[1]!).getByText('$300.00', { selector: '[data-slot="running-balance"]' })).toBeInTheDocument();
  });

  it('keeps the totals strip, the Download PDF action and the empty state', async () => {
    renderStatement();
    await waitFor(() => expect(screen.getByTestId('statement-running-balance')).toHaveTextContent('$300.00'));
    expect(screen.getByText('Billed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download pdf/i })).toBeInTheDocument();
  });

  it('says so when there is no activity, instead of rendering an empty list', async () => {
    mockApi.get.mockResolvedValue({ data: { ...STATEMENT, lines: [] } });
    renderStatement();
    expect(await screen.findByText('No activity yet.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });
});

describe('StatementPage - md and up is unchanged', () => {
  it('renders the four-column table with its headers', async () => {
    renderStatement();
    const table = await screen.findByRole('table');
    for (const header of ['Date', 'Description', 'Amount', 'Running Balance']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    expect(screen.queryByRole('list', { name: 'Statement activity' })).not.toBeInTheDocument();
  });
});
