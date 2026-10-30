/**
 * useDeleteNote - the delete of a note on a job or a lead, shared by every surface that lists them (the job's Overview
 * notes card and Notes tab, and the Activity panel in the side rail of a job or a lead).
 *
 * It asks first (the delete cannot be undone, though the record's activity keeps the text), calls the record's own route,
 * and refreshes every list the note can show in: the job page's notes and the Activity panel's notes and timeline. The
 * caller renders `confirmDialog` once.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteNotePrompt } from '@/lib/confirmPrompts';

/** Invoice notes have no delete; the type admits them only because the Activity panel is shared with the invoice page. */
export type NoteRecordType = 'JOB' | 'LEAD' | 'INVOICE';

export function useDeleteNote(recordType: NoteRecordType, recordId: string) {
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();

  const remove = useMutation({
    mutationFn: async (noteId: string) => {
      await api.delete(`/api/${recordType.toLowerCase()}s/${recordId}/notes/${noteId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes', recordType, recordId] });
      queryClient.invalidateQueries({ queryKey: ['timeline', recordType, recordId] });
      if (recordType === 'JOB') {
        queryClient.invalidateQueries({ queryKey: ['job-notes-wt', recordId] });
        queryClient.invalidateQueries({ queryKey: ['job-timeline', recordId] });
      }
    },
    onError: (err) => {
      toast({
        variant: 'destructive',
        title: 'Delete failed',
        description: extractApiError(err as Error, 'Could not delete the note. Please try again.'),
      });
    },
  });

  const requestDelete = async (noteId: string) => {
    if (await confirm(deleteNotePrompt())) remove.mutate(noteId);
  };

  return { requestDelete, isDeleting: remove.isPending, confirmDialog };
}
