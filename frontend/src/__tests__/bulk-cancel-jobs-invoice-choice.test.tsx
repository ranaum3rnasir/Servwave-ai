// Payments go-live slice 17 (#891) - the bulk cancel asks what happens to the jobs' open invoices.
//
// Contract under test (the routed v2 jobs list bulk bar):
//   - Cancel 2 jobs stays disabled until a reason AND an invoice choice are given. Nothing is
//     pre-selected: a default would be the same silent decision the single-job dialog refuses.
//   - "Keep the invoices" sends void_invoices: false; "Void the unpaid invoices" sends void_invoices: true.
//   - The copy never promises that open invoices will be voided: an invoice with payments never is.
//   - Before confirming, the dialog lists every invoice carrying money on the selected jobs, PAID
//     included, as kept with what was paid, and says a refund is a separate step.
//   - Each opening of the dialog starts with no choice.
//
// `api` is globally mocked (setup.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import { BulkBar } from '@/pages/v2/jobs/components/bulkBar';

// floating-ui (under the Radix menus) constructs a ResizeObserver; the global setup mock is not
// constructable.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const post = vi.mocked(api.post);
const get = vi.mocked(api.get);
const SELECTED = ['j0000000-0000-0000-0000-000000000001', 'j0000000-0000-0000-0000-000000000002'];

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { updated: SELECTED, failed: [], voided_invoice_ids: [] } });
  get.mockImplementation(async (url: string) => (
    url === '/api/job-cancel-reasons'
      ? { data: { job_cancel_reasons: [{ code: 'PRICE', label: 'Price', is_active: true, sort_order: 0, is_builtin: true }] } }
      : { data: { invoices: [] } }
  ));
});

function renderBulkBar(selected: string[] = SELECTED) {
  return renderWithProviders(
    <BulkBar selectedJobIds={selected} onClear={() => {}} assignees={[]} />,
    { ability: buildAbility([{ action: 'manage', subject: 'all' }]) },
  );
}

async function openCancelDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Change status' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Cancelled' }));
  await user.click(await screen.findByRole('combobox', { name: /Reason/ }));
  await user.click(await screen.findByRole('option', { name: 'Price' }));
  await user.type(screen.getByLabelText('Note (optional)'), 'Season over');
}

describe('Bulk cancel - the open-invoice choice (#891)', () => {
  it('needs an invoice choice, and sends void_invoices: false when the user keeps the invoices', async () => {
    const user = userEvent.setup();
    renderBulkBar();
    await openCancelDialog(user);

    // The button is drawn again when its reason goes, so it is looked up each time.
    const confirm = () => screen.getByRole('button', { name: 'Cancel 2 jobs' });
    expect(screen.getByRole('radio', { name: /Keep the invoices/ })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: /Void the unpaid invoices/ })).not.toBeChecked();
    expect(confirm()).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /Keep the invoices/ }));
    expect(confirm()).toBeEnabled();
    await user.click(confirm());

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/jobs/bulk-status', {
        ids: SELECTED,
        action: 'cancel',
        cancel_reason_code: 'PRICE',
        cancelled_reason: 'Season over',
        void_invoices: false,
      }),
    );
  });

  it('sends void_invoices: true when the user chooses to void the invoices', async () => {
    const user = userEvent.setup();
    renderBulkBar();
    await openCancelDialog(user);

    await user.click(screen.getByRole('radio', { name: /Void the unpaid invoices/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel 2 jobs' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/jobs/bulk-status', expect.objectContaining({ void_invoices: true })),
    );
  });

  it('says an invoice with payments is never voided, instead of promising every open invoice is', async () => {
    const user = userEvent.setup();
    renderBulkBar();
    await openCancelDialog(user);

    expect(screen.queryByText(/Open invoices on these jobs will be voided/)).not.toBeInTheDocument();
    expect(screen.getByText(/An invoice with payments is never voided/)).toBeInTheDocument();
  });

  it('starts every opening with no choice made', async () => {
    const user = userEvent.setup();
    renderBulkBar();
    await openCancelDialog(user);
    await user.click(screen.getByRole('radio', { name: /Keep the invoices/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel 2 jobs' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    await openCancelDialog(user);

    expect(screen.getByRole('radio', { name: /Keep the invoices/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Cancel 2 jobs' })).toBeDisabled();
  });

  it('lists a PAID invoice on a selected job as kept with its paid amount, before the user confirms', async () => {
    get.mockImplementation(async (url: string) => (
      url === '/api/job-cancel-reasons'
        ? { data: { job_cancel_reasons: [{ code: 'PRICE', label: 'Price', is_active: true, sort_order: 0, is_builtin: true }] } }
        : { data: { invoices: [{ job_id: SELECTED[0], job_number: 'J-1001', id: 'inv-9', invoice_number: 'I00419', status: 'PAID', amount_paid: 8400 }] } }
    ));
    const user = userEvent.setup();
    renderBulkBar();
    await openCancelDialog(user);

    expect(await screen.findByText('I00419')).toBeInTheDocument();
    expect(screen.getByText('$8,400.00 paid · kept')).toBeInTheDocument();
    expect(screen.getByText(/A refund is a separate step/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/jobs/cancel-preview', { params: { ids: SELECTED.join(',') } });

    // Choosing still lets the cancel go ahead.
    await user.click(screen.getByRole('radio', { name: /Void the unpaid invoices/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel 2 jobs' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/jobs/bulk-status', expect.objectContaining({ void_invoices: true })),
    );
  });

  it('words the reason prompt and the confirm button for the number of jobs picked', async () => {
    const user = userEvent.setup();
    renderBulkBar();
    await user.click(screen.getByRole('button', { name: 'Change status' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancelled' }));

    expect(await screen.findByRole('combobox', { name: /Reason/ })).toHaveTextContent('Why are these jobs being cancelled?');
    expect(screen.getByRole('button', { name: 'Cancel 2 jobs' })).toBeInTheDocument();
  });

  it('keeps the singular words for one job', async () => {
    const user = userEvent.setup();
    renderBulkBar([SELECTED[0]!]);
    await user.click(screen.getByRole('button', { name: 'Change status' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancelled' }));

    expect(await screen.findByRole('combobox', { name: /Reason/ })).toHaveTextContent('Why is this job being cancelled?');
    expect(screen.getByRole('button', { name: 'Cancel Job' })).toBeInTheDocument();
  });

  it('says why Confirm waits: first the reason, then the open-invoice choice', async () => {
    const user = userEvent.setup();
    renderBulkBar();
    await user.click(screen.getByRole('button', { name: 'Change status' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancelled' }));
    const confirm = () => screen.getByRole('button', { name: 'Cancel 2 jobs' });
    await screen.findByRole('button', { name: 'Cancel 2 jobs' });
    expect(confirm()).toBeDisabled();
    expect(confirm()).toHaveAccessibleDescription('Choose a reason');

    await user.click(await screen.findByRole('combobox', { name: /Reason/ }));
    await user.click(await screen.findByRole('option', { name: 'Price' }));
    expect(confirm()).toBeDisabled();
    expect(confirm()).toHaveAccessibleDescription('Choose what happens to the open invoices');

    await user.click(screen.getByRole('radio', { name: /Keep the invoices/ }));
    expect(confirm()).toBeEnabled();
    expect(confirm()).not.toHaveAccessibleDescription('Choose what happens to the open invoices');
  });
});
