/**
 * Every door that CREATES a job refreshes the customer page (visits-and-task-categories slice 01).
 *
 * A new job on a customer is a new row on that customer's page, and the "Schedule this job now"
 * create books Visit 1 in the same request (job.controller create, the third booking door). These
 * doors used to refresh `['jobs']` and, at most, `['customers']` - the list, which does not
 * prefix-match `['customer', id]` - so after an in-app return the customer page was missing the
 * job until a reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders, LEAD_FIXTURE, ALL_JOB_ACTIONS } from '@/__tests__/helpers';
import { expectCustomerPageStale, seedCustomerPage } from '@/__tests__/support/customerPageCache';
import { ESTIMATE_STATUS } from '@/constants/estimateStatus';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';
import { renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import { renderLeadDetail, serveLeadDetail } from '@/__tests__/harness/leadDetailPage';
import { renderEstimateWorkspace, serveEstimateWorkspace } from '@/__tests__/harness/estimateWorkspacePage';

/** Each page reads its own `:id`; the test sets it before rendering. */
const route = vi.hoisted(() => ({ id: '' }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useParams: () => ({ id: route.id }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/lib/api/shared/organization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/shared/organization')>()),
  useOrganization: () => ({ data: { job_type_options: [], source_options: [], timezone: 'America/New_York' } }),
}));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('@/components/crm/AttachmentSection', () => ({ AttachmentSection: () => null }));
// The estimate page's heavy sub-surfaces, stubbed as estimate-actions-convert-to-job.test.tsx does.
vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({ EstimateTabs: () => null }));
vi.mock('@/components/estimates/EstimateLineItemsEditor', () => ({
  EstimateLineItemsEditor: () => null,
  EstimateScopeOfWorkCard: () => null,
  estimateLinesToInvoiceShape: (lines: unknown) => lines,
}));
vi.mock('@/features/estimate-workspace/components/SignatureCard', () => ({ SignatureCard: () => null }));
vi.mock('@/features/estimate-workspace/components/NotesCard', () => ({ NotesCard: () => null }));
vi.mock('@/features/estimate-workspace/components/HistoryPanel', () => ({ HistoryPanel: () => null }));

stubBrowser();

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const post = vi.mocked(api.post);
const get = vi.mocked(api.get);
const NEW_JOB = { job: { id: 'job-new' } };

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: NEW_JOB });
});

describe('the job form', () => {
  const CUSTOMER = {
    id: 'c-form-1',
    first_name: 'Pat',
    last_name: 'Sample',
    company_name: null,
    phone: '5551234567',
    email: 'pat@example.test',
    service_locations: [
      { id: 'loc-1', is_primary: true, address_line1: '1 Sample St', address_line2: null, city: 'Passaic', state: 'NJ', zip: '07055' },
    ],
  };

  it('"Create Job" with "Schedule this job now" marks the customer page stale', async () => {
    get.mockImplementation(async (url: string) => {
      // The new-job form shows the creator rule's pre-fill and will not save blind without it.
      if (url === '/api/jobs/creator-prefill') return { data: { prefill: { sold_by_id: null, dispatcher_id: null } } };
      return url === `/api/customers/picker/${CUSTOMER.id}` ? { data: { customer: CUSTOMER } } : { data: {} };
    });
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<JobFormPage />, {
      ability: ADMIN,
      initialEntries: [`/jobs/new?customer_id=${CUSTOMER.id}`],
    });
    seedCustomerPage(queryClient);

    expect(await screen.findByDisplayValue('Pat')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Service Request/), 'Gate repair');
    await user.click(screen.getByRole('switch', { name: 'Schedule this job now' }));
    await user.type(screen.getByLabelText('Start date'), '10/02/2026');
    await user.tab();
    await user.type(screen.getByLabelText('Start time'), '9:00 AM');
    await user.tab();
    await user.type(screen.getByLabelText('End date'), '10/02/2026');
    await user.tab();
    await user.type(screen.getByLabelText('End time'), '11:00 AM');
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Create Job' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/jobs', expect.objectContaining({ scheduled_start: expect.any(String) })),
    );
    await expectCustomerPageStale(queryClient);
  });
});

