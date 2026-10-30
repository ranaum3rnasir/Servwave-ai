import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';

import { TabHarness, makeDetail, manyRows, serve, urlSearch } from './paymentsFixtures';
import { DISPUTE_ID, makeEvidence, mockApi } from './disputeFixtures';

const ROW1 = manyRows(3)[0]!;
const dispute = (over: Partial<NonNullable<ReturnType<typeof makeDetail>['dispute']>> = {}) => ({
  id: DISPUTE_ID, status: 'NEEDS_RESPONSE', reason_text: 'The customer does not recognize the charge', amount: 101,
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

describe('opening a dispute', () => {
  it('opens from ?dispute= on a fresh load, and closing takes the address off', async () => {
    serveAll({ detail: makeDetail(ROW1) });
    const u = userEvent.setup();
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?dispute=${DISPUTE_ID}`] });
    const drawer = await screen.findByRole('dialog', { name: 'Respond to dispute' });
    expect(await within(drawer).findByText('5 days left')).toBeInTheDocument();
    expect(urlSearch()).toContain(`dispute=${DISPUTE_ID}`);
    await u.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(urlSearch()).not.toContain('dispute=');
  });

  it('opens from Respond in the payment drawer, which gives way to the dispute drawer', async () => {
    serveAll({ detail: makeDetail(ROW1, { status: 'Disputed', dispute: dispute(), can_respond_dispute: true }) });
    const u = userEvent.setup();
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?payment=${ROW1.id}`] });
    const payment = await screen.findByRole('dialog', { name: 'Customer 1' });
    await u.click(await within(payment).findByRole('button', { name: 'Respond' }));
    const drawer = await screen.findByRole('dialog', { name: 'Respond to dispute' });
    expect(within(drawer).getByRole('button', { name: 'Add evidence' })).toBeInTheDocument();
    expect(urlSearch()).toContain(`dispute=${DISPUTE_ID}`);
    expect(urlSearch()).not.toContain('payment=');
  });

  it('offers a person who may not answer View, never Respond', async () => {
    serveAll({ detail: makeDetail(ROW1, { status: 'Disputed', dispute: dispute(), can_respond_dispute: false }) });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?payment=${ROW1.id}`] });
    const payment = await screen.findByRole('dialog', { name: 'Customer 1' });
    expect(await within(payment).findByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(within(payment).queryByRole('button', { name: 'Respond' })).not.toBeInTheDocument();
  });

  it('offers View on a dispute that is already under review', async () => {
    serveAll({ detail: makeDetail(ROW1, { status: 'Disputed', dispute: dispute({ status: 'UNDER_REVIEW' }), can_respond_dispute: true }) });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?payment=${ROW1.id}`] });
    const payment = await screen.findByRole('dialog', { name: 'Customer 1' });
    expect(await within(payment).findByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(within(payment).queryByRole('button', { name: 'Respond' })).not.toBeInTheDocument();
  });
});

describe('the dispute alert in the payment drawer', () => {
  it('reads the reason and the deadline as one sentence block, with a space between them', async () => {
    serveAll({ detail: makeDetail(ROW1, { status: 'Disputed', dispute: dispute(), can_respond_dispute: true }) });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?payment=${ROW1.id}`] });
    const payment = await screen.findByRole('dialog', { name: 'Customer 1' });
    const button = await within(payment).findByRole('button', { name: 'Respond' });
    const row = button.parentElement!;
    const block = row.children[0] as HTMLElement;
    expect(block).toHaveTextContent('Dispute: The customer does not recognize the charge. Respond by Oct 20, 2026.');
    // One text block beside the button, not two squeezed columns.
    expect(Array.from(row.children).filter((c) => c.tagName !== 'BUTTON')).toHaveLength(1);
  });

  it('shows the same alert without a deadline once the dispute is not waiting for an answer', async () => {
    serveAll({ detail: makeDetail(ROW1, { status: 'Disputed', dispute: dispute({ status: 'UNDER_REVIEW' }) }) });
    renderWithProviders(<TabHarness />, { initialEntries: [`/payments?payment=${ROW1.id}`] });
    const payment = await screen.findByRole('dialog', { name: 'Customer 1' });
    expect(await within(payment).findByRole('status')).toHaveTextContent('Dispute under review. The customer does not recognize the charge.');
  });
});
