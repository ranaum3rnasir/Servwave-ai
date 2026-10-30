/**
 * Payments go-live slice 28b - Record Payment while a bank debit is processing. The dialog works
 * from payable-now (balance due less the bank money still clearing): it says so, starts at that
 * figure, and does not let staff record more than it. The server refuses the same (409).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';

const post = vi.fn();
vi.mock('@/lib/axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }));

const renderDialog = (props = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecordPaymentDialog
        open onOpenChange={vi.fn()} invoiceId="inv-1" invoiceNumber="I00001"
        amountDue={500} onSuccess={vi.fn()} {...props}
      />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  post.mockReset().mockResolvedValue({ data: {} });
});

describe('RecordPaymentDialog - a bank payment is processing', () => {
  it('names the processing amount and what can be recorded now', async () => {
    renderDialog({ processingAmount: 200 });

    expect(await screen.findByTestId('record-payment-processing')).toHaveTextContent(
      'A bank payment of $200.00 is still processing. You can record up to $300.00 now.',
    );
  });

  it('starts at payable-now, not at the whole balance', async () => {
    renderDialog({ processingAmount: 200 });
    expect(await screen.findByLabelText(/amount/i)).toHaveValue('300');
  });

  it('records nothing when the debit in flight covers the whole balance', async () => {
    renderDialog({ processingAmount: 500 });
    expect(await screen.findByRole('button', { name: 'Record Payment' })).toBeDisabled();
  });

  it('cannot record more than payable-now, and says why', async () => {
    const user = userEvent.setup();
    renderDialog({ processingAmount: 200 });
    const amount = await screen.findByLabelText(/amount/i);
    await user.clear(amount);
    await user.type(amount, '450');

    expect(screen.getByTestId('record-payment-processing-over')).toHaveTextContent('up to $300.00');
    expect(screen.getByRole('button', { name: 'Record Payment' })).toBeDisabled();
  });

  it('shows nothing extra when no bank payment is processing', async () => {
    renderDialog();
    await screen.findByLabelText(/amount/i);
    expect(screen.queryByTestId('record-payment-processing')).not.toBeInTheDocument();
  });
});
