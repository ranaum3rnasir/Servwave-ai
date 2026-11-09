/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.12 - the "Sending as" line on the estimate and invoice send dialogs and on the bulk
// send bars, on the ROUTED pages (the estimate workspace, the invoice detail page, and the Invoices and Estimates lists).
//
// The REAL data hooks run; only the network layer is faked. An estimate or an invoice a person sends by hand goes out from their
// OWN address, so each send surface shows that address and the name the customer will see, from the same sending-identity read
// the compose windows use. A person with no address of their own reads the address-needed sentence, and Send is disabled with
// that sentence as its reason, readable by a screen reader.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';

const NEEDED_SENTENCE = "You don't have an email address yet. An admin needs to set one before you can send email.";
const OWN_ADDRESS = 'jane.smith.acme@mail.example.test';
const OWN_NAME = 'Jane Smith at Acme';

type Identity = { status: 'active' | 'address_needed'; address: string | null; name: string | null; sendingEnabled: boolean };
const ACTIVE: Identity = { status: 'active', address: OWN_ADDRESS, name: OWN_NAME, sendingEnabled: true };
const NEEDED: Identity = { status: 'address_needed', address: null, name: null, sendingEnabled: true };

let identity: Identity = ACTIVE;
/** Everything the page posted, in order. */
const posts: { url: string; body: unknown }[] = [];
/** Whether the company has the Email plan feature: the sending identity is only asked while it does. */
let emailFeature = true;

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: (feature: string) => (feature === 'email' ? emailFeature : true),
  useEntitlementsReady: () => true,
}));

const ESTIMATE_ID = 'est-s1012-id';
const INVOICE_ID = 'inv-s1012-id';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: ESTIMATE_ID }), useNavigate: () => vi.fn() };
});

