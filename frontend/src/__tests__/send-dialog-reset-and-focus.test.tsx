/**
 * Send dialogs: a fresh compose on every open, and focus that lands somewhere useful.
 *
 * Both were found while live-verifying the recipient pre-fill on staging.
 *
 * 1. STALE COMPOSE. Neither dialog is unmounted when closed - EstimateWorkspacePage and
 *    InvoiceDetailPage both render them unconditionally (InvoiceDetailPage twice: send + resend).
 *    So component state outlived Cancel: a one-off recipient typed once was still in "To" the next
 *    time the dialog opened. That is a wrong-recipient risk rather than a cosmetic one, because an
 *    override is only threaded when it DIFFERS from the saved customer email - a stale address
 *    therefore reads as the customer's own while quietly addressing someone else.
 *
 * 2. FOCUS. Radix focuses the first tabbable child on open. In SendEstimateDialog that was the
 *    "Via SMS" lock - an aria-disabled div kept focusable on purpose (R4) - whose tooltip opens on
 *    focus and covered the "To" label. Focus now goes to the recipient input instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { SendEstimateDialog } from '@/components/estimates/SendEstimateDialog';
import { SendInvoiceDialog } from '@/components/invoices/SendInvoiceDialog';

const CUSTOMER_EMAIL = 'saved@customer.test';
const TYPED_OVERRIDE = 'someone.else@example.com';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url === '/api/organization') {
      return {
        data: {
          accepted_payment_methods: ['CARD'],
          deposit_default_type: 'PERCENTAGE',
          deposit_default_percentage: 50,
        },
      };
    }
    return { data: {} };
  });
});

/**
 * Mounts the dialog closed, then drives open -> edit -> cancel -> reopen, exactly as the pages do
 * (the component is never unmounted). Returns the "To" value seen on the SECOND open.
 */
async function valueOnReopen(renderDialog: (open: boolean) => React.ReactElement) {
  const user = userEvent.setup();
  const { rerender } = renderWithProviders(renderDialog(false));

  rerender(renderDialog(true));
  const firstOpen = await screen.findByLabelText('To');
  expect(firstOpen).toHaveValue(CUSTOMER_EMAIL);

  await user.clear(firstOpen);
  await user.type(firstOpen, TYPED_OVERRIDE);
  expect(firstOpen).toHaveValue(TYPED_OVERRIDE);

  rerender(renderDialog(false));
  rerender(renderDialog(true));

  return screen.findByLabelText('To');
}

describe('SendEstimateDialog', () => {
  const renderDialog = (open: boolean) => (
    <SendEstimateDialog
      open={open}
      onOpenChange={() => {}}
      estimateId="est-1"
      estimateNumber="C00002-1"
      totalAmount={1000}
      customerEmail={CUSTOMER_EMAIL}
      alreadySent={false}
      onSuccess={() => {}}
    />
  );

  it('discards a cancelled one-off recipient and re-seeds "To" on reopen', async () => {
    expect(await valueOnReopen(renderDialog)).toHaveValue(CUSTOMER_EMAIL);
  });

  it('discards cancelled CC chips on reopen', async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(renderDialog(false));

    rerender(renderDialog(true));
    await user.type(await screen.findByLabelText(/^CC/), 'cc@example.com{Enter}');
    expect(await screen.findByRole('button', { name: 'Remove cc@example.com' })).toBeInTheDocument();

    rerender(renderDialog(false));
    rerender(renderDialog(true));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove cc@example.com' })).toBeNull(),
    );
  });

  it('focuses the recipient input on open, not the disabled "Via SMS" lock', async () => {
    const { rerender } = renderWithProviders(renderDialog(false));
    rerender(renderDialog(true));

    const to = await screen.findByLabelText('To');
    await waitFor(() => expect(to).toHaveFocus());
    // The SMS tooltip is focus-triggered; nothing should have opened it.
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('SendInvoiceDialog', () => {
  const renderDialog = (open: boolean) => (
    <SendInvoiceDialog
      open={open}
      onOpenChange={() => {}}
      invoiceId="inv-1"
      invoiceNumber="I00001"
      customerEmail={CUSTOMER_EMAIL}
      dueDate={null}
      totalAmount={1000}
      amountDue={1000}
      lineItems={[]}
      onSuccess={() => {}}
    />
  );

  it('discards a cancelled one-off recipient and re-seeds "To" on reopen', async () => {
    expect(await valueOnReopen(renderDialog)).toHaveValue(CUSTOMER_EMAIL);
  });
});
