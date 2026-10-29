/**
 * SRVW-285 — the decline reason is READABLE, not just recorded.
 *
 * The slice originally shipped `lost_reason_note` write-only: the column was written by the
 * public decline, and nothing on any staff surface selected or rendered it. That defeats the
 * request it came from — a general manager asked for this so the business could LEARN why
 * customers decline, and an answer nobody can read without opening a database has not been
 * learned. So the rail row is part of the same slice as the write, and these are its tests.
 *
 * Four cases, and the last two are the ones worth having: the reason is deliberately OPTIONAL
 * for the customer (requiring it risks them abandoning the decline and going silent, which
 * loses the reason AND the status), so "reason without note", "note without reason" and
 * "neither" are all ordinary states the rail has to render honestly. A missing row must read as
 * "they did not tell us", never as an empty field.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'est-decline-reason' }) };
});

// The same stub set the other workspace specs use — none of these sub-surfaces is under test.
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
vi.mock('@/components/estimates/SendEstimateDialog', () => ({ SendEstimateDialog: () => null }));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const mockApi = vi.mocked(api);

function declinedEstimate(over: Record<string, unknown> = {}) {
  return {
    id: 'est-decline-reason',
    lead_id: 'lead-decline-1',
    estimate_number: 'E00921',
    name: null,
    status: 'DECLINED',
    sent_at: '2026-09-01T00:00:00.000Z',
    approved_at: null,
    declined_at: '2026-09-05T00:00:00.000Z',
    lost_reason: null,
    lost_reason_note: null,
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
    public_token: 'tok-921',
    version: 1,
    modified_after_send: false,
    superseded_by_id: null,
    created_by: 'user-1',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-05T00:00:00.000Z',
    send_config: null,
    invoices: [],
    lead: {
      id: 'lead-decline-1',
      status: 'LOST',
      service_request: 'Kitchen cabinets',
      service_address_line1: '14 Test St',
      service_city: 'Boston',
      service_state: 'MA',
      service_zip: '02101',
      customer: {
        id: 'cust-921',
        first_name: 'Dana',
        last_name: 'Decline',
        company_name: null,
        email: 'dana@qa.servwave.test',
        phone: '5555550188',
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
    ...over,
  };
}

/**
 * The organisation's curated list (slice C). Note TIMING is switched OFF and the last row is one
 * the admin added - between them they are the two cases the rail has to label that the five
 * built-in labels cannot.
 */
const ORG_REASONS = [
  { code: 'PRICE', label: 'Price', is_active: true, sort_order: 0, is_builtin: true },
  { code: 'TIMING', label: 'Ready sooner than we can build', is_active: false, sort_order: 1, is_builtin: true },
  { code: 'WENT_WITH_A_DESIGNER', label: 'Went with a designer', is_active: true, sort_order: 2, is_builtin: false },
];

function setup(over: Record<string, unknown> = {}, reasons: unknown[] = []) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url.includes('/api/lost-reason-options')) return { data: { lost_reason_options: reasons } };
    if (url.includes('/api/estimates/')) return { data: { estimate: declinedEstimate(over) } };
    if (url.includes('/communications')) return { data: { items: [] } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

async function renderAndSettle() {
  renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });
  await waitFor(() => expect(screen.getAllByText('E00921').length).toBeGreaterThan(0));
}

describe('EstimateWorkspacePage — the customer’s decline reason is readable (SRVW-285)', () => {
  it('renders the reason and the comment when the customer gave both', async () => {
    setup({ lost_reason: 'COMPETITOR', lost_reason_note: 'Another shop came in three thousand under.' });
    await renderAndSettle();

    expect(screen.getByText('Reason')).toBeInTheDocument();
    // The LABEL, never the raw enum value — staff, the customer's own screen and the conversion
    // report have to read one wording for one loss.
    expect(screen.getByText('Went with a competitor')).toBeInTheDocument();
    expect(screen.queryByText('COMPETITOR')).toBeNull();

    expect(screen.getByText('Their comment')).toBeInTheDocument();
    expect(screen.getByText('Another shop came in three thousand under.')).toBeInTheDocument();
  });

  it('renders the reason alone when the customer skipped the comment', async () => {
    setup({ lost_reason: 'PRICE', lost_reason_note: null });
    await renderAndSettle();

    expect(screen.getByText('Price')).toBeInTheDocument();
    // No empty "Their comment" row — an absent answer is absent, not blank.
    expect(screen.queryByText('Their comment')).toBeNull();
  });

  it('renders the comment alone when the customer typed one but picked no reason', async () => {
    setup({ lost_reason: null, lost_reason_note: 'The designer was not the right fit for us.' });
    await renderAndSettle();

    expect(screen.getByText('Their comment')).toBeInTheDocument();
    expect(screen.getByText('The designer was not the right fit for us.')).toBeInTheDocument();
    expect(screen.queryByText('Reason')).toBeNull();
  });

  it('renders neither row when the customer declined without answering', async () => {
    setup();
    await renderAndSettle();

    // The decline itself still reads — losing the reason must never cost us the status.
    // `getAllByText`: "Declined" is both the status chip and the rail's date label.
    expect(screen.getAllByText('Declined').length).toBeGreaterThan(0);
    expect(screen.queryByText('Reason')).toBeNull();
    expect(screen.queryByText('Their comment')).toBeNull();
  });
});

/**
 * Slice C - the rail labels the ORGANISATION's reasons, not only the five built-in ones.
 *
 * Before this slice a code outside the five could not exist, so `LOST_REASON_LABELS[code] ?? code`
 * always hit the map. Now an admin can add one, and the fallback would render the stored code -
 * WENT_WITH_A_DESIGNER where the admin wrote "Went with a designer". These two cases are the
 * whole of what changed here, and the second is the one that is easy to get wrong.
 */
describe('EstimateWorkspacePage - the rail reads the organisation\'s own words (slice C)', () => {
  it('labels a reason the admin added, rather than showing its stored code', async () => {
    setup({ lost_reason: 'WENT_WITH_A_DESIGNER' }, ORG_REASONS);
    await renderAndSettle();

    await waitFor(() => expect(screen.getByText('Went with a designer')).toBeInTheDocument());
    // The code is the storage detail; it must not be what a staff member reads.
    expect(screen.queryByText('WENT_WITH_A_DESIGNER')).toBeNull();
  });

  it('still labels a reason the admin has since switched OFF', async () => {
    // D4 is that a reason is deactivated and never deleted precisely so estimates declined under
    // it stay readable. A rail that filtered to the ACTIVE list would blank exactly the history
    // that rule exists to protect - and it would do so silently, months after the admin's click.
    // The renamed label is what proves the row was read rather than guessed: "Timing" is the
    // built-in wording, and this org's is not.
    setup({ lost_reason: 'TIMING' }, ORG_REASONS);
    await renderAndSettle();

    await waitFor(() => expect(screen.getByText('Ready sooner than we can build')).toBeInTheDocument());
    expect(screen.queryByText('TIMING')).toBeNull();
  });
});