// Heavy sub-surfaces with no bearing on the send dialogs - the same stub set as the sibling page suites.
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({ EstimateTabs: () => null }));
vi.mock('@/components/estimates/EstimateLineItemsEditor', () => ({
  EstimateLineItemsEditor: () => null,
  EstimateScopeOfWorkCard: () => null,
  estimateLinesToInvoiceShape: (lines: unknown) => lines,
}));
vi.mock('@/features/estimate-workspace/components/SignatureCard', () => ({ SignatureCard: () => null }));
vi.mock('@/features/estimate-workspace/components/NotesCard', () => ({ NotesCard: () => null }));
vi.mock('@/features/estimate-workspace/components/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/estimates/PdfPreviewDialog', () => ({ PdfPreviewDialog: () => null }));
vi.mock('@/components/estimates/CancelEstimateDialog', () => ({ CancelEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));
vi.mock('@/components/crm/IconRail', () => ({ IconRail: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/crm/InternalCostsCard', () => ({ InternalCostsCard: () => null }));
vi.mock('@/components/leads/TagInput', () => ({ TagInput: () => null }));
vi.mock('@/components/invoices/InvoiceReceiptCard', () => ({ InvoiceReceiptCard: () => null }));
vi.mock('@/components/invoices/InvoiceLineItemsEditor', () => ({
  InvoiceLineItemsEditor: () => null,
  InvoiceScopeOfWorkCard: () => null,
}));
vi.mock('@/components/invoices/RecordPaymentDialog', () => ({ RecordPaymentDialog: () => null }));
vi.mock('@/components/invoices/VoidInvoiceDialog', () => ({ VoidInvoiceDialog: () => null }));
vi.mock('@/components/invoices/DeleteInvoiceDialog', () => ({ DeleteInvoiceDialog: () => null }));
vi.mock('@/components/invoices/RefundInvoiceDialog', () => ({ RefundInvoiceDialog: () => null }));
vi.mock('@/components/invoices/CreditInvoiceDialog', () => ({ CreditInvoiceDialog: () => null }));
vi.mock('@/components/invoices/VoidPaymentDialog', () => ({ VoidPaymentDialog: () => null }));
vi.mock('@/components/crm/RecordNumberEditor', () => ({ RecordNumberEditor: ({ number }: { number: string }) => <span>{number}</span> }));

import { DEPOSIT_DEFAULTS, renderEstimateWorkspace, serveEstimateWorkspace } from '@/__tests__/harness/estimateWorkspacePage';
import { renderInvoiceDetail, serveInvoiceDetail } from '@/__tests__/harness/invoiceDetailPage';
import InvoicesPage from '@/pages/v2/invoices/InvoicesPage';
import EstimatesPage from '@/pages/v2/estimates/EstimatesPage';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────

const CUSTOMER = {
  id: 'cust-1', first_name: 'Ran', last_name: 'Roffe', company_name: null, email: 'ran@customer.test', phone: '5550001234',
  billing_address_line1: null, billing_city: null, billing_state: null, billing_zip: null,
};

const DRAFT_ESTIMATE = {
  id: ESTIMATE_ID, estimate_number: 'C00002-1', name: null, status: 'DRAFT', approved_at: null, sent_at: null, declined_at: null,
  cancelled_at: null, scope_notes: null, tax_rate: '0.0625', subtotal: '1000.00', tax_amount: '62.50', total_amount: '1062.50',
  discount_type: null, discount_value: null, discount_name: null, discount_amount: '0.00', signature_data: null, signature_at: null,
  public_token: null, version: 1, modified_after_send: false, superseded_by_id: null, created_by: 'user-1',
  created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z', send_config: null,
  creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' }, line_items: [], scopes: [], job: null, job_id: null, invoices: [],
  lead_id: null, lead: null, customer_id: CUSTOMER.id, customer: CUSTOMER,
  actions: ['edit', 'send', 'delete', 'cancel', 'record_payment'],
};

function invoiceDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID, invoice_number: 'I01012', status: 'DRAFT', subtotal: '100.00', discount_amount: '0.00', tax_rate: '0', tax_amount: '0.00',
    deposit_credit: '0.00', total_amount: '100.00', amount_due: '100.00', sent_at: null, paid_at: null, due_date: '2026-06-15T00:00:00.000Z',
    voided_at: null, voided_reason: null, refunded_at: null, total_refunded: null, refund_reason: null, refund_reason_category: null,
    kind: 'STANDARD', created_at: '2026-06-01T00:00:00.000Z', updated_at: '2026-06-01T00:00:00.000Z',
    customer: { id: 'cust-1', first_name: 'Jane', last_name: 'Doe', company_name: null, email: 'jane@customer.test' },
    job: null, line_items: [], scopes: [], refunds: [], credits: [], payments: [], tags: [],
    actions: ['edit', 'send', 'delete', 'copy_payment_link', 'record_payment'],
    ...overrides,
  };
}

const listRow = (id: string, number: string, status: string) => ({
  id, invoice_number: number, status, kind: 'STANDARD', subtotal: '100.00', discount_amount: '0.00', tax_amount: '0.00',
  deposit_credit: '0.00', total_amount: '100.00', amount_due: '100.00', due_date: null, sent_at: status === 'DRAFT' ? null : '2026-06-01T00:00:00.000Z',
  paid_at: null, created_at: '2026-06-01T00:00:00.000Z', job: null,
  customer: { id: 'c1', first_name: 'Dana', last_name: 'Deposit', company_name: null },
});

const INVOICE_STATS = { due: { total: 0, count: 0 }, overdue: { total: 0, count: 0 }, collected_this_month: { total: 0, count: 0 }, unsent: 0, need_invoices: 0, deposits_held: 0 };

/** Answers every read the pages make; `page` adds the one the page under test needs. */
function answerNetwork(page: (url: string) => unknown | undefined) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/communication/sending-identity') return { data: identity };
    const own = page(url);
    if (own !== undefined) return { data: own };
    return { data: {} };
  });
  answerPosts();
}

function answerPosts() {
  mockApi.post.mockImplementation(async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return { data: { sent: [], failed: [] } };
  });
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  posts.length = 0;
  identity = ACTIVE;
  emailFeature = true;
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

/** The "Sending as" line a surface shows, found by its label. */
const sendingAsLine = async () => (await screen.findByText('Sending as')).parentElement!;

