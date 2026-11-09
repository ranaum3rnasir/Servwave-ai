import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { mountInvoiceDetail } from '@/__tests__/harness/invoiceDetailPage';
import userEvent from '@testing-library/user-event';
import { seesPrices } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/invoiceDetailRouter')).invoiceDetailRouter());

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
});

describe('invoiceDetailHeading', () => {
  /**
   * The v2 invoice detail heading: invoice id, then the customer.
   *
   * The rule is `lib/customer-name`'s, reused rather than re-implemented: a
   * personal name when there is one, the company name when there is not. "No
   * personal name" has to mean blank-or-whitespace, not just null - a customer
   * whose `first_name` is a single space must not put a hole in the heading.
   *
   * The legacy suites in `src/__tests__` are the behavioural contract for the
   * legacy page and stay pointed at it. This file covers the v2 page only.
   */

  // floating-ui, under Radix's dropdown, does `new ResizeObserver(...)`.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

  const INVOICE_ID = 'i0000000-0000-0000-0000-000000000001';

  type CustomerFixture = {
    first_name: string;
    last_name: string;
    company_name?: string | null;
  };

  /**
   * The narrowest invoice the detail page will render: no job, no estimate, no
   * money movement. Everything here exists to get past a null guard, not to
   * assert anything - the heading is the only surface under test.
   */
  function invoiceWithCustomer(customer: CustomerFixture) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I00001',
      status: 'DRAFT',
      kind: 'STANDARD',
      subtotal: 100,
      discount_amount: 0,
      tax_rate: 0,
      tax_amount: 0,
      tip: 0,
      deposit_credit: 0,
      total_amount: 100,
      amount_due: 100,
      net_collected: 0,
      public_token: null,
      sent_at: null,
      paid_at: null,
      due_date: null,
      voided_at: null,
      voided_reason: null,
      refunded_at: null,
      total_refunded: null,
      refund_reason: null,
      refund_reason_category: null,
      created_at: '2026-01-15T00:00:00.000Z',
      updated_at: '2026-01-15T00:00:00.000Z',
      line_items: [],
      scopes: [],
      payments: [],
      refunds: [],
      credits: [],
      tags: [],
      job: null,
      estimate: null,
      customer: {
        id: 'c0000000-0000-0000-0000-000000000001',
        email: 'billing@example.test',
        phone: '5125550125',
        ...customer,
      },
    };
  }

  function mountWith(customer: CustomerFixture) {
    mountInvoiceDetail({ id: INVOICE_ID, invoice: invoiceWithCustomer(customer), entry: `/invoices/${INVOICE_ID}` });
  }

  /**
   * The heading's text, with the decorative separator normalised back to " · ".
   *
   * The separator is its own aria-hidden span and the space either side of it is
   * a flex gap, so `textContent` butts it straight against its neighbours. Both
   * halves either side of it are still compared exactly.
   */
  async function headingText(): Promise<string> {
    const heading = await screen.findByRole('heading', { level: 1 });
    return (heading.textContent ?? '')
      .replace(/·/g, ' · ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('v2 InvoiceDetailPage heading', () => {
    it('shows the invoice id and the first + last name when both are present', async () => {
      mountWith({ first_name: 'Ada', last_name: 'Lovelace', company_name: 'Lovelace Mechanical' });

      expect(await headingText()).toBe('I00001 · Ada Lovelace');
    });

    it('falls back to the name it has when the first name is missing', async () => {
      mountWith({ first_name: '', last_name: 'Lovelace', company_name: 'Lovelace Mechanical' });

      expect(await headingText()).toBe('I00001 · Lovelace');
    });

    it('shows the company name when both personal names are missing', async () => {
      mountWith({ first_name: '', last_name: '', company_name: 'Lovelace Mechanical' });

      expect(await headingText()).toBe('I00001 · Lovelace Mechanical');
    });

    it('shows the company name when the personal names are whitespace only', async () => {
      mountWith({ first_name: '  ', last_name: '\t', company_name: 'Lovelace Mechanical' });

      expect(await headingText()).toBe('I00001 · Lovelace Mechanical');
    });
  });
});

