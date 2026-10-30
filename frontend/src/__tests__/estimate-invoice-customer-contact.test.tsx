/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.4 - the customer's name, primary phone and primary email on the
   estimate workspace header and the invoice page, drawn through the contact display policy.
   Renders the ROUTED pages (pages/v2/estimates/EstimateWorkspacePage, pages/v2/invoices/InvoiceDetailPage).

   The person's switches come from the "Me" answer, keyed by the catalog's own keys (read from the backend
   catalog file, never typed here). Every case is a custom switch set, never a built-in role name.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';
import InvoiceDetailPage from '@/pages/v2/invoices/InvoiceDetailPage';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { catalogToggle } from './support/backendSwitchCatalog';

const RECORD_ID = 'rec-0000-0000-0000-000000000001';
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: RECORD_ID }), useNavigate: () => mockNavigate };
});

vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
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
vi.mock('@/components/estimates/SendEstimateDialog', () => ({ SendEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// Whether the company has the phone service, toggled per test. Every other feature answers as it does today.
const phoneService = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements')>();
  return {
    ...actual,
    useFeature: (feature: Parameters<typeof actual.useFeature>[0]) =>
      (feature === 'phone' ? phoneService.value : actual.useFeature(feature)),
  };
});

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

type Switches = { copyPhone: boolean; copyEmail: boolean; contact: boolean; view: boolean };
const EVERYTHING_ON: Switches = { copyPhone: true, copyEmail: true, contact: true, view: true };

/** The "Me" answer for a person holding exactly these four switches. */
function meAnswer(s: Switches) {
  return {
    admin_box: false,
    values: {
      [catalogToggle('Copy customer phone').key]: s.copyPhone,
      [catalogToggle('Copy customer email').key]: s.copyEmail,
      [catalogToggle('Contact customers').key]: s.contact,
      [catalogToggle('View customers').key]: s.view,
    },
  };
}

const CUSTOMER = {
  id: 'cust-1', first_name: 'Alice', last_name: 'Test', company_name: null,
  email: 'alice@test.com', phone: '5550001234',
  billing_address_line1: null, billing_city: null, billing_state: null, billing_zip: null,
};

const ESTIMATE = {
  id: RECORD_ID,
  lead_id: 'lead-1',
  customer_id: CUSTOMER.id,
  estimate_number: 'L00042-1',
  name: 'Replace the doors',
  status: ESTIMATE_STATUS.DRAFT,
  approved_at: null, sent_at: null, declined_at: null, cancelled_at: null,
  scope_notes: null,
  tax_rate: '0.0625', subtotal: '1000.00', tax_amount: '62.50', total_amount: '1062.50',
  discount_type: null, discount_value: null, discount_name: null, discount_amount: '0.00',
  signature_data: null, signature_at: null,
  public_token: 'live-token',
  version: 1, modified_after_send: false, superseded_by_id: null,
  created_by: 'user-1',
  created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
  send_config: null,
  lead: {
    id: 'lead-1', lead_number: 'L00042', status: 'ESTIMATED', service_request: 'HVAC repair',
    customer: CUSTOMER,
  },
  creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
  line_items: [], scopes: [], job: null, job_id: null, invoices: [],
};

const INVOICE = {
  id: RECORD_ID,
  invoice_number: 'I00001',
  status: 'DRAFT',
  kind: 'STANDARD',
  subtotal: 100, discount_amount: 0, tax_rate: 0, tax_amount: 0, tip: 0, deposit_credit: 0,
  total_amount: 100, amount_due: 100, net_collected: 0,
  public_token: null, sent_at: null, paid_at: null, due_date: null, voided_at: null, voided_reason: null,
  refunded_at: null, total_refunded: null, refund_reason: null, refund_reason_category: null,
  created_at: '2026-01-15T00:00:00.000Z', updated_at: '2026-01-15T00:00:00.000Z',
  line_items: [], scopes: [], payments: [], refunds: [], credits: [], tags: [],
  job: null, estimate: null,
  customer: CUSTOMER,
};

const PAGES = [
  {
    name: 'the estimate workspace header',
    render: (switches: Switches) => {
      mockApi.get.mockImplementation(async (url: string) => {
        if (url === '/api/permission-switches/me') return { data: meAnswer(switches) };
        if (url.includes('/state-tax-rates')) return { data: { data: [] } };
        if (url.includes('/api/estimates/')) return { data: { estimate: ESTIMATE } };
        return { data: {} };
      });
      return renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });
    },
    context: { customerId: CUSTOMER.id, customerName: 'Alice Test', leadId: 'lead-1', leadLabel: 'L00042' },
    // The estimate header names the customer, with no link to the customer's page for anyone.
    nameLinks: false,
  },
  {
    name: 'the invoice page',
    render: (switches: Switches) => {
      mockApi.get.mockImplementation(async (url: string) => {
        if (url === '/api/permission-switches/me') return { data: meAnswer(switches) };
        if (url.startsWith('/api/invoices/')) return { data: { invoice: INVOICE } };
        return { data: {} };
      });
      return renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });
    },
    context: { customerId: CUSTOMER.id, customerName: 'Alice Test' },
    nameLinks: true,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  // The shared reader keeps the last answer per person; a case starts without the previous case's.
  localStorage.clear();
  phoneService.value = true;
});

