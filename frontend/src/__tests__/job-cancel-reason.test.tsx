/**
 * Roles & Permissions, PRD 6, S06.15 - cancelling a job needs a reason from the company's list, one job or many.
 *
 * Rendered against the ROUTED files: the job page's overflow menu (pages/v2/jobs/JobDetailPage) and the Jobs list's bulk
 * bar (pages/v2/jobs/JobsPage). The picker offers the company's ACTIVE reasons only and cannot be skipped; the note beside
 * it is optional; the bulk dialog lists every job the batch refused with its reason; the job page shows the reason by its
 * label as it is today; and no job screen has a Mark lost.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { JOB_ID, mountJobDetail, stubBrowser } from './harness/jobDetailPage';
import JobsPage from '@/pages/v2/jobs/JobsPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

vi.mock('react-router-dom', async () => (await import('./harness/jobDetailRouter')).jobDetailRouter());

const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const reason = (code: string, label: string, is_active = true, sort_order = 0) => ({ code, label, is_active, sort_order, is_builtin: true });
const SIX = [
  reason('CUSTOMER_BACKED_OUT', 'Customer backed out', true, 0),
  reason('WENT_WITH_A_COMPETITOR', 'Went with a competitor', true, 1),
  reason('PRICE', 'Price', true, 2),
  reason('COULD_NOT_DO_THE_WORK', 'Could not do the work', false, 3),
  reason('DUPLICATE_JOB', 'Duplicate job', true, 4),
  reason('OTHER', 'Other', true, 5),
];

const VISIT = {
  id: `${JOB_ID}-v1`, visit_seq: 1, status: 'SCHEDULED', purpose: 'WORK',
  scheduled_at: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', is_all_day: false,
  en_route_at: null, on_site_at: null, started_at: null, completed_at: null, cancelled_at: null,
  customer_email_sent_at: null, notes: null, status_steps: [], assignees: [],
};

function jobAnswer(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID, job_number: 'J00015', status: 'IN_PROGRESS', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', started_at: null,
    completed_at: null, cancelled_at: null, cancelled_reason: null, cancel_reason: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [VISIT], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null, locked: false, locked_actions: [], actions: ['cancel'],
    new_visit_closed_reason: null, ready_to_close: null,
    ...over,
  };
}

/** `reasons: 'loading'` holds the list read in flight (a read that never settles). */
function mountJob(over: Record<string, unknown> = {}, reasons: unknown[] | 'loading' = SIX) {
  return mountJobDetail({
    job: jobAnswer(over),
    visits: [VISIT],
    routes: [{
      match: (url) => url === '/api/job-cancel-reasons',
      data: reasons === 'loading' ? () => new Promise(() => {}) : { job_cancel_reasons: reasons },
    }],
  });
}

const cancelCalls = () => mockApi.post.mock.calls.filter(([url]) => String(url).endsWith('/cancel'));

beforeEach(() => {
  vi.clearAllMocks();
  stubBrowser();
  mockApi.post.mockResolvedValue({ data: { job: {}, voided_invoice_ids: [] } } as never);
});

async function openCancelDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Cancel' }));
  return screen.findByRole('dialog', { name: 'Cancel Job' });
}

