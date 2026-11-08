/**
 * #2010 - the deposit controls `SendEstimateDialog` and `MarkSentDialog` now share via
 * `DepositControls` + `useDepositDraft`.
 *
 * Covers the ACs `md_files/plans/agents/runs/issue-2010/spec.md` assigns to this file: AC1 (same
 * two labelled inputs in both dialogs), AC2 (the boxes mirror each other in Mark Sent), AC5 (a
 * frozen deposit is read-only with identical copy in both dialogs, plus the callsite wiring that
 * makes `depositFrozen` true on a SENT estimate and false on a DRAFT one), AC6 (the toggle hides
 * the controls and skips the PATCH), AC7 (an untouched dialog does not PATCH), AC8 (a failed PATCH
 * aborts the mark-sent and surfaces the error), AC11 (a cancelled edit does not survive a reopen,
 * in both dialogs), and AC12 (the CARD surcharge preview tracks the live draft, not a static
 * resolution).
 *
 * AC3/AC4 (persist a % edit as PERCENTAGE / a $ edit as FIXED, PATCH before POST) are already
 * proven by the frozen `repro-2010.test.tsx`; not repeated here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { MarkSentDialog } from '@/components/estimates/MarkSentDialog';
import { SendEstimateDialog } from '@/components/estimates/SendEstimateDialog';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

const ESTIMATE_ID = 'est-2010-shared';

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn(), patch: vi.fn(), get: vi.fn() },
}));

const mockOrg = vi.fn();
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => mockOrg(),
}));

vi.mock('@/components/payments/StripePaymentsBanner', () => ({
  StripePaymentsBanner: () => null,
}));

// The callsite describe block below mounts the real page; useParams needs a route param since
// the page is rendered outside a matching <Route>. Harmless for the direct-dialog tests above it -
// neither dialog reads route params, and useNavigate stays usable inside MemoryRouter regardless.
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: ESTIMATE_ID }), useNavigate: () => vi.fn() };
});

// Heavy sub-surfaces with no bearing on the deposit callsite wiring - same stub set as
// estimate-send-recipient-prefill.test.tsx. SendEstimateDialog and MarkSentDialog are
// deliberately NOT stubbed: their deposit inputs are what the callsite describe block asserts on.
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({
  EstimateTabs: () => null,
}));
vi.mock('@/components/estimates/EstimateLineItemsEditor', () => ({
  EstimateLineItemsEditor: () => null,
  EstimateScopeOfWorkCard: () => null,
  estimateLinesToInvoiceShape: (lines: unknown) => lines,
}));
vi.mock('@/features/estimate-workspace/components/SignatureCard', () => ({
  SignatureCard: () => null,
}));
vi.mock('@/features/estimate-workspace/components/NotesCard', () => ({ NotesCard: () => null }));
vi.mock('@/features/estimate-workspace/components/HistoryPanel', () => ({ HistoryPanel: () => null }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/estimates/PdfPreviewDialog', () => ({ PdfPreviewDialog: () => null }));
vi.mock('@/components/estimates/CancelEstimateDialog', () => ({ CancelEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({
  RecordEstimatePaymentDialog: () => null,
}));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({
  DuplicateEstimateDialog: () => null,
}));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const TOTAL = 1000;

// Shared page-level fixtures (finding 1 + AC5 callsite both mount the real page).
const CUSTOMER = {
  id: 'cust-2010',
  first_name: 'Qa',
  last_name: 'Customer',
  company_name: null,
  email: 'qa-2010-customer@example.com',
  phone: '5550001234',
  billing_address_line1: null,
  billing_city: null,
  billing_state: null,
  billing_zip: null,
};

const BASE_ESTIMATE = {
  id: ESTIMATE_ID,
  lead_id: null,
  lead: null,
  customer_id: CUSTOMER.id,
  customer: CUSTOMER,
  estimate_number: 'C00099-1',
  name: null,
  approved_at: null,
  declined_at: null,
  cancelled_at: null,
  scope_notes: null,
  tax_rate: '0',
  subtotal: '1000.00',
  tax_amount: '0.00',
  total_amount: '1000.00',
  discount_type: null,
  discount_value: null,
  discount_name: null,
  discount_amount: '0.00',
  signature_data: null,
  signature_at: null,
  public_token: null,
  version: 1,
  modified_after_send: false,
  superseded_by_id: null,
  created_by: 'user-1',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
  line_items: [],
  scopes: [],
  job: null,
  job_id: null,
  invoices: [],
  deposit_type: null,
  deposit_value: null,
};

/** Never sent: send_config is null, so the deposit is still editable. */
const DRAFT_ESTIMATE = {
  ...BASE_ESTIMATE,
  status: 'DRAFT',
  sent_at: null,
  send_config: null,
};

