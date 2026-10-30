import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, ALL_JOB_ACTIONS } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';

// Task 10 (Spec A) gated the Payments tab on ability.can('read', 'Invoice'); S04.26 gates it on the invoices the server lists
// (or the person being able to create one) instead, and Record Payment on Record payments.
//
// SRVW-140 REGRESSION LOCK - this fixture deliberately holds read Invoice and NO read Pricing.
// The card repointed seven frontend `can('read','Invoice')` cost/margin mirrors at the new
// `read Pricing` grant, but JobDetailPage.tsx:1456 (this tab) and CustomerDetailPage.tsx:1556
// are about invoice RECORDS and must NOT move - repointing them would hide real invoice
// surfaces from a user who is allowed to see them. Every case below goes red if either does.
// HONEST NOTE: this file passes before the fix too; it exists to fail if the wrong site moves.
const invoiceReadAbility = buildAbility([{ action: 'read', subject: 'Invoice' }]);
const recordPaymentAbility = buildAbility([{ action: 'read', subject: 'Invoice' }, { action: 'record_payment', subject: 'Invoice' }]);

// floating-ui (under Radix dropdown) does `new ResizeObserver(...)`
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'j0000000-0000-0000-0000-000000000001' }),
  };
});

const mockApi = vi.mocked(api);

const BASE_JOB = {
  id: 'j0000000-0000-0000-0000-000000000001',
  job_number: 'J00001',
  status: 'IN_PROGRESS',
  job_type: 'HVAC Installation',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: '2026-05-10T09:00:00.000Z',
  scheduled_end: null,
  started_at: '2026-05-10T09:00:00.000Z',
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  dispatcher: null,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Johnson',
    company_name: null,
    email: 'sarah@example.com',
    phone: '5125550198',
  },
  assignees: [] as { user: { id: string; first_name: string; last_name: string } }[],
  service_location: null,
  estimate: null,
  invoices: [] as Array<{
    id: string;
    invoice_number: string;
    status: string;
    total_amount: number | string;
    amount_due: number | string;
    created_at: string;
  }>,
  tags: [] as Array<{ id: string; name: string; color: string }>,
  source_plan_id: null,
  actions: ALL_JOB_ACTIONS,
  source_plan: null,
};

const FINANCIALS_PAID = {
  final_invoice: {
    id: 'inv1',
    invoice_number: 'I00007',
    total_amount: '1850',
    amount_due: '0',
    status: 'PAID',
    sent_at: null,
    paid_at: '2026-05-12T00:00:00.000Z',
  },
  invoices: [],
  payments: [
    {
      id: 'pay1',
      invoice_kind: 'DEPOSIT',
      amount: '500',
      method: 'CARD',
      paid_at: '2026-05-09T00:00:00.000Z',
      invoice_number: 'I00006',
    },
    {
      id: 'pay2',
      invoice_kind: 'STANDARD',
      amount: '1350',
      method: 'CARD',
      paid_at: '2026-05-12T00:00:00.000Z',
      invoice_number: 'I00007',
    },
  ],
};

const FINANCIALS_OPEN = {
  final_invoice: {
    id: 'inv2',
    invoice_number: 'I00009',
    total_amount: '2000',
    amount_due: '2000',
    status: 'SENT',
    sent_at: '2026-05-15T00:00:00.000Z',
    paid_at: null,
  },
  // The final invoice is one this person can open, so the server lists it.
  invoices: [
    { id: 'inv2', invoice_number: 'I00009', status: 'SENT', total_amount: '2000', amount_due: '2000', kind: 'STANDARD' },
  ],
  payments: [],
};

