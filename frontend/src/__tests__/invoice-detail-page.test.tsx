import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import InvoiceDetailPage from '@/pages/InvoiceDetailPage';
import { buildAbility } from '@/lib/ability';

// floating-ui (under Radix dropdown) does `new ResizeObserver(...)`; the global setup mock
// returns a plain object and isn't constructable — install a real class stub (same pattern as
// job-detail-page.test.tsx).
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
    useParams: () => ({ id: 'inv-abc-001' }),
    useNavigate: () => vi.fn(),
  };
});

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
// Mirrors SALES-shaped grants: can touch the invoice but cannot `read Invoice` — canSeePricing
// (and the backend's identical gate) is false.
const noPricingAbility = buildAbility([
  { action: 'update', subject: 'Invoice' },
  { action: 'manage_lines', subject: 'Invoice' },
]);

const mockApi = vi.mocked(api);

const SCOPE = {
  id: 'scope-1',
  title: 'Demo & haul-away',
  body: 'Remove old unit.',
  flat_price: 250,
  is_taxable: true,
  internal_cost: 100,
};

const LINE = {
  id: 'line-1',
  sequence: 1,
  description: 'Compressor swap',
  quantity: 1,
  unit_price: 300,
  unit_cost: 200,
  is_taxable: true,
  line_total: 300,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'SERVICE',
  price_book_item_id: null,
};

const BASE_INVOICE = {
  id: 'inv-abc-001',
  invoice_number: 'I00001',
  status: 'DRAFT',
  subtotal: 550,
  discount_amount: 0,
  tax_rate: 0,
  tax_amount: 0,
  tip: 0,
  deposit_credit: 0,
  total_amount: 550,
  amount_due: 550,
  public_token: null,
  sent_at: null,
  paid_at: null,
  due_date: null,
  voided_at: null,
  voided_reason: null,
  refunded_at: null,
  total_refunded: 0,
  refund_reason: null,
  refund_reason_category: null,
  line_items: [LINE],
  scopes: [SCOPE],
  net_collected: 0,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    email: 'john@doe.com',
    phone: '5551234567',
  },
  job: null,
  payments: [] as Array<{
    id: string;
    amount: number;
    method: string;
    paid_at: string;
    collector: null;
    reference_number: string | null;
    voided_at?: string | null;
    stripe_fee_amount?: number | null;
    platform_fee_amount?: number | null;
    net_amount?: number | null;
  }>,
};

