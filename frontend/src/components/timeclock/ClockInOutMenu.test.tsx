/**
 * Roles & Permissions S01.13 - clock in and out are never held to a place: the menu sends where the person is
 * and nothing else, with no override request and no out-of-zone step.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { useIsClockedIn, useRecordPunch } from '@/lib/api/timeclock';

vi.mock('@/lib/api/timeclock', () => ({ useIsClockedIn: vi.fn(), useRecordPunch: vi.fn() }));

import ClockInOutMenu from './ClockInOutMenu';

const mutateAsync = vi.fn();

function placeTheDeviceAt(lat: number, lng: number) {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok: (p: unknown) => void) => ok({ coords: { latitude: lat, longitude: lng, accuracy: 12 } }),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mutateAsync.mockResolvedValue({});
  vi.mocked(useIsClockedIn).mockReturnValue({ isClockedIn: false, sinceTs: null, isLoading: false });
  vi.mocked(useRecordPunch).mockReturnValue({ mutateAsync, isPending: false } as unknown as ReturnType<typeof useRecordPunch>);
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'geolocation');
});

describe('ClockInOutMenu', () => {
  it('clocks in from anywhere, sending only where the person is', async () => {
    placeTheDeviceAt(40.7128, -74.006);
    renderWithProviders(<ClockInOutMenu />);

    await userEvent.setup().click(screen.getByRole('button', { name: /clock in/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({ type: 'IN', lat: 40.7128, lng: -74.006, accuracy_m: 12 });
    expect(screen.queryByText(/override/i)).toBeNull();
  });

  it('offers no manager override step, however the server answers', async () => {
    placeTheDeviceAt(40.7128, -74.006);
    // The old out-of-zone answer: the menu must not turn it into an override request.
    mutateAsync.mockRejectedValueOnce({ response: { status: 422, data: { requiresOverride: true } } });
    renderWithProviders(<ClockInOutMenu />);

    await userEvent.setup().click(screen.getByRole('button', { name: /clock in/i }));

    await screen.findByText(/couldn.t clock in/i);
    expect(screen.queryByRole('button', { name: /override/i })).toBeNull();
    expect(screen.queryByText(/closer to clock in/i)).toBeNull();
  });
});
