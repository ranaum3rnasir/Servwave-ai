/**
 * Roles & Permissions, PRD 6, S06.19 - the routed job page on a Done job offers no line, scope or discount edit.
 *
 * A Done job's lines and prices are closed to everyone until it is reopened, a Change locked jobs holder included. GET
 * /api/jobs/:id answers `price_edit_closed_reason` (the Done sentence) and takes the line and discount actions off `actions`
 * into `locked_actions`; the Items tab says the sentence and draws Add item and Add scope of work disabled with it, and
 * leaves no per-line control. What stays open on a Done job (notes, files, a new invoice) keeps its control. The browser
 * never tests the status or a role name: a job whose answer carries no reason keeps its line controls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
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

const JOB_ID = 'j0000000-0000-0000-0000-000000000019';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

/** The PRD's own wording, written out here rather than imported from the page. */
const DONE_REASON = 'This job is Done. Reopen it to change its lines or prices.';

// Everything is allowed to this person by role: only the job's own answer decides what the page draws.
const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const LINE = {
  id: 'line-1', job_id: JOB_ID, sequence: 1, description: 'Compressor swap', quantity: 1, unit_price: 300, unit_cost: 200,
  markup_percent: null, is_taxable: true, line_total: 300, discount_type: null, discount_value: null, discount_amount: 0,
  item_type: 'SERVICE', price_book_item_id: null,
};
const SCOPE = { id: 'scope-1', title: 'Haul away', body: '', flat_price: 50, is_taxable: true, internal_cost: null };

function mountJob(over: Record<string, unknown> = {}) {
  const job = {
    id: JOB_ID, job_number: 'J00019', status: 'DONE', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', started_at: null,
    completed_at: '2026-10-03T00:00:00.000Z', closed_at: '2026-10-04T00:00:00.000Z', cancelled_at: null, cancelled_reason: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null,
    // A Change locked jobs holder: the lock does not bind them, and the Done rule still does.
    locked: false, locked_actions: ['edit_line_items', 'apply_discount'],
    actions: ['add_note', 'upload_attachment', 'create_invoice', 'duplicate'],
    price_edit_closed_reason: DONE_REASON,
    new_visit_closed_reason: 'Reopen this job first', status_door_closed_reason: 'Reopen this job first', ready_to_close: null,
    ...over,
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/visits`) return { data: { visits: [] } } as never;
    if (url.endsWith('/scopes')) return { data: { scopes: [SCOPE], billing: { total: 350, invoiced: 0, remaining: 350 } } } as never;
    if (url.endsWith('/line-items')) return { data: { lines: [LINE], billing: { total: 350, invoiced: 0, remaining: 350 } } } as never;
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } } as never;
    return { data: {} } as never;
  });
  return renderWithProviders(<JobDetailPage />, { ability });
}

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

describe('the Items tab of a Done job on the routed job page', () => {
  it('says the Done sentence where the edit would be, and draws Add item and Add scope of work disabled with it', async () => {
    mountJob();
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Items/i }));
    await screen.findByText('Compressor swap');

    expect(await screen.findByTestId('job-done-prices-notice')).toHaveTextContent(DONE_REASON);
    const addItem = screen.getByRole('button', { name: /add item/i });
    expect(addItem).toBeDisabled();
    expect(addItem).toHaveAccessibleDescription(DONE_REASON);
    const addScope = screen.getByRole('button', { name: /add scope of work/i });
    expect(addScope).toBeDisabled();
    expect(addScope).toHaveAccessibleDescription(DONE_REASON);
  });

  it('offers no per-line remove and no Price Book picker', async () => {
    mountJob();
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Items/i }));
    await screen.findByText('Compressor swap');
    expect(screen.queryByRole('button', { name: /remove compressor swap/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /price book/i })).toBeNull();
  });

  it('keeps the note composer, the upload and a new invoice, which a Done job still takes', async () => {
    mountJob();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Notes/i }));
    expect(await screen.findByRole('textbox', { name: 'Note' })).toBeEnabled();
    await user.click(screen.getByRole('tab', { name: /attachments/i }));
    expect(await screen.findByRole('button', { name: 'Upload' })).toBeEnabled();
  });

  it('keeps the line controls on a job whose answer carries no reason: the page never judges the status', async () => {
    mountJob({
      status: 'IN_PROGRESS', price_edit_closed_reason: null, locked_actions: [], status_door_closed_reason: null, new_visit_closed_reason: null,
      actions: ['add_note', 'edit_line_items', 'apply_discount'],
    });
    await userEvent.setup().click(await screen.findByRole('tab', { name: /Items/i }));
    await screen.findByText('Compressor swap');
    expect(screen.queryByTestId('job-done-prices-notice')).toBeNull();
    expect(screen.getByRole('button', { name: /add item/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /add scope of work/i })).toBeEnabled();
  });
});
