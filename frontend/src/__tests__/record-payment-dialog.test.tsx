import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';
import { DEFAULT_SCHEDULE_TIMEZONE } from '@/lib/schedule-tz';

const createJobInvoice = vi.fn();
vi.mock('@/lib/api/jobs', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/jobs')>()),
  createJobInvoice: (...a: unknown[]) => createJobInvoice(...a),
}));
const post = vi.fn();
vi.mock('@/lib/axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }));

const renderDialog = (props = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecordPaymentDialog
        open onOpenChange={vi.fn()} invoiceId="inv-1" invoiceNumber="I00001"
        amountDue={900} onSuccess={vi.fn()} {...props}
      />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  createJobInvoice.mockReset().mockResolvedValue({ invoice: { id: 'inv-new', invoice_number: 'I00031' } });
  post.mockReset().mockResolvedValue({ data: {} });
});

describe('RecordPaymentDialog', () => {
  it('defaults the amount to the invoice balance', async () => {
    renderDialog();
    expect(await screen.findByLabelText(/amount/i)).toHaveValue('900');
  });

  it('offers every payment method the API accepts (R5b shared list)', async () => {
    renderDialog();
    // Radix Select only mounts its listbox once opened — open it before querying options.
    await userEvent.click(await screen.findByRole('combobox'));
    // getByText would throw here — "Credit Card" and "Card (outside ServWave)" both
    // match /card/i. Query by option role and exact name instead.
    for (const label of [
      'Cash', 'Check', 'Credit Card', 'Card (outside ServWave)',
      'Bank transfer', 'Zelle', 'Venmo', 'Cash App', 'Other',
    ]) {
      expect(await screen.findByRole('option', { name: label })).toBeInTheDocument();
    }
    // The processor behind card payments is never named to the user (Ran, 2026-08-04).
    expect(screen.queryByText(/stripe/i)).not.toBeInTheDocument();
  });

  // V7-12: a hand-recorded payment can never be larger than the balance due. No tick-box, no
  // warning box: the Amount field says what is wrong and how to fix it, and the button stays off.
  describe('no overpaid invoices (V7-12)', () => {
    const recordButton = () => screen.getByRole('button', { name: /record payment/i });

    it('has no tick-box and no warning for any amount', async () => {
      renderDialog();
      const input = await screen.findByLabelText(/amount/i);
      await userEvent.clear(input);
      await userEvent.type(input, '1200');
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.queryByText(/record anyway/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/overpayment/i)).not.toBeInTheDocument();
    });

    it('above the balance: the sentence sits on the Amount field, the field is invalid, the button is off', async () => {
      renderDialog();
      const input = await screen.findByLabelText(/amount/i);
      await userEvent.clear(input);
      await userEvent.type(input, '1200');

      const message = screen.getByText('That is more than the $900.00 balance due. Enter $900.00 or less.');
      expect(message.closest('[role="alert"]')).not.toBeNull();
      expect(input).toHaveAttribute('aria-invalid', 'true');
      const describedBy = input.getAttribute('aria-describedby') ?? '';
      expect(describedBy.split(' ').some((id) => document.getElementById(id)?.contains(message))).toBe(true);
      expect(recordButton()).toBeDisabled();
      expect(post).not.toHaveBeenCalled();
    });

    it('the message replaces the Balance due hint, and the hint returns when the amount is fixed', async () => {
      renderDialog();
      const input = await screen.findByLabelText(/amount/i);
      expect(screen.getByText('Balance due: $900.00')).toBeInTheDocument();
      await userEvent.clear(input);
      await userEvent.type(input, '1200');
      expect(screen.queryByText('Balance due: $900.00')).not.toBeInTheDocument();
      await userEvent.clear(input);
      await userEvent.type(input, '900');
      expect(screen.getByText('Balance due: $900.00')).toBeInTheDocument();
      expect(input).not.toHaveAttribute('aria-invalid', 'true');
    });

    it('exactly the balance enables the button and posts it', async () => {
      renderDialog();
      const input = await screen.findByLabelText(/amount/i);
      await userEvent.clear(input);
      await userEvent.type(input, '900');
      await waitFor(() => expect(recordButton()).toBeEnabled());
      await userEvent.click(recordButton());
      expect(post).toHaveBeenCalledWith('/api/invoices/inv-1/payments', expect.objectContaining({ amount: 900 }));
    });

    it('one cent over is refused', async () => {
      renderDialog({ amountDue: 100 });
      const input = await screen.findByLabelText(/amount/i);
      await userEvent.clear(input);
      await userEvent.type(input, '100.01');
      expect(screen.getByText('That is more than the $100.00 balance due. Enter $100.00 or less.')).toBeInTheDocument();
      expect(recordButton()).toBeDisabled();
    });

    it('amount due $0.00: says there is nothing left to pay and keeps the button off', async () => {
      renderDialog({ amountDue: 0 });
      await screen.findByLabelText(/amount/i);
      expect(screen.getByText('There is nothing left to pay on this invoice.')).toBeInTheDocument();
      expect(recordButton()).toBeDisabled();
    });

    it('a server AMOUNT_ABOVE_BALANCE (balance moved) shows its sentence under the field, not in the bottom line, and reloads the invoice', async () => {
      const sentence = 'That is more than the $50.00 balance due. Enter $50.00 or less.';
      post.mockRejectedValue({ response: { status: 400, data: { code: 'AMOUNT_ABOVE_BALANCE', error: sentence } } });
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      render(
        <QueryClientProvider client={qc}>
          <RecordPaymentDialog open onOpenChange={vi.fn()} invoiceId="inv-1" invoiceNumber="I00001" amountDue={900} jobId="job-1" onSuccess={vi.fn()} />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(recordButton()).toBeEnabled());
      await userEvent.click(recordButton());

      const message = await screen.findByText(sentence);
      expect(message.closest('[role="alert"]')).not.toBeNull();
      expect(screen.getAllByText(sentence)).toHaveLength(1);
      expect(screen.getByLabelText(/amount/i)).toHaveAttribute('aria-invalid', 'true');
      expect(recordButton()).toBeDisabled();
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['invoice', 'inv-1'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['invoices'] });
      // The job page takes the balance from its financials query, so that reloads too.
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['job-financials', 'job-1'] });

      // Correcting the amount clears the refusal.
      const input = screen.getByLabelText(/amount/i);
      await userEvent.clear(input);
      await userEvent.type(input, '50');
      expect(screen.queryByText(sentence)).not.toBeInTheDocument();
    });

    it('a bank payment still clearing keeps its own two texts and shows no balance sentence', async () => {
      renderDialog({ amountDue: 900, processingAmount: 300 });
      const input = await screen.findByLabelText(/amount/i);
      expect(screen.getByTestId('record-payment-processing')).toHaveTextContent(
        'A bank payment of $300.00 is still processing. You can record up to $600.00 now.',
      );
      await userEvent.clear(input);
      await userEvent.type(input, '700');
      expect(screen.getByTestId('record-payment-processing-over')).toHaveTextContent(
        'That is more than can be recorded while the bank payment clears: up to $600.00.',
      );
      expect(screen.queryByText(/balance due\. Enter/)).not.toBeInTheDocument();
      expect(recordButton()).toBeDisabled();
    });
  });

  // The composite path creates the invoice FOR the typed amount, so amountDue is always 0 and an
  // overpayment is impossible. Gating it there would demand an acknowledgement of a nonsensical
  // "more than the $0.00 balance due" on every on-site urgent-workflow collection.
  it('never caps the no-invoice composite path at a balance', async () => {
    renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0 });
    const input = await screen.findByLabelText(/amount/i);
    await userEvent.clear(input);
    await userEvent.type(input, '600');

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/more than the/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Balance due:/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record payment/i })).toBeEnabled();
  });

  it('with NO invoice, says plainly it will create one, then creates → sends → pays in order', async () => {
    renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0 });
    expect(await screen.findByText(/will create an invoice/i)).toBeInTheDocument();

    const input = screen.getByLabelText(/amount/i);
    await userEvent.clear(input);
    await userEvent.type(input, '600');
    await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

    expect(createJobInvoice).toHaveBeenCalledWith('job-1', expect.objectContaining({ amount: 600 }));
    // The send is what keeps the lifecycle bar truthful — without it sent_at stays null and the
    // Invoice Sent node offers to create a SECOND invoice on a job already invoiced and paid.
    expect(post).toHaveBeenCalledWith('/api/invoices/inv-new/send', expect.anything());
    expect(post).toHaveBeenCalledWith('/api/invoices/inv-new/payments', expect.objectContaining({ amount: 600 }));
  });

  it('names the created invoice when the payment call fails, so the user does not create a second', async () => {
    post.mockImplementation((url: string) => (url.endsWith('/payments')
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({ data: {} })));
    renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0 });
    const input = await screen.findByLabelText(/amount/i);
    await userEvent.clear(input);
    await userEvent.type(input, '600');
    await userEvent.click(screen.getByRole('button', { name: /record payment/i }));
    expect(await screen.findByText(/I00031 was created/i)).toBeInTheDocument();
  });

  it('withholds the composite path when the customer holds a paid deposit', async () => {
    renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0, hasUnspentDeposit: true });
    expect(await screen.findByText(/deposit/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /record payment/i })).not.toBeInTheDocument();
  });

  it('closes the dialog after the composite (no-invoice) path succeeds, so a second click cannot double-bill', async () => {
    const onOpenChange = vi.fn();
    renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0, onOpenChange });
    const input = await screen.findByLabelText(/amount/i);
    await userEvent.clear(input);
    await userEvent.type(input, '600');
    await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  // SRVW-55 — tip chips + custom, mirroring PublicInvoicePage.
  describe('tip (SRVW-55)', () => {
    it('shows the tip section unconditionally, for every payment method (D1)', async () => {
      renderDialog();
      expect(await screen.findByText(/add a tip\?/i)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('combobox'));
      await userEvent.click(await screen.findByRole('option', { name: 'Bank transfer' }));
      expect(screen.getByText(/add a tip\?/i)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('combobox'));
      await userEvent.click(await screen.findByRole('option', { name: 'Check' }));
      expect(screen.getByText(/add a tip\?/i)).toBeInTheDocument();
    });

    it('selecting 15% on a $200 amount posts tip_amount: 30', async () => {
      renderDialog({ amountDue: 200 });
      await screen.findByLabelText(/amount/i);
      await userEvent.click(screen.getByRole('radio', { name: /15%/ }));
      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

      expect(post).toHaveBeenCalledWith('/api/invoices/inv-1/payments', expect.objectContaining({ tip_amount: 30 }));
    });

    it('"Other" posts the typed dollars verbatim', async () => {
      renderDialog({ amountDue: 200 });
      await screen.findByLabelText(/amount/i);
      await userEvent.click(screen.getByRole('radio', { name: 'Other' }));
      const tipInput = await screen.findByLabelText(/tip amount/i);
      await userEvent.type(tipInput, '17.50');
      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

      expect(post).toHaveBeenCalledWith('/api/invoices/inv-1/payments', expect.objectContaining({ tip_amount: 17.5 }));
    });

    it('no selection posts no tip_amount key at all', async () => {
      renderDialog({ amountDue: 200 });
      await screen.findByLabelText(/amount/i);
      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

      const call = post.mock.calls.find(([url]) => url === '/api/invoices/inv-1/payments');
      // axios/JSON.stringify drop an undefined-valued key on the wire - assert the value, not
      // key presence, since `{ tip_amount: undefined }` still satisfies `toHaveProperty`.
      expect(call[1].tip_amount).toBeUndefined();
    });

    it('recomputes the tip when the amount changes after a chip is selected', async () => {
      // A high balance keeps the amount change below amountDue, so this test exercises only the
      // tip recompute - not the balance cap.
      renderDialog({ amountDue: 1000 });
      const input = await screen.findByLabelText(/amount/i);
      await userEvent.click(screen.getByRole('radio', { name: /15%/ }));
      await userEvent.clear(input);
      await userEvent.type(input, '400');
      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

      // 15% of the now-$400 amount is $60, not the $150 the chip showed at $1000.
      expect(post).toHaveBeenCalledWith('/api/invoices/inv-1/payments', expect.objectContaining({ tip_amount: 60 }));
    });

    it('a tip never triggers the balance message', async () => {
      renderDialog({ amountDue: 200 });
      const input = await screen.findByLabelText(/amount/i);
      await userEvent.clear(input);
      await userEvent.type(input, '200');
      await userEvent.click(screen.getByRole('radio', { name: /20%/ }));

      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.queryByText(/more than the/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /record payment/i })).toBeEnabled();

      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));
      expect(post).toHaveBeenCalledWith('/api/invoices/inv-1/payments', expect.objectContaining({ amount: 200, tip_amount: 40 }));
    });

    it('carries tip_amount through the composite path\'s third (payment) request', async () => {
      renderDialog({ invoiceId: null, jobId: 'job-1', amountDue: 0 });
      const input = await screen.findByLabelText(/amount/i);
      await userEvent.clear(input);
      await userEvent.type(input, '200');
      await userEvent.click(screen.getByRole('radio', { name: /10%/ }));
      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));

      // Step 1 (create) must NOT be inflated by the tip - it is not part of the invoice.
      expect(createJobInvoice).toHaveBeenCalledWith('job-1', expect.objectContaining({ amount: 200 }));
      expect(post).toHaveBeenCalledWith('/api/invoices/inv-new/payments', expect.objectContaining({ amount: 200, tip_amount: 20 }));
    });

    it('clears the tip when the dialog is closed (Cancel) and reopened', async () => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const Wrapper = () => {
        const [open, setOpen] = useState(true);
        return (
          <QueryClientProvider client={qc}>
            <button onClick={() => setOpen(true)}>Reopen</button>
            <RecordPaymentDialog
              open={open} onOpenChange={setOpen} invoiceId="inv-1" invoiceNumber="I00001"
              amountDue={200} onSuccess={vi.fn()}
            />
          </QueryClientProvider>
        );
      };
      render(<Wrapper />);

      await userEvent.click(await screen.findByRole('radio', { name: /15%/ }));
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      await userEvent.click(screen.getByRole('button', { name: /reopen/i }));

      // Reopened on the same mounted instance - the 15% chip must no longer read as selected.
      expect(await screen.findByRole('radio', { name: /15%/ })).toHaveAttribute('aria-checked', 'false');
    });
  });

  // #1948 — "Date *" is REQUIRED: it is seeded to now (so the shared DateTimePicker's X is
  // there the moment the dialog opens) and the submit is gated on `!paidAt`. Clearing it
  // can only grey out "Record payment" with nothing said, so the call site opts out with
  // `clearable={false}`. These specs pin the CALL SITE - a picker that quietly stopped
  // passing the prop would still pass DateTimePicker's own unit tests.
  describe('required payment date (#1948)', () => {
    it('offers no clear control on the date field, though it opens already holding a date', async () => {
      renderDialog();
      // The seeded date is what puts every other consumer into the state that renders the X.
      expect(await screen.findByDisplayValue(/^\d{2}\/\d{2}\/\d{4}$/)).toBeInTheDocument();

      expect(screen.queryByRole('button', { name: /clear date and time/i })).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/clear date and time/i)).not.toBeInTheDocument();
    });

    it('stays submittable throughout - there is no control that can disable it', async () => {
      renderDialog();
      await screen.findByLabelText(/amount/i);
      const submit = screen.getByRole('button', { name: /record payment/i });
      // The submit waits for the lists of payment methods to be read, then opens.
      await waitFor(() => expect(submit).toBeEnabled());

      // Every button inside the date row (calendar / time-list openers) leaves the submit
      // enabled: nothing reachable there can empty a required field behind the user's back.
      for (const label of ['Open calendar', 'Open time list']) {
        await userEvent.click(screen.getByRole('button', { name: label }));
        await userEvent.keyboard('{Escape}');
        expect(screen.getByRole('button', { name: /record payment/i })).toBeEnabled();
      }
    });

    it('still backdates freely - losing the X costs no editing power', async () => {
      renderDialog();
      const dateInput = await screen.findByPlaceholderText('MM/DD/YYYY');
      await userEvent.clear(dateInput);
      await userEvent.type(dateInput, '3/4/2026');
      await userEvent.tab();
      expect(screen.getByDisplayValue('03/04/2026')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /record payment/i }));
      const call = post.mock.calls.find(([url]) => url === '/api/invoices/inv-1/payments');
      expect(call, 'the dialog never POSTed a payment').toBeDefined();

      // `paid_at` is a UTC instant built from the picked LOCAL date plus whatever
      // time-of-day the dialog seeded from the wall clock, so a substring match on
      // the local date is only true while ET is before 19:00. Assert the round trip
      // instead: whatever instant went out must land on Mar 4th in the org timezone.
      const sentLocalDate = new Intl.DateTimeFormat('en-US', {
        timeZone: DEFAULT_SCHEDULE_TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(call![1].paid_at));
      expect(sentLocalDate).toBe('03/04/2026');
    });
  });
});
