/**
 * A lead's GENERAL note (#3104, B7 follow-up): the text typed in the new-lead form's Notes box, kept as an ordinary note in
 * the lead's Notes list (notes.is_general = true, at most one per lead), and edited in place from the Edit lead form.
 *
 * The lead's own `notes` column is no longer written by anything: the create paths write this note instead, and the update
 * path edits it. Every other note stays add-and-delete.
 *
 *   - Creating a lead with text writes the note in the lead's own transaction, by the creator, at the lead's creation time,
 *     when the creator holds Add notes or Edit leads at all (lib/permissions/leadEdit `holdsLeadNoteSwitch`), whether or
 *     not their scope reaches the lead afterwards (Ran's build ruling 3). Without either switch the text is ignored: no
 *     note, no error.
 *   - Saving the Edit lead form's Notes box: unchanged text writes nothing; changed text rewrites the note in place (its
 *     author and time stay, edited_by / edited_at are set) and the lead's history gets ONE `NOTE_EDITED` entry with the text
 *     before and after; an emptied box removes the note and records the removal with its text (`NOTE_DELETED`, the same
 *     entry a delete from the Notes tab writes); text where there is no general note writes a new one by the editor.
 *
 * Saves of one lead's Edit form run one at a time (the lead's row is locked first), so the Before an edit records is the
 * text it really replaced. A Notes-tab delete does not take that lock: a write that finds the note gone (or changed) reads
 * again and applies to what is there, and the new general note is written with ON CONFLICT on the one-per-lead index, so
 * a race is never a failed save.
 */
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { holdsLeadNoteSwitch } from './permissions/leadEdit';
import { recordNoteDeleted, recordNoteEdited } from './record-note-history';

/** One note row as every notes list answers it: the text, who wrote it and when, and who last edited it and when. */
export const NOTE_ROW_SELECT = {
  id: true,
  content: true,
  created_at: true,
  creator: { select: { id: true, first_name: true, last_name: true } },
  edited_at: true,
  editor: { select: { id: true, first_name: true, last_name: true } },
} as const;

type Tx = Prisma.TransactionClient;

/** The text as it is stored: the blanks at either end removed. Blank text is no note. */
export function generalNoteText(text: string | null | undefined): string {
  return (text ?? '').trim();
}

/**
 * The new-lead form's Notes box, written as the lead's general note inside the transaction that creates the lead, so a lead
 * that is not created leaves no note behind. Returns whether a note was written.
 */
export async function writeGeneralNoteOnCreate(
  tx: Tx,
  req: Request,
  lead: { id: string; created_at: Date },
  text: string | null | undefined,
): Promise<boolean> {
  const content = generalNoteText(text);
  if (!content) return false;
  if (!holdsLeadNoteSwitch(req)) return false;
  await tx.note.create({
    data: {
      entity_type: 'LEAD',
      entity_id: lead.id,
      content,
      is_general: true,
      created_by: req.user!.id,
      created_at: lead.created_at,
      organization_id: req.user!.organization_id,
    },
  });
  return true;
}

/** What saving the Edit lead form's Notes box did to the general note. */
export type GeneralNoteEdit = 'unchanged' | 'edited' | 'removed' | 'created';

/**
 * The Edit lead form's Notes box, saved. The caller has already decided this person may edit the lead (the update route's
 * Edit leads and row reach); this writes the note and its history in the caller's transaction.
 */
export async function saveGeneralNoteFromEditForm(
  tx: Tx,
  req: Request,
  leadId: string,
  text: string | null | undefined,
): Promise<GeneralNoteEdit> {
  const orgId = req.user!.organization_id;
  const content = generalNoteText(text);
  const me = { id: req.user!.id, first_name: req.user!.first_name, last_name: req.user!.last_name };

  // One Edit-form save of this lead at a time: the next one waits here and then reads what this one wrote. FOR NO KEY
  // UPDATE, the strength every other lock on a lead takes (lib/numbering.ts): it still conflicts with itself, but not with
  // the key-share lock a child row's insert takes, so a save that also changes the status cannot deadlock with a
  // walkthrough booking that inserted a visit and then locks the lead.
  await tx.$queryRaw`SELECT id FROM "leads" WHERE id = ${leadId}::uuid AND organization_id = ${orgId}::uuid FOR NO KEY UPDATE`;

  // A Notes-tab delete can land between the read and the write; the write then changes nothing and the loop reads again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await tx.note.findFirst({
      where: { entity_type: 'LEAD', entity_id: leadId, is_general: true, organization_id: orgId },
      select: { id: true, content: true, created_at: true, creator: { select: { id: true, first_name: true, last_name: true } } },
    });

    if (!current) {
      if (!content) return 'unchanged';
      // ON CONFLICT: a general note that appeared meanwhile is not doubled and not an error; the loop then edits it.
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "notes" (id, entity_type, entity_id, content, created_by, organization_id, is_general)
        VALUES (gen_random_uuid(), 'LEAD'::"NoteEntity", ${leadId}::uuid, ${content}, ${me.id}::uuid, ${orgId}::uuid, true)
        ON CONFLICT (entity_type, entity_id) WHERE is_general = true DO NOTHING
        RETURNING id`;
      if (inserted.length > 0) return 'created';
      continue;
    }

    if (content === current.content.trim()) return 'unchanged';

    if (!content) {
      const { count } = await tx.note.deleteMany({ where: { id: current.id, organization_id: orgId } });
      if (count === 0) continue;
      await recordNoteDeleted(tx, orgId, { type: 'LEAD', id: leadId }, current, current.creator, me);
      return 'removed';
    }

    // Only the text that was read is replaced, so the history's Before is exactly what this save changed.
    const { count } = await tx.note.updateMany({
      where: { id: current.id, content: current.content, organization_id: orgId },
      data: { content, edited_by: me.id, edited_at: new Date() },
    });
    if (count === 0) continue;
    await recordNoteEdited(tx, orgId, { type: 'LEAD', id: leadId }, { noteId: current.id, from: current.content, to: content }, me);
    return 'edited';
  }
  throw new Error('The lead\'s general note kept changing while it was saved');
}
