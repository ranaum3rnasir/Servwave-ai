import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import type { AttentionActionId } from '@/lib/api/paymentsPage';

import { findCard, makeItem, serveAttention, CardWithDrawer } from './attentionFixtures';
import { mockApi } from './paymentsFixtures';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const user = () => userEvent.setup();
const rowWith = async (actions: AttentionActionId[]) => {
  serveAttention({ open: [makeItem(1, 'failed_refund', { actions })] });
  renderWithProviders(<CardWithDrawer />, { initialEntries: ['/payments'] });
  return within((await findCard()).querySelector('li') as HTMLElement);
};

beforeEach(() => mockApi.get.mockReset());

describe('the first two actions are buttons and the rest sit behind "More"', () => {
  it('shows one button for one action and no More', async () => {
    const row = await rowWith(['mark_resolved']);
    expect(row.getAllByRole('button').map((b) => b.textContent)).toEqual(['Mark resolved']);
  });

  it('shows two buttons for two actions and no More: the first filled, the second outline', async () => {
    const row = await rowWith(['refund_again', 'mark_resolved']);
    const buttons = row.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Refund again', 'Mark resolved']);
    expect(buttons[0]!.className).toMatch(/bg-primary/);
    expect(buttons[1]!.className).not.toMatch(/bg-primary/);
    expect(row.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('puts the third action in a "More" menu, and a button the viewer cannot use is absent, not disabled', async () => {
    const u = user();
    const row = await rowWith(['contact_customer', 'refund_again', 'mark_resolved']);
    expect(row.getAllByRole('button').map((b) => b.textContent)).toEqual(['Contact customer', 'Refund again', 'More']);
    const more = row.getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    expect(more.className).toMatch(/max-sm:min-h-11/);
    await u.click(more);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Mark resolved']);
    expect(within(menu).getAllByRole('menuitem')[0]!.className).toMatch(/max-sm:min-h-11/);
  });

  it('drops mark_settled and offers no Attach or Create invoice yet', async () => {
    const row = await rowWith(['mark_resolved']);
    expect(row.queryByRole('button', { name: /settle|Attach|Create invoice/i })).not.toBeInTheDocument();
  });
});

describe('keyboard', () => {
  it('Enter opens the menu, arrows move, Escape closes it and puts focus back on More', async () => {
    const u = user();
    const row = await rowWith(['contact_customer', 'refund_again', 'mark_resolved']);
    const more = row.getByRole('button', { name: 'More' });
    more.focus();
    await u.keyboard('{Enter}');
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: 'Mark resolved' })).toHaveFocus();
    await u.keyboard('{ArrowDown}');
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(more).toHaveFocus();
  });

  it('choosing "Mark resolved" in the menu opens the Mark as resolved dialog over the card, with focus inside it', async () => {
    const u = user();
    const row = await rowWith(['contact_customer', 'refund_again', 'mark_resolved']);
    await u.click(row.getByRole('button', { name: 'More' }));
    await u.click(await screen.findByRole('menuitem', { name: 'Mark resolved' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as resolved' });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('focus returns to the opener when Mark as resolved closes without resolving', () => {
  const THREE: AttentionActionId[] = ['contact_customer', 'refund_again', 'mark_resolved'];
  const TWO: AttentionActionId[] = ['refund_again', 'mark_resolved'];

  it.each([['Escape'], ['Cancel']])('%s from the row button puts focus back on that button', async (how) => {
    const u = user();
    const row = await rowWith(TWO);
    const opener = row.getByRole('button', { name: 'Mark resolved' });
    await u.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Mark as resolved' });
    if (how === 'Escape') await u.keyboard('{Escape}');
    else await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it.each([['Escape'], ['Cancel']])('%s when opened from More puts focus back on More', async (how) => {
    const u = user();
    const row = await rowWith(THREE);
    const more = row.getByRole('button', { name: 'More' });
    await u.click(more);
    await u.click(await screen.findByRole('menuitem', { name: 'Mark resolved' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mark as resolved' });
    if (how === 'Escape') await u.keyboard('{Escape}');
    else await u.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(more).toHaveFocus());
  });
});

describe('Mark as resolved on a phone', () => {
  const at = (belowMd: boolean) => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === MEDIA.belowMd && belowMd, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
  };

  it('Mark resolved and Contact customer are both bottom sheets', async () => {
    at(true);
    const u = user();
    const row = await rowWith(['contact_customer', 'mark_resolved']);
    await u.click(row.getByRole('button', { name: 'Mark resolved' }));
    expect((await screen.findByRole('dialog', { name: 'Mark as resolved' })).getAttribute('data-presentation')).toBe('bottom-sheet');
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await u.click(row.getByRole('button', { name: 'Contact customer' }));
    expect((await screen.findByRole('dialog', { name: 'Contact customer' })).getAttribute('data-presentation')).toBe('bottom-sheet');
  });
});
