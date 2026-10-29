// Caller ID slice 03 - the shared caller-ID save hooks can stay quiet.
//
// The side panel's Save makes several calls as one change, so those calls must
// not each toast (several toasts, or a success and an error side by side on a
// partial failure) or each refetch. `quiet: true` hands both to the caller.
// Without it a hook still reports its own outcome and refetches, as slice 02
// made every caller-ID save do.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { Toaster as KitToaster, toast } from '@/ui-kit/components/ui/sonner';
import { useSetNumberAssignments, useSetUserDefaultNumber } from '@/lib/api/phoneNumbers';

const mockApi = vi.mocked(api);
const LIST_KEY = ['communication', 'number-assignments'];

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  qc.setQueryData(LIST_KEY, {
    numbers: [{ id: 'num-1', e164: '+15552014410', label: null, is_org_default: false, sms_enabled: true, status: 'active', type: 'local', assignments: [] }],
    users: [],
  });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      {children}
      <KitToaster />
    </QueryClientProvider>
  );
  return { wrapper, invalidate };
}

const toastCount = () => document.querySelectorAll('[data-sonner-toast]').length;

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.put.mockResolvedValue({ data: { ok: true } });
});
afterEach(() => {
  toast.dismiss();
});

describe('useSetNumberAssignments', () => {
  it('reports its own outcome and refetches by default', async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSetNumberAssignments(), { wrapper });

    await act(() => result.current.mutateAsync({ id: 'num-1', userIds: ['u-1'] }));

    expect(await screen.findByText('Saved. 1 person can use (555) 201-4410')).toBeInTheDocument();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: LIST_KEY }));
  });

  it('with quiet: true shows no toast, on success or failure, and leaves the refetch to the caller', async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSetNumberAssignments({ quiet: true }), { wrapper });

    await act(() => result.current.mutateAsync({ id: 'num-1', userIds: ['u-1'] }));
    mockApi.put.mockRejectedValueOnce(new Error('Network Error'));
    await act(() => result.current.mutateAsync({ id: 'num-1', userIds: [] }).catch(() => undefined));
    await new Promise((r) => setTimeout(r, 50));

    expect(toastCount()).toBe(0);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('useSetUserDefaultNumber', () => {
  it('reports its own outcome and refetches by default', async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSetUserDefaultNumber(), { wrapper });

    await act(() => result.current.mutateAsync({ userId: 'u-1', phoneNumberId: 'num-1' }));

    expect(await screen.findByText('Default number saved')).toBeInTheDocument();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: LIST_KEY }));
  });

  it('with quiet: true shows no toast, on success or failure, and leaves the refetch to the caller', async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useSetUserDefaultNumber({ quiet: true }), { wrapper });

    await act(() => result.current.mutateAsync({ userId: 'u-1', phoneNumberId: 'num-1' }));
    mockApi.put.mockRejectedValueOnce(new Error('Network Error'));
    await act(() => result.current.mutateAsync({ userId: 'u-1', phoneNumberId: null }).catch(() => undefined));
    await new Promise((r) => setTimeout(r, 50));

    expect(toastCount()).toBe(0);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
