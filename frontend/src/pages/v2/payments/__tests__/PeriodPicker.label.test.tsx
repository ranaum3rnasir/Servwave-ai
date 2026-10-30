import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';

import { PeriodPicker } from '../components/PeriodPicker';

// 2027-01-01 03:00 UTC is still Dec 31, 2026 in Los Angeles: the org's year is 2026, the browser's UTC year is 2027.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-01T03:00:00Z'));
  vi.mocked(api.get).mockResolvedValue({ data: { timezone: 'America/Los_Angeles' } });
});
afterEach(() => vi.useRealTimers());

describe('PeriodPicker custom label', () => {
  it('leaves the year off a range in the organization\'s current year, read in the organization\'s zone', async () => {
    renderWithProviders(<PeriodPicker period={{ key: 'custom', from: '2026-12-01', to: '2026-12-05' }} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: /Period/ })).toHaveTextContent(/^Dec 1 - Dec 5$/));
  });
});