/** Already sent once: send_config exists and pins the billed figure. */
const SENT_ESTIMATE = {
  ...BASE_ESTIMATE,
  status: 'SENT',
  sent_at: '2026-06-01T00:00:00.000Z',
  send_config: {
    id: 'sc-2010',
    deposit_required: true,
    deposit_percentage: '50.00',
    deposit_amount: '500.00',
    payment_methods: [],
    message_body: null,
  },
};

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

function setupMocks(fixture: Record<string, unknown>) {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url.includes('/api/estimates/')) return { data: { estimate: fixture } };
    if (url === '/api/organization') {
      return {
        data: {
          accepted_payment_methods: ['CARD'],
          deposit_default_type: 'PERCENTAGE',
          deposit_default_percentage: 50,
        },
      };
    }
    return { data: {} };
  });
}

function renderMarkSent(props: Partial<React.ComponentProps<typeof MarkSentDialog>> = {}) {
  return renderWithProviders(
    <MarkSentDialog
      open
      onOpenChange={() => {}}
      estimateId="est-2010"
      estimateNumber="C00011-1"
      totalAmount={TOTAL}
      onSuccess={() => {}}
      {...props}
    />,
  );
}

function renderSend(props: Partial<React.ComponentProps<typeof SendEstimateDialog>> = {}) {
  return renderWithProviders(
    <SendEstimateDialog
      open
      onOpenChange={() => {}}
      estimateId="est-2010"
      estimateNumber="C00011-1"
      totalAmount={TOTAL}
      customerEmail="customer@example.com"
      alreadySent={false}
      onSuccess={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOrg.mockReturnValue({
    data: {
      deposit_default_type: 'PERCENTAGE',
      deposit_default_percentage: 50,
      accepted_payment_methods: ['EXTERNAL_CARD'],
    },
  });
  (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });
  (api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });
});

describe('AC1 - Mark Sent and Send expose the same two labelled inputs', () => {
  it('Mark Sent uses the mark-sent-deposit-pct/-amount ids', () => {
    renderMarkSent();
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText(/deposit %/i)).toHaveAttribute('id', 'mark-sent-deposit-pct');
    expect(dialog.getByLabelText(/deposit amount/i)).toHaveAttribute(
      'id',
      'mark-sent-deposit-amount',
    );
    expect(dialog.getByLabelText(/deposit %/i)).toHaveValue(50);
    expect(dialog.getByLabelText(/deposit amount/i)).toHaveValue(500);
  });

  it('Send uses the send-deposit-pct/-amount ids', () => {
    renderSend({ depositType: 'PERCENTAGE', depositValue: 50 });
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText(/deposit %/i)).toHaveAttribute('id', 'send-deposit-pct');
    expect(dialog.getByLabelText(/deposit amount/i)).toHaveAttribute('id', 'send-deposit-amount');
  });
});

describe('AC2 - the two boxes mirror each other, both ways, in Mark Sent', () => {
  it('typing a percentage recomputes the amount and the summary line', async () => {
    const user = userEvent.setup();
    renderMarkSent();
    const dialog = within(screen.getByRole('dialog'));

    await user.clear(dialog.getByLabelText(/deposit %/i));
    await user.type(dialog.getByLabelText(/deposit %/i), '25');

    expect(dialog.getByLabelText(/deposit amount/i)).toHaveValue(250);
    expect(dialog.getByText(/25%/)).toBeInTheDocument();
    expect(dialog.getByText('$250.00')).toBeInTheDocument();
  });

  it('clearing the amount and typing a dollar figure recomputes the percent', async () => {
    const user = userEvent.setup();
    renderMarkSent();
    const dialog = within(screen.getByRole('dialog'));

    await user.clear(dialog.getByLabelText(/deposit amount/i));
    await user.type(dialog.getByLabelText(/deposit amount/i), '400');

    expect(dialog.getByLabelText(/deposit %/i)).toHaveValue(40);
  });
});

