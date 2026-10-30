import { describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';

import { PeriodPicker } from '../components/PeriodPicker';

vi.mock('@/ui-kit/hooks/useOverlayPresentation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/hooks/useOverlayPresentation')>()),
  useOverlayPresentation: () => 'card',
}));

describe('PeriodPicker custom range on a desktop popover', () => {
  it('keeps the same inputs and focus when the select scroll lock clears after the popover opens', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { timezone: 'America/Los_Angeles' } });
    const u = userEvent.setup();
    renderWithProviders(
      <PeriodPicker period={{ key: '30', from: '2026-09-12', to: '2026-10-12' }} onChange={vi.fn()} />,
    );

    await u.click(screen.getByRole('combobox', { name: 'Period' }));
    const option = await screen.findByRole('option', { name: 'Custom range' });
    // The select is still closing: it holds the page scroll lock as the popover opens.
    document.body.setAttribute('data-scroll-locked', '1');
    await u.click(option);

    const start = await screen.findByLabelText('Start date');
    const end = screen.getByLabelText('End date');

    await act(async () => { document.body.removeAttribute('data-scroll-locked'); });

    await u.click(end);
    expect(screen.getByLabelText('End date')).toBe(end);
    expect(screen.getByLabelText('Start date')).toBe(start);
    expect(document.activeElement).toBe(end);

    await u.click(start);
    await u.tab();
    expect(screen.getByLabelText('End date')).toBe(end);
    // Tabbing out of Start lands inside the panel, never on the page body.
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('dialog', { name: 'Custom range' }).contains(document.activeElement)).toBe(true);
  });
});