describe('invoiceDetailPaymentHistory', () => {
  /**
   * Payments go-live slice 28: the payment history on the v2 invoice page says how each payment was
   * made, labels a payment that has not cleared or did not go through, names who sent a refund back,
   * and the Processing badge shows while bank money is clearing.
   */

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

  const INVOICE_ID = 'i0000000-0000-0000-0000-000000000001';

  const pay = (o: Record<string, unknown>) => ({
    amount: 100, method: 'CARD', paid_at: '2026-07-02T12:00:00.000Z', collected_by: null, paid_through_processor: true,
    reference_number: null, notes: null, created_at: '2026-07-02T12:00:00.000Z', collector: null, voided_at: null,
    state: 'SUCCEEDED', ...o,
  });

  function invoice(over: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID, invoice_number: 'I00001', status: 'PARTIAL', kind: 'STANDARD', subtotal: 500, discount_amount: 0,
      tax_rate: 0, tax_amount: 0, tip: 0, deposit_credit: 0, total_amount: 500, amount_due: 300, net_collected: 200,
      public_token: null, sent_at: null, paid_at: null, due_date: null, voided_at: null, voided_reason: null,
      refunded_at: null, total_refunded: null, refund_reason: null, refund_reason_category: null,
      created_at: '2026-01-15T00:00:00.000Z', updated_at: '2026-01-15T00:00:00.000Z',
      line_items: [], scopes: [], payments: [], refunds: [], credits: [], tags: [], job: null, estimate: null,
      customer: { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', company_name: null, email: 'a@example.test', phone: '5125550125' },
      ...over,
    };
  }

  async function openPayments(inv: ReturnType<typeof invoice>) {
    mountInvoiceDetail({ id: INVOICE_ID, invoice: inv, entry: `/invoices/${INVOICE_ID}`, ability: seesPrices });
    await userEvent.click(await screen.findByRole('tab', { name: /^Payments \(/ }));
    return screen.getByTestId('invoice-ledger');
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('v2 invoice payment history', () => {
    it('reads a card, a wallet, Link and a bank payment each the way the customer paid', async () => {
      const ledger = await openPayments(invoice({
        payments: [
          pay({ id: 'a', card_brand: 'visa', card_last4: '4242' }),
          pay({ id: 'b', wallet: 'APPLE_PAY', card_brand: 'visa', card_last4: '4242' }),
          pay({ id: 'c', wallet: 'LINK', card_brand: 'visa', card_last4: '0000' }),
          pay({ id: 'd', method: 'ACH', bank_name: 'Bank of Example', bank_last4: '6789' }),
        ],
      }));

      expect(within(ledger).getByText('Visa •••• 4242')).toBeInTheDocument();
      expect(within(ledger).getByText('Apple Pay (Visa •••• 4242)')).toBeInTheDocument();
      expect(within(ledger).getByText('Link')).toBeInTheDocument();
      expect(within(ledger).getByText('Bank of Example •••• 6789')).toBeInTheDocument();
      // Link never shows a placeholder card.
      expect(within(ledger).queryByText(/0000/)).not.toBeInTheDocument();
      // An online bank payment is a payment, not a hand-recorded one.
      expect(within(ledger).queryByText('Manual Payment')).not.toBeInTheDocument();
    });

    it('a refund row names the person who sent the money back', async () => {
      const ledger = await openPayments(invoice({
        payments: [pay({ id: 'a', card_brand: 'visa', card_last4: '4242' })],
        refunds: [{
          id: 'r1', invoice_id: INVOICE_ID, amount: 10, method: 'CARD', created_at: '2026-07-03T00:00:00.000Z', state: 'SUCCEEDED',
          refunded_by_user: { id: 'u1', first_name: 'Rita', last_name: 'Refunder' },
        }],
      }));

      expect(within(ledger).getByText('Rita Refunder')).toBeInTheDocument();
    });

    it('a deposit invoice with one payment reads "Payments (1)"', async () => {
      mountInvoiceDetail({
        id: INVOICE_ID,
        invoice: invoice({
          kind: 'DEPOSIT', status: 'PAID', amount_due: 0,
          payments: [pay({ id: 'a', amount: 200, card_brand: 'visa', card_last4: '4242' })],
          estimate: {
            id: 'est-1', estimate_number: 'E1',
            invoices: [{ id: INVOICE_ID, status: 'PAID', total_refunded: 0, refunded_at: null, payments: [{ amount: 200, method: 'CARD', paid_at: '2026-07-02T12:00:00.000Z', reference_number: null }] }],
          },
        }),
        entry: `/invoices/${INVOICE_ID}`,
        ability: seesPrices,
      });

      expect(await screen.findByRole('tab', { name: 'Payments (1)' })).toBeInTheDocument();
    });
  });

  describe('v2 invoice Processing badge', () => {
    it('shows "Processing $X" in the header while bank money is clearing', async () => {
      mountInvoiceDetail({
        id: INVOICE_ID,
        invoice: invoice({ processing_amount: 60, payments: [pay({ id: 'd', amount: 60, method: 'ACH', state: 'PROCESSING' })] }),
        entry: `/invoices/${INVOICE_ID}`,
        ability: seesPrices,
      });

      expect((await screen.findAllByText('Processing $60.00')).length).toBeGreaterThan(0);
    });

    it('shows no badge when no payment is processing', async () => {
      mountInvoiceDetail({ id: INVOICE_ID, invoice: invoice({ processing_amount: 0 }), entry: `/invoices/${INVOICE_ID}`, ability: seesPrices });

      await screen.findByRole('heading', { level: 1 });
      expect(screen.queryByText(/Processing \$/)).not.toBeInTheDocument();
    });
  });
});

describe('invoiceDetailPaymentOptions', () => {
  /**
   * Payments go-live slice 21 - the invoice page carries "Payment options" for that invoice: what
   * it stores (its override, or none) against what the org offers by default. The card's own
   * behaviour is pinned in src/__tests__/invoice-payment-options.test.tsx; this file pins that the
   * page hands it the invoice's stored overrides and the org's defaults, and the edit gate.
   */

  // floating-ui, under Radix's dropdown, does `new ResizeObserver(...)`.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

  const INVOICE_ID = 'i0000000-0000-0000-0000-000000000021';

  const ORG = {
    id: 'o1',
    accepted_payment_methods: ['CARD', 'ACH'],
    stripe_charges_enabled: true,
    card_offered_by_default: true,
    bank_offered_by_default: true,
  };

  function invoice(overrides: Record<string, unknown>) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I00001',
      status: 'DRAFT',
      kind: 'STANDARD',
      subtotal: 100,
      discount_amount: 0,
      tax_rate: 0,
      tax_amount: 0,
      tip: 0,
      deposit_credit: 0,
      total_amount: 100,
      amount_due: 100,
      net_collected: 0,
      public_token: null,
      sent_at: null,
      paid_at: null,
      due_date: null,
      voided_at: null,
      voided_reason: null,
      refunded_at: null,
      total_refunded: null,
      refund_reason: null,
      refund_reason_category: null,
      created_at: '2026-01-15T00:00:00.000Z',
      updated_at: '2026-01-15T00:00:00.000Z',
      line_items: [],
      scopes: [],
      payments: [],
      refunds: [],
      credits: [],
      tags: [],
      job: null,
      estimate: null,
      customer: {
        id: 'c0000000-0000-0000-0000-000000000001',
        email: 'billing@example.test',
        phone: '5125550125',
        first_name: 'Pat',
        last_name: 'Payer',
      },
      // The server's answer for this invoice: every action the page can offer.
      actions: ['edit', 'send', 'delete', 'copy_payment_link', 'record_payment'],
      ...overrides,
    };
  }

  function mount(overrides: Record<string, unknown>, rules: Parameters<typeof buildAbility>[0]) {
    mountInvoiceDetail({
      id: INVOICE_ID,
      invoice: invoice(overrides),
      organization: ORG,
      entry: `/invoices/${INVOICE_ID}`,
      ability: buildAbility(rules),
    });
  }

  describe('invoice page: Payment options', () => {
    it("shows the invoice's own override against the org default", async () => {
      mount({ payment_methods_override: ['ACH'], allow_partial_payment: true }, [
        { action: 'read', subject: 'Invoice' },
        { action: 'update', subject: 'Invoice' },
        // Edit invoices needs See prices.
        { action: 'read', subject: 'Prices' },
      ]);
      const card = await screen.findByTestId('invoice-payment-options');
      expect(await within(card).findByText('Org default: Card and bank')).toBeInTheDocument();
      expect(within(card).getByRole('checkbox', { name: /^card$/i })).not.toBeChecked();
      expect(within(card).getByRole('checkbox', { name: /^bank$/i })).toBeChecked();
      expect(within(card).getByRole('switch', { name: /allow partial payments/i })).toBeChecked();
      expect(within(card).getByRole('button', { name: /use org default/i })).toBeEnabled();
    });

    it('is read-only when the answer for the invoice lists no edit', async () => {
      mount({ payment_methods_override: null, allow_partial_payment: null, actions: [] }, [{ action: 'read', subject: 'Invoice' }]);
      const card = await screen.findByTestId('invoice-payment-options');
      expect(await within(card).findByRole('checkbox', { name: /^card$/i })).toBeDisabled();
      expect(within(card).getByRole('switch', { name: /allow partial payments/i })).toBeDisabled();
    });
  });
});

