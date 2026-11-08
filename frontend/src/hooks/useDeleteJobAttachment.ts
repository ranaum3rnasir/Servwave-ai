/**
 * useDeleteJobAttachment - shared delete mutation for the two job attachment surfaces
 * (`JobFilesCard` on the Overview tab and `AttachmentsTabBody` on the Attachments tab).
 *
 * Both render the SAME `['job-attachments-wt', jobId]` query, so a delete from either has to
 * invalidate both that key and `['attachments', 'JOB', jobId]` - exactly the pair their existing
 * upload handlers already invalidate. Extracted rather than duplicated so the two surfaces cannot
 * drift on which keys they refresh.
 *
 * Lead-sourced files are deliberately NOT deletable from a job: they belong to the lead and are
 * only forwarded in via `include_lead=true`, so deleting one here would silently remove it from
 * the lead too. Callers gate on `isDeletableFromJob` before rendering a delete control.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

/**
 * Keyed on `source` alone. The old test also OR'd in `context === 'WALKTHROUGH'`, which was
 * only ever a proxy for "came from the lead" back when WALKTHROUGH was the single context the
 * API forwarded. Every lead context now travels, so context no longer identifies a lead file -
 * keeping that clause would have left context=OTHER lead files looking deletable here, showing
 * a delete control whose request can only 404 (the route is scoped to entity_type=JOB).
 * `source` is absent when the list was fetched without include_lead, and in that case the list
 * holds nothing but the job's own rows - so the undefined case correctly reads as deletable.
 */
export function isDeletableFromJob(att: { context?: string | null; source?: string | null }): boolean {
  return att.source !== 'LEAD';
}

export function useDeleteJobAttachment(jobId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (attachmentId: string) => {
      await api.delete(`/api/attachments/job/${jobId}/${attachmentId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job-attachments-wt', jobId] });
      queryClient.invalidateQueries({ queryKey: ['attachments', 'JOB', jobId] });
    },
    onError: (err) => {
      toast({
        variant: 'destructive',
        title: 'Delete failed',
        description: extractApiError(err as Error, 'Could not delete the file. Please try again.'),
      });
    },
  });
}