describe('AC5 - a frozen deposit is read-only in both dialogs, with the same copy', () => {
  const frozenProps = {
    depositFrozen: true,
    existingDepositAmount: 74.64,
    existingDepositPercentage: 70,
  };

  it('Mark Sent', () => {
    renderMarkSent(frozenProps);
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText(/deposit %/i)).toBeDisabled();
    expect(dialog.getByLabelText(/deposit amount/i)).toBeDisabled();
    expect(dialog.getByLabelText(/deposit %/i)).toHaveValue(70);
    expect(dialog.getByLabelText(/deposit amount/i)).toHaveValue(74.64);
    expect(dialog.getByText('Set when this estimate was first sent')).toBeInTheDocument();
  });

  it('Send', () => {
    renderSend({ ...frozenProps, depositType: 'PERCENTAGE', depositValue: 70 });
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText(/deposit %/i)).toBeDisabled();
    expect(dialog.getByLabelText(/deposit amount/i)).toBeDisabled();
    expect(dialog.getByLabelText(/deposit %/i)).toHaveValue(70);
    expect(dialog.getByLabelText(/deposit amount/i)).toHaveValue(74.64);
    expect(dialog.getByText('Set when this estimate was first sent')).toBeInTheDocument();
  });
});

// #2091 - QA staging, demo org: estimate d00664-1 was sent with a 70% deposit ($1,540 of
// $2,200), a line-item price edit then took the total to $2,225, and the resend dialog kept
// showing $1,540 ("Set when this estimate was first sent") while the send itself re-priced the
// still-unpaid deposit invoice to $1,557.50 (repriceUnpaidDepositInvoice, #2091 decision
// "2031-5"). The dialog must show the figure the send will actually bill whenever the deposit
// invoice is still unpaid, and say so - never a settled invoice's honest frozen figure.
//
// Send-only: `willReprice`/`depositInvoiceUnpaid` are NOT wired into MarkSentDialog.
// `depositFrozen` (i.e. a send_config row existing) is unreachable wherever Mark Sent itself is
// reachable - `canMarkSent = canSend && isDraft` (EstimateWorkspacePage.tsx), and EVERY path back
// to DRAFT deletes send_config (`clearsSendConfig`/`estimateSendConfig.deleteMany`,
// status-transitions.ts + estimate.controller.ts, proven by back-to-draft-deposit.test.ts). A
// DRAFT estimate therefore never carries a frozen deposit for Mark Sent to have an opinion about;
// `DepositControls`/`useDepositDraft` stay general (Send still needs `willReprice`), but Mark
// Sent's callsite has nothing to pass it.
describe('#2091 - the resend preview follows an unpaid deposit invoice, not the frozen figure', () => {
  const repriceProps = {
    depositFrozen: true,
    depositType: 'PERCENTAGE' as const,
    depositValue: 70,
    existingDepositAmount: 700,
    existingDepositPercentage: 70,
  };
  // The total moved (a line-item price edit) after the first send - the same shape as the QA repro.
  const REPRICED_TOTAL = 1250;

  it('an unpaid deposit invoice shows the amount the send will actually bill', () => {
    renderSend({ ...repriceProps, totalAmount: REPRICED_TOTAL, depositInvoiceUnpaid: true });
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText(/deposit %/i)).toHaveValue(70);
    expect(dialog.getByLabelText(/deposit amount/i)).toHaveValue(875);
    expect(dialog.queryByText('Set when this estimate was first sent')).not.toBeInTheDocument();
    expect(dialog.getByText('Updates to match the current total when sent')).toBeInTheDocument();
  });

  it('a settled deposit invoice keeps the frozen, actually-billed figure', () => {
    renderSend({ ...repriceProps, totalAmount: REPRICED_TOTAL, depositInvoiceUnpaid: false });
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText(/deposit amount/i)).toHaveValue(700);
    expect(dialog.getByText('Set when this estimate was first sent')).toBeInTheDocument();
    expect(dialog.queryByText('Updates to match the current total when sent')).not.toBeInTheDocument();
  });

  it('the percent/amount inputs stay disabled either way - only the figure and hint move', () => {
    renderSend({ ...repriceProps, totalAmount: REPRICED_TOTAL, depositInvoiceUnpaid: true });
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText(/deposit %/i)).toBeDisabled();
    expect(dialog.getByLabelText(/deposit amount/i)).toBeDisabled();
  });
});

