import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';

import { DisputeDeadline } from '../components/DisputeDeadline';
import { mockApi } from './disputeFixtures';

const HOUR = 3_600_000;

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.get.mockResolvedValue({ data: { timezone: 'America/Los_Angeles' } });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

const at = (ms: number) => new Date(Date.now() + ms).toISOString();

describe('DisputeDeadline', () => {
  it('words the time with the shared helper, and is red and urgent under 48 hours', () => {
    renderWithProviders(<DisputeDeadline respondBy={at(40 * HOUR + 600_000)} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('40 hours left');
    expect(banner).toHaveAttribute('data-tone', 'danger');
  });

  it('is the warning tone, in whole days rounded down, from 48 hours', () => {
    renderWithProviders(<DisputeDeadline respondBy={at(72 * HOUR + 23 * HOUR)} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('3 days left');
    expect(banner).toHaveAttribute('data-tone', 'warning');
  });

  it('carries the deadline, date and time, in the organization time zone', async () => {
    // 2026-10-20 18:00Z is 11:00 AM in Los Angeles.
    renderWithProviders(<DisputeDeadline respondBy="2026-10-20T18:00:00.000Z" />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Respond by Oct 20, 2026, 11:00 AM'));
  });

  it('reads Past due once the deadline has passed', () => {
    renderWithProviders(<DisputeDeadline respondBy={at(-HOUR)} />);
    expect(screen.getByRole('status')).toHaveTextContent('Past due');
  });

  it('updates after a minute of the clock, and clears its timer on unmount', () => {
    const { unmount } = renderWithProviders(<DisputeDeadline respondBy={at(48 * HOUR + 30_000)} />);
    expect(screen.getByRole('status')).toHaveTextContent('2 days left');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByRole('status')).toHaveTextContent('47 hours left');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
