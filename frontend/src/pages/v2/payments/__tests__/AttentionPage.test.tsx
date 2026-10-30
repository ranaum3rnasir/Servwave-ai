import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';

import PaymentsPage from '../PaymentsPage';
import { makeItem, serveAttention } from './attentionFixtures';
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
  it('puts the Needs attention card between the tiles and the tabs, and its count matches the chip', async () => {
    serve([makeItem(1, 'failed_payment', { actions: [] }), makeItem(2, 'failed_payout', { actions: [] })]);
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments'], ability: OWNER });
    const card = await screen.findByRole('region', { name: /Needs attention/ });
    const tabs = screen.getByRole('tablist');
    expect(card.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getByText('2')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Needs attention 2' })).toBeInTheDocument();
  });

  it('Show all from the card lands on the Open view of the table', async () => {
    serve(Array.from({ length: 7 }, (_, i) => makeItem(i + 1, 'failed_payment', { actions: [] })));
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments?tab=payouts'], ability: OWNER });
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Show all 7' }));
    expect(await screen.findByRole('group', { name: 'Item status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open (7)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows no card when nothing is open', async () => {
    serve([]);
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments'], ability: OWNER });
    await screen.findByRole('tablist');
    expect(screen.queryByRole('region', { name: /Needs attention/ })).not.toBeInTheDocument();
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
    const card = await screen.findByRole('region', { name: /Needs attention/ });
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Respond' }));
    expect(await screen.findByRole('dialog', { name: 'Respond to dispute' })).toBeInTheDocument();
  });
});
