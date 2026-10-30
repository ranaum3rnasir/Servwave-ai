import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { usePunches } from '@/lib/api/timeclock';
import MyTimeLog from '@/components/timeclock/MyTimeLog';
import type { Punch } from '@/lib/timeclock/types';

vi.mock('@/lib/api/timeclock', () => ({ usePunches: vi.fn() }));
const mockUsePunches = vi.mocked(usePunches);

// Synthetic fixture matching lib/timeclock/types.ts Punch (no real PII).
function punch(over: Partial<Punch>): Punch {
  return {
    id: 'p1',
    userId: 'u1',
    userName: 'Test User',
    type: 'IN',
    ts: 0,
    lat: 0,
    lng: 0,
    accuracyM: null,
    ...over,
  };
}

const T = new Date('2026-07-10T09:00:00').getTime();

beforeEach(() => vi.clearAllMocks());

describe('MyTimeLog', () => {
  it('renders a closed session row with clock-in/out times and total hours', () => {
    mockUsePunches.mockReturnValue({
      data: [
        punch({ id: 'p1', type: 'IN', ts: T }),
        punch({ id: 'p2', type: 'OUT', ts: T + 90 * 60000 }),
      ],
      isLoading: false,
    } as ReturnType<typeof usePunches>);
    renderWithProviders(<MyTimeLog />);
    expect(screen.getByText('Time In & Time Out')).toBeInTheDocument();
    // 90-minute session → 1.5h appears as both the row Hours and the total.
    expect(screen.getAllByText('1.5h').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/total hours worked/i)).toBeInTheDocument();
  });

  it('shows where each clock-in and clock-out happened', () => {
    mockUsePunches.mockReturnValue({
      data: [
        punch({ id: 'p1', type: 'IN', ts: T, lat: 30.2672, lng: -97.7431 }),
        punch({ id: 'p2', type: 'OUT', ts: T + 90 * 60000, lat: 40.7128, lng: -74.006 }),
      ],
      isLoading: false,
    } as ReturnType<typeof usePunches>);
    renderWithProviders(<MyTimeLog />);
    expect(screen.getByText('30.2672, -97.7431')).toBeInTheDocument();
    expect(screen.getByText('40.7128, -74.0060')).toBeInTheDocument();
  });

  it('marks an open session as On the clock with no hours yet', () => {
    mockUsePunches.mockReturnValue({
      data: [punch({ id: 'p1', type: 'IN', ts: T })],
      isLoading: false,
    } as ReturnType<typeof usePunches>);
    renderWithProviders(<MyTimeLog />);
    expect(screen.getByText('On the clock')).toBeInTheDocument();
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('shows the empty state when there are no punches', () => {
    mockUsePunches.mockReturnValue({ data: [], isLoading: false } as ReturnType<typeof usePunches>);
    renderWithProviders(<MyTimeLog />);
    expect(screen.getByText('No clock-in activity yet.')).toBeInTheDocument();
  });
});
