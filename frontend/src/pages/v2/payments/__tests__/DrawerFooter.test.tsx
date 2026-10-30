import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';

import { makeItem, serveAttention } from './attentionFixtures';
import { TabHarness, makeDetail, manyRows, mockApi } from './paymentsFixtures';

const ROW1 = manyRows(3)[0]!;
const open = () => renderWithProviders(<TabHarness />, { initialEntries: [`/payments?payment=${ROW1.id}`] });
const filled = (b: HTMLElement) => ['bg-primary', 'bg-destructive-solid'].some((c) => b.classList.contains(c));

beforeEach(() => mockApi.get.mockReset());

describe('the payment drawer footer', () => {
  it('a disputed payment has one Respond: the one in the alert', async () => {
    serveAttention({
      open: [makeItem(1, 'dispute', { actions: ['respond'] })],
      rows: manyRows(3),
      detail: () => makeDetail(ROW1, {
        status: 'Disputed', can_respond_dispute: true,
        dispute: { id: 'dp-1', status: 'NEEDS_RESPONSE', reason_text: 'Not received', amount: 101, respond_by: '2026-10-20T18:00:00.000Z', closed_at: null },
      }),
    });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Customer 1' });
    await within(dialog).findByText(/Dispute: Not received/);
    // The footer's attention query has had its chance to answer.
    await within(dialog).findByRole('button', { name: 'Close' });
    await new Promise((r) => setTimeout(r, 50));
    const responds = within(dialog).getAllByRole('button', { name: 'Respond' });
    expect(responds).toHaveLength(1);
    expect(responds[0]!.closest('[data-slot="sheet-footer"]')).toBeNull();
  });

  it('a failed refund offers Refund again, Mark settled and Close; the plain Refund is gone and one button is filled', async () => {
    serveAttention({
      open: [makeItem(1, 'failed_refund', { actions: ['refund_again', 'mark_settled'] })],
      rows: manyRows(3),
      detail: () => makeDetail(ROW1, { can_refund: true }),
    });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Customer 1' });
    await within(dialog).findByRole('button', { name: 'Refund again' });
    const footer = dialog.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
    const buttons = within(footer).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Refund again', 'Mark settled', 'Close']);
    expect(buttons.filter(filled)).toHaveLength(1);
  });

  it('a payment with no Refund again keeps its Refund', async () => {
    serveAttention({
      open: [makeItem(1, 'failed_payment', { actions: ['contact_customer', 'mark_resolved'] })],
      rows: manyRows(3),
      detail: () => makeDetail(ROW1, { can_refund: true }),
    });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Customer 1' });
    expect(await within(dialog).findByRole('button', { name: 'Refund' })).toBeInTheDocument();
    await within(dialog).findByRole('button', { name: 'Contact customer' });
  });
});