describe('#2091 callsite - EstimateWorkspacePage wires the unpaid-deposit-invoice flag off estimate.invoices', () => {
  const SENT_ESTIMATE_UNPAID_DEPOSIT = {
    ...BASE_ESTIMATE,
    status: 'SENT',
    sent_at: '2026-06-01T00:00:00.000Z',
    total_amount: '1250.00',
    deposit_type: 'PERCENTAGE',
    deposit_value: 70,
    send_config: {
      id: 'sc-2091',
      deposit_required: true,
      deposit_percentage: '70.00',
      deposit_amount: '700.00',
      payment_methods: [],
      message_body: null,
    },
    invoices: [
      {
        id: 'inv-dep-2091', invoice_number: 'I00279', status: 'SENT', kind: 'DEPOSIT',
        total_amount: '700.00', amount_due: '700.00', payments: [],
      },
    ],
  };

  const SENT_ESTIMATE_PAID_DEPOSIT = {
    ...SENT_ESTIMATE_UNPAID_DEPOSIT,
    invoices: [
      {
        ...SENT_ESTIMATE_UNPAID_DEPOSIT.invoices[0],
        status: 'PAID',
        payments: [{ id: 'pay-2091', amount: 700, method: 'CARD' }],
      },
    ],
  };

  it('an unpaid deposit invoice: Resend shows the re-priced figure, not the billed one', async () => {
    setupMocks(SENT_ESTIMATE_UNPAID_DEPOSIT);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^resend$/i }));

    const dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByLabelText(/deposit amount/i)).toHaveValue(875);
    expect(dialog.getByText('Updates to match the current total when sent')).toBeInTheDocument();
  });

  it('a paid deposit invoice: Resend keeps showing the figure the customer was actually billed', async () => {
    setupMocks(SENT_ESTIMATE_PAID_DEPOSIT);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^resend$/i }));

    const dialog = within(await screen.findByRole('dialog'));
    expect(await dialog.findByLabelText(/deposit amount/i)).toHaveValue(700);
    expect(dialog.getByText('Set when this estimate was first sent')).toBeInTheDocument();
  });
});

describe('AC5 callsite - EstimateWorkspacePage wires depositFrozen from send_config', () => {
  it('disables the Send deposit % input when the estimate has already been sent', async () => {
    setupMocks(SENT_ESTIMATE);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^resend$/i }));

    expect(await screen.findByLabelText(/deposit %/i)).toBeDisabled();
  });

  it('leaves the Send deposit % input enabled when the estimate has never been sent', async () => {
    setupMocks(DRAFT_ESTIMATE);
    renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^send$/i }));

    expect(await screen.findByLabelText(/deposit %/i)).not.toBeDisabled();
  });
});

