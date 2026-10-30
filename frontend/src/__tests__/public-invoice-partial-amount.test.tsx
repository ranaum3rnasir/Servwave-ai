/**
 * Payments go-live slice 28b (from the slice 26 staging acceptance) - on the public invoice, an
 * "Amount to pay" with a third decimal (12.345) is not an empty field: it says to enter dollars and
 * cents, and Pay stays off. A truly empty field still reads "Enter an amount to pay."
 *
 * The page imported is the ROUTED one (pages/v2/routes/auth-public.routes.tsx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import PublicInvoicePage from '@/pages/v2/auth-public/PublicInvoicePage';

const INVOICE_ID = 'inv-partial-1';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: INVOICE_ID }),
    useSearchParams: () => [new URLSearchParams('token=tok-1'), vi.fn()],
  };
});

const SIGNED_OUT = { user: null, isAuthenticated: false, isLoading: false };

const PAYLOAD = {
  invoice: {
    id: INVOICE_ID, invoice_number: 'I00077', status: 'SENT', kind: 'STANDARD',
    subtotal: 500, discount_amount: 0, tax_amount: 0, deposit_credit: 0, total_amount: 500, amount_due: 500,
    due_date: null, sent_at: '2026-03-01T00:00:00.000Z', paid_at: null, created_at: '2026-03-01T00:00:00.000Z',
    job: null, customer: { first_name: 'Pat', last_name: 'Payer' },
    line_items: [{ id: 'li-1', sequence: 1, description: 'Door service', quantity: 1, unit_price: 500, is_taxable: false, line_total: 500 }],
    payments: [],
  },
  organization: { name: 'Test Services Co' },
  available_payment_methods: ['CARD'],
  payment_instructions: {},
  payable_now: 500,
  pay_state: 'PAYABLE',
  payment_options: { allow_partial: true, tips: { enabled: false, presets: [] } },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => PAYLOAD }));
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(SIGNED_OUT) : SIGNED_OUT) as unknown as typeof useAuthStore);
});
afterEach(() => vi.unstubAllGlobals());

async function amountField() {
  renderWithProviders(<PublicInvoicePage />, { initialEntries: [`/p/invoices/${INVOICE_ID}?token=tok-1`] });
  return screen.findByLabelText('Amount to pay');
}

describe('public invoice - Amount to pay', () => {
  it('a third decimal asks for dollars and cents, not for an amount', async () => {
    const user = userEvent.setup();
    const field = await amountField();
    await user.clear(field);
    await user.type(field, '12.345');

    expect(screen.getByText('Enter an amount in dollars and cents.')).toBeInTheDocument();
    expect(screen.queryByText('Enter an amount to pay.')).not.toBeInTheDocument();
  });

  it('an empty field still asks for an amount', async () => {
    const user = userEvent.setup();
    const field = await amountField();
    await user.clear(field);

    expect(screen.getByText('Enter an amount to pay.')).toBeInTheDocument();
  });

  it('a valid amount shows no error', async () => {
    const user = userEvent.setup();
    const field = await amountField();
    await user.clear(field);
    await user.type(field, '12.34');

    expect(screen.queryByText(/dollars and cents|Enter an amount/)).not.toBeInTheDocument();
  });
});

describe('public deposit invoice on a closed estimate', () => {
  const closedWith = (payments: unknown[]) => ({
    ...PAYLOAD,
    invoice: { ...PAYLOAD.invoice, kind: 'DEPOSIT', payments },
    pay_state: 'VOIDED',
    payable_now: 0,
  });

  it('says the invoice was voided when nothing was paid on it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => closedWith([]) }));
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [`/p/invoices/${INVOICE_ID}?token=tok-1`] });

    expect(await screen.findByText('Invoice Voided')).toBeInTheDocument();
  });

  it('does not say "voided" when it holds a payment: it names the payment and who to ask', async () => {
    const payment = { id: 'p1', amount: 200, paid_at: '2026-03-02T00:00:00.000Z', state: 'SUCCEEDED', method: 'CARD' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => closedWith([payment]) }));
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [`/p/invoices/${INVOICE_ID}?token=tok-1`] });

    expect(await screen.findByText('Deposit Closed')).toBeInTheDocument();
    expect(screen.queryByText(/voided/i)).not.toBeInTheDocument();
    expect(screen.getByText(/payment of \$200\.00/i)).toBeInTheDocument();
  });

  it('a voided STANDARD invoice that holds a payment is not called a deposit', async () => {
    const payment = { id: 'p1', amount: 200, paid_at: '2026-03-02T00:00:00.000Z', state: 'SUCCEEDED', method: 'CARD' };
    const standard = { ...closedWith([payment]), invoice: { ...PAYLOAD.invoice, kind: 'STANDARD', payments: [payment] } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => standard }));
    renderWithProviders(<PublicInvoicePage />, { initialEntries: [`/p/invoices/${INVOICE_ID}?token=tok-1`] });

    expect(await screen.findByText('Invoice Closed')).toBeInTheDocument();
    expect(screen.queryByText(/deposit/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Invoice Voided')).not.toBeInTheDocument();
    expect(screen.getByText(/payment of \$200\.00/i)).toBeInTheDocument();
  });
});
