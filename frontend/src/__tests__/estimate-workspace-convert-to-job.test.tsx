/**
 * S04.21 - the estimate page's Convert to job never walks the person into a page the server refuses.
 *
 * POST /api/jobs answers `job_openable`. A person who holds Create jobs but is not on the new job
 * (a walkthrough crew is not carried to it) gets a minimal job back and the job page would refuse
 * them. The header button and the Actions-menu mirror share one mutation, so one test through the
 * routed page covers the pair: it stays on the estimate and says the job was created.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';
import { renderEstimateWorkspace, serveEstimateWorkspace } from '@/__tests__/harness/estimateWorkspacePage';


vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'est-convert-1' }) };
});

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

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

const NEW_JOB = { id: 'job-new-1', job_number: 'J-0042' };

function wonEstimate() {
  return {
    id: 'est-convert-1',
    lead_id: 'lead-1',
    estimate_number: 'E00931',
    name: null,
    status: 'WON',
    sent_at: '2026-09-01T00:00:00.000Z',
    approved_at: '2026-09-03T00:00:00.000Z',
    tax_rate: '0.0625',
    subtotal: '1000.00',
    tax_amount: '62.50',
    total_amount: '1062.50',
    discount_amount: '0.00',
    public_token: 'tok-931',
    version: 1,
    created_by: 'user-1',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-03T00:00:00.000Z',
    invoices: [],
    lead: {
      id: 'lead-1',
      status: 'WON',
      service_request: 'Kitchen cabinets',
      customer: { id: 'cust-931', first_name: 'Cory', last_name: 'Convert', email: 'cory@qa.servwave.test', phone: '5555550199' },
    },
    creator: { id: 'user-1', first_name: 'Test', last_name: 'Admin' },
    line_items: [],
    scopes: [],
    job: null,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

async function convertFromTheHeader(response: Record<string, unknown>) {
  serveEstimateWorkspace({ estimate: wonEstimate(), routes: [
      { match: (url) => url.includes('/communications'), data: { items: [] } },
      { match: (url) => url.includes('/api/lost-reason-options'), data: { lost_reason_options: [] } },
    ] });
  mockApi.post.mockResolvedValue({ data: response });
  renderEstimateWorkspace({ beside: <LocationProbe />, entry: '/estimates/est-convert-1' });
  await userEvent.click(await screen.findByRole('button', { name: /Create Job/i }));
  await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EstimateWorkspacePage - Convert to job and the job page (S04.21)', () => {
  it('opens the new job when the server says it opens for the converter', async () => {
    await convertFromTheHeader({ job: NEW_JOB, job_openable: true });

    await waitFor(() => expect(screen.getByTestId('location-probe').textContent).toBe(`/jobs/${NEW_JOB.id}`));
  });

  it('stays on the estimate and says the job was created when it does not open for the converter', async () => {
    await convertFromTheHeader({ job: NEW_JOB, job_openable: false });

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const [message, options] = vi.mocked(toast.success).mock.calls[0]!;
    expect(message).toBe('Job J-0042 was created');
    expect((options as { description: string }).description).toMatch(/you are not on it/i);
    expect(screen.getByTestId('location-probe').textContent).toBe('/estimates/est-convert-1');
    expect(toast.error).not.toHaveBeenCalled();
  });
});
