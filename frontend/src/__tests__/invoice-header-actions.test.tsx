import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderInvoiceDetail, serveInvoiceDetail } from '@/__tests__/harness/invoiceDetailPage';
import { readFileSync } from 'node:fs';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/invoiceDetailRouter')).invoiceDetailRouter({ navigate: true }));
vi.mock('@/components/crm/IconRail', () => ({ IconRail: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/crm/InternalCostsCard', () => ({ InternalCostsCard: () => null }));
vi.mock('@/components/leads/TagInput', () => ({ TagInput: () => null }));
vi.mock('@/components/estimates/PdfPreviewDialog', () => ({ PdfPreviewDialog: () => null }));
vi.mock('@/components/invoices/InvoiceReceiptCard', () => ({ InvoiceReceiptCard: () => null }));
vi.mock('@/components/invoices/InvoiceLineItemsEditor', () => ({
  InvoiceLineItemsEditor: () => null,
  InvoiceScopeOfWorkCard: () => null,
}));
vi.mock('@/components/invoices/SendInvoiceDialog', () => ({ SendInvoiceDialog: () => null }));
vi.mock('@/components/invoices/RecordPaymentDialog', () => ({ RecordPaymentDialog: () => null }));
vi.mock('@/components/invoices/VoidInvoiceDialog', () => ({ VoidInvoiceDialog: () => null }));
vi.mock('@/components/invoices/DeleteInvoiceDialog', () => ({ DeleteInvoiceDialog: () => null }));
vi.mock('@/components/invoices/RefundInvoiceDialog', () => ({ RefundInvoiceDialog: () => null }));
vi.mock('@/components/invoices/CreditInvoiceDialog', () => ({ CreditInvoiceDialog: () => null }));
vi.mock('@/components/invoices/VoidPaymentDialog', () => ({ VoidPaymentDialog: () => null }));
vi.mock('@/components/crm/RecordNumberEditor', () => ({ RecordNumberEditor: ({ number }: { number: string }) => <span>{number}</span> }));

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('invoice-copy-link-redacted', () => {
  /**
   * #1997 round 3 (HIGH) — the backend now deletes `public_token` from the invoice detail response
   * entirely (not just nulls it) when the requester cannot read the anchored customer, because an
   * unauthenticated public PDF route accepts that token with no read-Customer check at all.
   *
   * The invoice detail page's "Copy Link" control does double duty (unlike the estimate side's):
   * `handleCopyLink` copies the existing link when `invoice.public_token` is present, and otherwise
   * calls `createInvoicePaymentLink` — a live, authenticated, unrelated-to-Customer-read backend
   * action that mints (or, for an ALREADY-sent invoice, simply returns) the real token in its `url`
   * response field. Treating "key absent because redacted" the same as "key null because never
   * sent" would turn that fallback into a side door: a requester denied the customer's contact block
   * could still fetch the very link the read response just withheld. The control must therefore
   * disable itself (neutral copy, no crash, no `token=undefined`) when the key is absent, and must
   * NOT invoke the payment-link mutation in that state.
   */

  const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
  const INVOICE_ID = 'inv-1997-copylink-id';

  // Heavy sub-surfaces with no bearing on the Actions menu — none of these render anything the
  // "Copy Link" control depends on.

  const mockApi = vi.mocked(api);

  function baseInvoice(overrides: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I01997',
      status: 'SENT',
      subtotal: '100.00',
      discount_amount: '0.00',
      tax_rate: '0',
      tax_amount: '0.00',
      deposit_credit: '0.00',
      total_amount: '100.00',
      amount_due: '100.00',
      sent_at: '2026-06-01T00:00:00.000Z',
      paid_at: null,
      due_date: '2026-06-15T00:00:00.000Z',
      voided_at: null,
      voided_reason: null,
      refunded_at: null,
      total_refunded: null,
      refund_reason: null,
      refund_reason_category: null,
      kind: 'STANDARD',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      customer: { id: 'cust-1997', first_name: 'Jane', last_name: 'Doe', company_name: null },
      job: null,
      line_items: [],
      scopes: [],
      refunds: [],
      credits: [],
      payments: [],
      tags: [],
      // The server's answer for this invoice: every action the page can offer.
      actions: ['edit', 'send', 'delete', 'copy_payment_link', 'record_payment'],
      ...overrides,
    };
  }

  function setupMocks(invoice: Record<string, unknown>) {
    serveInvoiceDetail({ invoice });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('InvoiceDetailPage — Copy Link control when public_token is redacted', () => {
    it('disables Copy Link with neutral copy when public_token is entirely ABSENT (redacted requester), and does not mint a payment link', async () => {
      const invoice = baseInvoice();
      delete (invoice as { public_token?: string }).public_token; // key absent, not null
      setupMocks(invoice);
      const user = userEvent.setup();

      renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

      await user.click(await screen.findByRole('button', { name: 'More actions' }));
      const item = await screen.findByRole('menuitem', { name: /not available/i });
      expect(item).toHaveAttribute('aria-disabled', 'true');

      await user.click(item);
      expect(mockApi.post).not.toHaveBeenCalledWith(expect.stringContaining('/payment-link'));
    });

    it('does not offer the payment link at all to a person without See prices: the link opens the customer\'s priced page (H6)', async () => {
      // The server leaves the token out for this person; the menu must not blame the customer for it.
      const invoice = baseInvoice();
      delete (invoice as { public_token?: string }).public_token;
      setupMocks(invoice);
      const user = userEvent.setup();
      const noPrices = buildAbility([{ action: 'manage', subject: 'all' }, { action: 'read', subject: 'Prices', inverted: true }]);

      renderInvoiceDetail({ id: INVOICE_ID, ability: noPrices });

      await user.click(await screen.findByRole('button', { name: 'More actions' }));
      await screen.findByRole('menuitem', { name: /print/i });
      expect(screen.queryByRole('menuitem', { name: /link|not available/i })).not.toBeInTheDocument();
      expect(mockApi.post).not.toHaveBeenCalledWith(expect.stringContaining('/payment-link'));
    });

    it('copies the existing link (no mutation call) when public_token is present', async () => {
      const invoice = baseInvoice({ public_token: 'tok-1997' });
      setupMocks(invoice);
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        writable: true,
        configurable: true,
      });

      renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

      await user.click(await screen.findByRole('button', { name: 'More actions' }));
      const item = await screen.findByRole('menuitem', { name: /copy payment link/i });
      await user.click(item);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('token=tok-1997'));
      expect(mockApi.post).not.toHaveBeenCalledWith(expect.stringContaining('/payment-link'), undefined);
    });

    it('still offers "Copy payment link" (mints one) when public_token is null (genuinely never sent) — unchanged pre-existing behavior', async () => {
      const invoice = baseInvoice({ status: 'DRAFT', sent_at: null, public_token: null });
      setupMocks(invoice);
      mockApi.post.mockResolvedValue({ data: { invoice, url: 'https://app.example.test/p/invoices/x?token=fresh' } });
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        writable: true,
        configurable: true,
      });

      renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

      await user.click(await screen.findByRole('button', { name: 'More actions' }));
      const item = await screen.findByRole('menuitem', { name: /copy payment link/i });
      await user.click(item);

      expect(mockApi.post).toHaveBeenCalledWith(expect.stringContaining('/payment-link'));
    });
  });
});

