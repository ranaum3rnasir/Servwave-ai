/**
 * Roles & Permissions S04.25 - the delete control on a note follows the server's per-note answer (`can_delete`,
 * `locked_actions`) on every surface that lists a job's or a lead's notes, and on none that lists another record's:
 *
 *   - the routed job page: the Overview notes card, the Notes tab, and the Activity panel in its side rail,
 *   - the lead page's Activity panel (src/pages/v2/leads/__tests__/leadNoteDelete.test.tsx),
 *   - the invoice page's Activity panel, whose notes are out of scope and carry no answer.
 *
 * A control shows only on a note the person may delete. On a locked job it shows disabled with the lock's reason, the
 * originating lead's notes shown on the job page carry no delete at all, and a confirmed delete calls the record's own
 * route and refreshes the notes and the activity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

/** The PRD's own wording, written out here rather than imported from the page. */
const LOCK_REASON = 'This job is locked. Only someone who can change locked jobs can change it.';

const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const note = (id: string, first: string, answer: Record<string, unknown>) => ({
  id, content: `Text of ${id}`, created_at: '2026-08-10T12:00:00.000Z',
  creator: { id: `u-${id}`, first_name: first, last_name: 'Tester' }, ...answer,
});

/** Mine: deletable. Theirs: not. Held: deletable (a switch holder's). Locked: the lock alone stops it. Lead: the lead's, shown on the job. */
const MINE = note('mine', 'Mia', { can_delete: true, locked_actions: [] });
const THEIRS = note('theirs', 'Theo', { can_delete: false, locked_actions: [] });
const LOCKED = note('locked', 'Lena', { can_delete: false, locked_actions: ['delete'] });
const FROM_LEAD = note('lead', 'Lou', { source: 'LEAD', can_delete: false, locked_actions: [] });

let noteRows: unknown[] = [];
let timelineRows: unknown[] = [];

function mount(overrides: Record<string, unknown> = {}) {
  const job = {
    id: JOB_ID, job_number: 'J00001', status: 'IN_PROGRESS', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-08-21T13:00:00.000Z', scheduled_end: '2026-08-21T15:00:00.000Z', started_at: null,
    completed_at: null, cancelled_at: null, cancelled_reason: null,
    created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null, actions: ['add_note'], locked: false, locked_actions: [],
    ...overrides,
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.startsWith(`/api/jobs/${JOB_ID}/notes`)) return { data: { notes: noteRows } } as never;
    if (url === `/api/jobs/${JOB_ID}/timeline`) return { data: { events: timelineRows } } as never;
    if (url === `/api/jobs/${JOB_ID}/visits`) return { data: { visits: [] } } as never;
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.startsWith('/api/attachments/')) return { data: { attachments: [] } } as never;
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } } as never;
    return { data: {} } as never;
  });
  return renderWithProviders(<JobDetailPage />, { ability });
}

beforeEach(() => {
  vi.clearAllMocks();
  noteRows = [];
  timelineRows = [];
});

const del = (author: string) => screen.queryByRole('button', { name: `Delete note by ${author} Tester` });

describe.each([
  ['the job\'s Overview notes card', async () => { await screen.findByText('Job Notes'); }],
  ['the job\'s Notes tab', async () => { await userEvent.setup().click(await screen.findByRole('tab', { name: /Notes/i })); }],
])('%s', (_name, open) => {
  it('draws Delete on a note the person may delete and on no other', async () => {
    noteRows = [MINE, THEIRS];
    mount();
    await open();
    await screen.findByText('Text of mine');
    expect(del('Mia')).toBeEnabled();
    expect(screen.getByText('Text of theirs')).toBeInTheDocument();
    expect(del('Theo')).not.toBeInTheDocument();
  });

  it('draws Delete disabled with the lock\'s reason when the lock alone stops the person', async () => {
    noteRows = [LOCKED];
    mount({ status: 'COMPLETED', locked: true });
    await open();
    await screen.findByText('Text of locked');
    const trash = del('Lena')!;
    expect(trash).toBeDisabled();
    expect(trash).toHaveAccessibleDescription(LOCK_REASON);
  });

  it('offers no delete on a note forwarded from the lead, locked or not', async () => {
    noteRows = [FROM_LEAD];
    mount({ status: 'COMPLETED', locked: true });
    await open();
    await screen.findByText('Text of lead');
    expect(del('Lou')).not.toBeInTheDocument();
  });

  it('asks first, then deletes through the job\'s own route and refreshes the notes', async () => {
    noteRows = [MINE];
    mount();
    await open();
    await screen.findByText('Text of mine');
    const user = userEvent.setup();
    await user.click(del('Mia')!);
    expect(mockApi.delete).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/delete this note/i);
    noteRows = [];
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/notes/mine`));
    await waitFor(() => expect(screen.queryByText('Text of mine')).not.toBeInTheDocument());
  });

  it('leaves the note alone when the person backs out of the question', async () => {
    noteRows = [MINE];
    mount();
    await open();
    await screen.findByText('Text of mine');
    const user = userEvent.setup();
    await user.click(del('Mia')!);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(mockApi.delete).not.toHaveBeenCalled();
    expect(screen.getByText('Text of mine')).toBeInTheDocument();
  });
});

describe('the job page\'s Activity panel', () => {
  const openActivity = async () => {
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Activity' }));
    return within(await screen.findByTestId('icon-rail-panel'));
  };

  it('draws Delete from the same per-note answer, and lists the "note deleted" entry with its text', async () => {
    noteRows = [MINE, THEIRS, LOCKED];
    timelineRows = [{
      id: 'ev-1', event_type: 'NOTE_DELETED', created_at: '2026-08-11T12:00:00.000Z', metadata: null,
      description: 'Note deleted: Gate code 4417 (written by Uma Tester, deleted by Dan Tester)',
      creator: { id: 'u-dan', first_name: 'Dan', last_name: 'Tester' },
    }];
    mount();
    const panel = await openActivity();
    await panel.findByText('Text of mine');
    const trash = (author: string) => panel.queryByRole('button', { name: `Delete note by ${author} Tester` });
    expect(trash('Mia')).toBeEnabled();
    expect(trash('Theo')).not.toBeInTheDocument();
    expect(trash('Lena')).toBeDisabled();
    expect(trash('Lena')).toHaveAccessibleDescription(LOCK_REASON);
    expect(await panel.findByText(/Note deleted: Gate code 4417/)).toBeInTheDocument();
  });

  it('calls the job\'s route and refreshes the activity after a confirmed delete', async () => {
    noteRows = [MINE];
    mount();
    const panel = await openActivity();
    await panel.findByText('Text of mine');
    const user = userEvent.setup();
    await user.click(panel.getByRole('button', { name: 'Delete note by Mia Tester' }));
    noteRows = [];
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/notes/mine`));
    await waitFor(() => expect(panel.queryByText('Text of mine')).not.toBeInTheDocument());
  });
});

describe('the invoice page\'s Activity panel', () => {
  it('offers no delete on invoice notes: they are out of scope and carry no answer', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: [note('inv', 'Ina', {})] } } as never;
      return { data: { events: [] } } as never;
    });
    renderWithProviders(<ActivityPanel entityType="INVOICE" entityId="inv-1" />);
    await screen.findByText('Text of inv');
    expect(del('Ina')).not.toBeInTheDocument();
  });
});
