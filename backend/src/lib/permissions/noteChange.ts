import type { Request } from 'express';
import type { Subject } from './catalog';
import { prisma } from '../prisma';
import { canActOnRow } from './enforce';
import { lockBindsPerson } from './jobLock';

/**
 * Who may delete a note on a job or a lead (Roles & Permissions, PRD 4, S04.25): one answer for the delete routes and for
 * the per-note answer the lists send, so a control is drawn only where the route would let the request in.
 *
 * Notes are the record's own data (P10, A8d). The caller has already opened the record the note hangs on. Then:
 *  - a person deletes a note they wrote, with no switch on (they could add it without the record's Edit, through Add notes);
 *  - the record's Edit (Edit jobs, Edit leads, at the person's row scope) deletes anyone's.
 * And the completed-job lock wins over both: on a locked job nobody deletes a note, their own included, without Change
 * locked jobs. That switch lifts the lock only, so someone else's note still needs the job's Edit. A lead never takes the
 * job lock, and the closed-lead lock covers only the lead's contact entries, so a Won or Lost lead's notes delete like any
 * other. Notes on customers, estimates, invoices and tasks are not covered here.
 */

/** The refusal for a delete of someone else's note by a person whose Edit does not reach the record. */
export const OWN_NOTES_ONLY_MESSAGE = 'You can only delete notes you wrote.';

/** The records whose notes this deletes. */
export type NoteEntityType = 'JOB' | 'LEAD';

/** What the person's switches and the lock say about the notes of one record. */
export interface NoteDeleteReach {
  /** The record's Edit holds on this record, which deletes anyone's note on it. */
  mayDeleteOthers: boolean;
  /** The completed-job lock binds the person on this record. */
  locked: boolean;
}

/**
 * The record-level half of the answer, asked once per record: whether the person's Edit reaches other people's notes
 * here, and whether the lock binds them. Both are read on every call and never cached.
 */
export async function noteDeleteReach(req: Request, entityType: NoteEntityType, entityId: string): Promise<NoteDeleteReach> {
  const subject: Subject = entityType === 'JOB' ? 'Job' : 'Lead';
  const delegate = entityType === 'JOB' ? prisma.job : prisma.lead;
  const mayDeleteOthers = !!req.ability?.can('update', subject) && (await canActOnRow(req, subject, delegate, entityId, 'update'));
  const locked = entityType === 'JOB' && (await lockBindsPerson(req, entityId));
  return { mayDeleteOthers, locked };
}

/** May the person delete a note written by `authorId`, before the lock is asked? */
export function mayDeleteNote(req: Request, reach: NoteDeleteReach, authorId: string): boolean {
  return authorId === req.user!.id || reach.mayDeleteOthers;
}

/** What one note allows the person: the final answer, and what only the lock took away. */
export interface NoteDeleteAnswer {
  can_delete: boolean;
  /** Controls the person's switches allow but the lock withholds, so the page can show them disabled with the reason. */
  locked_actions: Array<'delete'>;
}

/** The per-note answer, given the record-level reach. */
export function noteDeleteAnswer(req: Request, reach: NoteDeleteReach, authorId: string): NoteDeleteAnswer {
  const mayDelete = mayDeleteNote(req, reach, authorId);
  return { can_delete: mayDelete && !reach.locked, locked_actions: reach.locked && mayDelete ? ['delete'] : [] };
}

/** The answer for a note the page lists but the record's own routes cannot delete (the lead's notes on the job page). */
export const NOTE_NOT_DELETABLE_HERE: NoteDeleteAnswer = { can_delete: false, locked_actions: [] };
