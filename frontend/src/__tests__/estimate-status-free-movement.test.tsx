/**
 * EstimateWorkspacePage - the status pill's rows, checked at the WIRE.
 *
 * estimate-status-menu.test.tsx proves the menu renders and fires whatever the page hands it.
 * That is not enough: the page can hand it a handler pointed at the WRONG endpoint, and the menu
 * has no way to know. Exactly that happened - every row was rewired to the free setter except
 * DRAFT, which kept calling the retained `backtodraft` alias. The alias still enforces its
 * original source-status gate (SENT, PENDING), so the row rendered enabled on a WON estimate and
 * 400'd on click: a frontend that offers a move the backend refuses.
 *
 * So these tests assert the REQUEST, not the handler. A row that renders enabled must issue a call
 * the backend's free setter actually accepts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';

const ESTIMATE_ID = 'est-free-movement-id';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: ESTIMATE_ID }), useNavigate: () => vi.fn() };
});

// Same stub set as the sibling workspace-page suites - none of these surfaces bear on the pill.
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({ EstimateTabs: () => null }));
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
vi.mock('@/components/estimates/SendEstimateDialog', () => ({ SendEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

/**
 * A fully-sent estimate with a live customer link and NO money trail - the state in which every
 * row of the pill is offered. `status` is overridden per case.
 */
const BASE_ESTIMATE = {
  id: ESTIMATE_ID,
  lead_id: 'lead-1',
  estimate_number: 'L00042-1',
  name: null,
  status: ESTIMATE_STATUS.WON,
  approved_at: '2026-08-01T00:00:00.000Z',
  sent_at: '2026-07-28T00:00:00.000Z',
  declined_at: null,
  cancelled_at: null,
  scope_notes: null,
  tax_rate: '0.0625',
  subtotal: '1000.00',
  tax_amount: '62.50',
  total_amount: '1062.50',
  discount_type: null,
  discount_value: null,
  discount_name: null,
  discount_amount: '0.00',
  signature_data: null,
  signature_at: null,
  // Already sent, so the SENT row is a bare stamp rather than the mark-sent ceremony.
  public_token: 'live-token',
  version: 1,
  modified_after_send: false,
  superseded_by_id: null,
  created_by: 'user-1',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  send_config: null,
  lead: {
    id: 'lead-1',
    status: 'ESTIMATED',
    service_request: 'HVAC repair',
    service_address_line1: '100 Test St',
    service_city: 'Boston',
    service_state: 'MA',
    service_zip: '02101',
    customer: {
      id: 'cust-1',
      first_name: 'Alice',
      last_name: 'Test',
      company_name: null,
      email: 'alice@test.com',
      phone: '5550001234',
      billing_address_line1: null,
      billing_city: null,
      billing_state: null,
      billing_zip: null,
    },
  },
  creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
  line_items: [],
  scopes: [],
  job: null,
  job_id: null,
  invoices: [],
};

function renderAt(status: string, overrides: Record<string, unknown> = {}) {
  const estimate = { ...BASE_ESTIMATE, status, ...overrides };
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url.includes('/api/estimates/')) return { data: { estimate } };
    return { data: {} };
  });
  vi.mocked(api.patch).mockResolvedValue({ data: { estimate } });
  return renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });
}

const openPill = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: /change status/i }));
};

/** The single call the page made to the status endpoint, or undefined if it made none. */
const statusCall = () =>
  vi.mocked(api.patch).mock.calls.find(([url]) => String(url).endsWith(`/api/estimates/${ESTIMATE_ID}/status`));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage - every offered status row hits the free setter', () => {
  // The regression. From SENT/PENDING the legacy alias happened to work, so the bug was invisible
  // exactly where the old ordering allowed the move anyway - and broken everywhere it did not.
  it.each([ESTIMATE_STATUS.WON, ESTIMATE_STATUS.DECLINED, ESTIMATE_STATUS.ARCHIVED])(
    'sends {status:DRAFT} - not the backtodraft alias - when recalling a %s estimate',
    async (from) => {
      const user = userEvent.setup();
      renderAt(from);
      await openPill(user);

      await user.click(screen.getByRole('menuitem', { name: /draft/i }));
      await user.click(await screen.findByRole('button', { name: /recall to draft/i }));

      expect(statusCall()?.[1]).toEqual({ status: ESTIMATE_STATUS.DRAFT });
    },
  );

  it('sends {status:PENDING} when moving a won estimate back to deposit-pending', async () => {
    const user = userEvent.setup();
    renderAt(ESTIMATE_STATUS.WON);
    await openPill(user);

    await user.click(screen.getByRole('menuitem', { name: /pending/i }));
    await user.click(await screen.findByRole('button', { name: /move to deposit pending/i }));

    expect(statusCall()?.[1]).toEqual({ status: ESTIMATE_STATUS.PENDING });
  });

  it('sends {status:WON} when approving a declined estimate', async () => {
    const user = userEvent.setup();
    renderAt(ESTIMATE_STATUS.DECLINED);
    await openPill(user);

    await user.click(screen.getByRole('menuitem', { name: /won/i }));
    await user.click(await screen.findByRole('button', { name: /record as approved/i }));

    expect(statusCall()?.[1]).toEqual({ status: ESTIMATE_STATUS.WON });
  });

  // Already sent, so this is a bare stamp with no ceremony - and it must not reopen MarkSentDialog.
  it('sends {status:SENT} when stamping an archived estimate that still has its customer link', async () => {
    const user = userEvent.setup();
    renderAt(ESTIMATE_STATUS.ARCHIVED);
    await openPill(user);

    await user.click(screen.getByRole('menuitem', { name: /sent/i }));

    expect(statusCall()?.[1]).toEqual({ status: ESTIMATE_STATUS.SENT });
  });

  // The live dead end this file's sibling case did not reach, because the fixture always carried a
  // token. With none, the row used to open MarkSentDialog, whose endpoint accepts DRAFT only - so
  // an archived estimate offered "Sent" and answered `Cannot mark a archived estimate as sent`.
  // SENT is a label now: same request whether or not a customer link exists, and no dialog.
  it('sends {status:SENT} - not the mark-sent ceremony - on an archived estimate with no customer link', async () => {
    const user = userEvent.setup();
    renderAt(ESTIMATE_STATUS.ARCHIVED, { public_token: null });
    await openPill(user);

    await user.click(screen.getByRole('menuitem', { name: /sent/i }));

    expect(statusCall()?.[1]).toEqual({ status: ESTIMATE_STATUS.SENT });
    expect(screen.queryByRole('dialog', { name: /mark .* as sent/i })).not.toBeInTheDocument();
  });
});