function mockJobWith(
  financials: typeof FINANCIALS_PAID | typeof FINANCIALS_OPEN | { final_invoice: null; invoices: never[]; payments: never[] }
) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/financials')) return { data: financials };
    if (url.includes('/notes')) return { data: { notes: [] } };
    if (url.includes('/attachments')) return { data: { attachments: [] } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    if (url.includes('/api/jobs/')) return { data: { job: BASE_JOB } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JobDetailPage — Payments tab', () => {
  it('lists deposit and final-invoice payments in the Payments tab', async () => {
    mockJobWith(FINANCIALS_PAID);
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });

    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    // Scope to the Payments tabpanel — the masthead money block now also shows a
    // deposit figure, so a page-wide /deposit/i query would match twice.
    await screen.findByText('$500.00');
    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getByText('$500.00')).toBeInTheDocument();
    expect(panel.getByText('$1,350.00')).toBeInTheDocument();
    expect(panel.getByText(/deposit/i)).toBeInTheDocument();
    expect(panel.getByText(/final/i)).toBeInTheDocument();
  });

  // Payments go-live slice 05: a bank payment still PROCESSING (or one that FAILED) is listed
  // but is not money paid - not in Total paid, the deposit figure or % collected.
  it('leaves a processing or failed payment out of Total paid, the deposit figure and % collected', async () => {
    mockJobWith({
      ...FINANCIALS_PAID,
      final_invoice: { ...FINANCIALS_PAID.final_invoice, amount_due: '1350', status: 'PARTIAL' },
      payments: [
        { ...FINANCIALS_PAID.payments[0], state: 'SUCCEEDED' },
        { ...FINANCIALS_PAID.payments[0], id: 'pay-dep-failed', amount: '300', state: 'FAILED' },
        { ...FINANCIALS_PAID.payments[1], method: 'ACH', state: 'PROCESSING' },
      ],
    });
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });
    // Masthead money block: $500 of $1,850 landed.
    expect(await screen.findByText('27% collected')).toBeInTheDocument();
    expect(screen.getByText('Deposit $500.00')).toBeInTheDocument();

    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));
    const panel = within(screen.getByRole('tabpanel'));
    const footer = panel.getByText('Total paid').closest('tr')!;
    expect(within(footer).getByText('$500.00')).toBeInTheDocument();
    // The processing payment is still in the history.
    expect(panel.getByText('$1,350.00')).toBeInTheDocument();
  });

  // Payments go-live slice 28: the Method column says how the customer paid, and a payment that
  // has not cleared or did not go through says so.
  it('reads each payment the way the customer paid, and labels a processing or failed one', async () => {
    mockJobWith({
      ...FINANCIALS_PAID,
      payments: [
        { ...FINANCIALS_PAID.payments[0], id: 'a', method: 'CARD', wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242' },
        { ...FINANCIALS_PAID.payments[1], id: 'b', method: 'ACH', state: 'PROCESSING', bank_name: 'Bank of Example', bank_last4: '6789' },
        { ...FINANCIALS_PAID.payments[1], id: 'c', method: 'ACH', state: 'FAILED' },
      ],
    });
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getByText('Apple Pay (Visa •••• 4242)')).toBeInTheDocument();
    expect(panel.getByText('Bank of Example •••• 6789')).toBeInTheDocument();
    expect(panel.getByText('Processing')).toBeInTheDocument();
    expect(panel.getByText('Failed')).toBeInTheDocument();
  });

  it('shows Record Payment link when invoice has amount_due > 0 and is not PAID', async () => {
    mockJobWith(FINANCIALS_OPEN);
    renderWithProviders(<JobDetailPage />, { ability: recordPaymentAbility });

    await screen.findByRole('heading', { name: /J00001/ });

    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    const link = await screen.findByRole('link', { name: /record payment/i });
    expect(link).toHaveAttribute('href', '/invoices/inv2');
  });

  it('shows no Record Payment link without Record payments (S04.26)', async () => {
    mockJobWith(FINANCIALS_OPEN);
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    await screen.findByRole('link', { name: 'I00009' });
    expect(screen.queryByRole('link', { name: /record payment/i })).not.toBeInTheDocument();
  });

  it('does NOT show Record Payment link when final invoice is PAID', async () => {
    mockJobWith(FINANCIALS_PAID);
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });

    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    await screen.findByText('$500.00');

    expect(screen.queryByRole('link', { name: /record payment/i })).not.toBeInTheDocument();
  });

  it('shows "No invoice yet" state when final_invoice is null', async () => {
    mockJobWith({ final_invoice: null, invoices: [], payments: [] });
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    expect(await screen.findByText(/no invoice yet/i)).toBeInTheDocument();
  });

  // Task 3.4 (spec §7.3) — the job PaymentsTab surfaces a reconciled CARD payment's fee
  // breakdown alongside the invoice ledger's.
  it('shows the combined fee figure for a reconciled CARD payment, with a drill-in split', async () => {
    mockJobWith({
      ...FINANCIALS_PAID,
      payments: FINANCIALS_PAID.payments.map((p) =>
        p.id === 'pay2'
          ? { ...p, stripe_fee_amount: '38.15', platform_fee_amount: '6.75', net_amount: '1305.10' }
          : p,
      ),
    });
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    // Combined = 38.15 + 6.75 = 44.90
    const feeTrigger = await screen.findByRole('button', { name: /Fee \$44\.90/ });
    await userEvent.click(feeTrigger);

    expect(await screen.findByText('ServWave platform fee - 0.5%')).toBeInTheDocument();
    expect(screen.getByText('-$38.15')).toBeInTheDocument();
    expect(screen.getByText('-$6.75')).toBeInTheDocument();
    expect(screen.getByText('$1,305.10')).toBeInTheDocument();
  });

  it('renders no fee figure for payments with no reconciled fee data (the pay1/pay2 default fixtures)', async () => {
    mockJobWith(FINANCIALS_PAID);
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    await screen.findByText('$1,350.00');
    expect(screen.queryByRole('button', { name: /^Fee / })).not.toBeInTheDocument();
  });

  // #948 — a deposit's credit is drawn down via a SEPARATE, mirrored Payment row
  // (reference_number: 'DEPOSIT-CREDIT') written on the STANDARD invoice, while the
  // original DEPOSIT invoice keeps its own real Payment row. Summing every raw payment
  // double-counts that money. Worked example: $1000 job, $600 deposit fully credited,
  // $400 still owed — must read 60% collected (real cash), never 100% with a balance shown.
  it('does not double-count a deposit credit toward % collected', async () => {
    mockJobWith({
      final_invoice: {
        id: 'inv3',
        invoice_number: 'I00010',
        total_amount: '1000',
        amount_due: '400',
        status: 'SENT',
        sent_at: '2026-05-20T00:00:00.000Z',
        paid_at: null,
      },
      invoices: [
        {
          id: 'dep1',
          invoice_number: 'I00011',
          status: 'PAID',
          total_amount: '600',
          amount_due: '0',
          kind: 'DEPOSIT',
        },
      ],
      payments: [
        {
          id: 'pay1',
          invoice_kind: 'DEPOSIT',
          amount: '600',
          method: 'CARD',
          paid_at: '2026-05-09T00:00:00.000Z',
          invoice_number: 'I00011',
          reference_number: null,
        },
        {
          id: 'pay2',
          invoice_kind: 'STANDARD',
          amount: '600',
          method: 'CARD',
          paid_at: '2026-05-09T00:00:00.000Z',
          invoice_number: 'I00010',
          reference_number: 'DEPOSIT-CREDIT',
        },
      ],
    });
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });

    // Masthead "Zone C — money block" renders unconditionally, before any tab click.
    await screen.findByText('Balance due');
    expect(screen.queryByText('100% collected')).not.toBeInTheDocument();
    expect(screen.getAllByText('60% collected').length).toBeGreaterThan(0);

    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getByText('60% collected')).toBeInTheDocument();
    // The payment-history footer must also reflect real cash only (not $1,200).
    expect(panel.queryByText('$1,200.00')).not.toBeInTheDocument();
    expect(panel.getByText('Total paid').closest('tr')).toHaveTextContent('$600.00');
  });
});