// ─── The estimate send dialog (routed: the estimate workspace) ─────────────────────────────────────────────────────

describe('the estimate workspace: the send dialog', () => {
  function setup() {
    serveEstimateWorkspace({
      estimate: DRAFT_ESTIMATE,
      organization: DEPOSIT_DEFAULTS,
      routes: [{ match: (url) => url === '/api/communication/sending-identity', data: () => identity }],
    });
    answerPosts();
    renderEstimateWorkspace();
  }
  async function openDialog() {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole('button', { name: /^Send$/i }));
    await screen.findByLabelText('To');
    return user;
  }
  const dialogSend = () => screen.getByRole('button', { name: /^Send C00002-1/ });

  it('shows the sender\'s own address and the name the customer will see, and Send works', async () => {
    setup();
    await openDialog();

    const line = await sendingAsLine();
    await waitFor(() => expect(within(line).getByText(OWN_ADDRESS, { exact: false })).toBeInTheDocument());
    expect(within(line).getByText(OWN_NAME)).toBeInTheDocument();
    expect(dialogSend()).toBeEnabled();
    // No From choice: the line is text, not a picker.
    expect(within(line).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('reads the address-needed sentence for a person with no address, and disables Send with the reason readable', async () => {
    identity = NEEDED;
    setup();
    await openDialog();

    const line = await sendingAsLine();
    await waitFor(() => expect(within(line).getByText(NEEDED_SENTENCE)).toBeInTheDocument());
    expect(dialogSend()).toBeDisabled();
    expect(dialogSend()).toHaveAccessibleDescription(NEEDED_SENTENCE);
    expect(within(line).queryByText(OWN_ADDRESS, { exact: false })).not.toBeInTheDocument();
    expect(posts.filter((p) => p.url.endsWith('/send'))).toEqual([]);
  });

  it('keeps Send disabled, with its reason, while the company has outgoing email off', async () => {
    identity = { ...ACTIVE, sendingEnabled: false };
    setup();
    await openDialog();

    await waitFor(() => expect(dialogSend()).toBeDisabled());
    expect(dialogSend()).toHaveAccessibleDescription('Email sending is off for this organization');
  });

  it('claims nothing while the company lacks the Email plan feature: no line, and Send is as it was', async () => {
    emailFeature = false;
    setup();
    await openDialog();

    expect(screen.queryByText('Sending as')).not.toBeInTheDocument();
    expect(dialogSend()).toBeEnabled();
  });
});

// ─── The invoice send dialog (routed: the invoice detail page) ─────────────────────────────────────────────────────

describe('the invoice detail page: the send and resend dialogs', () => {
  function setup(invoice: Record<string, unknown>) {
    serveInvoiceDetail({
      invoice,
      routes: [{ match: (url) => url === '/api/communication/sending-identity', data: () => identity }],
    });
    answerPosts();
    renderInvoiceDetail({ id: ESTIMATE_ID, ability: adminAbility });
  }
  async function openDialog(button: RegExp) {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole('button', { name: button }));
    await screen.findByLabelText('To');
    return user;
  }

  it('shows the sender\'s own address and name on a send, and Send works', async () => {
    setup(invoiceDetail());
    await openDialog(/^Send invoice$/i);

    const line = await sendingAsLine();
    await waitFor(() => expect(within(line).getByText(OWN_ADDRESS, { exact: false })).toBeInTheDocument());
    expect(within(line).getByText(OWN_NAME)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Send Invoice$/ })).toBeEnabled();
  });

  it('shows it on a resend too', async () => {
    setup(invoiceDetail({ status: 'SENT', sent_at: '2026-06-01T00:00:00.000Z', public_token: 'tok-1012' }));
    await openDialog(/resend invoice/i);

    const line = await sendingAsLine();
    await waitFor(() => expect(within(line).getByText(OWN_ADDRESS, { exact: false })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Resend Invoice$/ })).toBeEnabled();
  });

  it('reads the address-needed sentence for a person with no address, and disables Send with the reason readable', async () => {
    identity = NEEDED;
    setup(invoiceDetail());
    await openDialog(/^Send invoice$/i);

    const line = await sendingAsLine();
    await waitFor(() => expect(within(line).getByText(NEEDED_SENTENCE)).toBeInTheDocument());
    const send = screen.getByRole('button', { name: /^Send Invoice$/ });
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(NEEDED_SENTENCE);
    expect(posts).toEqual([]);
  });
});

