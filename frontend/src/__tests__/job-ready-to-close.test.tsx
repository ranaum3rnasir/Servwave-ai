/**
 * Roles & Permissions, PRD 6, S06.13 - the Ready to close banner and Mark Done on the routed job page.
 *
 * The job's own answer (`job.ready_to_close`) carries the amount owed and whether Mark Done is offered, disabled or absent;
 * the browser never works out money owed. A holder who may close over money owed confirms the amount in the design
 * system's confirm dialog before the request goes; the server checks it again and its refusal is shown as it was written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';
import { toast } from '@/ui-kit/components/ui/sonner';
import { notificationDeepLink } from '@/components/notifications/notificationDeepLink';
import type { NotificationView } from '@/lib/api/notifications';
import type { ReadyToCloseAnswer } from '@/components/jobs/review/ReadyToCloseBanner';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
const mockToast = vi.mocked(toast);

const JOB_ID = 'j0000000-0000-0000-0000-000000000013';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const MONEY_OWED_WORDS = 'Money is still owed on this job. Only someone allowed to close jobs with money owed can mark it Done.';

const offered = (amount_owed = 0): ReadyToCloseAnswer => ({ amount_owed, mark_done: 'offered', mark_done_reason: null, confirm_amount: amount_owed > 0, review_changes: false });

const VISIT = {
  id: `${JOB_ID}-v1`, visit_seq: 1, status: 'COMPLETED', purpose: 'WORK',
  scheduled_at: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', is_all_day: false,
  en_route_at: null, on_site_at: null, started_at: null, completed_at: '2026-10-02T15:00:00.000Z', cancelled_at: null,
  customer_email_sent_at: null, notes: null, status_steps: [], assignees: [],
};

/** Mount the routed job page with the answer the server would give this person. */
function mount(over: Record<string, unknown> = {}, entry = '/') {
  const job = {
    id: JOB_ID, job_number: 'J00013', status: 'READY_TO_CLOSE', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', started_at: null,
    completed_at: '2026-10-02T15:00:00.000Z', cancelled_at: null, cancelled_reason: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [VISIT], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null, locked: true, locked_actions: [], actions: ['mark_done'],
    new_visit_closed_reason: 'Reopen this job first', ready_to_close: offered(),
    ...over,
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/visits`) return { data: { visits: [VISIT] } } as never;
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } } as never;
    return { data: {} } as never;
  });
  return renderWithProviders(<JobDetailPage />, { ability, initialEntries: [entry] });
}

const markDoneCalls = () => mockApi.post.mock.calls.filter(([url]) => String(url).endsWith('/mark-done'));
const jobReads = () => mockApi.get.mock.calls.filter(([url]) => url === `/api/jobs/${JOB_ID}`);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { job: {} } } as never);
});
afterEach(() => vi.restoreAllMocks());

// S06.24: the Ready to close alert's link is the job itself, with no panel named, and the banner on it offers Mark Done.
describe('the Ready to close alert\'s link', () => {
  const link = notificationDeepLink({
    id: 'n1', verb: 'job.ready_to_close', category: 'JOB', priority: 'FEED', needs_action: true, object_type: 'JOB', object_id: JOB_ID,
    object_label: 'J00013', title: 'J00013 is ready to close', body: null, data: { object_label: 'J00013', fallback_reason: '' },
    action_type: null, created_at: '2026-10-10T00:00:00Z', seen_at: null, read_at: null, acted_at: null, dismissed_at: null,
  } as NotificationView);

  it('opens the job with no panel in its address, where the banner offers Mark Done', async () => {
    expect(link).toBe(`/jobs/${JOB_ID}`);
    mount({}, link);
    const banner = await screen.findByRole('region', { name: 'Ready to close' });
    expect(within(banner).getByRole('button', { name: 'Mark Done' })).toBeEnabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockApi.get.mock.calls.filter(([url]) => String(url).endsWith('/review'))).toHaveLength(0);
  });
});

describe('the Ready to close banner', () => {
  it('says "Ready to close" and offers Mark Done to a Close jobs holder when nothing is owed, with no amount', async () => {
    mount();
    const banner = await screen.findByRole('region', { name: 'Ready to close' });
    expect(within(banner).getByText('Ready to close')).toBeInTheDocument();
    expect(within(banner).queryByTestId('ready-to-close-owed')).not.toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Mark Done' })).toBeEnabled();
  });

  it('marks the job Done on one press when nothing is owed: no dialog, no amount sent', async () => {
    mount();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Mark Done' }));
    await waitFor(() => expect(markDoneCalls()).toHaveLength(1));
    expect(markDoneCalls()[0]).toEqual([`/api/jobs/${JOB_ID}/mark-done`, { confirmed_amount: null }]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Job marked Done'));
  });

  it('shows the amount owed the server gave, and asks the holder of Close jobs with money owed to confirm it before anything is sent', async () => {
    mount({ ready_to_close: offered(350) });
    const banner = await screen.findByRole('region', { name: 'Ready to close' });
    expect(within(banner).getByTestId('ready-to-close-owed')).toHaveTextContent('$350.00 owed');

    const user = userEvent.setup();
    await user.click(within(banner).getByRole('button', { name: 'Mark Done' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark this job Done?' });
    expect(within(dialog).getByText(/\$350\.00 is still owed on J00013/)).toBeInTheDocument();
    expect(markDoneCalls()).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Mark Done, $350.00 still owed' }));
    await waitFor(() => expect(markDoneCalls()).toHaveLength(1));
    expect(markDoneCalls()[0]).toEqual([`/api/jobs/${JOB_ID}/mark-done`, { confirmed_amount: 350 }]);
  });

  it('sends nothing when the person backs out of the amount confirmation', async () => {
    mount({ ready_to_close: offered(350) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Mark Done' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark this job Done?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(markDoneCalls()).toHaveLength(0);
  });

  it('draws Mark Done disabled, with the reason and the amount, for a Close jobs holder who may not close over money owed', async () => {
    mount({
      actions: [],
      ready_to_close: { amount_owed: 75, mark_done: 'disabled', mark_done_reason: MONEY_OWED_WORDS, confirm_amount: false },
    });
    const banner = await screen.findByRole('region', { name: 'Ready to close' });
    expect(within(banner).getByText(MONEY_OWED_WORDS)).toBeInTheDocument();
    expect(within(banner).getByTestId('ready-to-close-owed')).toHaveTextContent('$75.00 owed');
    const button = within(banner).getByRole('button', { name: 'Mark Done' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(MONEY_OWED_WORDS);
    await userEvent.setup().click(button);
    expect(markDoneCalls()).toHaveLength(0);
  });

  it('shows a reviewer who cannot close the status and the amount, and no Mark Done', async () => {
    mount({ actions: [], ready_to_close: { amount_owed: 60, mark_done: 'none', mark_done_reason: null, confirm_amount: false } });
    const banner = await screen.findByRole('region', { name: 'Ready to close' });
    expect(within(banner).getByTestId('ready-to-close-owed')).toHaveTextContent('$60.00 owed');
    expect(within(banner).queryByRole('button', { name: 'Mark Done' })).not.toBeInTheDocument();
  });

  it('is not drawn for a person the job says nothing about Ready to close to', async () => {
    mount({ actions: ['edit'], ready_to_close: null });
    await screen.findByText('J00013');
    expect(screen.queryByRole('region', { name: 'Ready to close' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark Done' })).not.toBeInTheDocument();
  });

  it('is not drawn once the job has left Ready to close', async () => {
    mount({ status: 'DONE', actions: [], ready_to_close: null });
    await screen.findByText('J00013');
    expect(screen.queryByRole('region', { name: 'Ready to close' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark Done' })).not.toBeInTheDocument();
  });

  it('is not drawn in Office review, and the review banner is the one shown there', async () => {
    mount({ status: 'OFFICE_REVIEW', actions: ['office_review'], ready_to_close: offered() });
    await screen.findByText('J00013');
    expect(screen.queryByRole('region', { name: 'Ready to close' })).not.toBeInTheDocument();
  });

  it('shows the server\'s refusal as it was written and reads the job again, when the amount changed under the person', async () => {
    const refusal = 'The amount owed on this job is now $60.00. Check it and confirm again.';
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: refusal, code: 'MARK_DONE_AMOUNT', amount_owed: 60 } }, isAxiosError: true });
    mount({ ready_to_close: offered(100) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Mark Done' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark this job Done?' });
    const readsBefore = jobReads().length;
    await user.click(within(dialog).getByRole('button', { name: 'Mark Done, $100.00 still owed' }));

    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith(refusal));
    await waitFor(() => expect(jobReads().length).toBeGreaterThan(readsBefore));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
