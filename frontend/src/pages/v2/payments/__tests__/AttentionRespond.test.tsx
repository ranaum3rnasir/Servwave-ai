import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';

import { makeItem, serveAttention, findCard, CardWithDrawer } from './attentionFixtures';
import { DISPUTE_ID, makeEvidence } from './disputeFixtures';
import { mockApi } from './paymentsFixtures';


function Where() {
  const { search } = useLocation();
  return <div data-testid="where">{search}</div>;
}

const openItem = makeItem(3, 'dispute', { actions: ['respond'], dispute_id: DISPUTE_ID });

beforeEach(() => mockApi.get.mockReset());

describe('Respond, with the dispute drawer part of the page', () => {
  it('opens its Payment, the Dispute and the Respond view as one stack, and calls nothing', async () => {
    serveAttention({ open: [openItem] });
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(((url: string, config?: unknown) => {
      if (url === `/api/payments-page/disputes/${DISPUTE_ID}/evidence`) return Promise.resolve({ data: makeEvidence() });
      if (typeof url === 'string' && url.startsWith('/api/attachments/')) return Promise.resolve({ data: { attachments: [] } });
      return (base as (...a: unknown[]) => unknown)(url, config);
    }) as never);
    renderWithProviders(<><CardWithDrawer /><Where /></>, { initialEntries: ['/payments?tab=payouts'] });
    const row = within(await findCard()).getByRole('listitem');
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Respond' }));
    const item = openItem;
    expect(new URLSearchParams(screen.getByTestId('where').textContent!).get('d')).toBe(`payment:${item.payment_id},dispute:${DISPUTE_ID},respond:${DISPUTE_ID}`);
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
