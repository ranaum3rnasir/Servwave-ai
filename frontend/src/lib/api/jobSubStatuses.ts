import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

/** SRVW-112 - an org-defined label under one FIXED JobStatus parent. */
export interface JobSubStatus {
  id: string;
  /** The parent JobStatus this label lives under. Immutable after create. */
  parent: string;
  label: string;
  sort_order: number;
}

export function useJobSubStatuses() {
  return useQuery<JobSubStatus[]>({
    queryKey: ['job-sub-statuses'],
    // The `?? []` matters: JobDetailPage mounts this hook inside six existing suites that mock
    // axios with a `{ data: {} }` fallthrough, and an undefined resolve makes React Query v5 log
    // "Query data cannot be undefined" in all six.
    queryFn: () => api.get('/api/job-sub-statuses').then((r) => r.data.job_sub_statuses ?? []),
  });
}

export function useCreateJobSubStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ parent, label }: { parent: string; label: string }) =>
      api.post('/api/job-sub-statuses', { parent, label }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job-sub-statuses'] }),
    onError: (err) =>
      toast({
        title: 'Could not add sub-status',
        description: extractApiError(err, 'Failed to add sub-status'),
        variant: 'destructive',
      }),
  });
}

export function useUpdateJobSubStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      api.patch(`/api/job-sub-statuses/${id}`, { label }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job-sub-statuses'] }),
    onError: (err) =>
      toast({
        title: 'Could not rename sub-status',
        description: extractApiError(err, 'Failed to rename sub-status'),
        variant: 'destructive',
      }),
  });
}

export function useDeleteJobSubStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/job-sub-statuses/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job-sub-statuses'] }),
    onError: (err) =>
      toast({
        title: 'Could not delete sub-status',
        description: extractApiError(err, 'Failed to delete sub-status'),
        variant: 'destructive',
      }),
  });
}

export function useReorderJobSubStatuses() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ parent, ordered_ids }: { parent: string; ordered_ids: string[] }) =>
      api.post('/api/job-sub-statuses/reorder', { parent, ordered_ids }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job-sub-statuses'] }),
    onError: (err) =>
      toast({
        title: 'Could not reorder sub-statuses',
        description: extractApiError(err, 'Failed to reorder sub-statuses'),
        variant: 'destructive',
      }),
  });
}
