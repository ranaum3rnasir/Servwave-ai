import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useAssignableUsers } from './users';

/** One client per render so a test's cache never leaks into the next. */
const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe('useAssignableUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue({ data: [] });
  });

  // The whole point of the slice: the roster is NOT the user directory. The directory is
  // gated on `read User`, which SALES does not hold, so hitting it 403s a rep's pickers
  // into "No more members".
  it('reads the scoped roster endpoint, never the user directory', async () => {
    renderHook(() => useAssignableUsers({ purpose: 'walkthroughPerformer' }), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(api.get).not.toHaveBeenCalledWith('/api/users', expect.anything());
    expect(api.get).toHaveBeenCalledWith('/api/users/assignable', expect.anything());
  });

  it('always sends the purpose — it selects the grant the server scopes by', async () => {
    renderHook(() => useAssignableUsers({ purpose: 'walkthroughPerformer' }), { wrapper });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/users/assignable', {
        params: { purpose: 'walkthroughPerformer' },
      }),
    );
  });

  it('threads department_id + eligible_for alongside the purpose', async () => {
    renderHook(
      () => useAssignableUsers({ purpose: 'jobCrew', departmentId: 'dept-1', eligibleFor: 'owner' }),
      { wrapper },
    );
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/users/assignable', {
        params: { purpose: 'jobCrew', department_id: 'dept-1', eligible_for: 'owner' },
      }),
    );
  });

  it('sends eligible_for=task for the task owner/watchers pool (#434)', async () => {
    renderHook(() => useAssignableUsers({ purpose: 'task', eligibleFor: 'task' }), { wrapper });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/users/assignable', {
        params: { purpose: 'task', eligible_for: 'task' },
      }),
    );
  });

  it('sends include_referenced_in for the completeness filters', async () => {
    renderHook(() => useAssignableUsers({ purpose: 'jobCrew', includeReferencedIn: 'jobs' }), {
      wrapper,
    });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/users/assignable', {
        params: { purpose: 'jobCrew', include_referenced_in: 'jobs' },
      }),
    );
  });

  it('omits optional params when not given', async () => {
    renderHook(() => useAssignableUsers({ purpose: 'jobCrew' }), { wrapper });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/users/assignable', {
        params: { purpose: 'jobCrew' },
      }),
    );
  });

  it('unwraps the bare array the endpoint returns (no { users } envelope)', async () => {
    const roster = [{ id: 'u1', first_name: 'Sam', last_name: 'Reyes', role: 'SALES', department: null }];
    vi.mocked(api.get).mockResolvedValue({ data: roster });
    const { result } = renderHook(() => useAssignableUsers({ purpose: 'walkthroughPerformer' }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.data).toEqual(roster));
  });

  // Transitional, and the reason it is worth a test: 21 suites still mock axios with the
  // old directory envelope. Delete this alongside the `{ users }` branch in `rosterOf`.
  it('still unwraps a { users } envelope while the old mocks survive', async () => {
    const roster = [{ id: 'u1', first_name: 'Sam', last_name: 'Reyes', role: 'SALES', department: null }];
    vi.mocked(api.get).mockResolvedValue({ data: { users: roster } });
    const { result } = renderHook(() => useAssignableUsers({ purpose: 'jobCrew' }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(roster));
  });

  // Every picker calls .filter/.map straight off this, so a shape the hook does not
  // recognise must land as an empty roster, never as a value that throws through render.
  it('yields an array for an unrecognised payload rather than letting a picker throw', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { unexpected: true } });
    const { result } = renderHook(() => useAssignableUsers({ purpose: 'task' }), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it('does not fetch when disabled', () => {
    renderHook(() => useAssignableUsers({ purpose: 'task', enabled: false }), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('sends the directory purpose as `directory`', async () => {
    renderHook(() => useAssignableUsers({ purpose: 'directory', eligibleFor: 'task' }), { wrapper });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/users/assignable', {
        params: { purpose: 'directory', eligible_for: 'task' },
      }),
    );
  });

  // Every purpose is scoped by a DIFFERENT grant — `assign User` for crew and performers,
  // `assign Task` for tasks, `read User` for the directory read. Sharing a cache entry would let
  // whichever resolved last overwrite the others, and a holder of one grant but not another would
  // see the wrong pool in a picker. `directory` is in here rather than assumed: it was added after
  // the other three, and the key is a hand-written array, so "the new value is part of the key" is
  // exactly the kind of thing that is true until someone edits the array.
  it('keys the cache by purpose, so no two purposes share one entry', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sharedWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    vi.mocked(api.get).mockImplementation((_url, config) => {
      const purpose = (config?.params as { purpose?: string } | undefined)?.purpose;
      return Promise.resolve({
        data: [{ id: `only-${purpose}`, first_name: 'A', last_name: 'B', role: 'SALES', department: null }],
      });
    });

    const crew = renderHook(() => useAssignableUsers({ purpose: 'jobCrew' }), {
      wrapper: sharedWrapper,
    });
    await waitFor(() => expect(crew.result.current.data).toBeDefined());

    const task = renderHook(() => useAssignableUsers({ purpose: 'task' }), {
      wrapper: sharedWrapper,
    });
    await waitFor(() => expect(task.result.current.data).toBeDefined());

    const directory = renderHook(() => useAssignableUsers({ purpose: 'directory' }), {
      wrapper: sharedWrapper,
    });
    await waitFor(() => expect(directory.result.current.data).toBeDefined());

    expect(api.get).toHaveBeenCalledTimes(3);
    expect(crew.result.current.data?.[0]?.id).toBe('only-jobCrew');
    expect(task.result.current.data?.[0]?.id).toBe('only-task');
    expect(directory.result.current.data?.[0]?.id).toBe('only-directory');
  });
});