describe('invoice-page-actions-follow-record', () => {
  /**
   * Roles & Permissions S04.27 - the invoice page draws send, resend, edit, delete a draft, copy payment link and record
   * payment from the server's answer for THIS invoice (`invoice.actions`), not from the person's role name or their
   * switches alone. A creator with View invoices off finishes their own invoice (their ability holds nothing on invoices
   * at all); a person whose answer for the invoice is empty gets none of the buttons, an Admin-named role included.
   * Renders the routed page (pages/v2/invoices/InvoiceDetailPage).
   */

  const INVOICE_ID = 'inv-s0427-actions-id';

  // Heavy sub-surfaces with no bearing on the header's actions.


  function baseInvoice(overrides: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I0427',
      status: 'DRAFT',
      subtotal: '100.00',
      discount_amount: '0.00',
      tax_rate: '0',
      tax_amount: '0.00',
      deposit_credit: '0.00',
      total_amount: '100.00',
      amount_due: '100.00',
      sent_at: null,
      paid_at: null,
      due_date: '2026-06-15T00:00:00.000Z',
      voided_at: null,
      voided_reason: null,
      refunded_at: null,
      total_refunded: null,
      refund_reason: null,
      refund_reason_category: null,
      kind: 'STANDARD',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      customer: { id: 'cust-1997', first_name: 'Jane', last_name: 'Doe', company_name: null },
      job: null,
      line_items: [],
      scopes: [],
      refunds: [],
      credits: [],
      payments: [],
      tags: [],
      public_token: null,
      actions: [],
      ...overrides,
    };
  }

  function setupMocks(invoice: Record<string, unknown>) {
    serveInvoiceDetail({ invoice });
  }

  /** Sign in as a person with this base role name; the page must not read it to decide any action. */
  function signedInWithRole(role: string) {
    vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        user: { id: 'u-s0427', email: 'p@test.com', first_name: 'Pat', last_name: 'Person', role },
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })) as never);
  }

  /**
   * A person whose switches grant nothing on invoices: they reach the page by the creator rule alone. They hold See prices
   * (P11) because the PDF preview the menu tests anchor on is the invoice's prices.
   */
  const NO_INVOICE_SWITCHES = () => buildAbility([{ action: 'read', subject: 'Prices' }]);

  async function openMenu() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await screen.findByRole('menuitem', { name: /preview pdf/i });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('InvoiceDetailPage - the buttons follow the answer for this invoice', () => {
    it('offers send, edit and delete on a draft the person made, with no View invoices and no Edit invoices', async () => {
      signedInWithRole('TECHNICIAN');
      setupMocks(baseInvoice({ actions: ['edit', 'send', 'delete'] }));

      renderInvoiceDetail({ id: INVOICE_ID, ability: NO_INVOICE_SWITCHES() });

      expect(await screen.findByRole('button', { name: /send invoice/i })).toBeInTheDocument();
      await openMenu();
      expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
      // The creator rule never opens the money actions.
      expect(screen.queryByRole('menuitem', { name: /payment link/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /record payment/i })).not.toBeInTheDocument();
    });

    it('offers none of them on an invoice whose answer is empty, to an admin-named role holding every switch', async () => {
      signedInWithRole('ADMIN');
      setupMocks(baseInvoice({ actions: [] }));

      renderInvoiceDetail({ id: INVOICE_ID,
        ability: buildAbility([
          { action: 'read', subject: 'Invoice' }, { action: 'update', subject: 'Invoice' }, { action: 'send', subject: 'Invoice' },
          { action: 'delete', subject: 'Invoice' }, { action: 'record_payment', subject: 'Invoice' }, { action: 'send_payment_link', subject: 'Invoice' },
          { action: 'read', subject: 'Prices' },
        ]),
      });

      await openMenu();
      expect(screen.queryByRole('button', { name: /send invoice/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /payment link/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /record payment/i })).not.toBeInTheDocument();
    });

    it('offers resend on a sent invoice when the answer lists send', async () => {
      signedInWithRole('TECHNICIAN');
      setupMocks(baseInvoice({ status: 'SENT', sent_at: '2026-06-01T00:00:00.000Z', actions: ['edit', 'send'] }));

      renderInvoiceDetail({ id: INVOICE_ID, ability: NO_INVOICE_SWITCHES() });

      expect(await screen.findByRole('button', { name: /resend invoice/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^send invoice/i })).not.toBeInTheDocument();
    });

    it('offers copy payment link and record payment when the answer lists them, whatever the ability says', async () => {
      signedInWithRole('TECHNICIAN');
      setupMocks(baseInvoice({ status: 'SENT', sent_at: '2026-06-01T00:00:00.000Z', actions: ['copy_payment_link', 'record_payment'] }));

      renderInvoiceDetail({ id: INVOICE_ID, ability: NO_INVOICE_SWITCHES() });

      expect((await screen.findAllByRole('button', { name: /record payment/i })).length).toBeGreaterThan(0);
      await openMenu();
      expect(screen.getByRole('menuitem', { name: /copy payment link/i })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument();
    });

    it('asks no role name anywhere on the page', () => {
      const source = readFileSync('src/pages/v2/invoices/InvoiceDetailPage.tsx', 'utf8');
      expect(source).not.toMatch(/user\??\.role\b/);
      expect(source).not.toMatch(/['"](?:ADMIN|DISPATCHER|TECHNICIAN|SALES)['"]/);
    });
  });
});

describe('invoice-payment-link-switch', () => {
  /**
   * Roles & Permissions S01.17 - the invoice page's payment-link action follows the "Send payment links" switch, not
   * the person's role name. The routed page (pages/v2/invoices/InvoiceDetailPage) offers "Copy payment link" to a
   * person whose ability holds `send_payment_link` on invoices whatever their role is called (a technician on their own
   * invoice), and offers it to nobody whose ability lacks it, an Admin-named role included.
   */

  const INVOICE_ID = 'inv-s0117-paylink-id';

  // Heavy sub-surfaces with no bearing on the Actions menu — none of these render anything the
  // "Copy Link" control depends on.


  function baseInvoice(overrides: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I0117',
      status: 'SENT',
      subtotal: '100.00',
      discount_amount: '0.00',
      tax_rate: '0',
      tax_amount: '0.00',
      deposit_credit: '0.00',
      total_amount: '100.00',
      amount_due: '100.00',
      sent_at: '2026-06-01T00:00:00.000Z',
      paid_at: null,
      due_date: '2026-06-15T00:00:00.000Z',
      voided_at: null,
      voided_reason: null,
      refunded_at: null,
      total_refunded: null,
      refund_reason: null,
      refund_reason_category: null,
      kind: 'STANDARD',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      customer: { id: 'cust-1997', first_name: 'Jane', last_name: 'Doe', company_name: null },
      job: null,
      line_items: [],
      scopes: [],
      refunds: [],
      credits: [],
      payments: [],
      tags: [],
      actions: [],
      ...overrides,
    };
  }

  function setupMocks(invoice: Record<string, unknown>) {
    serveInvoiceDetail({ invoice });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Sign in as a person with this base role name; the page must not read it to decide the link action. */
  function signedInWithRole(role: string) {
    vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        user: { id: 'u-s0117', email: 'p@test.com', first_name: 'Pat', last_name: 'Person', role },
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })) as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('InvoiceDetailPage - the payment-link action follows the Send payment links switch', () => {
    it('offers Copy payment link to a technician-role person whose answer for the invoice lists it', async () => {
      signedInWithRole('TECHNICIAN');
      setupMocks(baseInvoice({ status: 'DRAFT', sent_at: null, public_token: null, actions: ['copy_payment_link'] }));
      const user = userEvent.setup();

      renderInvoiceDetail({ id: INVOICE_ID,
        // The link opens the customer's priced page, so the copy needs See prices too (H6, ticket 34).
        ability: buildAbility([
          { action: 'read', subject: 'Invoice' }, { action: 'send_payment_link', subject: 'Invoice' }, { action: 'read', subject: 'Prices' },
        ]),
      });

      await user.click(await screen.findByRole('button', { name: 'More actions' }));
      expect(await screen.findByRole('menuitem', { name: /copy payment link/i })).toBeInTheDocument();
    });

    it('offers no payment link to an admin-role person whose answer for the invoice leaves it out', async () => {
      signedInWithRole('ADMIN');
      setupMocks(baseInvoice({ status: 'DRAFT', sent_at: null, public_token: null, actions: ['edit', 'send'] }));
      const user = userEvent.setup();

      renderInvoiceDetail({ id: INVOICE_ID,
        ability: buildAbility([
          { action: 'read', subject: 'Invoice' }, { action: 'send', subject: 'Invoice' }, { action: 'update', subject: 'Invoice' },
          { action: 'read', subject: 'Prices' },
        ]),
      });

      await user.click(await screen.findByRole('button', { name: 'More actions' }));
      await screen.findByRole('menuitem', { name: /preview pdf/i });
      expect(screen.queryByRole('menuitem', { name: /payment link/i })).not.toBeInTheDocument();
    });
  });
});

