import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';

import { AttentionCard } from '../components/AttentionCard';
import { makeItem, serveAttention } from './attentionFixtures';
import { mockApi } from './paymentsFixtures';


function Where() {
  const { search } = useLocation();
  return <div data-testid="where">{search}</div>;
}

beforeEach(() => mockApi.get.mockReset());

describe('Respond, with the dispute drawer part of the page', () => {
  it('opens the dispute drawer address and calls nothing', async () => {
    serveAttention({ open: [makeItem(3, 'dispute', { actions: ['respond'] })] });
    renderWithProviders(<><AttentionCard /><Where /></>, { initialEntries: ['/payments?tab=payouts'] });
    const row = within(await screen.findByRole('region', { name: /Needs attention/ })).getByRole('listitem');
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Respond' }));
    expect(screen.getByTestId('where').textContent).toContain('dispute=dp-3');
    expect(screen.getByTestId('where').textContent).toContain('tab=payments');
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('from the payment drawer it gives way: the payment address comes off', async () => {
    serveAttention({ open: [makeItem(3, 'dispute', { actions: ['respond'] })] });
    renderWithProviders(<><AttentionCard /><Where /></>, { initialEntries: ['/payments?tab=payments&payment=pay-9'] });
    const row = within(await screen.findByRole('region', { name: /Needs attention/ })).getByRole('listitem');
    await userEvent.setup().click(within(row).getByRole('button', { name: 'Respond' }));
    expect(screen.getByTestId('where').textContent).toContain('dispute=dp-3');
    expect(screen.getByTestId('where').textContent).not.toContain('payment=');
  });
});
