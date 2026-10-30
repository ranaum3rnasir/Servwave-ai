import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { JOB_LOCKED_REASON } from '@/lib/jobLocked';
import { noteDeleteControl, type NoteDeleteAnswer } from '@/lib/notes/noteChange';

/**
 * The delete control on one note (Roles & Permissions S04.25), drawn from the server's per-note answer: a button on a
 * note the person may delete, the same button disabled with the lock's reason where only the completed-job lock stops
 * them, and nothing on any other note.
 */
export function NoteDeleteButton({
  note,
  authorName,
  pending,
  onDelete,
}: {
  note: NoteDeleteAnswer;
  authorName: string;
  pending?: boolean;
  onDelete: () => void;
}) {
  const control = noteDeleteControl(note);
  if (control === 'hidden') return null;
  const locked = control === 'locked';
  return (
    <Button
      variant="ghost"
      tone="danger"
      size="icon"
      aria-label={`Delete note by ${authorName}`}
      disabled={locked || pending}
      disabledReason={locked ? JOB_LOCKED_REASON : undefined}
      onClick={onDelete}
      className="h-7 w-7 shrink-0"
    >
      <Trash2 />
    </Button>
  );
}
