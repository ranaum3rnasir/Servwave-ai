/**
 * Roles & Permissions, PRD 6, S06.32 - a job the one-time close-out upgrade moved has nobody who closed it.
 *
 * The upgrade moves a Completed job to Done (stamped closed on the day it was completed, closed_by_id empty) or to Ready to
 * close, opens no review round, and writes one History entry with no actor. The routed job page must draw such a job
 * without a closer, and the Activity panel must list the entry as the system's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { ActivityPanel } from '@/components/crm/ActivityPanel';
import { buildAbility } from '@/lib/ability';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

const JOB_ID = 'j0000000-0000-0000-0000-000000000032';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

/** The History entry as the server lists it: no creator, the words the upgrade writes. */
const UPGRADE_ENTRY = {
  id: 'ev-upgrade',
  event_type: 'JOB_CLOSE_OUT_UPGRADED',
  description: 'Moved by the job close-out upgrade',
  created_at: '2026-10-20T12:00:00.000Z',
  creator: null,
  metadata: { from: 'COMPLETED', to: 'DONE', via: 'job_close_out_upgrade' },
};

function mount(over: Record<string, unknown>) {
  const job = {
    id: JOB_ID, job_number: 'J00032', status: 'DONE', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: null, scheduled_end: null, started_at: null,
    completed_at: '2026-03-04T15:20:00.000Z', closed_at: '2026-03-04T15:20:00.000Z', closed_by_id: null,
    cancelled_at: null, cancelled_reason: null, created_at: '2026-03-01T00:00:00.000Z', updated_at: '2026-03-04T15:20:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null, locked: true, locked_actions: [], actions: [],
    new_visit_closed_reason: 'Reopen this job first', ready_to_close: null,
    ...over,
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/visits`) return { data: { visits: [] } } as never;
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.includes('/timeline')) return { data: { events: [UPGRADE_ENTRY] } } as never;
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } } as never;
    return { data: {} } as never;
  });
  return renderWithProviders(<JobDetailPage />, { ability });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a job the close-out upgrade moved', () => {
  it('draws a Done job that nobody closed: the Done chip, the lock notice, and no closer', async () => {
    mount({});
    expect(await screen.findByText('J00032')).toBeInTheDocument();
    expect(screen.getAllByText('Done').length).toBeGreaterThan(0);
    expect(await screen.findByTestId('job-locked-notice')).toBeInTheDocument();
    expect(screen.queryByText(/closed by/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined|null/)).not.toBeInTheDocument();
  });

  it('draws a Ready to close job that never had a review round: the banner and the amount, and Mark Done for a closer', async () => {
    mount({
      status: 'READY_TO_CLOSE', closed_at: null, actions: ['mark_done'],
      ready_to_close: { amount_owed: 120, mark_done: 'offered', mark_done_reason: null, confirm_amount: true },
    });
    const banner = await screen.findByRole('region', { name: 'Ready to close' });
    expect(within(banner).getByTestId('ready-to-close-owed')).toHaveTextContent('$120.00 owed');
    expect(within(banner).getByRole('button', { name: 'Mark Done' })).toBeEnabled();
    // no review banner and no request for a review round it does not have
    expect(screen.queryByRole('region', { name: /office review/i })).not.toBeInTheDocument();
    expect(mockApi.get.mock.calls.some(([url]) => String(url).includes('/review'))).toBe(false);
  });
});

describe('the Activity panel', () => {
  it('lists the upgrade entry as the system\'s, in the upgrade\'s words', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/timeline')) return { data: { events: [UPGRADE_ENTRY] } } as never;
      return { data: {} } as never;
    });
    renderWithProviders(<ActivityPanel entityType="JOB" entityId={JOB_ID} />);

    await waitFor(() => expect(screen.getByText('Moved by the job close-out upgrade')).toBeInTheDocument());
    expect(screen.getByText('System')).toBeInTheDocument();
  });
});
