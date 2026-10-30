import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';

import PaymentsPage from '../PaymentsPage';
import { makeItem, serveAttention, findCard } from './attentionFixtures';
import { DISPUTE_ID, makeEvidence } from './disputeFixtures';
import { mockApi } from './paymentsFixtures';

const OWNER = buildAbility(catalogToggle('Manage payout account').grants.map((g) => ({ action: g.action, subject: g.subject }) as never));

function serve(open: ReturnType<typeof makeItem>[]) {
  serveAttention({ open });
  const base = mockApi.get.getMockImplementation()!;
  mockApi.get.mockImplementation(((url: string, config?: unknown) => {
    if (url === '/api/organization/stripe/status') {
      return Promise.resolve({ data: { connected: true, terms_accepted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true } });
    }
    return (base as (...a: unknown[]) => unknown)(url, config);
  }) as never);
}

beforeEach(() => mockApi.get.mockReset());

describe('the Payments page', () => {
  it('mounts the card once: switching tabs and choosing the Needs attention chip never remount, hide or reorder it', async () => {
    const u = userEvent.setup();
    serve([makeItem(1, 'failed_payment', { actions: [] }), makeItem(2, 'dispute', { actions: [] })]);
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments'], ability: OWNER });
    const card = await findCard();
    const rowTitles = () => within(card).getAllByRole('listitem').map((r) => r.textContent);
    const before = rowTitles();
    await u.click(screen.getByRole('tab', { name: 'Payouts' }));
    await u.click(await screen.findByRole('tab', { name: 'Payments' }));
    await u.click(await screen.findByRole('button', { name: 'Needs attention 2' }));
    expect(await screen.findByRole('group', { name: 'Item status' })).toBeInTheDocument();
    expect(document.body.contains(card)).toBe(true);
    expect(screen.getAllByRole('region', { name: /Needs attention/ })).toEqual([card]);
    expect(rowTitles()).toEqual(before);
  });

  it('puts the Needs attention card between the tiles and the tabs, and its count matches the chip', async () => {
    serve([makeItem(1, 'failed_payment', { actions: [] }), makeItem(2, 'failed_payout', { actions: [] })]);
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments'], ability: OWNER });
    const card = await findCard();
    const tabs = screen.getByRole('tablist');
    expect(card.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getByText('2')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Needs attention 2' })).toBeInTheDocument();
  });

  it('View all from the card lands on the Open view of the table', async () => {
    serve(Array.from({ length: 7 }, (_, i) => makeItem(i + 1, 'failed_payment', { actions: [] })));
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments?tab=payouts'], ability: OWNER });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'View all 7' }));
    expect(await screen.findByRole('group', { name: 'Item status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open (7)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the card with "Nothing needs attention" when nothing is open', async () => {
    serve([]);
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments'], ability: OWNER });
    await screen.findByRole('tablist');
    expect(within(await findCard()).getByText('Nothing needs attention')).toBeInTheDocument();
  });

  it('Respond on a dispute item opens the dispute drawer, on the Payments tab', async () => {
    serve([makeItem(3, 'dispute', { actions: ['respond'], dispute_id: DISPUTE_ID })]);
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(((url: string, config?: unknown) => {
      if (url === `/api/payments-page/disputes/${DISPUTE_ID}/evidence`) return Promise.resolve({ data: makeEvidence() });
      if (typeof url === 'string' && url.startsWith('/api/attachments/')) return Promise.resolve({ data: { attachments: [] } });
      return (base as (...a: unknown[]) => unknown)(url, config);
    }) as never);
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments?tab=payouts'], ability: OWNER });
    const card = await findCard();
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Respond' }));
    // Payment, then Dispute, then the Respond view on top (the form step).
    expect(await screen.findByRole('dialog', { name: 'Respond to dispute' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Dispute' })).toBeInTheDocument();
  });
});
