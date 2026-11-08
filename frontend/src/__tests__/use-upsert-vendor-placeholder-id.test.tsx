/**
 * The "Add Vendor" dialog stamps a brand-new vendor with a client-side
 * placeholder id (`vnd_new_<timestamp>`) so the optimistic row has a React
 * key before the server responds. useUpsertVendor posted that id as-is: the
 * backend's upsert treats any truthy `id` as an update and looked it up
 * against the UUID `vendors.id` column, throwing on the malformed value and
 * turning every "Add Vendor" save into a 500. The id must be stripped unless
 * it's a real server-issued UUID.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useUpsertVendor } from '@/lib/api/inventory';

const mockApi = vi.mocked(api);

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { vendor: {} } });
});

describe('useUpsertVendor — dialog placeholder id', () => {
  it('strips a client-synthesized `vnd_new_*` id before posting (create path)', async () => {
    const { result } = renderHook(() => useUpsertVendor(), { wrapper });

    result.current.mutate({ id: 'vnd_new_1753200000000', name: 'Acme', category: 'Locks' });

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0][1] as { id?: string };
    expect(body.id).toBeUndefined();
  });

  it('keeps a real server UUID id (update path)', async () => {
    const { result } = renderHook(() => useUpsertVendor(), { wrapper });
    const realId = 'e2000000-0000-0000-0000-000000000001';

    result.current.mutate({ id: realId, name: 'Acme Updated' });

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0][1] as { id?: string };
    expect(body.id).toBe(realId);
  });

  it('omits id entirely when none is given', async () => {
    const { result } = renderHook(() => useUpsertVendor(), { wrapper });

    result.current.mutate({ name: 'Acme' });

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const body = mockApi.post.mock.calls[0][1] as { id?: string };
    expect(body.id).toBeUndefined();
  });
});
