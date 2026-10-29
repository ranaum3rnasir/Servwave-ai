import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import {
  useWorkflows,
  useToggleWorkflow,
  usePatchWorkflow,
  type ApiWorkflow,
} from './workflows';

const wrapper = (qc: QueryClient) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

const baseWorkflow: ApiWorkflow = {
  id: 'wf-1',
  name: 'Appointment reminder',
  status: 'DRAFT',
  is_enabled: false,
  trigger_type: 'JOB_SCHEDULED',
  trigger_config: null,
  send_window: 'ANYTIME',
  template_key: null,
  legacy_rule_id: null,
  published_at: null,
  last_triggered_at: null,
  trigger_count: 0,
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  steps: [],
  issues: [{ step_index: -1, path: 'steps', message: 'Add at least one step' }],
  has_unpublished_changes: false,
  published_version: null,
};

describe('useWorkflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches GET /api/workflows and returns the list', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [baseWorkflow] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useWorkflows(), { wrapper: wrapper(qc) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(api.get).toHaveBeenCalledWith('/api/workflows');
    expect(result.current.data).toEqual([baseWorkflow]);
  });
});

describe('useToggleWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs /api/workflows/:id/toggle and invalidates the workflows list', async () => {
    const published = { ...baseWorkflow, status: 'PUBLISHED' as const, is_enabled: true };
    vi.mocked(api.post).mockResolvedValue({ data: published });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useToggleWorkflow(), { wrapper: wrapper(qc) });

    await result.current.mutateAsync({ id: 'wf-1', is_enabled: true });

    expect(api.post).toHaveBeenCalledWith('/api/workflows/wf-1/toggle', { is_enabled: true });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workflows'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workflows', 'wf-1'] });
  });
});

describe('usePatchWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces the fresh issues / has_unpublished_changes from the response to the caller', async () => {
    const patched: ApiWorkflow = {
      ...baseWorkflow,
      status: 'PUBLISHED',
      steps: [{ id: 's1', position: 0, step_type: 'WAIT', config: { duration_minutes: 60 } }],
      issues: [],
      has_unpublished_changes: true,
    };
    vi.mocked(api.patch).mockResolvedValue({ data: patched });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => usePatchWorkflow(), { wrapper: wrapper(qc) });

    const response = await result.current.mutateAsync({
      id: 'wf-1',
      data: { steps: [{ step_type: 'WAIT', config: { duration_minutes: 60 } }] },
    });

    expect(api.patch).toHaveBeenCalledWith('/api/workflows/wf-1', {
      steps: [{ step_type: 'WAIT', config: { duration_minutes: 60 } }],
    });
    expect(response.issues).toEqual([]);
    expect(response.has_unpublished_changes).toBe(true);
  });
});
