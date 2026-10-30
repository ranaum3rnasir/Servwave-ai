import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';

import { PeriodPicker } from '../components/PeriodPicker';

// On a phone the custom range is a bottom sheet, not a popover hanging off the select.
vi.mock('@/ui-kit/hooks/useOverlayPresentation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/hooks/useOverlayPresentation')>()),
  useOverlayPresentation: () => 'bottom-sheet',
}));

describe('PeriodPicker on a phone', () => {
  it('opens the custom range as a bottom sheet with both fields and Apply', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { timezone: 'America/Los_Angeles' } });
    const onChange = vi.fn();
    const u = userEvent.setup();
    renderWithProviders(
      <PeriodPicker period={{ key: '30', from: '2026-09-12', to: '2026-10-12' }} onChange={onChange} />,
    );

    await u.click(screen.getByRole('combobox', { name: 'Period' }));
    await u.click(await screen.findByRole('option', { name: 'Custom range' }));

    const sheet = await screen.findByRole('dialog', { name: 'Custom range' });
    expect(sheet).toHaveAttribute("data-slot", "sheet-content");
    expect(screen.getByLabelText('Start date')).toBeInTheDocument();
    expect(screen.getByLabelText('End date')).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith({ key: 'custom', from: '2026-09-12', to: '2026-10-12' });
  });
});
