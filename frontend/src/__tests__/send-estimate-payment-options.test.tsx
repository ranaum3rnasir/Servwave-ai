/**
 * Payments go-live slice 21 - the estimate send dialog's payment options.
 *
 * The send keeps its per-send methods and deposit settings, and gains the deposit-policy override
 * (story 30): a trusted customer can approve now and pay the deposit later. Both say when they
 * differ from the org default, and the policy saves to the estimate (PATCH, null = the org's)
 * before the send goes out, the same order the deposit figure already uses.
 */
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from './helpers';
import { SendEstimateDialog } from '@/components/estimates/SendEstimateDialog';
import { renderEstimateWorkspace, serveEstimateWorkspace } from '@/__tests__/harness/estimateWorkspacePage';

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn(), patch: vi.fn(), get: vi.fn() },
}));

const mockOrg = vi.fn();
vi.mock('@/lib/api/shared/organization', () => ({
  useOrganization: () => mockOrg(),
}));

vi.mock('@/components/payments/PaymentsSetupBanner', () => ({
  PaymentsSetupBanner: () => null,
}));

// The page-level test below drives the real dialog through EstimateWorkspacePage; these are the
// page's heavy sub-surfaces with no bearing on the send dialog (the same stub set as
// estimate-send-recipient-prefill.test.tsx). The dialog-level tests never render them.
const PAGE_ESTIMATE_ID = 'est-locked-id';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: PAGE_ESTIMATE_ID }), useNavigate: () => vi.fn() };
});
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

const post = api.post as ReturnType<typeof vi.fn>;
const patch = api.patch as ReturnType<typeof vi.fn>;

const ORG = {
  deposit_default_type: 'PERCENTAGE',
  deposit_default_percentage: 50,
  accepted_payment_methods: ['CHECK', 'CARD', 'ACH'],
  stripe_charges_enabled: true,
  card_offered_by_default: true,
  bank_offered_by_default: true,
  deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
};

function renderDialog(props: Partial<React.ComponentProps<typeof SendEstimateDialog>> = {}) {
  return renderWithProviders(
    <SendEstimateDialog
      open
      onOpenChange={() => {}}
      estimateId="est-1"
      estimateNumber="C00001-1"
      totalAmount={1000}
      customerEmail="payer@example.test"
      alreadySent={false}
      onSuccess={() => {}}
      {...props}
    />,
  );
}

const policy = (name: RegExp) => screen.getByRole('radio', { name });
const method = (name: RegExp) => screen.getByRole('checkbox', { name });

/** Signs in an admin whose org's plan lacks online payments, for this test only. */
function signedInWithoutOnlinePayments() {
  const signedIn = vi.mocked(useAuthStore).getMockImplementation()!;
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: { id: 'u1', role: 'ADMIN', org_features: ['payments', 'estimates'] }, isAuthenticated: true })) as never);
  onTestFinished(() => { vi.mocked(useAuthStore).mockImplementation(signedIn); });
}
const send = () => screen.getByRole('button', { name: /send c00001-1/i });

beforeEach(() => {
  vi.clearAllMocks();
  mockOrg.mockReturnValue({ data: { ...ORG } });
  post.mockResolvedValue({ data: {} });
  patch.mockResolvedValue({ data: {} });
});

describe('deposit policy on one estimate', () => {
  it('starts on the org policy and does not touch the estimate when left alone', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(policy(/require the deposit before approval/i)).toBeChecked();
    expect(screen.queryByText(/org default: require/i)).not.toBeInTheDocument();

    await user.click(send());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(patch).not.toHaveBeenCalled();
  });

  it('lets this customer approve now and pay later, and saves that to the estimate before sending', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(policy(/allow approval now, deposit paid later/i));
    expect(screen.getByText('Org default: Require the deposit before approval')).toBeInTheDocument();

    await user.click(send());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith('/api/estimates/est-1', { deposit_policy: 'PAY_LATER' });
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]);
  });

  it("shows an estimate's stored override, and \"Use org default\" resets it on send", async () => {
    const user = userEvent.setup();
    renderDialog({ depositPolicy: 'PAY_LATER' });
    expect(policy(/allow approval now, deposit paid later/i)).toBeChecked();
    expect(screen.getByText('Org default: Require the deposit before approval')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /use org default/i }));
    expect(policy(/require the deposit before approval/i)).toBeChecked();
    expect(screen.queryByText(/org default: require/i)).not.toBeInTheDocument();

    await user.click(send());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith('/api/estimates/est-1', { deposit_policy: null });
  });

  it('follows an org whose default is pay later', () => {
    mockOrg.mockReturnValue({ data: { ...ORG, deposit_policy: 'PAY_LATER' } });
    renderDialog();
    expect(policy(/allow approval now, deposit paid later/i)).toBeChecked();
    expect(screen.queryByText(/org default:/i)).not.toBeInTheDocument();
  });
});