describe('invoiceDetailWithoutPrices', () => {
  /**
   * Roles & Permissions alignment, AL-05 (P11): the invoice page for a person without See prices. The server leaves every price
   * out of the invoice it sends, and the page draws no total, balance, payment or priced grid, and no document to download.
   */

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

  const INVOICE_ID = 'i0000000-0000-0000-0000-000000000002';

  /** An invoice as the server sends it to a person without the switch: every price key is simply absent. */
  const PRICE_BLIND_INVOICE = {
    id: INVOICE_ID, invoice_number: 'I00002', status: 'PARTIAL', kind: 'STANDARD', public_token: null, sent_at: null, paid_at: null,
    due_date: null, voided_at: null, voided_reason: null, created_at: '2026-01-15T00:00:00.000Z', updated_at: '2026-01-15T00:00:00.000Z',
    line_items: [{ id: 'li-1', invoice_id: INVOICE_ID, sequence: 1, description: 'Replace hinge', quantity: 2, is_taxable: true, item_type: 'MATERIAL' }],
    scopes: [{ id: 's-1', title: 'Fit the door', body: 'Square it up', is_taxable: true }],
    payments: [{ id: 'p-1', method: 'CARD', paid_at: '2026-07-02T12:00:00.000Z', state: 'SUCCEEDED', voided_at: null }],
    refunds: [], credits: [], tags: [], job: null, estimate: null,
    customer: { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', company_name: null, email: 'a@example.test', phone: '5125550125' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('v2 invoice page without See prices', () => {
    it('shows what the work is and how many, with no figure, no Payments tab and no document actions', async () => {
      mountInvoiceDetail({
        id: INVOICE_ID,
        invoice: PRICE_BLIND_INVOICE,
        entry: `/invoices/${INVOICE_ID}`,
        ability: buildAbility([{ action: 'read', subject: 'Invoice' }] as never),
      });

      expect(await screen.findByText('Replace hinge')).toBeInTheDocument();
      expect(screen.getByText('Fit the door')).toBeInTheDocument();
      expect(screen.queryByTestId('invoice-amount-due')).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: /^Payments/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/Preview PDF|Download PDF/)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/\$|NaN/);
    });
  });
});