// ─── Bulk send (routed: the Invoices and Estimates lists) ──────────────────────────────────────────────────────────

describe('the Invoices list: bulk send', () => {
  function setup() {
    answerNetwork((url) => {
      if (url === '/api/invoices') {
        return { invoices: [listRow('a1', 'I-DRAFT', 'DRAFT'), listRow('a2', 'I-SENT', 'SENT')], total: 2, page: 1, pageSize: 25, stats: INVOICE_STATS };
      }
      return undefined;
    });
    renderWithProviders(<InvoicesPage />, { ability: adminAbility });
  }
  async function selectFirstRow() {
    const row = (await screen.findByText('I-DRAFT')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    return screen.findByText(/1 invoice selected/);
  }
  const bar = () => document.querySelector('[data-slot="bulk-action-bar"]') as HTMLElement;

  it('shows the sender\'s own address on the bar, with Send and Send reminder enabled', async () => {
    setup();
    await selectFirstRow();

    await waitFor(() => expect(within(bar()).getByText(OWN_ADDRESS, { exact: false })).toBeInTheDocument());
    expect(within(bar()).getByText(OWN_NAME)).toBeInTheDocument();
    expect(within(bar()).getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(within(bar()).getByRole('button', { name: 'Send reminder' })).toBeEnabled();
  });

  it('reads the address-needed sentence and disables both bulk buttons with the reason readable', async () => {
    identity = NEEDED;
    setup();
    await selectFirstRow();

    const line = (await within(bar()).findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(NEEDED_SENTENCE)).toBeInTheDocument());
    for (const name of ['Send', 'Send reminder']) {
      const button = within(bar()).getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(NEEDED_SENTENCE);
    }
    expect(posts).toEqual([]);
  });
});

describe('the Estimates list: bulk send reminder', () => {
  const estimateRow = {
    id: 'e1', estimate_number: 'E-SENT', name: null, status: 'SENT', total_amount: '500.00', created_at: '2026-06-01T00:00:00.000Z',
    sent_at: '2026-06-02T00:00:00.000Z', lead: null, lead_id: null, customer_id: 'c1', customer: { id: 'c1', first_name: 'Dana', last_name: 'Deposit', company_name: null },
    creator: { id: 'u1', first_name: 'Test', last_name: 'Admin' }, job: null, job_id: null, tags: [],
  };
  function setup() {
    answerNetwork((url) => {
      if (url === '/api/estimates') {
        return {
          estimates: [estimateRow], pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
          stats: { by_status: {}, worth: {} },
        };
      }
      return undefined;
    });
    renderWithProviders(<EstimatesPage />, { ability: adminAbility });
  }
  const bar = () => document.querySelector('[data-slot="bulk-action-bar"]') as HTMLElement;
  async function selectRow() {
    const row = (await screen.findByText('E-SENT')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    await screen.findByText(/1 estimate selected/);
  }

  it('shows the sender\'s own address on the bar and keeps Send reminder enabled', async () => {
    setup();
    await selectRow();

    await waitFor(() => expect(within(bar()).getByText(OWN_ADDRESS, { exact: false })).toBeInTheDocument());
    expect(within(bar()).getByRole('button', { name: 'Send reminder' })).toBeEnabled();
  });

  it('reads the address-needed sentence and disables Send reminder with the reason readable', async () => {
    identity = NEEDED;
    setup();
    await selectRow();

    const line = (await within(bar()).findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(NEEDED_SENTENCE)).toBeInTheDocument());
    const button = within(bar()).getByRole('button', { name: 'Send reminder' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(NEEDED_SENTENCE);
  });
});