describe('deposit policy on a locked estimate', () => {
  // A locked estimate (deposit paid, or lock_on_send on a sent one) refuses every PATCH with
  // "This estimate is locked. Use Revise to make changes." A policy change the dialog let through
  // would abort the whole resend, so the policy is shown but cannot move.
  it('shows the stored policy read-only, offers no reset, and resends without touching the estimate', async () => {
    const user = userEvent.setup();
    renderDialog({ alreadySent: true, depositFrozen: true, locked: true, depositPolicy: 'PAY_LATER' });

    expect(policy(/allow approval now, deposit paid later/i)).toBeChecked();
    expect(policy(/allow approval now, deposit paid later/i)).toBeDisabled();
    expect(policy(/require the deposit before approval/i)).toBeDisabled();
    expect(screen.queryByRole('button', { name: /use org default/i })).not.toBeInTheDocument();
    expect(screen.getByText(/locked with the estimate/i)).toBeInTheDocument();

    await user.click(send());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('payment methods for this send', () => {
  it("pre-selects the org's default methods, card and bank included, and sends them", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(method(/^card$/i)).toBeChecked();
    expect(method(/^bank$/i)).toBeChecked();
    expect(method(/^check$/i)).toBeChecked();
    expect(screen.queryByText(/org default: card/i)).not.toBeInTheDocument();

    await user.click(send());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].payment_methods).toEqual(['CARD', 'ACH', 'CHECK']);
  });

  it('a bank-only send says how it differs from the org default', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(method(/^card$/i));
    await user.click(method(/^check$/i));
    expect(screen.getByText('Org default: Card, bank and check')).toBeInTheDocument();

    await user.click(send());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1].payment_methods).toEqual(['ACH']);
  });

  it('leaves card unticked when the owner does not offer it by default, but it can still be chosen', () => {
    mockOrg.mockReturnValue({ data: { ...ORG, card_offered_by_default: false } });
    renderDialog();
    expect(method(/^card$/i)).not.toBeChecked();
    expect(method(/^bank$/i)).toBeChecked();
  });

  it('marks an online method the account cannot take yet as unavailable', () => {
    mockOrg.mockReturnValue({ data: { ...ORG, accepted_payment_methods: ['CHECK', 'CARD'] } });
    renderDialog();
    expect(screen.getByText('Unavailable until bank payments are active')).toBeInTheDocument();
    expect(method(/^bank$/i)).not.toBeChecked();
  });

  // Payments go-live slice 16 (fix round 2) - the customer's page offers no online method while the
  // org's plan lacks online payments, so the dialog must not pre-select Card or Bank as if it would.
  it('an org whose plan lacks online payments: Card and Bank start unticked and say why', async () => {
    signedInWithoutOnlinePayments();
    const user = userEvent.setup();
    renderDialog();

    expect(method(/^card$/i)).not.toBeChecked();
    expect(method(/^bank$/i)).not.toBeChecked();
    expect(method(/check/i)).toBeChecked();
    expect(screen.getAllByText('Not included in your plan.')).toHaveLength(2);
    expect(screen.queryByText(/^Unavailable until/)).not.toBeInTheDocument();

    await user.click(send());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({ payment_methods: ['CHECK'] });
  });
});

describe('the estimate page tells the send dialog when the estimate is locked', () => {
  const customer = {
    id: 'cust-1', first_name: 'Pat', last_name: 'Payer', company_name: null, email: 'payer@example.test',
    phone: '5550001234', billing_address_line1: null, billing_city: null, billing_state: null, billing_zip: null,
  };
  const SENT_ESTIMATE = {
    id: PAGE_ESTIMATE_ID, estimate_number: 'C00001-2', name: null, status: 'SENT', approved_at: null,
    sent_at: '2026-10-01T00:00:00.000Z', declined_at: null, cancelled_at: null, scope_notes: null,
    tax_rate: '0', subtotal: '1000.00', tax_amount: '0.00', total_amount: '1000.00', discount_type: null,
    discount_value: null, discount_name: null, discount_amount: '0.00', signature_data: null, signature_at: null,
    public_token: 'tok', version: 1, modified_after_send: false, superseded_by_id: null, created_by: 'user-1',
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    send_config: { deposit_required: true, deposit_amount: 500, deposit_percentage: 50, payment_methods: ['CARD'] },
    deposit_policy: null, creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
    line_items: [], scopes: [], job: null, job_id: null, invoices: [],
    // The server's answer for this estimate: every action the page can offer.
    actions: ['edit', 'send', 'delete', 'cancel', 'record_payment'],
    lead_id: null, lead: null, customer_id: customer.id, customer,
  };

  // Local repro: org lock_on_send ON, estimate SENT; choosing "deposit paid later" in Resend made
  // the dialog PATCH the locked estimate, the backend answered 400 and the resend never went out.
  it('a sent estimate in a lock-on-send org opens Resend with the policy read-only', async () => {
    mockOrg.mockReturnValue({ data: { ...ORG, lock_on_send: true } });
    serveEstimateWorkspace({ estimate: SENT_ESTIMATE, otherwise: { data: [] } });
    const user = userEvent.setup();
    renderEstimateWorkspace();

    await user.click(await screen.findByRole('button', { name: /^Resend$/i }));
    expect(await screen.findByRole('radio', { name: /allow approval now, deposit paid later/i })).toBeDisabled();
    expect(policy(/require the deposit before approval/i)).toBeDisabled();
  });
});
