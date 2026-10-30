import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';

import { PeriodPicker } from '../components/PeriodPicker';

// The phone sheet is anchored to the bottom edge, so anything above the footer moves when the sheet's height
// changes. Blurring a bad field commits its text and clears the message; if that shrinks the sheet between
// pointerdown and click, the first tap on the other field lands on the sheet instead.
vi.mock('@/ui-kit/hooks/useOverlayPresentation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/hooks/useOverlayPresentation')>()),
  useOverlayPresentation: () => 'bottom-sheet',
}));

describe('PeriodPicker custom range error line on a phone', () => {
  it('keeps the error line mounted and its height reserved after the message clears', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { timezone: 'America/Los_Angeles' } });
    const u = userEvent.setup();
    renderWithProviders(
      <PeriodPicker period={{ key: 'custom', from: '2026-10-12', to: '2026-09-12' }} onChange={vi.fn()} />,
    );

    await u.click(screen.getByRole('combobox', { name: /Period/ }));
    await u.click(await screen.findByRole('option', { name: 'Custom range' }));
    await u.click(await screen.findByRole('button', { name: 'Apply' }));

    const alert = await screen.findByRole('alert');
    const slot = alert.parentElement as HTMLElement;
    expect(slot).toHaveAttribute('data-testid', 'range-error-slot');
    const reserved = slot.className;
    expect(reserved).toMatch(/min-h-/);

    // One tap on the other field blurs the bad one; its blur commits and clears the message. The sheet's
    // focus trap grabs the dialog when a node is removed while focus sits on the body, so nothing may be removed.
    const end = screen.getByLabelText('End date');
    await u.clear(end);
    await u.type(end, '10/20/2026');
    const removed: Node[] = [];
    const watch = new MutationObserver((records) => records.forEach((r) => removed.push(...Array.from(r.removedNodes))));
    watch.observe(screen.getByRole('dialog', { name: 'Custom range' }), { childList: true, subtree: true });
    await u.click(screen.getByLabelText('Start date'));
    watch.takeRecords().forEach((r) => removed.push(...Array.from(r.removedNodes)));
    watch.disconnect();
    expect(removed).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();

    const after = screen.getAllByTestId('range-error-slot');
    expect(after).toContain(slot);
    expect(slot.isConnected).toBe(true);
    expect(slot.className).toBe(reserved);
    expect(screen.getByLabelText('Start date')).toBe(document.activeElement);
  });
});
