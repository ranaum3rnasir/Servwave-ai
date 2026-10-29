import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import StatementPage from '@/pages/StatementPage';

// Mock useParams to render the JOB-scope statement.
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ jobId: 'job-1' }),
  };
});

const mockApi = vi.mocked(api);

const JOB_STATEMENT = {
  scope: 'job',
  job: { id: 'job-1', job_number: 'J00001' },
  lines: [
    {
      type: 'invoice',
      date: '2026-02-01T00:00:00.000Z',
      invoice_id: 'inv-1',
      invoice_number: 'I00001',
      invoice_kind: 'STANDARD',
      amount: 500,
      running_balance: 500,
    },
    {
      type: 'payment',
      date: '2026-02-05T00:00:00.000Z',
      invoice_id: 'inv-1',
      invoice_number: 'I00001',
      invoice_kind: 'STANDARD',
      amount: 200,
      running_balance: 300,
    },
  ],
  totals: { billed: 500, paid: 200, refunded: 0, credited: 0, balance: 300 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: JOB_STATEMENT });
});

describe('StatementPage (job scope)', () => {
  it('renders the ledger lines with running balance and totals', async () => {
    renderWithProviders(<StatementPage />);

    await waitFor(() => {
      expect(screen.getByText('Job Statement')).toBeInTheDocument();
    });

    // Two ledger rows, labelled by line type.
    expect(screen.getByText('Invoice')).toBeInTheDocument();
    expect(screen.getByText('Payment')).toBeInTheDocument();

    // Running balance column shows the row's own value (not recomputed).
    // $300.00 appears in both the payment row's running balance and the totals.
    expect(screen.getAllByText('$300.00').length).toBeGreaterThan(0);

    // Totals summary renders the balance as the bold bottom line.
    expect(screen.getByText('Balance')).toBeInTheDocument();
    expect(screen.getByText('Billed')).toBeInTheDocument();
  });

  it('exposes a Download PDF action', async () => {
    renderWithProviders(<StatementPage />);
    await waitFor(() => {
      expect(screen.getByText('Download PDF')).toBeInTheDocument();
    });
  });
});

// ─── Deposit-credit totals strip (regression) ──────────────
// A deposit-funded statement reconciles only when the strip shows a distinct
// 'Deposit credit' column between 'Paid' and 'Refunded' (Balance = Billed − Paid
// − Deposit credit − Credited + Refunded). Cash-only statements must omit it so
// the strip never shows a $0.00 deposit column.

// Deposit-funded: $80,000 billed, $5,625 cash paid, $74,375 deposit drawn down →
// $0.00 balance. The deposit drawdown is its OWN totals column, NOT folded into Paid.
const DEPOSIT_FUNDED_STATEMENT = {
  scope: 'job',
  job: { id: 'job-1', job_number: 'J00001' },
  lines: [
    {
      type: 'invoice',
      date: '2026-02-01T00:00:00.000Z',
      invoice_id: 'inv-1',
      invoice_number: 'I00001',
      invoice_kind: 'STANDARD',
      amount: 80000,
      running_balance: 80000,
    },
    {
      type: 'deposit_credit',
      date: '2026-02-02T00:00:00.000Z',
      invoice_id: 'inv-1',
      invoice_number: 'I00001',
      invoice_kind: 'STANDARD',
      amount: 74375,
      running_balance: 5625,
    },
    {
      type: 'payment',
      date: '2026-02-05T00:00:00.000Z',
      invoice_id: 'inv-1',
      invoice_number: 'I00001',
      invoice_kind: 'STANDARD',
      amount: 5625,
      running_balance: 0,
    },
  ],
  totals: {
    billed: 80000,
    paid: 5625,
    deposit_credit: 74375,
    refunded: 0,
    credited: 0,
    balance: 0,
  },
};

// Cash-only: deposit_credit omitted entirely (0 by default on the backend).
const CASH_ONLY_STATEMENT = {
  scope: 'job',
  job: { id: 'job-1', job_number: 'J00001' },
  lines: [
    {
      type: 'invoice',
      date: '2026-02-01T00:00:00.000Z',
      invoice_id: 'inv-1',
      invoice_number: 'I00001',
      invoice_kind: 'STANDARD',
      amount: 500,
      running_balance: 500,
    },
    {
      type: 'payment',
      date: '2026-02-05T00:00:00.000Z',
      invoice_id: 'inv-1',
      invoice_number: 'I00001',
      invoice_kind: 'STANDARD',
      amount: 200,
      running_balance: 300,
    },
  ],
  totals: { billed: 500, paid: 200, refunded: 0, credited: 0, balance: 300 },
};

describe('StatementPage deposit-credit totals strip', () => {
  it('renders a Deposit credit cell with its amount when deposit_credit is non-zero', async () => {
    mockApi.get.mockResolvedValue({ data: DEPOSIT_FUNDED_STATEMENT });
    renderWithProviders(<StatementPage />);

    await waitFor(() => {
      expect(screen.getByText('Job Statement')).toBeInTheDocument();
    });

    // Locate the totals-strip cell (the strip uses an uppercase 10px label).
    // The label also appears once as the ledger-row description, so scope to the
    // strip cell — assert the label AND its formatted amount render together there.
    const stripLabel = screen
      .getAllByText('Deposit credit')
      .find((el) => el.className.includes('uppercase'));
    expect(stripLabel).toBeDefined();
    const stripCell = stripLabel!.closest('div')!;
    expect(stripCell).toHaveTextContent('$74,375.00');

    // It sits alongside the existing reconciling columns.
    expect(screen.getByText('Billed')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Refunded')).toBeInTheDocument();
  });

  it('omits the Deposit credit cell on a cash-only statement', async () => {
    mockApi.get.mockResolvedValue({ data: CASH_ONLY_STATEMENT });
    renderWithProviders(<StatementPage />);

    await waitFor(() => {
      expect(screen.getByText('Job Statement')).toBeInTheDocument();
    });

    // No deposit drawdown → no $0.00 deposit column in the totals strip.
    expect(screen.queryByText('Deposit credit')).not.toBeInTheDocument();
  });
});
