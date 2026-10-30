/**
 * What the server says one note allows the person (Roles & Permissions S04.25): the notes lists of a job and of a lead send
 * it on every row, decided from whose note it is, Delete other people's notes and the completed-job lock. The page draws a
 * delete control from it and never re-derives the rule. A list that sends no answer (an invoice's notes, which are out of
 * scope) gets no control.
 */
export interface NoteDeleteAnswer {
  can_delete?: boolean;
  /** Controls the person's switches allow and only the lock withholds: drawn disabled with the reason. */
  locked_actions?: Array<'delete'>;
}

export type NoteControl = 'enabled' | 'locked' | 'hidden';

/** How the delete control is drawn for this note. */
export function noteDeleteControl(note: NoteDeleteAnswer): NoteControl {
  if (note.can_delete === true) return 'enabled';
  if (note.locked_actions?.includes('delete')) return 'locked';
  return 'hidden';
}