describe('AC6 - "Require deposit" off hides the controls and writes no deposit', () => {
  it('hides both inputs and the summary line', async () => {
    const user = userEvent.setup();
    renderMarkSent({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.click(screen.getByRole('switch', { name: /require deposit/i }));

    expect(screen.queryByLabelText(/deposit %/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/70%/)).not.toBeInTheDocument();
  });

  it('marks sent with deposit_required: false and issues no PATCH', async () => {
    const user = userEvent.setup();
    renderMarkSent({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.click(screen.getByRole('switch', { name: /require deposit/i }));
    await user.click(screen.getByRole('button', { name: /mark as sent/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith(
      expect.stringContaining('/mark-sent'),
      expect.objectContaining({ deposit_required: false }),
    );
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('AC7 - an untouched Mark Sent dialog does not PATCH', () => {
  it('marks sent without a preceding PATCH when nothing was typed', async () => {
    const user = userEvent.setup();
    renderMarkSent({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.click(screen.getByRole('button', { name: /mark as sent/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('AC8 - a failed deposit write aborts the mark-sent and surfaces the error', () => {
  it('does not mark sent, and shows the failure', async () => {
    (api.patch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('deposit save failed'));
    const user = userEvent.setup();
    renderMarkSent();
    const dialog = within(screen.getByRole('dialog'));

    await user.clear(dialog.getByLabelText(/deposit %/i));
    await user.type(dialog.getByLabelText(/deposit %/i), '25');
    await user.click(dialog.getByRole('button', { name: /mark as sent/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
    expect(await screen.findByText('deposit save failed')).toBeInTheDocument();
  });
});

describe('AC11 - a cancelled edit does not survive a reopen', () => {
  it('Mark Sent re-seeds on reopen', async () => {
    const user = userEvent.setup();
    const renderDialog = (open: boolean) => (
      <MarkSentDialog
        open={open}
        onOpenChange={() => {}}
        estimateId="est-2010"
        estimateNumber="C00011-1"
        totalAmount={TOTAL}
        onSuccess={() => {}}
      />
    );
    const { rerender } = renderWithProviders(renderDialog(false));
    rerender(renderDialog(true));

    let dialog = within(screen.getByRole('dialog'));
    await user.clear(dialog.getByLabelText(/deposit %/i));
    await user.type(dialog.getByLabelText(/deposit %/i), '25');
    expect(dialog.getByLabelText(/deposit %/i)).toHaveValue(25);

    rerender(renderDialog(false));
    rerender(renderDialog(true));

    dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText(/deposit %/i)).toHaveValue(50);
    expect(dialog.getByLabelText(/deposit amount/i)).toHaveValue(500);
  });

  it('Send re-seeds on reopen', async () => {
    const user = userEvent.setup();
    const renderDialog = (open: boolean) => (
      <SendEstimateDialog
        open={open}
        onOpenChange={() => {}}
        estimateId="est-2010"
        estimateNumber="C00011-1"
        totalAmount={TOTAL}
        customerEmail="customer@example.com"
        alreadySent={false}
        depositType="PERCENTAGE"
        depositValue={50}
        onSuccess={() => {}}
      />
    );
    const { rerender } = renderWithProviders(renderDialog(false));
    rerender(renderDialog(true));

    let dialog = within(screen.getByRole('dialog'));
    await user.clear(dialog.getByLabelText(/deposit %/i));
    await user.type(dialog.getByLabelText(/deposit %/i), '25');
    expect(dialog.getByLabelText(/deposit %/i)).toHaveValue(25);

    rerender(renderDialog(false));
    rerender(renderDialog(true));

    dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByLabelText(/deposit %/i)).toHaveValue(50);
    expect(dialog.getByLabelText(/deposit amount/i)).toHaveValue(500);
  });
});

describe('AC12 - the CARD surcharge preview tracks the live draft', () => {
  it('recomputes when the operator edits the percentage', async () => {
    mockOrg.mockReturnValue({
      data: {
        deposit_default_type: 'PERCENTAGE',
        deposit_default_percentage: 50,
        accepted_payment_methods: ['CARD'],
      },
    });
    const user = userEvent.setup();
    renderMarkSent();
    const dialog = within(screen.getByRole('dialog'));

    expect(dialog.getByText('$517.50 (incl. $17.50 processing fee)')).toBeInTheDocument();

    await user.clear(dialog.getByLabelText(/deposit %/i));
    await user.type(dialog.getByLabelText(/deposit %/i), '25');

    expect(dialog.getByText('$258.75 (incl. $8.75 processing fee)')).toBeInTheDocument();
  });
});

// Security round 1 (#2010) — coverage gap: `canSubmit`'s `&& depositValid` term was implemented
// and reviewer-approved (spec.md's "Reviewer ruling ... APPROVED") but had no committed regression
// test, so a future edit could drop it silently. Pins the three cases the validator's ad hoc
// mutation testing exercised (H17/H18/H19 in security-round-1.json's verifier reasoning).
describe("Mark Sent's canSubmit stays gated on depositValid (security round 1, coverage gap)", () => {
  it('a percentage over 100 disables Mark as Sent and shows the range message', async () => {
    const user = userEvent.setup();
    renderMarkSent();
    const dialog = within(screen.getByRole('dialog'));

    await user.clear(dialog.getByLabelText(/deposit %/i));
    await user.type(dialog.getByLabelText(/deposit %/i), '150');

    expect(dialog.getByRole('button', { name: /mark as sent/i })).toBeDisabled();
    expect(dialog.getByText(/Enter a deposit between/)).toBeInTheDocument();
  });

  it('a percentage of 0 disables Mark as Sent', async () => {
    const user = userEvent.setup();
    renderMarkSent();
    const dialog = within(screen.getByRole('dialog'));

    await user.clear(dialog.getByLabelText(/deposit %/i));
    await user.type(dialog.getByLabelText(/deposit %/i), '0');

    expect(dialog.getByRole('button', { name: /mark as sent/i })).toBeDisabled();
  });

  it('clearing the percent box disables Mark as Sent and issues no PATCH', async () => {
    const user = userEvent.setup();
    renderMarkSent();
    const dialog = within(screen.getByRole('dialog'));

    await user.clear(dialog.getByLabelText(/deposit %/i));

    const button = dialog.getByRole('button', { name: /mark as sent/i });
    expect(button).toBeDisabled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });
});

// Security round 1 (#2010) finding 1 (low) — MarkSentDialog's deposit editor took no ability
// check, so a role holding `send Estimate` but not `update Estimate` (the reachable shape:
// unticking Estimates -> Edit removes only the managed `update` grant and leaves `send` standing)
// saw fully editable deposit inputs, and typing into them wedged Mark as Sent behind a PATCH the
// backend correctly 403s. The fix threads `ability.can('update', 'Estimate')` into `editable`
// so the inputs render disabled and the draft can never go dirty - Mark as Sent still works.
describe('Finding 1 (security round 1) - deposit editability follows update Estimate ability', () => {
  const sendOnlyAbility = buildAbility([
    { action: 'read', subject: 'Estimate' },
    { action: 'send', subject: 'Estimate' },
  ]);

  it('a send-only role sees a read-only deposit in Mark Sent, can still mark it sent, and no PATCH fires', async () => {
    setupMocks(DRAFT_ESTIMATE);
    renderWithProviders(<EstimateWorkspacePage />, { ability: sendOnlyAbility });

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^actions$/i }));
    await user.click(await screen.findByRole('menuitem', { name: /mark sent/i }));

    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByLabelText(/deposit %/i)).toBeDisabled();
    expect(dialog.getByLabelText(/deposit amount/i)).toBeDisabled();

    const markSentButton = dialog.getByRole('button', { name: /mark as sent/i });
    expect(markSentButton).not.toBeDisabled();

    await user.click(markSentButton);

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(expect.stringContaining('/mark-sent'), expect.anything()),
    );
    expect(api.patch).not.toHaveBeenCalled();
  });
});

// #2044 — with an org that DOES accept methods, unchecking every box (the "user unchecked all"
// half of the dialog-level warning) must show the warning and leave the primary button enabled.
// The zero-ORG-methods half is covered by the frozen repro-2044.test.tsx.
describe('#2044 - unchecking every payment method warns but does not block', () => {
  it('Send: unchecking the only accepted method warns and leaves Send enabled', async () => {
    const user = userEvent.setup();
    renderSend();
    const dialog = within(screen.getByRole('dialog'));

    const methodCheckbox = dialog.getByRole('checkbox', { name: /External Credit Card Processor/i });
    expect(methodCheckbox).toBeChecked();
    await user.click(methodCheckbox);

    expect(
      dialog.getByText(
        /No payment method selected\. The customer will not be able to pay the deposit or approve this estimate online\./,
      ),
    ).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: /^send/i })).toBeEnabled();
  });

  it('Mark Sent: unchecking the only accepted method warns and leaves Mark as Sent enabled', async () => {
    const user = userEvent.setup();
    renderMarkSent();
    const dialog = within(screen.getByRole('dialog'));

    const methodCheckbox = dialog.getByRole('checkbox', { name: /External Credit Card Processor/i });
    expect(methodCheckbox).toBeChecked();
    await user.click(methodCheckbox);

    expect(
      dialog.getByText(
        /No payment method selected\. The customer will not be able to pay the deposit or approve this estimate online\./,
      ),
    ).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
  });
});
