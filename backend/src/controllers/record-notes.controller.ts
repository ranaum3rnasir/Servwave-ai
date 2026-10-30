/**
 * Deleting a note on a job or a lead (Roles & Permissions, PRD 4, S04.25): DELETE /api/jobs/:id/notes/:noteId and
 * DELETE /api/leads/:id/notes/:noteId.
 *
 * The route guard asks only that the person can read the record. The handler opens the record in the detail route's own
 * split (not found for a missing record or one in another company, forbidden for one in the same company outside their
 * reach), finds the note on THAT record, and then asks `lib/permissions/noteChange`: the completed-job lock first (a locked job
 * refuses everyone without Change locked jobs, the author included), then whose note it is (your own, or anyone's with the
 * record's Edit). A refusal changes nothing.
 *
 * The delete is a hard one: the note's row goes, and in the same transaction the record's timeline gets a "note deleted"
 * entry that keeps the text, the author, when it was written and who deleted it (lib/record-note-history).
 */
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { canAccessRow } from '../lib/permissions/enforce';
import { queueReviewAttention } from '../services/notifications/reviewAttentionQueue';
import { JOB_LOCKED_CODE, JOB_LOCKED_MESSAGE } from '../lib/permissions/jobLock';
import {
  OWN_NOTES_ONLY_MESSAGE,
  mayDeleteNote,
  noteDeleteReach,
  type NoteEntityType,
} from '../lib/permissions/noteChange';
import { recordNoteDeleted } from '../lib/record-note-history';

const WORD = { JOB: 'Job', LEAD: 'Lead' } as const;

/** Does the record exist in the caller's company? */
async function recordExists(req: Request, entityType: NoteEntityType, id: string): Promise<boolean> {
  const where = { id, ...tenantWhere(req) };
  const row =
    entityType === 'JOB'
      ? await prisma.job.findFirst({ where, select: { id: true } })
      : await prisma.lead.findFirst({ where, select: { id: true } });
  return !!row;
}

function deleteNoteOn(entityType: NoteEntityType) {
  return async function deleteNote(req: Request, res: Response) {
    try {
      const id = String(req.params.id ?? '');
      const noteId = String(req.params.noteId ?? '');

      if (!(await recordExists(req, entityType, id))) {
        res.status(404).json({ error: `${WORD[entityType]} not found` });
        return;
      }
      const delegate = entityType === 'JOB' ? prisma.job : prisma.lead;
      if (!(await canAccessRow(req, WORD[entityType], delegate, id))) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }

      const note = await prisma.note.findFirst({
        where: { id: noteId, entity_type: entityType, entity_id: id, ...tenantWhere(req) },
        select: {
          id: true,
          content: true,
          created_at: true,
          created_by: true,
          creator: { select: { id: true, first_name: true, last_name: true } },
        },
      });
      if (!note) {
        res.status(404).json({ error: 'Note not found' });
        return;
      }

      const reach = await noteDeleteReach(req, entityType, id);
      // The completed-job lock wins over the author's own right and over the switch.
      if (reach.locked) {
        res.status(403).json({ error: JOB_LOCKED_MESSAGE, code: JOB_LOCKED_CODE });
        return;
      }
      if (!mayDeleteNote(req, reach, note.created_by)) {
        res.status(403).json({ error: OWN_NOTES_ONLY_MESSAGE });
        return;
      }

      const deleted = await prisma.$transaction(async (tx) => {
        // deleteMany: a second delete of the same note finds nothing and records nothing.
        const { count } = await tx.note.deleteMany({ where: { id: note.id, ...tenantWhere(req) } });
        if (count === 0) return false;
        await recordNoteDeleted(
          tx,
          req.user!.organization_id,
          { type: entityType, id },
          note,
          note.creator,
          { id: req.user!.id, first_name: req.user!.first_name, last_name: req.user!.last_name },
        );
        return true;
      });
      // S06.24: on a Done job a note delete raises the Office review attention alert (queued; sent after the response if the job is Done).
      if (deleted && entityType === 'JOB') {
        queueReviewAttention({ orgId: req.user!.organization_id, actorId: req.user!.id, jobId: id, onlyIfDone: true, items: [{ reason: 'A note was deleted', title: 'Note' }] });
      }

      res.json({ success: true });
    } catch (err) {
      logger.error(`Delete ${entityType.toLowerCase()} note error:`, err);
      res.status(500).json({ error: 'Failed to delete note' });
    }
  };
}

export const deleteJobNote = deleteNoteOn('JOB');
export const deleteLeadNote = deleteNoteOn('LEAD');
