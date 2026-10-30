// Payments go-live slice 17 (#891) - CancelJobDialog asks before touching paid invoices.
//
// Contract under test:
//   - The first Cancel Job click sends the reason only. When the API answers 409
//     JOB_CANCEL_HAS_PAYMENTS, the dialog lists the affected invoices and offers the explicit
//     choices instead of showing a bare error. Nothing is sent again until a choice is made.
//   - An invoice with payments, a fully PAID one included, is listed as kept with what was paid,
//     and the dialog says a refund is a separate step. Choosing still lets the cancel go ahead.
//   - "Keep the invoices" re-sends the cancel with void_invoices: false.
//   - "Void the unpaid invoices" (offered only when an unpaid invoice is listed) re-sends it with
//     void_invoices: true.
//
// `api` is globally mocked (setup.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { CancelJobDialog } from '@/components/jobs/CancelJobDialog';

const mockApi = vi.mocked(api);

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

function conflict(invoices: unknown[]) {
  return Object.assign(new Error('Request failed with status code 409'), {
    isAxiosError: true,
    response: {
      status: 409,
      data: {
        error: 'Invoice I00412 on this job has payments.',
        code: 'JOB_CANCEL_HAS_PAYMENTS',
        invoices,
      },
    },
  });
}

const REASONS = [
  { code: 'PRICE', label: 'Price', is_active: true, sort_order: 0, is_builtin: true },
  { code: 'OTHER', label: 'Other', is_active: true, sort_order: 1, is_builtin: true },
];

const PAID = { id: 'inv-1', invoice_number: 'I00412', status: 'PARTIAL', has_payments: true, amount_paid: 3000, amount_due: 5400 };
const UNPAID = { id: 'inv-2', invoice_number: 'I00413', status: 'SENT', has_payments: false, amount_paid: 0, amount_due: 900 };

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks leaves queued *Once values in place; drain them so no test feeds the next.
  mockApi.post.mockReset();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    // S06.15: the company's cancel reasons, the list the dialog's required picker offers.
    if (url === '/api/job-cancel-reasons') return { data: { job_cancel_reasons: REASONS } };
    return { data: { data: [], page: 1, limit: 50, total: 0 } };
  });
});

function render() {
  return renderWithProviders(<CancelJobDialog open onOpenChange={vi.fn()} jobId={JOB_ID} />);
}

async function submitReason() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('combobox', { name: /Reason/ }));
  await user.click(await screen.findByRole('option', { name: 'Other' }));
  fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'Customer called off' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Job' }));
}

