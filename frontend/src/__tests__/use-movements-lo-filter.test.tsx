/**
 * useMovements → logistic_order_id. The movements endpoint has accepted this
 * filter since LO-2, but nothing in the frontend could send it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useMovements } from '@/lib/api/inventory';

const mockApi = vi.mocked(api);

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: { data: [], meta: {} } });
});

describe('useMovements — Logistic Order filter', () => {
  it('sends logistic_order_id when logisticOrderId is set', async () => {
    renderHook(() => useMovements({ logisticOrderId: 'lo-uuid-1' }), { wrapper });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(mockApi.get.mock.calls[0][1]!.params.logistic_order_id).toBe('lo-uuid-1');
  });

  it('omits the key entirely when it is unset', async () => {
    renderHook(() => useMovements({}), { wrapper });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(mockApi.get.mock.calls[0][1]!.params.logistic_order_id).toBeUndefined();
  });
});
