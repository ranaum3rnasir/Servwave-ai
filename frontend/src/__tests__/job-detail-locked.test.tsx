/**
 * Roles & Permissions, PRD 4, S04.22 - the completed-job lock on the routed job page.
 *
 * GET /api/jobs/:id answers `locked` (the job is Completed or later, or Cancelled, and the person cannot change locked
 * jobs) and `locked_actions` (what the person's switches allow that the lock is withholding). The page says the lock
 * once and draws the controls it turns off disabled, with the reason, instead of leaving them out. What the lock leaves
 * open (notes, files, invoices) keeps its controls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

/** The PRD's own wording, written out here rather than imported from the page. */
const LOCK_REASON = 'This job is locked. Only someone who can change locked jobs can change it.';

const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const LINE = {
  id: 'line-1', job_id: JOB_ID, sequence: 1, description: 'Compressor swap', quantity: 1, unit_price: 300, unit_cost: 200,
  markup_percent: null, is_taxable: true, line_total: 300, discount_type: null, discount_value: null, discount_amount: 0,
  item_type: 'SERVICE', price_book_item_id: null,
};

const VISIT = {
  id: `${JOB_ID}-v1`, visit_seq: 1, status: 'SCHEDULED', purpose: 'WORK',
  scheduled_at: '2026-08-21T13:00:00.000Z', scheduled_end: '2026-08-21T15:00:00.000Z', is_all_day: false,
  en_route_at: null, on_site_at: null, started_at: null, completed_at: null, cancelled_at: null,
  customer_email_sent_at: null, notes: null, status_steps: [], assignees: [],
};

/** What the files route answers for the job: rows carrying the server's per-file answer. */
let attachmentRows: unknown[] = [];