describe('invoice-refund-switch', () => {
  /**
   * Roles & Permissions S04.26 - the invoice page's Refund action follows the "Refund payments" switch, not the person's
   * role name or their other money switches. The routed page (pages/v2/invoices/InvoiceDetailPage) offers Refund on a
   * paid invoice to a person whose ability holds `refund` on invoices whatever their role is called, and to nobody whose
   * ability lacks it - an Admin-named role, and a person who holds Record payments, void and credit, included.
   */

  const INVOICE_ID = 'inv-s0426-refund-id';

  // Heavy sub-surfaces with no bearing on the Actions menu — none of these render anything the
  // "Copy Link" control depends on.


  function baseInvoice(overrides: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I0426',
      status: 'PAID',
      subtotal: '100.00',
      discount_amount: '0.00',
      tax_rate: '0',
      tax_amount: '0.00',
      deposit_credit: '0.00',
      total_amount: '100.00',
      amount_due: '0.00',
      net_collected: '100.00',
      sent_at: '2026-06-01T00:00:00.000Z',
      paid_at: null,
      due_date: '2026-06-15T00:00:00.000Z',
      voided_at: null,
      voided_reason: null,
      refunded_at: null,
      total_refunded: null,
      refund_reason: null,
      refund_reason_category: null,
      kind: 'STANDARD',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      customer: { id: 'cust-1997', first_name: 'Jane', last_name: 'Doe', company_name: null },
      job: null,
      line_items: [],
      scopes: [],
      refunds: [],
      credits: [],
      payments: [{ id: 'pay-1', amount: '100.00', method: 'CASH', paid_at: '2026-06-02T00:00:00.000Z', state: 'SUCCEEDED', voided_at: null, reference_number: null }],
      tags: [],
      ...overrides,
    };
  }

  function setupMocks(invoice: Record<string, unknown>) {
    serveInvoiceDetail({ invoice });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Sign in as a person with this base role name; the page must not read it to decide the link action. */
  function signedInWithRole(role: string) {
    vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        user: { id: 'u-s0426', email: 'p@test.com', first_name: 'Pat', last_name: 'Person', role },
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })) as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('InvoiceDetailPage - the Refund action follows the Refund payments switch', () => {
    it('offers Refund on a paid invoice to a technician-role person who holds the switch', async () => {
      signedInWithRole('TECHNICIAN');
      setupMocks(baseInvoice());

      renderInvoiceDetail({ id: INVOICE_ID,
        // Refund payments needs View invoices and View payments and payouts.
        ability: buildAbility([
          { action: 'read', subject: 'Invoice' }, { action: 'refund', subject: 'Invoice' },
          { action: 'view_payments', subject: 'Organization' },
        ]),
      });

      expect((await screen.findAllByRole('button', { name: 'Refund' })).length).toBeGreaterThan(0);
    });

    it('offers no Refund to an admin-role person who holds every other money switch but not this one', async () => {
      signedInWithRole('ADMIN');
      setupMocks(baseInvoice());

      renderInvoiceDetail({ id: INVOICE_ID,
        ability: buildAbility([
          { action: 'read', subject: 'Invoice' }, { action: 'record_payment', subject: 'Invoice' },
          { action: 'credit', subject: 'Invoice' }, { action: 'void', subject: 'Invoice' }, { action: 'send_payment_link', subject: 'Invoice' },
          // Record payments needs See prices.
          { action: 'read', subject: 'Prices' },
        ]),
      });

      await screen.findAllByRole('button', { name: 'Credit' });
      expect(screen.queryByRole('button', { name: 'Refund' })).not.toBeInTheDocument();
    });
  });
});

