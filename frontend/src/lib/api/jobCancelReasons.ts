import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

/**
 * The organisation's job cancel reasons (Roles & Permissions, S06.14): the job twin of the estimate decline reasons in
 * `lostReasonOptions.ts`, on a route and a cache key of its own, so editing one list never touches the other.
 *
 * Keyed on `code`, not a row id: an organisation that has never edited its list reads the six built-ins, which exist
 * only in code until the first edit writes them.
 */
export interface JobCancelReason {
  /** The stored value. Immutable - a cancelled job holds this string. */
  code: string;
  /** The words the cancel dialogs show. Renameable. */
  label: string;
  is_active: boolean;
  sort_order: number;
  /** One of the six ServWave ships with: renameable and switchable, never removable. */
  is_builtin: boolean;
}

const KEY = ['job-cancel-reasons'];

export function useJobCancelReasons() {
  return useQuery<JobCancelReason[]>({
    queryKey: KEY,
    // `?? []`: a suite that mocks axios with a bare `{ data: {} }` would otherwise resolve undefined.
    queryFn: () => api.get('/api/job-cancel-reasons').then((r) => r.data.job_cancel_reasons ?? []),
  });
}

/**
 * The reasons a cancel dialog offers: this org's ACTIVE reasons, in the settings order, as select options. The same one
 * reader of GET /api/job-cancel-reasons the settings page uses (the list there also holds the turned-off ones, which a
 * new cancel may not use), so there is one cache entry and a rename shows in both at once. `loading` is true until the
 * list has arrived: a dialog must not offer an empty picker as if the company had no reasons.
 */
export function useOfferedJobCancelReasons(): { options: { value: string; label: string }[]; loading: boolean } {
  const { data, isLoading } = useJobCancelReasons();
  const options = useMemo(() => (data ?? []).filter((r) => r.is_active).map((r) => ({ value: r.code, label: r.label })), [data]);
  return { options, loading: isLoading };
}

export function useCreateJobCancelReason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ label }: { label: string }) =>
      api.post('/api/job-cancel-reasons', { label }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (err) =>
      toast({
        title: 'Could not add that reason',
        description: extractApiError(err, 'Failed to add the cancel reason'),
        variant: 'destructive',
      }),
  });
}

/** Rename, switch off, or switch back on. The server refuses to switch "Other" off. */
export function useUpdateJobCancelReason() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, ...body }: { code: string; label?: string; is_active?: boolean }) =>
      api.patch(`/api/job-cancel-reasons/${code}`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (err) =>
      toast({
        title: 'Could not update that reason',
        description: extractApiError(err, 'Failed to update the cancel reason'),
        variant: 'destructive',
      }),
  });
}

export function useReorderJobCancelReasons() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ordered_codes }: { ordered_codes: string[] }) =>
      api.post('/api/job-cancel-reasons/reorder', { ordered_codes }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (err) =>
      toast({
        title: 'Could not reorder the reasons',
        description: extractApiError(err, 'Failed to reorder the cancel reasons'),
        variant: 'destructive',
      }),
  });
}
