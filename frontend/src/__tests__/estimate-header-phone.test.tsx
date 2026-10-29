/**
 * Mobile slice 55: the estimate workspace's header on the shared detail header.
 *
 * Below sm: Back and the name on one row (the name wraps), the status pill, the first applicable
 * of Record Payment / Create Job / Send as the one full-width primary action, and everything else
 * (the other buttons and the whole Actions list) inside one Actions menu. From sm up the buttons
 * sit in a row in the order they always did, with Back kept beside the name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import { MEDIA } from '@/ui-kit/lib/breakpoints';

const ESTIMATE_ID = 'est-header-phone-id';
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: ESTIMATE_ID }), useNavigate: () => mockNavigate };
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
vi.mock('@/components/estimates/SendEstimateDialog', () => ({
  SendEstimateDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="send-dialog" /> : null),
}));
vi.mock('@/components/estimates/RecordEstimatePaymentDialog', () => ({ RecordEstimatePaymentDialog: () => null }));
vi.mock('@/components/estimates/DuplicateEstimateDialog', () => ({ DuplicateEstimateDialog: () => null }));
vi.mock('@/components/estimates/WaiveDepositDialog', () => ({ WaiveDepositDialog: () => null }));
vi.mock('@/components/estimates/RefundDepositDialog', () => ({ RefundDepositDialog: () => null }));

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const originalMatchMedia = window.matchMedia;

function setPhone(isPhone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: isPhone && query === MEDIA.belowSm,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const ESTIMATE = {
  id: ESTIMATE_ID,
  lead_id: 'lead-1',
  estimate_number: 'L00042-1',
  name: 'Replace the front entry doors and the side gate hardware for the whole building',
  status: ESTIMATE_STATUS.DRAFT,
  approved_at: null,
  sent_at: null,
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
      id: 'cust-1', first_name: 'Alice', last_name: 'Test', company_name: null,
      email: 'alice@test.com', phone: '5550001234',
      billing_address_line1: null, billing_city: null, billing_state: null, billing_zip: null,
    },
  },
  creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
  line_items: [],
  scopes: [],
  job: null,
  job_id: null,
  invoices: [],
};

function mount() {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url.includes('/state-tax-rates')) return { data: { data: [] } };
    if (url.includes('/api/estimates/')) return { data: { estimate: ESTIMATE } };
    return { data: {} };
  });
  return renderWithProviders(<EstimateWorkspacePage />, { ability: adminAbility });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
  window.history.replaceState(null, '');
});

describe('estimate header on a phone (mobile slice 55)', () => {
  it('stacks: Back to the list, the first applicable button as the full-width primary, the rest inside Actions', async () => {
    setPhone(true);
    const user = userEvent.setup();
    mount();

    const primary = await screen.findByRole('button', { name: 'Record Payment' });
    expect(primary.parentElement!.className).toContain('[&>button]:h-11');
    // Send is not a header button on a phone; it is in the Actions menu.
    expect(screen.queryByRole('button', { name: /^Send$/ })).not.toBeInTheDocument();

    const menu = screen.getByRole('button', { name: 'Actions' });
    expect(menu.className).toContain('w-full');
    await user.click(menu);
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent?.trim());
    expect(items[0]).toBe('Send');
    // The whole Actions list is still in the same menu.
    expect(items).toEqual(expect.arrayContaining(['Preview', 'Download', 'History']));
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Back to estimates' }));
    expect(mockNavigate).toHaveBeenCalledWith('/estimates');
  });

  it('shows the whole estimate name (it wraps) and the status pill in the header', async () => {
    setPhone(true);
    mount();
    const header = await screen.findByTestId('detail-header');
    const name = within(header).getByText(/Replace the front entry doors/);
    expect(name.className).toContain('break-words');
    expect(within(header).getByRole('button', { name: /Status: DRAFT/i })).toBeInTheDocument();
  });
});

describe('estimate header from sm up (unchanged)', () => {
  it('keeps Back beside the name and the buttons in their old order: Record Payment, Send, Actions', async () => {
    setPhone(false);
    mount();
    await screen.findByRole('button', { name: 'Record Payment' });
    const header = screen.getByTestId('detail-header');
    const names = within(header)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    const at = (n: string) => names.findIndex((x) => x?.startsWith(n));
    expect(at('Back to estimates')).toBeGreaterThanOrEqual(0);
    expect(at('Record Payment')).toBeLessThan(at('Send'));
    expect(at('Send')).toBeLessThan(at('Actions'));
  });
});
