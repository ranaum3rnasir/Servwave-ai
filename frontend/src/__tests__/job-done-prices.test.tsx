import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JOB_ID, mountJobDetail, stubBrowser } from './harness/jobDetailPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
vi.mock('react-router-dom', async () => (await import('./harness/jobDetailRouter')).jobDetailRouter());

stubBrowser();

/** The PRD's own wording, written out here rather than imported from the page. */
const DONE_REASON = 'This job is Done. Reopen it to change its lines or prices.';

// Everything is allowed to this person by role: only the job's own answer decides what the page draws.

const LINE = {
  id: 'line-1', job_id: JOB_ID, sequence: 1, description: 'Compressor swap', quantity: 1, unit_price: 300, unit_cost: 200,
  markup_percent: null, is_taxable: true, line_total: 300, discount_type: null, discount_value: null, discount_amount: 0,
  item_type: 'SERVICE', price_book_item_id: null,
};
const SCOPE = { id: 'scope-1', title: 'Haul away', body: '', flat_price: 50, is_taxable: true, internal_cost: null };

function mountJob(over: Record<string, unknown> = {}) {
  return mountJobDetail({
    job: {
      job_number: 'J00019', status: 'DONE', completed_at: '2026-10-03T00:00:00.000Z', closed_at: '2026-10-04T00:00:00.000Z',
      // A Change locked jobs holder: the lock does not bind them, and the Done rule still does.
      locked: false, locked_actions: ['edit_line_items', 'apply_discount'],
      actions: ['add_note', 'upload_attachment', 'create_invoice', 'duplicate'],
      price_edit_closed_reason: DONE_REASON,
      new_visit_closed_reason: 'Reopen this job first', status_door_closed_reason: 'Reopen this job first', ready_to_close: null,
      ...over,
    },
    scopes: [SCOPE], lines: [LINE], billing: { total: 350, invoiced: 0, remaining: 350 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubBrowser();
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
