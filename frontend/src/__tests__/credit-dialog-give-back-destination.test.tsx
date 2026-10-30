/**
 * Payments go-live slice 32b items 2 and 3 - the Issue Credit dialog says what will really happen
 * to a give-back, and the hand "Refund method" picker follows the PAYMENT, not the amount:
 *   - for a give-back that goes back through the processor (a card or a bank payment) the picker
 *     never shows, at an empty amount, a zero amount or any amount;
 *   - for money recorded by hand it shows from the start;
 *   - the wording names where the money goes back (the card, the bank account, or recorded by
 *     hand) and never calls it cash on a card- or bank-paid invoice.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { CreditInvoiceDialog } from '@/components/invoices/CreditInvoiceDialog';

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const pay = (id: string, method: string) => ({
  id, amount: 200, method, paid_at: daysAgo(5), state: 'SUCCEEDED',
  paid_through_processor: method === 'CARD' || method === 'ACH',
});
const moneyField = () => document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
const picker = () => screen.queryByRole('combobox', { name: 'Refund method' });

function open(payments: ReturnType<typeof pay>[]) {
  renderWithProviders(
    <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" balanceOwed={0} canRefund payments={payments} />,
  );
}

describe.each([['a card', 'CARD'], ['a bank', 'ACH']])('Issue Credit on %s-paid invoice: the hand picker', (_label, method) => {
  it('is not there with the give-back box ticked and no amount typed', async () => {
    const user = userEvent.setup();
    open([pay('p1', method)]);
    await user.click(screen.getByTestId('credit-refund-instead'));
    expect(picker()).not.toBeInTheDocument();
  });

  it('is not there at a zero amount, nor once an amount is typed', async () => {
    const user = userEvent.setup();
    open([pay('p1', method)]);
    await user.click(screen.getByTestId('credit-refund-instead'));
    await user.type(moneyField(), '0');
    expect(picker()).not.toBeInTheDocument();
    await user.clear(moneyField());
    await user.type(moneyField(), '50');
    expect(picker()).not.toBeInTheDocument();
  });
});

describe('Issue Credit on a hand-paid invoice: the hand picker', () => {
  it('shows from the start, empty amount or not', async () => {
    const user = userEvent.setup();
    open([pay('h1', 'CASH')]);
    await user.click(screen.getByTestId('credit-refund-instead'));
    expect(picker()).toBeInTheDocument();
    await user.type(moneyField(), '50');
    expect(picker()).toBeInTheDocument();
  });
});

describe('Issue Credit: the wording names where the money goes back', () => {
  it('a card-paid invoice: back to the card, never cash', async () => {
    const user = userEvent.setup();
    open([pay('c1', 'CARD')]);
    await user.type(moneyField(), '50');
    await user.click(screen.getByTestId('credit-refund-instead'));
    const dialog = screen.getByTestId('credit-invoice-dialog');
    expect(dialog.textContent).toMatch(/\$50\.00 refunded to the card/);
    expect(dialog.textContent).toMatch(/goes back to the card/);
    expect(dialog.textContent).not.toMatch(/cash/i);
  });

  it('a bank-paid invoice: back to the bank account, never cash', async () => {
    const user = userEvent.setup();
    open([pay('b1', 'ACH')]);
    await user.type(moneyField(), '50');
    await user.click(screen.getByTestId('credit-refund-instead'));
    const dialog = screen.getByTestId('credit-invoice-dialog');
    expect(dialog.textContent).toMatch(/\$50\.00 refunded to the bank account/);
    expect(dialog.textContent).toMatch(/goes back to the bank account/);
    expect(dialog.textContent).not.toMatch(/cash/i);
  });

  it('a hand-paid invoice: the refund is recorded by hand', async () => {
    const user = userEvent.setup();
    open([pay('h1', 'CHECK')]);
    await user.type(moneyField(), '50');
    await user.click(screen.getByTestId('credit-refund-instead'));
    const dialog = screen.getByTestId('credit-invoice-dialog');
    expect(dialog.textContent).toMatch(/\$50\.00 refund recorded by hand/);
    expect(dialog.textContent).toMatch(/recorded as a refund by hand/);
  });

  it('the excess over a balance names the destination too', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CreditInvoiceDialog open onOpenChange={vi.fn()} invoiceId="inv-1" balanceOwed={100} canRefund payments={[pay('c1', 'CARD')]} />,
    );
    await user.type(moneyField(), '150');
    expect(screen.getByTestId('credit-invoice-dialog').textContent).toMatch(/\$50\.00 refunded as excess to the card/);
  });
});