function mount(overrides: Record<string, unknown>) {
  const job = {
    id: JOB_ID, job_number: 'J00001', status: 'COMPLETED', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-08-21T13:00:00.000Z', scheduled_end: '2026-08-21T15:00:00.000Z', started_at: null,
    completed_at: '2026-08-22T13:00:00.000Z', cancelled_at: null, cancelled_reason: null,
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [VISIT], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null,
    ...overrides,
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/visits`) return { data: { visits: [VISIT] } } as never;
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 300, invoiced: 0, remaining: 300 } } } as never;
    if (url.endsWith('/line-items')) return { data: { lines: [LINE], billing: { total: 300, invoiced: 0, remaining: 300 } } } as never;
    if (url.startsWith(`/api/attachments/JOB/${JOB_ID}`)) return { data: { attachments: attachmentRows } } as never;
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } } as never;
    return { data: {} } as never;
  });
  return renderWithProviders(<JobDetailPage />, { ability });
}

beforeEach(() => {
  vi.clearAllMocks();
  attachmentRows = [];
});

const LOCKED_BY_THE_LOCK = ['edit', 'assign', 'schedule', 'delete', 'renumber', 'edit_line_items', 'apply_discount'];
const STILL_OPEN = ['add_note', 'upload_attachment', 'create_invoice', 'duplicate'];

describe('a locked job on the routed job page', () => {
  it('says why once, and draws the withheld header actions disabled with the reason', async () => {
    mount({ locked: true, actions: STILL_OPEN, locked_actions: LOCKED_BY_THE_LOCK });
    await screen.findByText('J00001');

    const notice = await screen.findByTestId('job-locked-notice');
    expect(notice).toHaveTextContent(LOCK_REASON);

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Actions' }));
    const menu = await screen.findByRole('menu');
    for (const label of ['Assign', 'Reschedule', 'Delete']) {
      const item = within(menu).getByRole('menuitem', { name: new RegExp(label) });
      expect(item, label).toHaveAttribute('aria-disabled', 'true');
      expect(item, label).toHaveTextContent(LOCK_REASON);
    }
    // What the lock leaves open keeps its control.
    expect(within(menu).getByRole('menuitem', { name: /Duplicate Job/ })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('shows Add visit, and each visit\'s Reschedule and Cancel, disabled', async () => {
    mount({ locked: true, actions: STILL_OPEN, locked_actions: LOCKED_BY_THE_LOCK });
    await screen.findByText('J00001');
    await userEvent.setup().click(screen.getByRole('tab', { name: /visits/i }));
    const addVisit = await screen.findByRole('button', { name: 'Add visit' });
    expect(addVisit).toBeDisabled();
    const office = await screen.findByRole('group', { name: 'Office actions' });
    expect(within(office).getByRole('button', { name: 'Reschedule' })).toBeDisabled();
    expect(within(office).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('shows Add item disabled on the Items tab and removes the line controls', async () => {
    mount({ locked: true, actions: STILL_OPEN, locked_actions: LOCKED_BY_THE_LOCK });
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Items/i }));
    await screen.findByText('Compressor swap');
    expect(screen.getByRole('button', { name: /add item/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /remove compressor swap/i })).toBeNull();
  });

  it('keeps the note composer for a person with Add notes', async () => {
    mount({ locked: true, actions: STILL_OPEN, locked_actions: LOCKED_BY_THE_LOCK });
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Notes/i }));
    expect(await screen.findByRole('textbox', { name: 'Note' })).toBeInTheDocument();
  });
});

describe('a job that is not locked for the person', () => {
  it('shows no notice and leaves the header actions and Add visit enabled', async () => {
    mount({ locked: false, actions: [...STILL_OPEN, ...LOCKED_BY_THE_LOCK], locked_actions: [] });
    await screen.findByText('J00001');
    expect(screen.queryByTestId('job-locked-notice')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /visits/i }));
    expect(await screen.findByRole('button', { name: 'Add visit' })).toBeEnabled();
    await user.click(await screen.findByRole('button', { name: 'Actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Assign/ })).not.toHaveAttribute('aria-disabled', 'true');
  });
});

describe('the files of a locked job on the routed job page (S04.24)', () => {
  const FILE = {
    id: 'att-1', file_name: 'panel.pdf', file_url: 'https://files.test/panel.pdf', file_type: 'application/pdf', display_name: 'Panel sheet',
    source: 'JOB',
  };

  it('draws Delete disabled with the lock\'s reason on the Overview files card and on the Attachments tab', async () => {
    attachmentRows = [{ ...FILE, can_delete: false, can_rename: false, locked_actions: ['delete', 'rename'] }];
    mount({ locked: true, actions: STILL_OPEN, locked_actions: LOCKED_BY_THE_LOCK });
    await screen.findByText('J00001');

    const onCard = await screen.findByRole('button', { name: 'Delete Panel sheet' });
    expect(onCard).toBeDisabled();
    expect(onCard).toHaveAttribute('title', LOCK_REASON);

    await userEvent.setup().click(screen.getByRole('tab', { name: /attachments/i }));
    const onTab = (await screen.findAllByRole('button', { name: 'Delete Panel sheet' })).find((b) => b !== onCard)!;
    expect(onTab).toBeDisabled();
    expect(onTab).toHaveAttribute('title', LOCK_REASON);
  });

  it('draws Delete enabled on a file the person may delete and none on a file they may not', async () => {
    attachmentRows = [
      { ...FILE, can_delete: true, can_rename: false, locked_actions: [] },
      { ...FILE, id: 'att-2', display_name: 'Their sheet', can_delete: false, can_rename: false, locked_actions: [] },
    ];
    mount({ locked: false, actions: [...STILL_OPEN, ...LOCKED_BY_THE_LOCK], locked_actions: [] });
    await screen.findByText('J00001');
    expect(await screen.findByRole('button', { name: 'Delete Panel sheet' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Delete Their sheet' })).toBeNull();
  });
});

describe.each([
  ['OFFICE_REVIEW', 'Move this job back out of review first'],
  ['READY_TO_CLOSE', 'Move this job back out of review first'],
  ['DONE', 'Reopen this job first'],
])('a %s job on the routed job page (S06.4)', (status, newVisitWords) => {
  const closedJob = { status, locked: true, actions: STILL_OPEN, locked_actions: LOCKED_BY_THE_LOCK, new_visit_closed_reason: newVisitWords };

  it('says the lock once and draws the withheld header actions disabled with the lock reason', async () => {
    mount(closedJob);
    await screen.findByText('J00001');
    expect(await screen.findByTestId('job-locked-notice')).toHaveTextContent(LOCK_REASON);

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Actions' }));
    const menu = await screen.findByRole('menu');
    for (const label of ['Assign', 'Reschedule', 'Delete']) {
      const item = within(menu).getByRole('menuitem', { name: new RegExp(label) });
      expect(item, label).toHaveAttribute('aria-disabled', 'true');
      expect(item, label).toHaveTextContent(LOCK_REASON);
    }
  });

  it('draws Add visit disabled with its own words and the existing visits\' controls disabled with the lock reason', async () => {
    mount(closedJob);
    await screen.findByText('J00001');
    await userEvent.setup().click(screen.getByRole('tab', { name: /visits/i }));
    const addVisit = await screen.findByRole('button', { name: 'Add visit' });
    expect(addVisit).toBeDisabled();
    expect(addVisit).toHaveAccessibleDescription(newVisitWords);
    const office = await screen.findByRole('group', { name: 'Office actions' });
    for (const name of ['Reschedule', 'Cancel']) {
      const control = within(office).getByRole('button', { name });
      expect(control, name).toBeDisabled();
      expect(control, name).toHaveAccessibleDescription(LOCK_REASON);
    }
  });

  it('draws Add item disabled with the lock reason and removes the line controls', async () => {
    mount(closedJob);
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Items/i }));
    await screen.findByText('Compressor swap');
    const addItem = screen.getByRole('button', { name: /add item/i });
    expect(addItem).toBeDisabled();
    expect(addItem).toHaveAccessibleDescription(LOCK_REASON);
    expect(screen.queryByRole('button', { name: /remove compressor swap/i })).toBeNull();
  });

  it('keeps the note composer and the file upload for a person with Add notes and Upload attachments', async () => {
    mount(closedJob);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Notes/i }));
    expect(await screen.findByRole('textbox', { name: 'Note' })).toBeEnabled();
    await user.click(screen.getByRole('tab', { name: /attachments/i }));
    expect(await screen.findByRole('button', { name: 'Upload' })).toBeEnabled();
  });
});

// S06.9: while the job is in Office review, an Office review holder who also holds the edit's own switch keeps the lines and
// the discount (the server lists them in `actions`, not in `locked_actions`) and the customer details (`contact_locked`
// false). Details, people and visits stay withheld. The page draws what the server's answer says and judges no status.
describe('a job in Office review for its reviewer, on the routed job page (S06.9)', () => {
  const REVIEW_LOCKED = ['edit', 'assign', 'schedule', 'delete', 'renumber'];
  const reviewerJob = {
    status: 'OFFICE_REVIEW', locked: true, contact_locked: false,
    actions: [...STILL_OPEN, 'edit_line_items', 'apply_discount', 'office_review'], locked_actions: REVIEW_LOCKED,
    new_visit_closed_reason: 'Move this job back out of review first',
  };

  it('leaves Add item and the line controls on the Items tab enabled', async () => {
    mount(reviewerJob);
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Items/i }));
    await screen.findByText('Compressor swap');
    expect(screen.getByRole('button', { name: /add item/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /remove compressor swap/i })).toBeInTheDocument();
  });

  it('keeps the details withheld: Assign, Reschedule and Delete stay disabled with the lock reason', async () => {
    mount(reviewerJob);
    await screen.findByText('J00001');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Actions' }));
    const menu = await screen.findByRole('menu');
    for (const label of ['Assign', 'Reschedule', 'Delete']) {
      const item = within(menu).getByRole('menuitem', { name: new RegExp(label) });
      expect(item, label).toHaveAttribute('aria-disabled', 'true');
      expect(item, label).toHaveTextContent(LOCK_REASON);
    }
  });

  it('draws Delete enabled on a job file the server lists as deletable', async () => {
    attachmentRows = [{
      id: 'att-1', file_name: 'panel.pdf', file_url: 'https://files.test/panel.pdf', file_type: 'application/pdf', display_name: 'Panel sheet',
      source: 'JOB', can_delete: true, can_rename: true, locked_actions: [],
    }];
    mount(reviewerJob);
    await screen.findByText('J00001');
    expect(await screen.findByRole('button', { name: 'Delete Panel sheet' })).toBeEnabled();
  });

  it('is the same job withheld for a person without Office review: the lines go back to disabled', async () => {
    mount({ ...reviewerJob, contact_locked: true, actions: STILL_OPEN, locked_actions: [...REVIEW_LOCKED, 'edit_line_items', 'apply_discount'] });
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Items/i }));
    await screen.findByText('Compressor swap');
    expect(screen.getByRole('button', { name: /add item/i })).toBeDisabled();
  });
});
