/**
 * Roles & Permissions S01.13 - the Timesheets report: whose punches it asks for follows Timesheets scope
 * (read from the person's switches, never a role name), and the punch log says where each clock-in and clock-out happened.
 * Nothing on the page is about clock-in location rules any more.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders, seedMySwitches } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { usePunches, useOtReviews, useUpsertOtReview } from '@/lib/api/timeclock';
import type { Punch } from '@/lib/timeclock/types';

vi.mock('@/lib/api/timeclock', () => ({
  usePunches: vi.fn(),
  useOtReviews: vi.fn(),
  useUpsertOtReview: vi.fn(),
}));
vi.mock('@/lib/api/shared/organization', () => ({ useOrganization: () => ({ data: { timezone: 'America/New_York' } }) }));
// Charts measure their container; jsdom has none.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

import TimesheetsReport from '../TimesheetsReport';

const mockUsePunches = vi.mocked(usePunches);

const PUNCHES: Punch[] = [
  { id: 'p1', userId: 'u1', userName: 'Tess Tech', type: 'IN', ts: Date.UTC(2026, 6, 10, 13, 0), lat: 30.2672, lng: -97.7431, accuracyM: 9 },
  { id: 'p2', userId: 'u1', userName: 'Tess Tech', type: 'OUT', ts: Date.UTC(2026, 6, 10, 21, 0), lat: 40.7128, lng: -74.006, accuracyM: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockUsePunches.mockReturnValue({ data: PUNCHES } as ReturnType<typeof usePunches>);
  vi.mocked(useOtReviews).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useOtReviews>);
  vi.mocked(useUpsertOtReview).mockReturnValue({ mutateAsync: vi.fn() } as unknown as ReturnType<typeof useUpsertOtReview>);
});

describe('Timesheets report', () => {
  it.each(['all', 'team'])('asks for the organisation\'s punches when Timesheets scope is %s', (scope) => {
    seedMySwitches({ timesheets_scope: scope });
    renderWithProviders(<TimesheetsReport />, { ability: buildAbility([{ action: 'read', subject: 'Report' }]) });
    expect(mockUsePunches).toHaveBeenCalledWith({ scope: 'org' });
    expect(vi.mocked(useOtReviews)).toHaveBeenCalledWith({ scope: 'org' });
  });

  it('asks only for the own punches on Attached, whatever the base role', () => {
    seedMySwitches({ timesheets_scope: 'attached' });
    renderWithProviders(<TimesheetsReport />, { ability: buildAbility([{ action: 'read', subject: 'Report' }]) });
    expect(mockUsePunches).toHaveBeenCalledWith({ scope: 'me' });
    expect(vi.mocked(useOtReviews)).toHaveBeenCalledWith({ scope: 'me' });
  });

  it('shows where each clock-in and clock-out happened, and no location rules', () => {
    seedMySwitches({ timesheets_scope: 'all' });
    renderWithProviders(<TimesheetsReport />, { ability: buildAbility([{ action: 'read', subject: 'Report' }]) });
    expect(screen.getByText('30.2672, -97.7431')).toBeInTheDocument();
    expect(screen.getByText('40.7128, -74.0060')).toBeInTheDocument();
    expect(screen.queryByText(/in-zone|in zone|override|work zone/i)).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Location' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Job time' })).toBeNull();
  });
});
