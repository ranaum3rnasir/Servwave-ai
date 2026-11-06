import { formatDistanceToNow } from 'date-fns';

/** Who last edited a note and when, as every notes list answers it. Null on a note never edited. */
export interface NoteEditMarks {
  edited_at?: string | null;
  editor?: { id: string; first_name: string; last_name: string } | null;
}

/**
 * "Edited by <name> · <time>" under a note's text (#3104). Only a lead's general note can be edited (from the Edit lead
 * form), so on every other note this draws nothing. Same row shape on the Notes tab, the Activity panel and the job's
 * "From Lead" notes.
 */
export function NoteEditedMark({ note }: { note: NoteEditMarks }) {
  if (!note.edited_at) return null;
  const who = note.editor ? `${note.editor.first_name} ${note.editor.last_name}`.trim() : '';
  const when = formatDistanceToNow(new Date(note.edited_at), { addSuffix: true });
  return (
    <span className="bg-status-amber-subtle text-muted-foreground mt-1 inline-block self-start rounded-md px-1.5 py-0.5 text-[11px]">
      {who ? `Edited by ${who} · ${when}` : `Edited · ${when}`}
    </span>
  );
}