describe('the job page', () => {
  function mockJob(jobId: string) {
    serveJobDetail({
      jobId,
      job: {
        id: jobId, job_number: 'J00001', status: 'SCHEDULED',
        customer: { id: 'cust-1', first_name: 'Pat', last_name: 'Sample', company_name: null },
        assignees: [], invoices: [], linked_estimates: [], tags: [], actions: ALL_JOB_ACTIONS,
        created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
      },
    });
  }

  it('"Duplicate Job" marks the customer page stale', async () => {
    route.id = 'j-dup-1';
    mockJob('j-dup-1');
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { queryClient } = renderJobDetail({ ability: ADMIN });
    seedCustomerPage(queryClient);

    await user.click(await screen.findByRole('button', { name: /actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Duplicate Job/ }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/jobs/j-dup-1/duplicate'));
    await expectCustomerPageStale(queryClient);
  });

  // Deleting the job removes it, and every visit on it, from the customer page.
  it('"Delete" marks the customer page stale', async () => {
    route.id = 'j-del-1';
    mockJob('j-del-1');
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { queryClient } = renderJobDetail({ ability: ADMIN });
    seedCustomerPage(queryClient);

    await user.click(await screen.findByRole('button', { name: /actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    const confirm = (await screen.findByText('Delete this job?'))
      .closest<HTMLElement>('[role="alertdialog"],[role="dialog"]')!;
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/jobs/j-del-1'));
    await expectCustomerPageStale(queryClient);
  });
});

describe('the lead page', () => {
  it('"Convert to job" marks the customer page stale', async () => {
    route.id = LEAD_FIXTURE.id;
    const estimate = {
      id: 'es-1', estimate_number: 'E00001', status: 'WON', total_amount: '1500.00',
      created_at: '2026-02-01T00:00:00.000Z',
    };
    serveLeadDetail({ lead: { ...LEAD_FIXTURE, status: 'WON', estimates: [estimate] } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { queryClient } = renderLeadDetail({ ability: ADMIN });
    seedCustomerPage(queryClient);

    await user.click(await screen.findByRole('button', { name: /Convert to job/i }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/jobs', { estimate_id: 'es-1' }));
    await expectCustomerPageStale(queryClient);
  });
});

// Not a create, but the same page harness: the lead status menu takes a lead to LOST through the
// Mark Lost dialog (lead-statuses slice 05: closing a lead always asks why), and the server cancels
// its booked walkthrough trips on that path, so it is a visit write.
describe('the lead page status menu', () => {
  it('setting Lost through its reason dialog marks the customer page stale', async () => {
    route.id = LEAD_FIXTURE.id;
    serveLeadDetail({ lead: { ...LEAD_FIXTURE, status: 'CONTACTED' } });
    post.mockResolvedValue({ data: {} });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { queryClient } = renderLeadDetail({ ability: ADMIN });
    seedCustomerPage(queryClient);

    await user.click(await screen.findByRole('button', { name: 'Lead status: Contacted' }));
    await user.click(await screen.findByRole('menuitem', { name: /Lost/ }));
    // The menu opens the dialog; nothing is written until a reason is given.
    expect(api.patch).not.toHaveBeenCalled();
    await user.type(await screen.findByPlaceholderText('Why was this lead lost?'), 'Went with another company');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Mark Lost' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`, expect.anything()),
    );
    await expectCustomerPageStale(queryClient);
  });
});

describe('the estimate page', () => {
  it('"Create Job" marks the customer page stale', async () => {
    route.id = 'est-1';
    const estimate = {
      id: 'est-1', lead_id: 'lead-9', estimate_number: 'L00009-1', name: null, status: ESTIMATE_STATUS.WON,
      approved_at: '2026-07-20T00:00:00.000Z', sent_at: '2026-07-19T00:00:00.000Z', declined_at: null,
      cancelled_at: null, scope_notes: null, tax_rate: '0', subtotal: '1000.00', tax_amount: '0.00',
      total_amount: '1000.00', discount_type: null, discount_value: null, discount_name: null,
      discount_amount: '0.00', signature_data: null, signature_at: null, public_token: null, version: 1,
      modified_after_send: false, superseded_by_id: null, created_by: 'user-1',
      created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z', send_config: null,
      lead: {
        id: 'lead-9', status: 'ESTIMATED', service_request: 'Gate repair',
        customer: { id: 'cust-1', first_name: 'Pat', last_name: 'Sample', company_name: null, email: 'pat@example.test', phone: '5551234567' },
      },
      creator: { id: 'user-1', first_name: 'Ada', last_name: 'Admin' },
      line_items: [], scopes: [], job: null, job_id: null, invoices: [],
    };
    serveEstimateWorkspace({ estimate });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { queryClient } = renderEstimateWorkspace({ ability: ADMIN });
    seedCustomerPage(queryClient);

    const header = (await screen.findAllByRole('button', { name: /Create Job/i }))[0]!;
    await user.click(header);

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/jobs', { estimate_id: 'est-1' }));
    await expectCustomerPageStale(queryClient);
  });
});
