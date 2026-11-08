import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateJobInvoiceDialog } from '@/components/invoices/CreateJobInvoiceDialog';
import { listJobLines } from '@/lib/api/jobs';
import api from '@/lib/axios';

vi.mock('@/lib/api/jobs', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/jobs')>()),
  listJobLines: vi.fn().mockResolvedValue({
    lines: [],
    billing: { total: 100, invoiced: 100, remaining: 0, over_billed: 0 },
  }),
}));

const renderDialog = (props = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CreateJobInvoiceDialog
        open onOpenChange={vi.fn()} jobId="job-1" jobNumber="J00001" onCreated={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
};

describe('CreateJobInvoiceDialog', () => {
  it('submits an amount above the remaining balance — remaining is guidance, not a cap', async () => {
    // B1 removed BOTH backend over-bill guards. A client-side cap now refuses work the server
    // would accept, which is the dead end this spec exists to remove.
    renderDialog();
    await userEvent.type(await screen.findByLabelText(/amount/i), '500');
    await userEvent.click(screen.getByTestId('create-job-invoice-submit'));
    expect(screen.queryByText(/exceeds the remaining balance/i)).not.toBeInTheDocument();
  });

  it('State 2 — offers to send an existing draft instead of creating a second invoice', async () => {
    renderDialog({ existingDraft: { id: 'i2', invoice_number: 'I00002' }, sendAfterCreate: true });
    expect(await screen.findByRole('button', { name: /send I00002/i })).toBeInTheDocument();
    expect(screen.queryByTestId('create-job-invoice-submit')).not.toBeInTheDocument();
  });

  it('labels the submit "Create & Send" when sendAfterCreate is set', async () => {
    renderDialog({ sendAfterCreate: true });
    expect(await screen.findByRole('button', { name: /create & send/i })).toBeInTheDocument();
  });

  it('keeps the plain "Create Invoice" label for the Items-tab call site', async () => {
    renderDialog();
    expect(await screen.findByRole('button', { name: /create invoice/i })).toBeInTheDocument();
  });

  describe('create-and-send: send 400s for a missing recipient (the else/create-form branch)', () => {
    it('collects an email inline and retries only the send — never creates a second invoice', async () => {
      // Regression for the review finding: needsRecipient previously only had a matching
      // <Input> in the existingDraft (State 2) branch. The create-form branch (States 3/4,
      // the actual create-AND-send path) had no way to act on the same failure, and a
      // re-click of "Create & Send" would call createJobInvoice a second time.
      let createCalls = 0;
      let sendCalls = 0;
      vi.mocked(api).post.mockImplementation((url: string) => {
        if (url === '/api/jobs/job-1/invoices') {
          createCalls += 1;
          return Promise.resolve({ data: { invoice: { id: 'new-inv-1' } } });
        }
        if (url === '/api/invoices/new-inv-1/send') {
          sendCalls += 1;
          if (sendCalls === 1) {
            return Promise.reject({
              response: { data: { error: 'This customer has no recipient email on file.' } },
            });
          }
          return Promise.resolve({ data: { invoice: { id: 'new-inv-1', status: 'SENT' } } });
        }
        return Promise.reject(new Error(`unexpected POST ${url}`));
      });

      renderDialog({ sendAfterCreate: true });
      await userEvent.type(await screen.findByLabelText(/amount/i), '500');
      await userEvent.click(screen.getByTestId('create-job-invoice-submit'));

      // The invoice WAS created (createCalls below asserts exactly once); the send 400'd.
      // The create-form branch must offer a recipient field, same as State 2 already does.
      const recipientInput = await screen.findByLabelText(/send to/i);
      expect(screen.getByText(/enter an email address/i)).toBeInTheDocument();

      await userEvent.type(recipientInput, 'jane@customer.com');
      await userEvent.click(screen.getByTestId('create-job-invoice-submit'));

      await waitFor(() => expect(sendCalls).toBe(2));
      expect(createCalls).toBe(1);
    });
  });

  describe('itemized mode', () => {
    // Descriptions are stored as `name\ndetail` (LineItemRow.splitDescription). The picker used to
    // render the raw string on ONE `truncate`d line, which both ran the two halves together and —
    // because `truncate` is white-space: nowrap — blew the dialog's grid track out past the panel.
    const LINES = [
      {
        id: 'l1',
        description: 'Water Heater Replacement\nSupply and install 50-gallon natural gas water heater',
        quantity: 1,
        unit_price: 1250,
        line_total: 1250,
        item_type: 'MATERIAL',
      },
      {
        id: 'l2',
        description: 'Installation Labor\n4 hours on-site',
        quantity: 4,
        unit_price: 145,
        line_total: 580,
        item_type: 'SERVICE',
      },
    ];

    const renderItemized = () => {
      vi.mocked(listJobLines).mockResolvedValue({
        lines: LINES as never,
        billing: { total: 1830, invoiced: 0, remaining: 1830, over_billed: 0 },
      });
      return renderDialog({ initialMode: 'ITEMIZED' });
    };

    it('renders the item name and its detail separately, not as one run-on line', async () => {
      renderItemized();
      expect(await screen.findByText('Water Heater Replacement')).toBeInTheDocument();
      expect(
        screen.getByText('Supply and install 50-gallon natural gas water heater'),
      ).toBeInTheDocument();
    });

    it('select all selects every line, and clears them again', async () => {
      renderItemized();
      const selectAll = await screen.findByLabelText(/select all/i);

      await userEvent.click(selectAll);
      // Scoped to the summary row on purpose — $1,830.00 is also the header's remaining balance.
      const summary = await screen.findByText('2 of 2 selected');
      expect(summary.parentElement).toHaveTextContent('$1,830.00');

      await userEvent.click(screen.getByLabelText(/clear all/i));
      expect(await screen.findByText('0 of 2 selected')).toBeInTheDocument();
    });

    it('bills exactly the lines whose cards were clicked', async () => {
      vi.mocked(api).post.mockResolvedValue({ data: { invoice: { id: 'inv-1' } } } as never);
      renderItemized();

      await userEvent.click(await screen.findByRole('button', { name: /Water Heater Replacement/i }));
      await userEvent.click(screen.getByTestId('create-job-invoice-submit'));

      await waitFor(() =>
        expect(vi.mocked(api).post).toHaveBeenCalledWith('/api/jobs/job-1/invoices', {
          lineIds: ['l1'],
          description: undefined,
        }),
      );
    });
  });
});
