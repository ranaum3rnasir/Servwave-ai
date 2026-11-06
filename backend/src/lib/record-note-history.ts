/**
 * The history of a deleted note (Roles & Permissions, PRD 4, S04.25): one TimelineEvent on the JOB or the LEAD the note
 * hung on, so nothing disappears unseen and the office review (PRD 6) can show "notes removed".
 *
 * The note itself is removed for good; this entry is what keeps it. It carries the note's whole text, who wrote it and
 * when, and who deleted it, in the description (what the Activity feed shows) and in the metadata (what the review reads):
 * `{ note_id, note_content, written_by, written_by_name, written_at, deleted_by, deleted_by_name }`.
 *
 * The writer takes the transaction client of the delete itself, so the entry and the delete commit or roll back together.
 */
import type { Prisma } from '@prisma/client';

type Db = Pick<Prisma.TransactionClient, 'timelineEvent'>;

/** The record a note hangs on, and so the one whose timeline the entry lands on. */
export type NoteRecord = { type: 'JOB' | 'LEAD'; id: string };

/**
 * The same event type on both records, as the attachment delete's `ATTACHMENT_DELETED` is on every record. EDITED is a
 * lead's general note changed from the Edit lead form (#3104), the only note that can be edited.
 */
export const NOTE_EVENT = { DELETED: 'NOTE_DELETED', EDITED: 'NOTE_EDITED' } as const;

/** A person as a name on a history line. */
export interface NoteHistoryPerson {
  id: string;
  first_name: string;
  last_name: string;
}

/** The note as it stood when it was deleted. */
export interface DeletedNote {
  id: string;
  content: string;
  created_at: Date;
}

const nameOf = (p: { first_name: string; last_name: string }) => `${p.first_name} ${p.last_name}`.trim();

export async function recordNoteDeleted(
  db: Db,
  orgId: string,
  record: NoteRecord,
  note: DeletedNote,
  writtenBy: NoteHistoryPerson,
  deletedBy: NoteHistoryPerson,
): Promise<void> {
  const writer = nameOf(writtenBy);
  const deleter = nameOf(deletedBy);
  await db.timelineEvent.create({
    data: {
      organization_id: orgId,
      entity_type: record.type,
      entity_id: record.id,
      event_type: NOTE_EVENT.DELETED,
      description: `Note deleted: ${note.content} (written by ${writer}, deleted by ${deleter})`,
      metadata: {
        note_id: note.id,
        note_content: note.content,
        written_by: writtenBy.id,
        written_by_name: writer,
        written_at: note.created_at.toISOString(),
        deleted_by: deletedBy.id,
        deleted_by_name: deleter,
      },
      created_by: deletedBy.id,
    },
  });
}

/**
 * The history of an edit to a lead's general note (#3104): one TimelineEvent on the lead with who edited it and the text
 * before and after, `{ note_id, from, to, edited_by, edited_by_name }`. The Activity panel draws it as "<name> edited the
 * note" with Before and After. Written with the transaction client of the edit itself.
 */
export async function recordNoteEdited(
  db: Db,
  orgId: string,
  record: NoteRecord,
  edit: { noteId: string; from: string; to: string },
  editedBy: NoteHistoryPerson,
): Promise<void> {
  await db.timelineEvent.create({
    data: {
      organization_id: orgId,
      entity_type: record.type,
      entity_id: record.id,
      event_type: NOTE_EVENT.EDITED,
      description: 'Note edited',
      metadata: {
        note_id: edit.noteId,
        from: edit.from,
        to: edit.to,
        edited_by: editedBy.id,
        edited_by_name: nameOf(editedBy),
      },
      created_by: editedBy.id,
    },
  });
}