describe('invoice-resend-redacted', () => {
  /**
   * #1997 follow-on — `getAvailableActions`'s `canResend` (invoiceMoney.ts) used
   * `!!invoice.public_token` as a "has this invoice ever been sent" proxy. Since round 3's fix
   * (see `handoffs/security-fix-2.md`), `public_token` is entirely ABSENT on a document whose
   * anchored customer the requester cannot read — so a requester with `resend Invoice` but a
   * narrowed `read Customer` lost the Resend button on an already-SENT invoice, even though the
   * backend still allows the resend (it resolves the recipient from the DB row, not the redacted
   * response).
   *
   * The real "was this sent" signal is `status` (SENT/PARTIAL) plus `sent_at`, exactly the pair the
   * backend's own `isSentInvoice()` (backend/src/lib/invoice-editable.ts) uses. Both are always
   * projected in `invoiceDetailSelect` and neither is touched by the customer-contact redaction, so
   * the Resend button must key off those, not off `public_token`.
   */

  const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
  const INVOICE_ID = 'inv-1997-resend-id';

  // Heavy sub-surfaces with no bearing on the Resend button.


  function baseInvoice(overrides: Record<string, unknown> = {}) {
    return {
      id: INVOICE_ID,
      invoice_number: 'I01997',
      status: 'SENT',
      subtotal: '100.00',
      discount_amount: '0.00',
      tax_rate: '0',
      tax_amount: '0.00',
      deposit_credit: '0.00',
      total_amount: '100.00',
      amount_due: '100.00',
      sent_at: '2026-06-01T00:00:00.000Z',
      paid_at: null,
      due_date: '2026-06-15T00:00:00.000Z',
      voided_at: null,
      voided_reason: null,
      refunded_at: null,
      total_refunded: null,
      refund_reason: null,
      refund_reason_category: null,
      kind: 'STANDARD',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      customer: { id: 'cust-1997', first_name: 'Jane', last_name: 'Doe', company_name: null },
      job: null,
      line_items: [],
      scopes: [],
      refunds: [],
      credits: [],
      payments: [],
      tags: [],
      // The server's answer for this invoice: every action the page can offer.
      actions: ['edit', 'send', 'delete', 'copy_payment_link', 'record_payment'],
      ...overrides,
    };
  }

  function setupMocks(invoice: Record<string, unknown>) {
    serveInvoiceDetail({ invoice });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('InvoiceDetailPage — Resend button when public_token is redacted', () => {
    it('still offers Resend on a SENT invoice when public_token is entirely ABSENT (redacted requester)', async () => {
      const invoice = baseInvoice();
      delete (invoice as { public_token?: string }).public_token; // key absent, not null
      setupMocks(invoice);

      renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

      expect(await screen.findByRole('button', { name: /resend invoice/i })).toBeInTheDocument();
    });

    it('offers Resend on a SENT invoice when public_token is present (unchanged)', async () => {
      const invoice = baseInvoice({ public_token: 'tok-1997' });
      setupMocks(invoice);

      renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

      expect(await screen.findByRole('button', { name: /resend invoice/i })).toBeInTheDocument();
    });

    it('never offers Resend on a DRAFT invoice, token or not', async () => {
      const invoice = baseInvoice({ status: 'DRAFT', sent_at: null, public_token: null });
      setupMocks(invoice);

      renderInvoiceDetail({ id: INVOICE_ID, ability: adminAbility });

      await screen.findByText('I01997');
      expect(screen.queryByRole('button', { name: /resend invoice/i })).not.toBeInTheDocument();
    });
  });
});
