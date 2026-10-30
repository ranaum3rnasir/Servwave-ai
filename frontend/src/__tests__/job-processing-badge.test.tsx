import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, ALL_JOB_ACTIONS } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';

const invoiceReadAbility = buildAbility([{ action: 'read', subject: 'Invoice' }]);

// floating-ui (under Radix dropdown) does `new ResizeObserver(...)`
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'j0000000-0000-0000-0000-000000000001' }),
  };
});

const mockApi = vi.mocked(api);

const BASE_JOB = {
  id: 'j0000000-0000-0000-0000-000000000001',
  job_number: 'J00001',
  status: 'IN_PROGRESS',
  job_type: 'HVAC Installation',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: '2026-05-10T09:00:00.000Z',
  scheduled_end: null,
  started_at: '2026-05-10T09:00:00.000Z',
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  dispatcher: null,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Johnson',
    company_name: null,
    email: 'sarah@example.com',
    phone: '5125550198',
  },
  assignees: [] as { user: { id: string; first_name: string; last_name: string } }[],
  service_location: null,
  estimate: null,
  invoices: [
    {
      id: 'inv-bank',
      invoice_number: 'I00392',
      status: 'SENT',
      total_amount: '300',
      amount_due: '225.25',
      created_at: '2026-05-01T00:00:00.000Z',
    },
  ],
  tags: [] as Array<{ id: string; name: string; color: string }>,
  source_plan_id: null,
  actions: ALL_JOB_ACTIONS,
  source_plan: null,
};


const financials = (processing: number | undefined) => ({
  final_invoice: {
    id: 'inv-bank', invoice_number: 'I00392', total_amount: '300', amount_due: '225.25',
    status: 'SENT', sent_at: '2026-05-15T00:00:00.000Z', paid_at: null,
  },
  invoices: [
    {
      id: 'inv-bank', invoice_number: 'I00392', status: 'SENT', total_amount: '300', amount_due: '225.25',
      sent_at: '2026-05-15T00:00:00.000Z', paid_at: null, kind: 'STANDARD',
      ...(processing === undefined ? {} : { processing_amount: processing }),
    },
  ],
  payments: [
    { id: 'p1', invoice_kind: 'STANDARD', amount: '74.75', method: 'CARD', state: 'SUCCEEDED', paid_at: '2026-05-12T00:00:00.000Z', invoice_number: 'I00392' },
    { id: 'p2', invoice_kind: 'STANDARD', amount: '100', method: 'ACH', state: 'PROCESSING', paid_at: '2026-05-13T00:00:00.000Z', invoice_number: 'I00392' },
  ],
});

function mockJob(fin: ReturnType<typeof financials>, jobInvoiceProcessing: number | null = 100) {
  const job = {
    ...BASE_JOB,
    invoices: [{ ...BASE_JOB.invoices[0], ...(jobInvoiceProcessing === null ? {} : { processing_amount: jobInvoiceProcessing }) }],
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/financials')) return { data: fin };
    if (url.includes('/notes')) return { data: { notes: [] } };
    if (url.includes('/attachments')) return { data: { attachments: [] } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    if (url.includes('/api/jobs/')) return { data: { job } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// Payments go-live slice 28 conductor ruling D1: a bank payment in flight is visible on the job page.
describe('JobDetailPage - bank payment processing (D1)', () => {
  it('badges the Overview invoice line with the processing amount', async () => {
    mockJob(financials(100));
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });
    await screen.findByRole('heading', { name: /J00001/ });
    const line = (await screen.findByRole('link', { name: 'I00392' })).parentElement!;
    expect(within(line).getByText('Processing $100.00')).toBeInTheDocument();
  });

  it('badges the Payments tab invoice card', async () => {
    mockJob(financials(100));
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });
    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Payments' }));
    const panel = within(screen.getByRole('tabpanel'));
    expect(panel.getAllByText('Processing $100.00').length).toBeGreaterThan(0);
  });

  it('keeps Balance due as money not yet received and adds a Processing line beside it', async () => {
    mockJob(financials(100));
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });
    await screen.findByRole('heading', { name: /J00001/ });
    expect(await screen.findByText('Balance due')).toBeInTheDocument();
    // 300 contract - 74.75 landed: processing money is not subtracted.
    expect(screen.getByText('$225.25')).toBeInTheDocument();
    expect(screen.getByText('25% collected')).toBeInTheDocument();
    expect(screen.getByTestId('balance-processing')).toHaveTextContent('Processing $100.00');
  });

  it('shows no badge and no balance line when nothing is processing, or the old payload lacks the field', async () => {
    mockJob(financials(undefined), null);
    renderWithProviders(<JobDetailPage />, { ability: invoiceReadAbility });
    await screen.findByRole('heading', { name: /J00001/ });
    await screen.findByText('Balance due');
    expect(screen.queryByTestId('balance-processing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('processing-badge')).not.toBeInTheDocument();
  });
});