describe('the job page cancel dialog', () => {
  it('cannot be confirmed without a reason from the list, and has no free-text way round it', async () => {
    mountJob();
    const user = userEvent.setup();
    const dialog = await openCancelDialog(user);

    expect(within(dialog).getByRole('combobox', { name: /Reason/ })).toBeInTheDocument();
    // The note is optional and is not the reason: typing one alone does not enable the cancel.
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'only a note');
    expect(within(dialog).getByRole('button', { name: 'Cancel Job' })).toBeDisabled();
    expect(cancelCalls()).toHaveLength(0);
  });

  it("offers the company's active reasons only, in the company's order", async () => {
    mountJob();
    const user = userEvent.setup();
    const dialog = await openCancelDialog(user);

    await user.click(within(dialog).getByRole('combobox', { name: /Reason/ }));

    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).toEqual(['Customer backed out', 'Went with a competitor', 'Price', 'Duplicate job', 'Other']);
    expect(screen.queryByRole('option', { name: 'Could not do the work' })).not.toBeInTheDocument();
  });

  it('sends the picked reason code, and the note only when one was written', async () => {
    mountJob();
    const user = userEvent.setup();
    let dialog = await openCancelDialog(user);
    await user.click(within(dialog).getByRole('combobox', { name: /Reason/ }));
    await user.click(await screen.findByRole('option', { name: 'Price' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Job' }));

    await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    expect(cancelCalls()[0]).toEqual([`/api/jobs/${JOB_ID}/cancel`, { cancel_reason_code: 'PRICE' }]);

    // With a note.
    vi.clearAllMocks();
    mockApi.post.mockResolvedValue({ data: { job: {}, voided_invoice_ids: [] } } as never);
    dialog = await openCancelDialog(user);
    await user.click(within(dialog).getByRole('combobox', { name: /Reason/ }));
    await user.click(await screen.findByRole('option', { name: 'Other' }));
    await user.type(within(dialog).getByLabelText('Note (optional)'), '  Moved away  ');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Job' }));
    await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    expect(cancelCalls()[0]![1]).toEqual({ cancel_reason_code: 'OTHER', cancelled_reason: 'Moved away' });
  });

  it('stays usable with a long list: past ten reasons the picker is searched, not scrolled', async () => {
    const many = Array.from({ length: 24 }, (_, i) => reason(`REASON_${i}`, `Reason number ${i}`, true, i));
    many.push(reason('STORM_DAMAGE', 'Storm damage', true, 99));
    mountJob({}, many);
    const user = userEvent.setup();
    const dialog = await openCancelDialog(user);

    await user.click(within(dialog).getByRole('combobox', { name: /Reason/ }));
    await user.type(await screen.findByLabelText('Search options'), 'storm');

    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Storm damage']);
    await user.click(options[0]!);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Job' }));
    await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    expect(cancelCalls()[0]![1]).toEqual({ cancel_reason_code: 'STORM_DAMAGE' });
  });

  it('does not offer a picker that looks empty while the list is still loading', async () => {
    mountJob({}, 'loading');
    const user = userEvent.setup();
    const dialog = await openCancelDialog(user);
    expect(within(dialog).getByRole('combobox', { name: /Reason/ })).toBeDisabled();
  });
});

describe('the job page shows the reason by its label as it is today', () => {
  it('shows a cancelled job\'s reason label and its note', async () => {
    mountJob({
      status: 'CANCELLED', cancelled_at: '2026-10-03T12:00:00.000Z', cancelled_reason: 'Quoted too high',
      cancel_reason: { code: 'PRICE', label: 'Too expensive', is_active: true }, actions: [],
    });
    expect(await screen.findByText('Cancellation Reason')).toBeInTheDocument();
    expect(screen.getByText('Too expensive')).toBeInTheDocument();
    expect(screen.getByText('Quoted too high')).toBeInTheDocument();
  });

  it('still shows a reason that has since been turned off', async () => {
    mountJob({
      status: 'CANCELLED', cancelled_at: '2026-10-03T12:00:00.000Z', cancelled_reason: null,
      cancel_reason: { code: 'DUPLICATE_JOB', label: 'Duplicate job', is_active: false }, actions: [],
    });
    expect(await screen.findByText('Duplicate job')).toBeInTheDocument();
  });

  it('shows a job cancelled before the list existed by its written reason alone', async () => {
    mountJob({ status: 'CANCELLED', cancelled_at: '2026-09-03T12:00:00.000Z', cancelled_reason: 'Customer moved away', cancel_reason: null, actions: [] });
    expect(await screen.findByText('Customer moved away')).toBeInTheDocument();
  });
});

describe('Cancel on the job page follows the job\'s own answer', () => {
  it('is not offered on a Done job, or to a person whose answer does not list it', async () => {
    mountJob({ status: 'DONE', actions: [] });
    await screen.findByText('J00015');
    const user = userEvent.setup();
    const menu = screen.queryByRole('button', { name: 'Actions' });
    if (menu) {
      await user.click(menu);
      expect(screen.queryByRole('menuitem', { name: 'Cancel' })).not.toBeInTheDocument();
    }
  });

  it('has no Mark lost anywhere on a job', async () => {
    mountJob();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    await screen.findByRole('menuitem', { name: 'Cancel' });
    expect(screen.queryByRole('menuitem', { name: /lost/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/mark lost/i)).not.toBeInTheDocument();
  });
});

// ─── The Jobs list bulk dialog ────────────────────────────────────────────────

const RUNNING = 'j0000000-0000-0000-0000-0000000000a1';
const FINISHED = 'j0000000-0000-0000-0000-0000000000a2';
const row = (id: string, n: string, status: string) => ({
  id, job_number: n, status, scheduled_start: '2026-07-20T09:00:00.000Z', created_at: '2026-07-15T00:00:00.000Z',
  customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, customer_number: 'C00001' },
  assignees: [], service_location: null,
});
const JOB_LIST = {
  jobs: [row(RUNNING, 'J00071', 'IN_PROGRESS'), row(FINISHED, 'J00072', 'DONE')],
  pagination: { page: 1, limit: 25, total: 2, totalPages: 1 },
  stats: { unassigned: 0, scheduled: 0, in_progress: 1, completed: 1, cancelled: 0, need_invoices: 0 },
  users: [], departments: [], tags: [],
};

async function openBulkCancel(user: ReturnType<typeof userEvent.setup>) {
  mockApi.get.mockImplementation((async (url: string) => {
    if (url === '/api/job-cancel-reasons') return { data: { job_cancel_reasons: SIX } };
    if (url === '/api/jobs/cancel-preview') return { data: { invoices: [] } };
    return { data: JOB_LIST };
  }) as never);
  renderWithProviders(<JobsPage />, { ability, initialEntries: ['/jobs'] });
  await screen.findByText('J00071');
  await user.click(screen.getByRole('checkbox', { name: 'Select J00071' }));
  await user.click(screen.getByRole('checkbox', { name: 'Select J00072' }));
  await user.click(await screen.findByRole('button', { name: /change status/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Cancelled' }));
  return screen.findByRole('dialog', { name: /Cancel 2 jobs/ });
}

describe('the Jobs list bulk cancel dialog', () => {
  it('needs a reason from the list and the invoice choice before it can be confirmed', async () => {
    const user = userEvent.setup();
    const dialog = await openBulkCancel(user);
    // The button is drawn again when its reason goes, so it is looked up each time.
    const confirm = () => within(dialog).getByRole('button', { name: 'Cancel 2 jobs' });

    expect(confirm()).toBeDisabled();
    await user.click(within(dialog).getByRole('radio', { name: /Keep the invoices/ }));
    expect(confirm()).toBeDisabled();

    await user.click(within(dialog).getByRole('combobox', { name: /Reason/ }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).not.toContain('Could not do the work');
    await user.click(screen.getByRole('option', { name: 'Went with a competitor' }));
    expect(confirm()).toBeEnabled();
  });

  it('takes one reason and one note for the whole batch, and lists the job the batch refused with its reason', async () => {
    mockApi.post.mockResolvedValue({
      data: { updated: [RUNNING], failed: [{ id: FINISHED, error: 'Reopen this job first' }], voided_invoice_ids: [] },
    } as never);
    const user = userEvent.setup();
    const dialog = await openBulkCancel(user);

    await user.click(within(dialog).getByRole('combobox', { name: /Reason/ }));
    await user.click(await screen.findByRole('option', { name: 'Went with a competitor' }));
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Season over');
    await user.click(within(dialog).getByRole('radio', { name: /Keep the invoices/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel 2 jobs' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/bulk-status', {
      ids: [RUNNING, FINISHED], action: 'cancel', cancel_reason_code: 'WENT_WITH_A_COMPETITOR', cancelled_reason: 'Season over', void_invoices: false,
    }));
    // The dialog stays up and names each refused job with the reason it was refused for.
    const result = await screen.findByRole('dialog', { name: /1 job could not be cancelled/ });
    expect(within(result).getByText('1 job was cancelled.')).toBeInTheDocument();
    const list = within(result).getByRole('list', { name: 'Jobs that could not be cancelled' });
    expect(within(list).getByText('J00072')).toBeInTheDocument();
    expect(within(list).getByText('Reopen this job first')).toBeInTheDocument();
    expect(within(list).queryByText('J00071')).not.toBeInTheDocument();
  });

  it('closes by itself when every job in the batch was cancelled', async () => {
    mockApi.post.mockResolvedValue({ data: { updated: [RUNNING, FINISHED], failed: [], voided_invoice_ids: [] } } as never);
    const user = userEvent.setup();
    const dialog = await openBulkCancel(user);
    await user.click(within(dialog).getByRole('combobox', { name: /Reason/ }));
    await user.click(await screen.findByRole('option', { name: 'Price' }));
    await user.click(within(dialog).getByRole('radio', { name: /Keep the invoices/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel 2 jobs' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('has no Lost in the bulk status menu', async () => {
    const user = userEvent.setup();
    await openBulkCancel(user);
    // The menu is closed by now; open it again to read every choice.
    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: /change status/i }));
    const choices = (await screen.findAllByRole('menuitem')).map((m) => m.textContent ?? '');
    expect(choices.length).toBeGreaterThan(0);
    for (const choice of choices) expect(choice).not.toMatch(/lost/i);
  });
});
