import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

import { TabHarness, makeDetail, manyRows, serve, urlSearch } from './paymentsFixtures';
import { DISPUTE_ID, makeEvidence, mockApi } from './disputeFixtures';

const ROW1 = manyRows(3)[0]!;
const dispute = (over: Partial<NonNullable<ReturnType<typeof makeDetail>['dispute']>> = {}) => ({
  id: DISPUTE_ID, reference: 'DSP-000001', status: 'NEEDS_RESPONSE', reason_text: 'The customer does not recognize the charge', amount: 101,
  respond_by: '2026-10-20T12:00:00.000Z', closed_at: null, ...over,
});

/** The payments list and detail, plus the dispute's own evidence route. */
function serveAll({ detail, evidence = makeEvidence() }: { detail: ReturnType<typeof makeDetail>; evidence?: ReturnType<typeof makeEvidence> }) {
  serve({ rows: manyRows(3), detail: () => detail });
  const base = mockApi.get.getMockImplementation()!;
  mockApi.get.mockImplementation(((url: string, config?: unknown) => {
    if (url === `/api/payments-page/disputes/${DISPUTE_ID}/evidence`) return Promise.resolve({ data: evidence });
    if (url.startsWith('/api/attachments/')) return Promise.resolve({ data: { attachments: [] } });
    return (base as (u: string, c?: unknown) => Promise<unknown>)(url, config);
  }) as never);
}

beforeEach(() => {
  mockApi.get.mockReset();
});

const PAYMENT_DIALOG = { name: /^Payment PMT-/ };
const dparam = () => new URLSearchParams(urlSearch()).get('d');

describe('opening a dispute', () => {
  it('opens from ?dispute= on a fresh load (read as d), and closing takes the address off', async () => {
    serveAll({ detail: makeDetail(ROW1) });
    const u = userEvent.setup();
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?dispute=${DISPUTE_ID}`] });
    const drawer = await screen.findByRole('dialog', { name: /^Dispute DSP-/ });
    expect(await within(drawer).findByText('5 days left')).toBeInTheDocument();
    await waitFor(() => expect(dparam()).toBe(`dispute:${DISPUTE_ID}`));
    expect(urlSearch()).not.toContain('dispute=');
    await u.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(urlSearch()).not.toContain('d=');
  });

  it('Respond to dispute in the payment drawer pushes the Dispute then the Respond view, and Back steps out one view at a time', async () => {
    serveAll({ detail: makeDetail(ROW1, { status: 'Disputed', dispute: dispute(), can_respond_dispute: true }) });
    const u = userEvent.setup();
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=payment:${ROW1.id}`] });
    const payment = await screen.findByRole('dialog', PAYMENT_DIALOG);
    await u.click(await within(payment).findByRole('button', { name: 'Respond to dispute' }));
    const respond = await screen.findByRole('dialog', { name: 'Respond to dispute' });
    expect(dparam()).toBe(`payment:${ROW1.id},dispute:${DISPUTE_ID},respond:${DISPUTE_ID}`);
    await u.click(within(respond).getByRole('button', { name: 'Back to Dispute' }));
    const dispute1 = await screen.findByRole('dialog', { name: /^Dispute DSP-/ });
    expect(await within(dispute1).findByRole('button', { name: 'Respond' })).toBeInTheDocument();
    expect(dparam()).toBe(`payment:${ROW1.id},dispute:${DISPUTE_ID}`);
    await u.click(within(dispute1).getByRole('button', { name: 'Back to Payment' }));
    expect(await screen.findByRole('dialog', PAYMENT_DIALOG)).toBeInTheDocument();
    expect(dparam()).toBe(`payment:${ROW1.id}`);
  });

  it('offers a person who may not answer View, never Respond', async () => {
    serveAll({ detail: makeDetail(ROW1, { status: 'Disputed', dispute: dispute(), can_respond_dispute: false }) });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=payment:${ROW1.id}`] });
    const payment = await screen.findByRole('dialog', PAYMENT_DIALOG);
    expect(await within(payment).findByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(within(payment).queryByRole('button', { name: /^Respond/ })).not.toBeInTheDocument();
  });

  it('offers View on a dispute that is already under review', async () => {
    serveAll({ detail: makeDetail(ROW1, { status: 'Disputed', dispute: dispute({ status: 'UNDER_REVIEW' }), can_respond_dispute: true }) });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=payment:${ROW1.id}`] });
    const payment = await screen.findByRole('dialog', PAYMENT_DIALOG);
    expect(await within(payment).findByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(within(payment).queryByRole('button', { name: /^Respond/ })).not.toBeInTheDocument();
  });

  it('View pushes the Dispute on this Payment (Back goes to the Payment, the address adds a history entry)', async () => {
    serveAll({ detail: makeDetail(ROW1, { status: 'Disputed', dispute: dispute(), can_respond_dispute: true }) });
    const u = userEvent.setup();
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=payment:${ROW1.id}`] });
    const payment = await screen.findByRole('dialog', PAYMENT_DIALOG);
    await u.click(await within(payment).findByRole('button', { name: 'View' }));
    const drawer = await screen.findByRole('dialog', { name: /^Dispute DSP-/ });
    expect(dparam()).toBe(`payment:${ROW1.id},dispute:${DISPUTE_ID}`);
    expect(within(drawer).getByRole('button', { name: 'Back to Payment' })).toBeInTheDocument();
  });
});

describe('the dispute alert in the payment drawer', () => {
  it('reads the reason, the deadline with its time and the time left as one text block, with spaces between', async () => {
    serveAll({ detail: makeDetail(ROW1, { status: 'Disputed', dispute: dispute(), can_respond_dispute: true }) });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=payment:${ROW1.id}`] });
    const payment = await screen.findByRole('dialog', PAYMENT_DIALOG);
    const button = await within(payment).findByRole('button', { name: 'View' });
    const row = button.parentElement!;
    const block = row.children[0] as HTMLElement;
    expect(block.textContent).toMatch(/^Dispute: The customer does not recognize the charge\. Respond by Oct 20, 2026, \d{1,2}:\d{2}\s?[AP]M \(.+\)\.$/);
    // One text block beside the button, not two squeezed columns.
    expect(Array.from(row.children).filter((c) => c.tagName !== 'BUTTON')).toHaveLength(1);
  });

  it('shows the same alert without a deadline once the dispute is not waiting for an answer', async () => {
    serveAll({ detail: makeDetail(ROW1, { status: 'Disputed', dispute: dispute({ status: 'UNDER_REVIEW' }) }) });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?d=payment:${ROW1.id}`] });
    const payment = await screen.findByRole('dialog', PAYMENT_DIALOG);
    expect(await within(payment).findByRole('status')).toHaveTextContent('Dispute under review. The customer does not recognize the charge.');
  });
});