describe('CancelJobDialog - invoices with payments (#891)', () => {
  it('has no "Choose why" subtitle under the title', async () => {
    render();
    expect(await screen.findByRole('heading', { name: 'Cancel Job' })).toBeInTheDocument();
    expect(screen.queryByText(/Choose why this job/)).not.toBeInTheDocument();
  });

  it('lists the affected invoices and offers the choices when the cancel hits paid invoices', async () => {
    mockApi.post.mockRejectedValueOnce(conflict([PAID, UNPAID]));
    render();

    await submitReason();

    expect(await screen.findByText('I00412')).toBeInTheDocument();
    expect(screen.getByText('I00413')).toBeInTheDocument();
    expect(screen.getByText('$3,000.00 paid · kept')).toBeInTheDocument();
    expect(screen.getByText('$900.00 due')).toBeInTheDocument();
    // W3: two outcomes exist, so both radios show with the safe one (keep) preselected.
    expect(screen.getByRole('radio', { name: /Keep the invoices/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Void the unpaid invoices/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Cancel Job' })).toBeEnabled();
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.post).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/cancel`, {
      cancel_reason_code: 'OTHER',
      cancelled_reason: 'Customer called off',
    });
  });

  it('lists a fully PAID invoice as kept with its paid amount, says a refund is separate, and still cancels', async () => {
    const onOpenChange = vi.fn();
    const FULLY_PAID = { id: 'inv-9', invoice_number: 'I00419', status: 'PAID', has_payments: true, amount_paid: 8400, amount_due: 0 };
    mockApi.post.mockRejectedValueOnce(conflict([FULLY_PAID]));
    mockApi.post.mockResolvedValueOnce({ data: { job: { id: JOB_ID, status: 'CANCELLED' }, voided_invoice_ids: [] } });
    renderWithProviders(<CancelJobDialog open onOpenChange={onOpenChange} jobId={JOB_ID} />);

    await submitReason();

    expect(await screen.findByText('I00419')).toBeInTheDocument();
    expect(screen.getByText('$8,400.00 paid · kept')).toBeInTheDocument();
    // W3: nothing unpaid to void, so there is no choice: a plain sentence and an enabled button.
    expect(screen.getByText('The invoice stays as it is. Refund it separately.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByText(/always kept as it is/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel Job' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel Job' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
    expect(mockApi.post).toHaveBeenLastCalledWith(`/api/jobs/${JOB_ID}/cancel`, {
      cancel_reason_code: 'OTHER',
      cancelled_reason: 'Customer called off',
      void_invoices: false,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('re-sends the cancel with void_invoices: true when the user voids the unpaid invoices', async () => {
    mockApi.post.mockRejectedValueOnce(conflict([PAID, UNPAID]));
    mockApi.post.mockResolvedValueOnce({ data: { job: { id: JOB_ID, status: 'CANCELLED' }, voided_invoice_ids: ['inv-2'] } });
    render();

    await submitReason();
    fireEvent.click(await screen.findByRole('radio', { name: /Void the unpaid invoices/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Job' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
    expect(mockApi.post).toHaveBeenLastCalledWith(`/api/jobs/${JOB_ID}/cancel`, {
      cancel_reason_code: 'OTHER',
      cancelled_reason: 'Customer called off',
      void_invoices: true,
    });
  });

  it('re-sends the cancel with void_invoices: false once the user chooses to keep the invoices', async () => {
    const onOpenChange = vi.fn();
    mockApi.post.mockRejectedValueOnce(conflict([PAID, UNPAID]));
    mockApi.post.mockResolvedValueOnce({ data: { job: { id: JOB_ID, status: 'CANCELLED' }, voided_invoice_ids: [] } });
    renderWithProviders(<CancelJobDialog open onOpenChange={onOpenChange} jobId={JOB_ID} />);

    await submitReason();
    fireEvent.click(await screen.findByRole('radio', { name: /Keep the invoices/ }));
    const cancelButton = screen.getByRole('button', { name: 'Cancel Job' });
    expect(cancelButton).toBeEnabled();
    fireEvent.click(cancelButton);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
    expect(mockApi.post).toHaveBeenLastCalledWith(`/api/jobs/${JOB_ID}/cancel`, {
      cancel_reason_code: 'OTHER',
      cancelled_reason: 'Customer called off',
      void_invoices: false,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('forgets the conflict and the choice when the same dialog moves to another job', async () => {
    // SchedulePage mounts ONE CancelJobDialog and switches its jobId between jobs.
    const OTHER_JOB = 'j0000000-0000-0000-0000-000000000002';
    mockApi.post.mockRejectedValueOnce(conflict([PAID]));
    mockApi.post.mockResolvedValueOnce({ data: { job: { id: OTHER_JOB, status: 'CANCELLED' }, voided_invoice_ids: [] } });
    const { rerender } = renderWithProviders(<CancelJobDialog open onOpenChange={vi.fn()} jobId={JOB_ID} />);
    await submitReason();
    await screen.findByText('I00412');

    rerender(<CancelJobDialog open onOpenChange={vi.fn()} jobId={OTHER_JOB} />);

    expect(screen.queryByText('I00412')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    await submitReason();
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
    // No choice was made for this job, so none is sent.
    expect(mockApi.post).toHaveBeenLastCalledWith(`/api/jobs/${OTHER_JOB}/cancel`, {
      cancel_reason_code: 'OTHER',
      cancelled_reason: 'Customer called off',
    });
  });

  it('forgets the conflict and the choice when the dialog is closed and reopened', async () => {
    mockApi.post.mockRejectedValueOnce(conflict([PAID]));
    const { rerender } = renderWithProviders(<CancelJobDialog open onOpenChange={vi.fn()} jobId={JOB_ID} />);
    await submitReason();
    await screen.findByText('I00412');

    rerender(<CancelJobDialog open={false} onOpenChange={vi.fn()} jobId={JOB_ID} />);
    rerender(<CancelJobDialog open onOpenChange={vi.fn()} jobId={JOB_ID} />);

    expect(await screen.findByLabelText('Note (optional)')).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /Reason/ })).toHaveTextContent('Why is this job being cancelled?');
    expect(screen.queryByText('I00412')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('shows money still processing apart from money paid, and never as paid', async () => {
    mockApi.post.mockRejectedValueOnce(conflict([
      { ...PAID, amount_paid: 1000, amount_processing: 3000 },
      { ...PAID, id: 'inv-3', invoice_number: 'I00414', amount_paid: 0, amount_processing: 250 },
    ]));
    render();

    await submitReason();

    expect(await screen.findByText('$1,000.00 paid · $3,000.00 processing · kept')).toBeInTheDocument();
    expect(screen.getByText('$250.00 processing · kept')).toBeInTheDocument();
    expect(screen.queryByText('$0.00 paid')).not.toBeInTheDocument();
  });

  it('shows a payments marker instead of amounts when the API withholds money figures', async () => {
    mockApi.post.mockRejectedValueOnce(
      conflict([{ id: 'inv-1', invoice_number: 'I00412', status: 'PARTIAL', has_payments: true }]),
    );
    render();

    await submitReason();

    expect(await screen.findByText('Has payments · kept')).toBeInTheDocument();
    expect(screen.queryByText(/\$[\d,]+\.\d\d/)).not.toBeInTheDocument();
  });

  it('keeps showing an ordinary error for any other refusal', async () => {
    mockApi.post.mockRejectedValueOnce(
      Object.assign(new Error('x'), { response: { status: 500, data: { error: 'Failed to cancel job' } } }),
    );
    render();

    await submitReason();

    expect(await screen.findByText('Failed to cancel job')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });
});
