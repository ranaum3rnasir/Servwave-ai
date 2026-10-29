import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useUpdateDepartment } from './departments';

const wrapper = (qc: QueryClient) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

describe('useUpdateDepartment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PATCHes /api/departments/:id with the new name', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: { department: { id: 'd1', name: 'Plumbing', created_at: '' } } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useUpdateDepartment(), { wrapper: wrapper(qc) });

    await result.current.mutateAsync({ id: 'd1', name: 'Plumbing' });

    expect(api.patch).toHaveBeenCalledWith('/api/departments/d1', { name: 'Plumbing' });
  });

  it('invalidates the departments query on success', async () => {
    vi.mocked(api.patch).mockResolvedValue({ data: { department: { id: 'd1', name: 'HVAC', created_at: '' } } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateDepartment(), { wrapper: wrapper(qc) });

    await result.current.mutateAsync({ id: 'd1', name: 'HVAC' });

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['departments'] }),
    );
  });
});
