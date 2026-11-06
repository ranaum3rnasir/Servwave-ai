import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { StickyNote } from 'lucide-react';

import api from '@/lib/axios';
import { TextLengthCounter } from '@/components/form';
import { LONG_TEXT_MAX, tooLongMessage } from '@/lib/textLimits';
import { getInitials } from '@/lib/utils';
import { NoteDeleteButton } from '@/components/notes/NoteDeleteButton';
import { NoteEditedMark, type NoteEditMarks } from '@/components/notes/NoteEditedMark';
import { useDeleteNote } from '@/lib/notes/useDeleteNote';
import type { NoteDeleteAnswer } from '@/lib/notes/noteChange';
import { useFieldDraft } from '@/lib/drafts/useFieldDraft';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui-kit/components/ui/card';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { DraftRestoredNote } from '@/ui-kit/components/ui/draftRestoredNote';

export interface RecordNoteItem extends NoteDeleteAnswer, NoteEditMarks {
  id: string;
  content: string;
  created_at: string;
  creator: { id: string; first_name: string; last_name: string };
  /** `LEAD` on a job's list marks a note carried over from the lead ("From Lead"). */
  source?: string | null;
}

/**
 * The notes composer and feed, shared by the job's and the lead's Notes tab: the "Add note" box, the "Notes (N)"
 * list newest first, the per-note delete that follows the server's per-note answer, and the kept unsent text (keyed
 * on the record type and id, so a tab switch or a reload does not lose it).
 *
 * The mutation, its invalidations, the Cmd/Ctrl+Enter submit and the newest-first sort are the job tab's, unchanged.
 */
export function RecordNotesTab({
  recordType,
  recordId,
  notes,
  canAddNotes,
}: {
  recordType: 'JOB' | 'LEAD';
  recordId: string;
  notes: RecordNoteItem[] | undefined;
  /** The record's own answer for adding a note (the job's / the lead's `add_note`). Without it the tab is
   *  read-only rather than absent: the history still reads, and no composer is offered
   *  whose submit the API is guaranteed to reject. */
  canAddNotes: boolean;
}) {
  const queryClient = useQueryClient();
  // Mobile slice 57: switching tabs unmounts this panel, and a camera, rotation or locked screen
  // can unload the page. The note is kept on the device until it is added.
  const draft = useFieldDraft({ recordType, recordId, field: 'notes-tab-note', enabled: canAddNotes });
  const noteContent = draft.value;
  const setNoteContent = draft.setValue;

  const addNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      const { data } = await api.post(`/api/${recordType.toLowerCase()}s/${recordId}/notes`, { content });
      return data.note;
    },
    onSuccess: () => {
      draft.clear();
      if (recordType === 'JOB') queryClient.invalidateQueries({ queryKey: ['job-notes-wt', recordId] });
      queryClient.invalidateQueries({ queryKey: ['notes', recordType, recordId] });
    },
  });

  // The delete control on each note follows the server's per-note answer (S04.25).
  const deleteNote = useDeleteNote(recordType, recordId);

  const allNotes = [...(notes ?? [])].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return (
    <div className="flex flex-col gap-4 p-5">
      {/* Composer - only for users the API will actually accept a note from. */}
      {canAddNotes && (
      <Card>
        <CardHeader>
          <CardTitle>Add note</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Textarea
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.metaKey || e.ctrlKey) &&
                e.key === 'Enter' &&
                noteContent.trim() &&
                noteContent.trim().length <= LONG_TEXT_MAX &&
                !addNoteMutation.isPending
              ) {
                e.preventDefault();
                addNoteMutation.mutate(noteContent.trim());
              }
            }}
            placeholder="Write a note..."
            rows={3}
            aria-label="Note"
          />
          <TextLengthCounter length={noteContent.trim().length} max={LONG_TEXT_MAX} />
          {noteContent.trim().length > LONG_TEXT_MAX && <p className="text-destructive text-xs">{tooLongMessage(LONG_TEXT_MAX)}</p>}
          <DraftRestoredNote restored={draft.restored} onDiscard={draft.clear} />
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-[11px] touch:!hidden">Cmd + Enter to add</span>
            {/* ms-auto: the hint is hidden on touch, so the button keeps the right edge on its own. */}
            <Button
              size="sm"
              className="ms-auto"
              disabled={!noteContent.trim() || noteContent.trim().length > LONG_TEXT_MAX || addNoteMutation.isPending}
              onClick={() => addNoteMutation.mutate(noteContent.trim())}
            >
              {addNoteMutation.isPending ? 'Adding...' : 'Add Note'}
            </Button>
          </div>
          {addNoteMutation.error && <p className="text-destructive text-xs">Failed to add note</p>}
        </CardContent>
      </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Notes <span className="text-muted-foreground font-normal">({allNotes.length})</span>
          </CardTitle>
        </CardHeader>
        {allNotes.length === 0 ? (
          <EmptyState icon={<StickyNote />} title="No notes yet" />
        ) : (
          <div className="divide-y border-t">
            {allNotes.map((note) => (
              <div key={note.id} className="flex gap-3 px-5 py-4">
                <span className="bg-brand-subtle text-brand-emphasis mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold">
                  {getInitials(`${note.creator.first_name} ${note.creator.last_name}`)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-[13px] font-semibold">
                      {note.creator.first_name} {note.creator.last_name}
                    </span>
                    {note.source === 'LEAD' && (
                      <Badge variant="softBlue" size="pill">From Lead</Badge>
                    )}
                    <span className="text-muted-foreground ms-auto whitespace-nowrap text-[11px]">
                      {formatDistanceToNow(new Date(note.created_at), { addSuffix: true })}
                    </span>
                    <NoteDeleteButton
                      note={note}
                      authorName={`${note.creator.first_name} ${note.creator.last_name}`}
                      pending={deleteNote.isDeleting}
                      onDelete={() => deleteNote.requestDelete(note.id)}
                    />
                  </div>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                    {note.content}
                  </p>
                  <NoteEditedMark note={note} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      {deleteNote.confirmDialog}
    </div>
  );
}