function mockInvoice(overrides: Partial<typeof BASE_INVOICE> = {}, loRows: unknown[] = []) {
  const invoice = { ...BASE_INVOICE, ...overrides };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/notes')) return { data: { notes: [] } };
    if (url.endsWith('/timeline')) return { data: { events: [] } };
    if (url.includes('/api/logistic-orders')) return { data: { data: loRows, page: 1, limit: 50, total: loRows.length } };
    if (url.includes('/api/invoices/')) return { data: { invoice } };
    // /api/state-tax-rates and any other incidental GET (e.g. price-book search) — array-shaped
    // default so callers that immediately `.map`/`.find` the response don't crash.
    return { data: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Phase 11.6 - InvoiceDetailPage moves from DetailPageShell to TabStrip.
// Pins the real page's rendered tab-strip markup byte-exact: the `<Card
// pad={0}>` wrapper is now this page's own JSX (was DetailPageShell's `card`
// prop), and `padX={4} padTop={2}` is passed straight to TabStrip. One
// disclosed, reasoned-not-asserted difference lives in this page's own
// comment above its `TabStrip` call: the old `"w-full justify-start"` tokens
// DetailPageShell hardcoded for this shape are not reproduced (both are CSS
// no-ops inside a Card - a block-level flex TabsList already fills its
// parent's width, and `justify-start` matches the browser's own default
// `justify-content` for a flex row) - the rendered class string below is
// therefore intentionally shorter than DetailPageShell's own, not a miss.
describe('InvoiceDetailPage tab strip - TabStrip rendered contract', () => {
  const cls = (el: Element | null) => el?.getAttribute('class') ?? '';

  it('wraps TabStrip in a Card(pad=0) and forwards padX={4} padTop={2}', async () => {
    mockInvoice();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const list = await screen.findByRole('tablist');
    expect(cls(list)).toBe('flex items-center gap-[26px] border-b border-border pt-2 pr-4 pl-4');

    // TabStrip's own Tabs root is the Card's direct child, no className.
    const tabsRoot = list.parentElement as HTMLElement;
    expect(cls(tabsRoot)).toBe('');
    const card = tabsRoot.parentElement as HTMLElement;
    expect(cls(card)).toBe('rounded-card border border-border bg-surface-light text-text-primary shadow-card p-0');
  });
});

describe('InvoiceDetailPage — Receipt consolidation (Batch 3)', () => {
  it('renders InvoiceReceiptCard in the Line Items tab with Subtotal/Tax/Total/Balance due', async () => {
    mockInvoice();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const card = within(await screen.findByTestId('invoice-receipt-card'));
    expect(card.getByText('Subtotal')).toBeInTheDocument();
    expect(card.getByText('Total')).toBeInTheDocument();
    expect(card.getByText('Balance due')).toBeInTheDocument();
  });

  it('removes the old standalone "Payment Summary" card entirely (consolidated into the Receipt card)', async () => {
    mockInvoice();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await screen.findByTestId('invoice-receipt-card');
    expect(screen.queryByText('Payment Summary')).not.toBeInTheDocument();
    expect(screen.queryByText(/Additional Payments/)).not.toBeInTheDocument();
  });

  it('removes the old invoice-only money tail under the Line Items tab (no duplicate Balance Due block)', async () => {
    mockInvoice();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await screen.findByTestId('invoice-receipt-card');
    // Only ONE "Balance due"/"Balance Due" row should exist on the page now — the Receipt card's.
    const balanceDueLabels = [
      ...screen.queryAllByText('Balance due'),
      ...screen.queryAllByText('Balance Due'),
    ];
    expect(balanceDueLabels).toHaveLength(1);
    expect(screen.queryByText('Less deposit credit')).not.toBeInTheDocument();
    expect(screen.queryByText('Less payments applied')).not.toBeInTheDocument();
  });

  it('renders the ScopeOfWorkCard block as a sibling of the line-items grid, off the SAME invoice fetch (no separate GET)', async () => {
    mockInvoice();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    expect(await screen.findByDisplayValue('Demo & haul-away')).toBeInTheDocument();
    expect(screen.getByText('Compressor swap')).toBeInTheDocument();
    // The invoice detail fetch is the only GET hitting /api/invoices/:id — never a /scopes GET.
    expect(mockApi.get).not.toHaveBeenCalledWith(expect.stringContaining('/scopes'));
  });

  it('renders InternalCostsCard when the ability can read Invoice', async () => {
    mockInvoice();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await screen.findByTestId('invoice-receipt-card');
    expect(screen.getByText('Internal costs')).toBeInTheDocument();
  });

  it('hides InternalCostsCard entirely when the ability cannot read Invoice', async () => {
    mockInvoice();
    renderWithProviders(<InvoiceDetailPage />, { ability: noPricingAbility });

    await screen.findByTestId('invoice-receipt-card');
    expect(screen.queryByText('Internal costs')).not.toBeInTheDocument();
  });

  it('keeps the page-header hero amount untouched (still renders Amount Due outside the Receipt card)', async () => {
    mockInvoice({ amount_due: 550 });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await screen.findByTestId('invoice-receipt-card');
    expect(screen.getByTestId('invoice-amount-due')).toBeInTheDocument();
    expect(screen.getByText('Amount Due')).toBeInTheDocument();
  });
});

// Copy-to-Invoice (R5e) — a job-less, standalone invoice reaches its source estimate only via
// the new top-level invoice.estimate field (invoice.job is null, so invoice.job?.estimate never
// resolves). Both the links-row derivation and buildLedgerEvents fall back to it.
describe('InvoiceDetailPage — job-less estimate link (Copy-to-Invoice, R5e)', () => {
  it('shows "Estimate {number}" in the links row for a job-less invoice via the top-level estimate field', async () => {
    mockInvoice({
      job: null,
      estimate: { id: 'est-jobless-1', estimate_number: 'E00301' },
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const link = await screen.findByRole('link', { name: /Estimate E00301/ });
    expect(link).toHaveAttribute('href', '/estimates/est-jobless-1');
    // No Job link renders alongside it — this invoice has no job.
    expect(screen.queryByRole('link', { name: /^Job / })).toBeNull();
  });

  it('renders the "Deposit Paid" ledger row for a job-less invoice via invoice.estimate (buildLedgerEvents fallback)', async () => {
    mockInvoice({
      job: null,
      estimate: {
        id: 'est-jobless-1',
        estimate_number: 'E00301',
        invoices: [
          {
            id: 'dep-inv-1',
            status: 'PAID',
            total_refunded: '0.00',
            refunded_at: null,
            payments: [
              {
                amount: '200.00',
                method: 'CARD',
                paid_at: '2026-07-05T00:00:00.000Z',
                reference_number: null,
              },
            ],
          },
        ],
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));

    expect(await screen.findByText('Deposit Paid')).toBeInTheDocument();
    const ledger = within(await screen.findByTestId('invoice-ledger'));
    expect(ledger.getByText('$200.00')).toBeInTheDocument();
    // The deposit row links back to the estimate, same as the job-anchored path.
    expect(ledger.getByRole('link', { name: 'E00301' })).toHaveAttribute('href', '/estimates/est-jobless-1');
  });
});

// ─── Money trust (#843) ─────────────────────────────────────────────────────────────────────
// Reversals must render, voided cash must not count, the bar must be net-based, and an
// overpayment must be visible rather than silent.
describe('InvoiceDetailPage - reversal ledger + overpayment (money trust)', () => {
  const openPayments = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(await screen.findByRole('tab', { name: /^Payments/ }));

  it('excludes a voided payment from the collected footer and from the Paid KPI', async () => {
    // $200 collected plus a $60 payment that was voided. Collected must read $200, never $260.
    // ($260 is chosen to collide with nothing else on the page - SCOPE.flat_price is $250.)
    const user = userEvent.setup();
    mockInvoice({
      status: 'PARTIAL',
      total_amount: 550,
      amount_due: 350,
      payments: [
        { id: 'p1', amount: 200, method: 'CASH', paid_at: '2026-07-02T00:00:00.000Z', collector: null, reference_number: null },
        { id: 'p2', amount: 60, method: 'CASH', paid_at: '2026-07-02T12:00:00.000Z', collector: null, reference_number: null, voided_at: '2026-07-03T00:00:00.000Z' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    // The Paid KPI on the Line Items tab must agree.
    await screen.findByTestId('invoice-receipt-card');
    expect(screen.getByText('$200.00')).toBeInTheDocument();
    expect(screen.queryByText('$260.00')).not.toBeInTheDocument();

    await openPayments(user);
    const ledger = within(await screen.findByTestId('invoice-ledger'));
    expect(ledger.getByText(/\+\$200\.00 collected/)).toBeInTheDocument();
    expect(ledger.queryByText(/\+\$260\.00 collected/)).not.toBeInTheDocument();
    // The voided row is still listed as evidence.
    expect(ledger.getByText('voided')).toBeInTheDocument();
  });

  it('renders itemized Refund and Credit rows on a PARTIALLY_REFUNDED invoice, credit out of net cash', async () => {
    // $200 collected, $50 refunded, $30 credited. Net CASH = 200 − 50 = $150; the credit is
    // reported on its own figure and is never folded into cash.
    const user = userEvent.setup();
    mockInvoice({
      status: 'PARTIALLY_REFUNDED',
      total_amount: 550,
      amount_due: 350,
      payments: [
        { id: 'p1', amount: 200, method: 'CASH', paid_at: '2026-07-02T00:00:00.000Z', collector: null, reference_number: null },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      refunds: [{ id: 'r1', invoice_id: 'inv-abc-001', amount: 50, method: 'CASH', created_at: '2026-07-04T00:00:00.000Z' }] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      credits: [{ id: 'cr1', invoice_id: 'inv-abc-001', amount: 30, reason: 'Goodwill', created_at: '2026-07-05T00:00:00.000Z' }] as any,
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });
    await openPayments(user);

    const ledger = within(await screen.findByTestId('invoice-ledger'));
    expect(ledger.getByText('Refund')).toBeInTheDocument();
    expect(ledger.getByText('Credit')).toBeInTheDocument();
    expect(ledger.getByText('Refunds & Credits')).toBeInTheDocument();
    expect(ledger.getByText(/−\$50\.00 refunded/)).toBeInTheDocument();
    expect(ledger.getByText(/−\$30\.00 credited/)).toBeInTheDocument();
    expect(ledger.getByText(/Net cash/)).toBeInTheDocument();
    expect(ledger.getByText('$150.00')).toBeInTheDocument();
    // Negative guard: the credit-subtracted net ($120) must appear NOWHERE.
    expect(ledger.queryByText('$120.00')).not.toBeInTheDocument();
  });

  it('reopens the progress bar and shows a Refunded row on the receipt after a partial refund', async () => {
    mockInvoice({
      status: 'PARTIALLY_REFUNDED',
      subtotal: 1000,
      total_amount: 1000,
      amount_due: 0,
      payments: [
        { id: 'p1', amount: 1000, method: 'CASH', paid_at: '2026-07-02T00:00:00.000Z', collector: null, reference_number: null },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      refunds: [{ id: 'r1', invoice_id: 'inv-abc-001', amount: 400, method: 'CASH', created_at: '2026-07-04T00:00:00.000Z' }] as any,
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const card = within(await screen.findByTestId('invoice-receipt-card'));
    expect(card.getByText('Refunded')).toBeInTheDocument();
    expect(card.getByText('60% collected')).toBeInTheDocument();
    expect(card.queryByText('100% collected')).not.toBeInTheDocument();
  });

  it('folds a legacy aggregate refund (status REFUNDED, no refunds[] rows) into the receipt', async () => {
    // Pre-ledger refund: $500 paid, total_refunded 500, no refunds[] rows. The bar must reopen to
    // 0% rather than stick at 100%.
    mockInvoice({
      status: 'REFUNDED',
      subtotal: 500,
      total_amount: 500,
      amount_due: 0,
      refunded_at: '2026-07-05T00:00:00.000Z',
      total_refunded: 500,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      refunds: [] as any,
      payments: [
        { id: 'p1', amount: 500, method: 'CASH', paid_at: '2026-07-02T00:00:00.000Z', collector: null, reference_number: null },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const card = within(await screen.findByTestId('invoice-receipt-card'));
    expect(card.getByText('Refunded')).toBeInTheDocument();
    expect(card.getByText('0% collected')).toBeInTheDocument();
    expect(card.queryByText('100% collected')).not.toBeInTheDocument();
  });

  it('renders the overpaid banner when more is settled than the invoice bills for', async () => {
    mockInvoice({
      status: 'PAID',
      subtotal: 500,
      total_amount: 500,
      amount_due: 0,
      payments: [
        { id: 'p1', amount: 650, method: 'CASH', paid_at: '2026-07-02T00:00:00.000Z', collector: null, reference_number: null },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    expect(await screen.findByTestId('invoice-overpaid-banner')).toBeInTheDocument();
    expect(screen.getByText(/Overpaid by \$150\.00/)).toBeInTheDocument();
  });

  it('does NOT show an overpaid banner when a larger deposit is only PARTLY applied', async () => {
    // $500 deposit paid on the sibling DEPOSIT invoice; applyDepositCredit draws down only
    // min(remaining, invoiceTotal) = $300 onto this $300 invoice, leaving $200 unspent. Reading the
    // raw deposit payment would render a false "Overpaid by $200.00 - issue a refund" banner.
    mockInvoice({
      status: 'PAID',
      subtotal: 300,
      total_amount: 300,
      amount_due: 0,
      deposit_credit: 300,
      payments: [
        { id: 'dc', amount: 300, method: 'CARD', paid_at: '2026-07-02T00:00:00.000Z', collector: null, reference_number: 'DEPOSIT-CREDIT' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      estimate: {
        id: 'est-1',
        estimate_number: 'E00001',
        invoices: [
          {
            id: 'dep-inv',
            status: 'PAID',
            total_refunded: 0,
            refunded_at: null,
            payments: [{ amount: 500, method: 'CARD', paid_at: '2026-07-02T00:00:00.000Z', reference_number: null }],
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const card = within(await screen.findByTestId('invoice-receipt-card'));
    // Fully settled by the applied credit - and NOT overpaid.
    expect(card.getByText('100% collected')).toBeInTheDocument();
    expect(card.queryByText('Overpaid')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invoice-overpaid-banner')).not.toBeInTheDocument();
    expect(screen.queryByText(/Overpaid by/)).not.toBeInTheDocument();
  });

  it('counts the APPLIED deposit credit as collected (100%, not the payments-only reading)', async () => {
    // $1,000 invoice: $300 deposit applied + $700 paid directly, amount_due 0.
    const user = userEvent.setup();
    mockInvoice({
      status: 'PAID',
      subtotal: 1000,
      total_amount: 1000,
      amount_due: 0,
      deposit_credit: 300,
      payments: [
        { id: 'p1', amount: 700, method: 'CASH', paid_at: '2026-07-03T00:00:00.000Z', collector: null, reference_number: null },
        { id: 'dc', amount: 300, method: 'CARD', paid_at: '2026-07-02T00:00:00.000Z', collector: null, reference_number: 'DEPOSIT-CREDIT' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const card = within(await screen.findByTestId('invoice-receipt-card'));
    expect(card.getByText('100% collected')).toBeInTheDocument();
    expect(card.queryByText('70% collected')).not.toBeInTheDocument();

    await openPayments(user);
    const ledger = within(await screen.findByTestId('invoice-ledger'));
    expect(ledger.getByText('Deposit Credit Applied')).toBeInTheDocument();
    expect(ledger.getByText(/\+\$1,000\.00 collected/)).toBeInTheDocument();
  });
});

// SERV10X-59 — sent-invoice non-blocking "resend?" reminder. needs_resend is derived server-side
// (invoice.controller.ts getById); the page only has to render the banner and wire it to the
// SAME resendOpen state the hero "Resend Invoice" button already uses.
describe('InvoiceDetailPage — resend reminder banner (SERV10X-59)', () => {
  const SENT_RESENDABLE = {
    status: 'SENT',
    public_token: 'tok-1',
    sent_at: '2026-07-01T00:00:00.000Z',
  };

  it('shows the banner and a Resend action when needs_resend is true', async () => {
    mockInvoice({ ...SENT_RESENDABLE, needs_resend: true } as Partial<typeof BASE_INVOICE>);
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    expect(await screen.findByText(/This invoice changed since it was sent/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Resend$/ })).toBeInTheDocument();
  });

  it('hides the banner when needs_resend is false', async () => {
    mockInvoice({ ...SENT_RESENDABLE, needs_resend: false } as Partial<typeof BASE_INVOICE>);
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await screen.findByTestId('invoice-detail');
    expect(screen.queryByText(/This invoice changed since it was sent/)).not.toBeInTheDocument();
  });

  it('hides the banner on a DRAFT invoice even if needs_resend were somehow true (no public_token, not payable)', async () => {
    mockInvoice({ status: 'DRAFT', public_token: null, sent_at: null, needs_resend: true } as Partial<typeof BASE_INVOICE>);
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await screen.findByTestId('invoice-detail');
    expect(screen.queryByText(/This invoice changed since it was sent/)).not.toBeInTheDocument();
  });

  it('clicking Resend on the banner opens the Send dialog in resend mode', async () => {
    const user = userEvent.setup();
    mockInvoice({ ...SENT_RESENDABLE, needs_resend: true } as Partial<typeof BASE_INVOICE>);
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: /^Resend$/ }));

    expect(await screen.findByText(`Resend Invoice ${BASE_INVOICE.invoice_number}`)).toBeInTheDocument();
  });
});

// SERV10X-59 — invoices previously had no activity surface at all (IconRail/ActivityPanel was
// only mounted on Lead/Job pages). Mounting it here rides the same '/api/invoices/:id/timeline'
// GET this ticket adds, plus the pre-existing '/api/invoices/:id/notes'.
describe('InvoiceDetailPage — activity rail (SERV10X-59)', () => {
  it('renders the Activity rail icon-button', async () => {
    mockInvoice();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await screen.findByTestId('invoice-detail');
    expect(await screen.findByRole('button', { name: /^activity$/i })).toBeInTheDocument();
  });

  it('opening the Activity panel fetches this invoice’s timeline', async () => {
    const user = userEvent.setup();
    mockInvoice();
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: /^activity$/i }));

    expect(mockApi.get).toHaveBeenCalledWith(expect.stringContaining('/api/invoices/inv-abc-001/timeline'));
  });
});

// Inventory P1 §4 — voiding/deleting returns invoice-BORN synced stock; the dialogs/confirms
// say so. Job-copied lines are NOT_TRACKED by construction, so the raw SYNCED filter already
// scopes the count correctly.
describe('InvoiceDetailPage — synced-stock return notes (Inventory P1)', () => {
  const SYNCED_LINE = {
    ...LINE,
    id: 'line-syn',
    stock_status: 'SYNCED',
    stock_location_id: 'loc-1',
  };

  it('the Void dialog banner counts invoice-born SYNCED lines', async () => {
    mockInvoice({
      status: 'SENT',
      sent_at: '2026-07-02T00:00:00.000Z',
      public_token: 'tok-1',
      line_items: [SYNCED_LINE, { ...LINE, id: 'line-nt', stock_status: 'NOT_TRACKED' }],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Void Invoice/ }));

    expect(
      await screen.findByText(/1 synced inventory item\(s\) will be returned to stock\./),
    ).toBeInTheDocument();
  });

  it('the Void dialog banner omits the stock sentence when no line is SYNCED', async () => {
    mockInvoice({
      status: 'SENT',
      sent_at: '2026-07-02T00:00:00.000Z',
      public_token: 'tok-1',
      line_items: [{ ...LINE, stock_status: 'NOT_TRACKED' }],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Void Invoice/ }));

    // The banner itself renders (void warning), but with no returned-to-stock sentence.
    expect(await screen.findByText(/will preserve the record/)).toBeInTheDocument();
    expect(screen.queryByText(/will be returned to stock/)).toBeNull();
  });

  it('the DRAFT delete dialog gains the return sentence when synced lines exist, and never calls window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    mockInvoice({ status: 'DRAFT', line_items: [SYNCED_LINE] });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));

    expect(
      await screen.findByText(/synced inventory item\(s\) will be returned to stock/i),
    ).toBeInTheDocument();
    expect(mockApi.delete).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('the delete dialog omits the return sentence when no line is SYNCED', async () => {
    mockInvoice({ status: 'DRAFT', line_items: [LINE] });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));

    await screen.findByRole('heading', { name: /Delete Invoice/ });
    expect(screen.queryByText(/will be returned to stock/i)).toBeNull();
  });

  it('confirming the delete dialog calls DELETE and closes it', async () => {
    mockInvoice({ status: 'DRAFT', line_items: [LINE] });
    mockApi.delete.mockResolvedValue({ data: { success: true } });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    await user.click(await screen.findByRole('button', { name: /^Delete Invoice$/ }));

    expect(mockApi.delete).toHaveBeenCalledWith('/api/invoices/inv-abc-001');
    expect(screen.queryByRole('heading', { name: /Delete Invoice/ })).toBeNull();
  });

  it('the delete dialog lists the invoice’s Logistic Orders and their consequence', async () => {
    mockInvoice({ status: 'DRAFT', line_items: [LINE] }, [
      {
        id: 'lo-1',
        number: 'LO-I00170-1',
        seq: 1,
        status: 'PROCESSED',
        anchors: { invoiceId: 'inv-abc-001', invoiceNumber: 'I00170' },
        lineCount: 1,
        createdBy: null,
        processedAt: '2026-07-21T00:00:00.000Z',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
    ]);
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));

    expect(await screen.findByText('LO-I00170-1')).toBeInTheDocument();
    expect(screen.getByText(/returns 1 item to stock/i)).toBeInTheDocument();
  });
});

describe('InvoiceDetailPage — PDF preview/download actions', () => {
  it('shows Preview PDF and Download PDF in the overflow menu', async () => {
    mockInvoice({ status: 'DRAFT' });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));

    expect(await screen.findByRole('menuitem', { name: /Preview PDF/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Download PDF/ })).toBeInTheDocument();
  });

  it('clicking Preview PDF opens the PDF preview dialog for this invoice', async () => {
    mockInvoice({ status: 'DRAFT' });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Preview PDF/ }));

    expect(await screen.findByText('Invoice I00001')).toBeInTheDocument();
  });

  it('clicking Download PDF requests the invoice PDF blob', async () => {
    mockInvoice({ status: 'DRAFT' });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Download PDF/ }));

    await waitFor(() =>
      expect(mockApi.get).toHaveBeenCalledWith('/api/invoices/inv-abc-001/pdf', { responseType: 'blob' }),
    );
  });
});

// The Amount column is one number. The processor-fee drill-in that used to stack underneath it
// (Task 3.4, spec §7.3) was removed from this ledger on Ran's call 2026-08-04 - three different
// figures competing under one amount made the rows unreadable. The drill-in still lives on the
// job Payments tab; only the invoice ledger dropped it.
describe('InvoiceDetailPage — per-payment fee display (Task 3.4, retired from this ledger)', () => {
  it('renders the amount alone, with no processor-fee drill-in stacked under it', async () => {
    mockInvoice({
      status: 'PAID',
      paid_at: '2026-07-10T00:00:00.000Z',
      payments: [
        {
          id: 'pay-card-1',
          amount: 500,
          method: 'CARD',
          paid_at: '2026-07-10T00:00:00.000Z',
          collector: null,
          reference_number: null,
          stripe_fee_amount: 14.75,
          platform_fee_amount: 2.5,
          net_amount: 482.75,
        },
      ],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));

    await screen.findByTestId('invoice-ledger');
    // The amount itself is still there...
    expect(screen.getByRole('cell', { name: '+$500.00' })).toBeInTheDocument();
    // ...but the combined 14.75 + 2.50 = 17.25 fee trigger and its split are gone.
    expect(screen.queryByRole('button', { name: /Fee \$17\.25/ })).not.toBeInTheDocument();
    expect(screen.queryByText('ServWave platform fee — 0.5%')).not.toBeInTheDocument();
  });

  it('renders no fee figure for a manual (CHECK) payment, or a CARD payment not yet reconciled', async () => {
    mockInvoice({
      status: 'PAID',
      paid_at: '2026-07-10T00:00:00.000Z',
      payments: [
        { id: 'pay-check-1', amount: 200, method: 'CHECK', paid_at: '2026-07-05T00:00:00.000Z', collector: null, reference_number: 'CHK-1' },
        { id: 'pay-card-unreconciled', amount: 300, method: 'CARD', paid_at: '2026-07-06T00:00:00.000Z', collector: null, reference_number: null },
      ],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));

    await screen.findByTestId('invoice-ledger');
    expect(screen.queryByRole('button', { name: /^Fee / })).not.toBeInTheDocument();
  });
});

// Slice 5 (card service fee) — org-facing visibility of what the customer paid on top (D1: the
// fee never touches this payment's amount, so it gets its OWN COLUMN rather than being folded in
// or stacked under the amount).
describe('InvoiceDetailPage — service fee visibility (Slice 5)', () => {
  it('shows the service fee collected on a card-paid invoice, in its own column', async () => {
    mockInvoice({
      status: 'PAID',
      paid_at: '2026-08-04T00:00:00.000Z',
      payments: [
        {
          id: 'pay-fee-1',
          amount: 1000,
          method: 'CARD',
          paid_at: '2026-08-04T00:00:00.000Z',
          collector: null,
          reference_number: null,
          service_fee_amount: 35,
        },
      ],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));

    expect(await screen.findByRole('columnheader', { name: 'Service fee' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '$35.00' })).toBeInTheDocument();
    // D1: the fee is NOT folded into the payment's own amount.
    expect(screen.getByRole('cell', { name: '+$1,000.00' })).toBeInTheDocument();
  });

  it('shows an em dash in the service fee column for a manual (CHECK) payment or a card payment with none collected', async () => {
    mockInvoice({
      status: 'PAID',
      paid_at: '2026-08-04T00:00:00.000Z',
      payments: [
        { id: 'pay-check-2', amount: 200, method: 'CHECK', paid_at: '2026-08-03T00:00:00.000Z', collector: null, reference_number: 'CHK-2' },
        { id: 'pay-card-no-fee', amount: 300, method: 'CARD', paid_at: '2026-08-03T00:00:00.000Z', collector: null, reference_number: null, service_fee_amount: null },
      ],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));

    await screen.findByTestId('invoice-ledger');
    // The column is always present (it is a table column, not a conditional caption) - what
    // changes is that every cell in it reads '—' rather than a figure.
    expect(screen.getByRole('columnheader', { name: 'Service fee' })).toBeInTheDocument();
    expect(screen.getAllByRole('cell', { name: '—' }).length).toBeGreaterThanOrEqual(2);
  });

  it('has no settings surface anywhere that lets an org change the service fee rate', async () => {
    // No settings form, no attestation checkbox, no rate input (plan D4/Slice 5). Regression
    // guard against the original (pre-rewrite) slice scope, which this plan explicitly retired.
    mockInvoice({
      status: 'PAID',
      paid_at: '2026-08-04T00:00:00.000Z',
      payments: [
        { id: 'pay-fee-3', amount: 1000, method: 'CARD', paid_at: '2026-08-04T00:00:00.000Z', collector: null, reference_number: null, service_fee_amount: 35 },
      ],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));
    await screen.findByRole('cell', { name: '$35.00' });

    expect(screen.queryByLabelText(/service fee rate/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/service fee.{0,20}(attest|acknowledge|agree)/i)).not.toBeInTheDocument();
  });
});

// The ledger's "By" column used to read 'Stripe' for every CARD row regardless of whether the org
// had Stripe at all, which misattributes the payment for an org running cards on its own terminal.
describe('InvoiceDetailPage — payment attribution in the By column', () => {
  it('names Stripe only when the payment carries a Stripe intent, and the org method otherwise', async () => {
    mockInvoice({
      status: 'PAID',
      paid_at: '2026-08-04T00:00:00.000Z',
      payments: [
        {
          id: 'pay-stripe',
          amount: 100,
          method: 'CARD',
          paid_at: '2026-08-04T00:00:00.000Z',
          collector: null,
          reference_number: null,
          stripe_payment_intent_id: 'pi_live_1',
        },
        {
          id: 'pay-own-terminal',
          amount: 200,
          method: 'EXTERNAL_CARD',
          paid_at: '2026-08-04T00:00:00.000Z',
          collector: null,
          reference_number: null,
          stripe_payment_intent_id: null,
        },
      ],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));

    await screen.findByTestId('invoice-ledger');
    // Both labels come from PAYMENT_METHOD_LABELS - the same vocabulary Settings > Payments &
    // Lists uses - so the column can only ever name a method the org actually configured.
    expect(screen.getByText('Credit Card')).toBeInTheDocument();
    expect(screen.getByText('External Credit Card Processor')).toBeInTheDocument();
    // The processor's name never reaches the screen, even though the row carries its intent id.
    expect(screen.queryByText(/stripe/i)).not.toBeInTheDocument();
  });

  it('keeps the collector name when a person recorded the payment', async () => {
    mockInvoice({
      status: 'PAID',
      paid_at: '2026-08-04T00:00:00.000Z',
      payments: [
        {
          id: 'pay-by-person',
          amount: 150,
          method: 'EXTERNAL_CARD',
          paid_at: '2026-08-04T00:00:00.000Z',
          collector: { id: 'u1', first_name: 'Dana', last_name: 'Reyes' },
          reference_number: null,
          stripe_payment_intent_id: null,
        },
      ],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));

    expect(await screen.findByText('Dana Reyes')).toBeInTheDocument();
    expect(screen.queryByText('External Credit Card Processor')).not.toBeInTheDocument();
  });
});

// Slice 8 (customer-facing tipping) — the tip gets its own column beside the service fee, always
// a dollar figure and never a percentage (D11), never folded into the payment amount (D10).
describe('InvoiceDetailPage — tip visibility (Slice 8)', () => {
  it('shows the tip collected on a card-paid invoice, in its own column beside the service fee', async () => {
    mockInvoice({
      status: 'PAID',
      paid_at: '2026-08-04T00:00:00.000Z',
      payments: [
        {
          id: 'pay-tip-1',
          amount: 1000,
          method: 'CARD',
          paid_at: '2026-08-04T00:00:00.000Z',
          collector: null,
          reference_number: null,
          service_fee_amount: 35,
          tip_amount: 150,
        },
      ],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));

    expect(await screen.findByRole('columnheader', { name: 'Tip' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '$150.00' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '$35.00' })).toBeInTheDocument();
    // D10: neither figure is folded into the payment's own amount.
    expect(screen.getByRole('cell', { name: '+$1,000.00' })).toBeInTheDocument();
  });

  it('shows an em dash in the tip column for a payment with no tip', async () => {
    mockInvoice({
      status: 'PAID',
      paid_at: '2026-08-04T00:00:00.000Z',
      payments: [
        { id: 'pay-no-tip', amount: 1000, method: 'CARD', paid_at: '2026-08-04T00:00:00.000Z', collector: null, reference_number: null, tip_amount: null },
      ],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /^Payments/ }));

    await screen.findByTestId('invoice-ledger');
    // The column header is always present; only its cells go to '—'.
    expect(screen.getByRole('columnheader', { name: 'Tip' })).toBeInTheDocument();
    expect(screen.getAllByRole('cell', { name: '—' }).length).toBeGreaterThanOrEqual(2);
  });
});

// Editable record IDs (2026-08-19 plan) - RecordNumberEditor wired into the header's
// invoice-number render, gated on ability.can('renumber', 'Invoice') && !invoice.sent_at.
describe('InvoiceDetailPage - record number editor gating', () => {
  it('shows the edit affordance for a user with the renumber grant on an unsent invoice', async () => {
    mockInvoice({ sent_at: null });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: /edit id/i })).toBeInTheDocument();
  });

  it('hides the edit affordance for a user without the renumber grant', async () => {
    mockInvoice({ sent_at: null });
    renderWithProviders(<InvoiceDetailPage />, { ability: noPricingAbility });

    await screen.findAllByText('I00001');
    expect(screen.queryByRole('button', { name: /edit id/i })).toBeNull();
  });

  // The gate reads the same two things the backend does. It used to check sent_at alone, so an
  // unsent invoice carrying a real payment offered a pencil that the backend then refused -
  // the user got as far as typing a new number before being told no.
  const LIVE_PAYMENT = {
    id: 'pay-1',
    amount: 1000,
    method: 'CASH',
    paid_at: '2026-07-05T00:00:00.000Z',
    collector: null,
    reference_number: null,
    voided_at: null,
  };

  it('hides the edit affordance on an unsent invoice that carries a live payment', async () => {
    mockInvoice({ sent_at: null, payments: [LIVE_PAYMENT] });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await screen.findAllByText('I00001');
    expect(screen.queryByRole('button', { name: /edit id/i })).toBeNull();
  });

  it('keeps the edit affordance when the only payment against it was voided', async () => {
    mockInvoice({
      sent_at: null,
      payments: [{ ...LIVE_PAYMENT, voided_at: '2026-07-06T00:00:00.000Z' }],
    });
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: /edit id/i })).toBeInTheDocument();
  });
});
