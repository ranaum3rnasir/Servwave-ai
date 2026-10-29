/**
 * Code review #11: what the job page refreshes, and what it leaves alone.
 *
 * - Deleting the job DROPS the job's own queries instead of invalidating them: an invalidated query
 *   that is still on screen refetches at once, and every one of those refetches is a 404 for a job
 *   that no longer exists, fired before the page navigates away. The board and the customer page
 *   are still refreshed - the job's visits left both.
 * - An invoice or a payment is not a visit write: it refreshes the job page, never the scheduler
 *   board or the job's visit list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { jobVisitsQueryKey } from '@/lib/useJobVisits';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { expectCustomerPageStale, seedCustomerPage } from '@/__tests__/support/customerPageCache';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
// A stand-in that reports a recorded payment the way the real dialog does on success.
vi.mock('@/components/invoices/RecordPaymentDialog', () => ({
  RecordPaymentDialog: ({ onSuccess }: { onSuccess: () => void }) => (
    <button type="button" onClick={onSuccess}>stub: payment recorded</button>
  ),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const get = vi.mocked(api.get);

const JOB = {
  id: JOB_ID, job_number: 'J00001', status: 'UNSCHEDULED',
  customer: { id: 'cust-1', first_name: 'Pat', last_name: 'Sample', company_name: null },
  assignees: [], invoices: [], linked_estimates: [], tags: [],
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
};

const jobGets = () => get.mock.calls.filter(([url]) => url === `/api/jobs/${JOB_ID}`).length;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.post).mockResolvedValue({ data: {} });
  vi.mocked(api.delete).mockResolvedValue({ data: {} });
  get.mockImplementation(async (url: string) => (url === `/api/jobs/${JOB_ID}` ? { data: { job: JOB } } : { data: {} }));
});

/** The page on a real route, so navigating away after a delete unmounts it as it does in the app. */
function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/jobs/:id" element={<JobDetailPage />} />
      <Route path="*" element={<p>elsewhere</p>} />
    </Routes>,
    { initialEntries: [`/jobs/${JOB_ID}`], ability: buildAbility([{ action: 'manage', subject: 'all' }]) },
  );
}

describe('deleting the job', () => {
  it('drops the job\'s own queries - no refetch of the deleted job - and still refreshes the customer page', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    seedCustomerPage(queryClient);
    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const before = jobGets();

    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}`));
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    await expectCustomerPageStale(queryClient);
    // The deleted job was never asked for again (the old invalidation refetched it on the spot).
    expect(jobGets()).toBe(before);
  });
});

describe('a payment recorded on the job page', () => {
  it('refreshes the job, and leaves the scheduler board and the visit list alone', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderPage();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(await screen.findByRole('button', { name: 'stub: payment recorded' }));

    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    expect(keys).toContain(JSON.stringify(['job', JOB_ID]));
    expect(keys).toContain(JSON.stringify(['job-financials', JOB_ID]));
    for (const key of [['schedule-jobs'], ['schedule-walkthroughs'], jobVisitsQueryKey(JOB_ID), ['customer']]) {
      expect(keys).not.toContain(JSON.stringify(key));
    }
  });
});

describe('the shared visit-write refresh', () => {
  // Calendar entries (the customer's Events) are standalone meetings with participants - no job,
  // lead or visit behind them (backend CalendarEntry has no such relation) - and their own writes
  // refresh them (invalidateCalendarEntryQueries). A visit write has nothing to say to them.
  it('leaves the customer\'s Events alone: a calendar entry is not a visit', () => {
    const qc = new QueryClient();
    qc.setQueryDefaults(['customer-calendar-entries', 'cust-1'], { gcTime: Infinity });
    qc.setQueryData(['customer-calendar-entries', 'cust-1'], []);

    refreshAfterVisitWrite(qc, { jobId: JOB_ID });

    expect(qc.getQueryState(['customer-calendar-entries', 'cust-1'])?.isInvalidated).toBe(false);
  });
});
