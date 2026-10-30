// Payments go-live slice 18 - voiding an invoice that carries payments is refused, and the void
// action says why.
//
// Contract under test:
//   - When the API answers 409 INVOICE_HAS_PAYMENTS, the dialog shows the server's reason
//     verbatim, stays open, and reports no success.
//   - The refusal belongs to that attempt: closing the dialog and opening it again starts clean,
//     with neither the refusal nor the reason typed.
//
// `api` is globally mocked (setup.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { VoidInvoiceDialog } from '@/components/invoices/VoidInvoiceDialog';

const mockApi = vi.mocked(api);

const INVOICE_ID = 'i0000000-0000-0000-0000-000000000018';
const HAS_PAYMENTS = 'This invoice has payments. Void or refund them first.';

const refusal = () =>
  Object.assign(new Error('Request failed with status code 409'), {
    isAxiosError: true,
    response: { status: 409, data: { error: HAS_PAYMENTS, code: 'INVOICE_HAS_PAYMENTS' } },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockReset();
});

function dialog(props: { open: boolean; onOpenChange?: (open: boolean) => void; onSuccess?: () => void }) {
  return (
    <VoidInvoiceDialog
      open={props.open}
      onOpenChange={props.onOpenChange ?? vi.fn()}
      invoiceId={INVOICE_ID}
      invoiceNumber="I00418"
      onSuccess={props.onSuccess ?? vi.fn()}
    />
  );
}

async function submitReason() {
  fireEvent.change(await screen.findByPlaceholderText('Why is this invoice being voided?'), {
    target: { value: 'Sent in error' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Void Invoice' }));
}

describe('VoidInvoiceDialog - an invoice with payments', () => {
  it('has no subtitle, keeps the cannot-be-undone box and the required reason', () => {
    renderWithProviders(dialog({ open: true }));
    expect(screen.queryByText(/Please provide a reason/)).not.toBeInTheDocument();
    expect(screen.getByText(/This action cannot be undone/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Void Invoice' })).toBeDisabled();
  });

  // One attempt, end to end: the refusal is shown with the server's reason while the dialog stays
  // open (no success reported), and it is gone once the dialog is closed and opened again. The
  // second half is what this slice adds; the first half pins the message the slice relies on.
  it('shows the refusal reason, stays open, and forgets the refusal once closed and opened again', async () => {
    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    mockApi.post.mockRejectedValueOnce(refusal());
    const { rerender } = renderWithProviders(dialog({ open: true, onOpenChange, onSuccess }));

    await submitReason();

    expect(await screen.findByText(HAS_PAYMENTS)).toBeInTheDocument();
    expect(mockApi.post).toHaveBeenCalledWith(`/api/invoices/${INVOICE_ID}/void`, { voided_reason: 'Sent in error' });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(dialog({ open: false, onOpenChange, onSuccess }));
    rerender(dialog({ open: true, onOpenChange, onSuccess }));

    expect(await screen.findByPlaceholderText('Why is this invoice being voided?')).toHaveValue('');
    await waitFor(() => expect(screen.queryByText(HAS_PAYMENTS)).not.toBeInTheDocument());
  });
});