describe.each(PAGES)('$name', ({ render, context, nameLinks }) => {
  it('opens the in-app dialer for the primary phone, with the record attached, and leaves no native phone or text link', async () => {
    const user = userEvent.setup();
    render(EVERYTHING_ON);

    await user.click(await screen.findByRole('button', { name: '(555) 000-1234' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Call' }));

    expect(requestCall).toHaveBeenCalledWith('5550001234', context);
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });

  it('opens the in-app composer from the phone, not a native text link', async () => {
    const user = userEvent.setup();
    render(EVERYTHING_ON);

    await user.click(await screen.findByRole('button', { name: '(555) 000-1234' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Text' }));

    expect(mockNavigate).toHaveBeenCalledWith(`/communication/text?customerId=${CUSTOMER.id}`);
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });

  it('shows the digits with no copy control, no selection and no native link with Copy customer phone off', async () => {
    render({ ...EVERYTHING_ON, copyPhone: false });

    // The email's copy control proves the person's switches have landed; the phone is judged after that.
    await screen.findByRole('button', { name: 'Copy email address' });
    const digits = screen.getByText('(555) 000-1234');
    expect(digits.className).toContain('select-none');
    expect(screen.queryByRole('button', { name: 'Copy phone number' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('shows the copy control for the person whose switch is on', async () => {
    render(EVERYTHING_ON);

    expect(await screen.findByRole('button', { name: 'Copy phone number' })).toBeInTheDocument();
  });

  it('gives a native call link to a copy-allowed phone and digits only to the rest, when the company has no phone service', async () => {
    phoneService.value = false;
    const { unmount } = render(EVERYTHING_ON);
    expect(await screen.findByRole('link', { name: '(555) 000-1234' })).toHaveAttribute('href', 'tel:5550001234');
    unmount();

    // Wait for the person's switches to land (the copy control proves they did) before judging the number.
    render({ ...EVERYTHING_ON, copyPhone: false, copyEmail: true });
    await screen.findByRole('button', { name: 'Copy email address' });
    expect(screen.getByText('(555) 000-1234')).toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('keeps the email a mail link only with Copy customer email on', async () => {
    const { unmount } = render(EVERYTHING_ON);
    expect(await screen.findByRole('link', { name: 'alice@test.com' })).toHaveAttribute('href', 'mailto:alice@test.com');
    expect(screen.getByRole('button', { name: 'Copy email address' })).toBeInTheDocument();
    unmount();

    // Wait for the person's switches to land (the phone copy control proves they did) before judging the email.
    render({ ...EVERYTHING_ON, copyEmail: false });
    await screen.findByRole('button', { name: 'Copy phone number' });
    const email = screen.getByText('alice@test.com');
    expect(email.closest('a')).toBeNull();
    expect(email.className).toContain('select-none');
    expect(screen.queryByRole('button', { name: 'Copy email address' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('shows the contact lines and a plain-text name to a person with View customers off', async () => {
    render({ ...EVERYTHING_ON, view: false });

    expect(await screen.findByRole('button', { name: '(555) 000-1234' })).toBeInTheDocument();
    expect(screen.getByText('alice@test.com')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Alice Test' })).not.toBeInTheDocument();
    expect(document.querySelector(`a[href$="/customers/${CUSTOMER.id}"]`)).toBeNull();
  });

  it(nameLinks ? 'links the name to the customer page with View customers on' : 'names the customer in plain text with View customers on', async () => {
    render(EVERYTHING_ON);

    await screen.findByRole('button', { name: '(555) 000-1234' });
    const link = document.querySelector(`a[href$="/customers/${CUSTOMER.id}"]`);
    if (nameLinks) expect(link).not.toBeNull();
    else expect(link).toBeNull();
  });

  it('offers no in-app call or text, and no native link, with Contact customers off', async () => {
    render({ ...EVERYTHING_ON, contact: false });

    // The copy controls prove the person's switches have landed; the phone is judged after that.
    await screen.findByRole('button', { name: 'Copy phone number' });
    expect(screen.getByText('(555) 000-1234')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '(555) 000-1234' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });
});
