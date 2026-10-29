/// <reference types="@testing-library/jest-dom/vitest" />
// The bridge dialer's outcome poll (useCallOutcome) settles only on a FINAL call.
//
// The 'end' webhook writes a finished row, but a 'starts' webhook writes the
// same call as `ringing` first (lib/ctm/ingest.ts callStatus). Stopping on the
// first row of any status would stop asking while the call is still going, and
// the dialer would never learn it ended. Only completed / voicemail / missed
// are final; ringing and active keep the poll alive.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import api from '@/lib/axios';
import { useCallOutcome } from '@/lib/api/communication';

const mockApi = vi.mocked(api);
const OUTCOME_URL = '/api/communication/calls/outcome';

let rowStatus: string | null = null;

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function outcomeCalls() {
  return mockApi.get.mock.calls.filter(([u]) => u === OUTCOME_URL).length;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  rowStatus = null;
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === OUTCOME_URL) {
      return { data: { call: rowStatus ? { id: 'ca-1', status: rowStatus, durationSec: 0 } : null } };
    }
    return { data: {} };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCallOutcome - stops asking only once the call is over', () => {
  it('keeps polling while the only row is the call-start (ringing) row', async () => {
    rowStatus = 'ringing';
    const since = new Date(Date.now()).toISOString();
    renderHook(() => useCallOutcome('+19294039424', since), { wrapper: wrapper() });
    await advance(0);
    const afterFirst = outcomeCalls();
    expect(afterFirst).toBe(1);

    await advance(15_000);
    expect(outcomeCalls()).toBeGreaterThanOrEqual(afterFirst + 2);
  });

  it('stops polling once the row is completed', async () => {
    rowStatus = 'completed';
    const since = new Date(Date.now()).toISOString();
    renderHook(() => useCallOutcome('+19294039424', since), { wrapper: wrapper() });
    await advance(0);
    expect(outcomeCalls()).toBe(1);

    await advance(15_000);
    expect(outcomeCalls()).toBe(1);
  });
});
