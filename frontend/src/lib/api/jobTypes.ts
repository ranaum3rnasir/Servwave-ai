import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { createOrgListApi } from './orgListRows';

/** The Lists page's reads and writes of the Job types rows (V7-04a). */
export const jobTypeKeys = { all: ['job-types'] as const };
export const jobTypesApi = createOrgListApi('/api/job-types');

/**
 * Adds one entry to the organization's Job types list (`POST /api/job-types`), then refreshes the
 * organization record, which is where the forms read `job_type_options` from.
 *
 * Callers use `mutate` (never `mutateAsync`) and keep saving the record with the typed text: a
 * refused or failed add (duplicate, list full, no permission) must never block the lead.
 */
export function useAddJobType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.post('/api/job-types', { name }).then((r) => r.data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['organization'] }),
  });
}