// The estimate-anchored job shape: the R6 conversion sets Estimate.job_id and leaves
// jobs.estimate_id null, so the job has a paid DEPOSIT invoice and no STANDARD one. Reproduces
// staging job 698630 (the pilot org), which showed a paid $3,467.67 deposit in Payment
// history while the Invoice card read "No invoice yet" and the masthead read "No contract yet".
describe('JobDetailPage - job linked to its estimate via EstimateJobLink', () => {
  const LINKED_ESTIMATE = {
    id: 'e0000000-0000-0000-0000-000000000001',
    estimate_number: 'E00001',
    total_amount: '4953.81',
    status: 'WON',
  };

  const DEPOSIT_ONLY_FINANCIALS = {
    final_invoice: null,
    invoices: [
      {
        id: 'dep1',
        invoice_number: 'I00042',
        status: 'PAID',
        total_amount: '3467.67',
        amount_due: '0',
        kind: 'DEPOSIT',
      },
    ],
    payments: [
      {
        id: 'pay1',
        invoice_kind: 'DEPOSIT',
        amount: '3467.67',
        method: 'BANK_TRANSFER',
        paid_at: '2026-08-04T00:00:00.000Z',
        invoice_number: 'I00042',
        reference_number: null,
      },
    ],
  };

  function mockLinkedJob(financials: unknown, job: Record<string, unknown> = {}) {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/financials')) return { data: financials };
      if (url.includes('/notes')) return { data: { notes: [] } };
      if (url.includes('/attachments')) return { data: { attachments: [] } };
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      if (url.includes('/api/jobs/')) {
        return { data: { job: { ...BASE_JOB, linked_estimates: [LINKED_ESTIMATE], ...job } } };
      }
      return { data: {} };
    });
  }

  it('lists the paid deposit invoice, with a link, instead of "No invoice yet"', async () => {
    mockLinkedJob(DEPOSIT_ONLY_FINANCIALS);
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.queryByText(/no invoice yet/i)).not.toBeInTheDocument();
    expect(panel.getByRole('link', { name: 'I00042' })).toHaveAttribute('href', '/invoices/dep1');
  });

  it('derives the masthead contract and balance from the linked estimate', async () => {
    mockLinkedJob(DEPOSIT_ONLY_FINANCIALS);
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });

    expect(await screen.findByText('Balance due')).toBeInTheDocument();
    expect(screen.queryByText(/no contract yet/i)).not.toBeInTheDocument();
    // 4953.81 contract - 3467.67 deposit collected = 1486.14 outstanding.
    expect(screen.getByText('$1,486.14')).toBeInTheDocument();
    expect(screen.getByText(/Contract/).textContent).toContain('$4,953.81');
  });

  it('renders the payment method label, not the raw enum', async () => {
    mockLinkedJob(DEPOSIT_ONLY_FINANCIALS);
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getByText('Bank transfer')).toBeInTheDocument();
    expect(panel.queryByText('BANK_TRANSFER')).not.toBeInTheDocument();
  });

  it('omits voided invoices from the card', async () => {
    mockLinkedJob({
      ...DEPOSIT_ONLY_FINANCIALS,
      invoices: [
        ...DEPOSIT_ONLY_FINANCIALS.invoices,
        {
          id: 'void1',
          invoice_number: 'I00043',
          status: 'VOIDED',
          total_amount: '999',
          amount_due: '0',
          kind: 'STANDARD',
        },
      ],
    });
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));

    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getByRole('link', { name: 'I00042' })).toBeInTheDocument();
    expect(panel.queryByRole('link', { name: 'I00043' })).not.toBeInTheDocument();
  });

  it('ignores a superseded linked estimate when deriving the contract', async () => {
    mockLinkedJob(
      { final_invoice: null, invoices: [], payments: [] },
      { linked_estimates: [{ ...LINKED_ESTIMATE, status: 'SUPERSEDED' }] },
    );
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });

    await screen.findByRole('heading', { name: /J00001/ });

    expect(await screen.findByText(/no contract yet/i)).toBeInTheDocument();
  });
});
