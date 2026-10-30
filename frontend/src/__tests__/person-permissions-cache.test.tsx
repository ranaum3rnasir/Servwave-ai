/**
 * Roles & Permissions, PRD 2, S02.9 - a person's Permissions page never shows a set a role change has since replaced.
 *
 * A role change fills the person's switches and moves who they are based on, and the Roles page edits the set a person
 * is based on, so a person's cached set is stale after either. The page must read afresh the next time it is opened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { usePersonSwitches, useSaveRoleSwitches } from '@/lib/api/permissionSwitches';
import { useUpdateUser } from '@/lib/api/users';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const mockApi = vi.mocked(api);

const personAnswer = (role: string) => ({
  user_id: 'u1', admin_box: false, editable: true, based_on: { key: role, label: role, type: 'built_in' }, values: {}, differences: [], difference_count: 0,
});

/** The app's own client keeps an answer fresh for five minutes; the page is reopened inside that window. */
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return Wrapper;
}

let basedOn = 'DISPATCHER';

beforeEach(() => {
  vi.clearAllMocks();
  basedOn = 'DISPATCHER';
  mockApi.get.mockImplementation(() => Promise.resolve({ data: personAnswer(basedOn) }));
  mockApi.patch.mockResolvedValue({ data: { user: { id: 'u1' } } });
  mockApi.put.mockResolvedValue({ data: { role: 'DISPATCHER', values: {} } });
});

describe("a person's cached Permissions set", () => {
  it("is read again after the person's role is changed", async () => {
    const { result } = renderHook(() => ({ person: usePersonSwitches('u1'), update: useUpdateUser() }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.person.data?.based_on?.key).toBe('DISPATCHER'));

    basedOn = 'SALES';
    await act(async () => { await result.current.update.mutateAsync({ id: 'u1', payload: { role: 'SALES' } }); });

    await waitFor(() => expect(result.current.person.data?.based_on?.key).toBe('SALES'));
  });

  it('is read again after the Roles page saves the role the person is based on', async () => {
    const { result } = renderHook(() => ({ person: usePersonSwitches('u1'), save: useSaveRoleSwitches() }), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.person.data?.based_on?.key).toBe('DISPATCHER'));

    basedOn = 'DISPATCHER_V2';
    await act(async () => { await result.current.save.mutateAsync({ role: 'DISPATCHER', values: {} }); });

    await waitFor(() => expect(result.current.person.data?.based_on?.key).toBe('DISPATCHER_V2'));
  });
});
