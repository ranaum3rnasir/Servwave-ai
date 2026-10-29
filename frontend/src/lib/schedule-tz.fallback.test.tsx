/**
 * `useScheduleTimezone()`'s fallback answers TWO different questions, and only one of them is a
 * defect:
 *
 *   A. `org === undefined` - the query is in flight (or has failed). Guessing Eastern here is a
 *      lie, and Defect C is the three write-path forms that bake that guess into persisted state.
 *      Fixed at those three seeds, not here.
 *   B. `org.timezone === null` - the org has loaded and simply has no zone configured.
 *      `Organization.timezone` is nullable, and this fallback is the right answer.
 *
 * This file pins B. It PASSES before the fix as well as after - a characterisation test, stated
 * as one rather than dressed up as red. It exists so that a later attempt to "fix" the hook by
 * returning `undefined` while loading trips here first, instead of silently breaking
 * `__tests__/jobs-page.test.tsx` (which depends on B) and, worse, throwing
 * `RangeError: Invalid time zone specified: undefined` out of the date-fns-tz helpers that have
 * required a `timeZone` since #1804.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { DEFAULT_SCHEDULE_TIMEZONE, useScheduleTimezone } from '@/lib/schedule-tz';

interface OrgQueryState {
  data: { id: string; timezone: string | null } | undefined;
  isLoading: boolean;
  isError: boolean;
}

const orgMock = vi.hoisted(() => ({
  state: { data: undefined, isLoading: true, isError: false } as OrgQueryState,
}));

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => orgMock.state };
});

describe('useScheduleTimezone - the fallback covers two cases and must keep covering the legitimate one', () => {
  it('still falls back when the org has loaded with no timezone configured', () => {
    orgMock.state = { data: { id: 'org-1', timezone: null }, isLoading: false, isError: false };

    const { result } = renderHook(() => useScheduleTimezone());

    expect(result.current).toBe(DEFAULT_SCHEDULE_TIMEZONE);
  });

  it('returns the org zone once the query has answered with one', () => {
    orgMock.state = { data: { id: 'org-1', timezone: 'America/Denver' }, isLoading: false, isError: false };

    const { result } = renderHook(() => useScheduleTimezone());

    expect(result.current).toBe('America/Denver');
  });

  // Stated, not endorsed: this IS the loading lie. The hook keeps its `string` return type on
  // purpose (53 call sites, and a runtime RangeError if any one of them missed the widening), so
  // the repair belongs at the seeds that persist this value, not here.
  it('answers the Eastern default while the org query is still in flight', () => {
    orgMock.state = { data: undefined, isLoading: true, isError: false };

    const { result } = renderHook(() => useScheduleTimezone());

    expect(result.current).toBe(DEFAULT_SCHEDULE_TIMEZONE);
  });
});
