/**
 * Roles & Permissions security review, CR-14 - the Users & Teams role column counts how many switches each person has
 * changed from their role. Saving or resetting a role moves what those counts are measured against, so the people list
 * must be read again, as it already is after a person-side save.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useSaveRoleSwitches } from '@/lib/api/permissionSwitches';
import { useResetRole } from '@/lib/api/roles';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return Wrapper;
}

let peopleReads = 0;

/** The people list under the key the Users & Teams page reads it by (lib/api/users.ts). */
const usePeople = () => useQuery({ queryKey: ['users', 'all'], queryFn: async () => ++peopleReads });

beforeEach(() => {
  vi.clearAllMocks();
  peopleReads = 0;
  mockApi.put.mockResolvedValue({ data: { role: 'DISPATCHER', values: {} } });
  mockApi.post.mockResolvedValue({ data: { role: 'DISPATCHER', values: {} } });
  mockApi.get.mockResolvedValue({ data: [] });
});

describe('the Users & Teams people list', () => {
  it('is read again after a role is saved', async () => {
    const { result } = renderHook(() => ({ people: usePeople(), save: useSaveRoleSwitches() }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.people.data).toBe(1));
    await act(async () => { await result.current.save.mutateAsync({ role: 'DISPATCHER', values: {} }); });
    await waitFor(() => expect(result.current.people.data).toBe(2));
  });

  it('is read again after a role is reset', async () => {
    const { result } = renderHook(() => ({ people: usePeople(), reset: useResetRole() }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.people.data).toBe(1));
    await act(async () => { await result.current.reset.mutateAsync('DISPATCHER'); });
    await waitFor(() => expect(result.current.people.data).toBe(2));
  });
});
