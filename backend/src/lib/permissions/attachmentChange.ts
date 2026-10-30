import type { Request } from 'express';
import type { AttachmentEntity } from '@prisma/client';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { lockBindsPerson } from './jobLock';

/**
 * Who may rename or remove a file (Roles & Permissions, PRD 4, S04.24): one answer for the attachment routes and for
 * the per-file answer the list sends, so a control is drawn only where the route would let the request in.
 *
 * The Attachments switches decide, and the caller has already opened the record the file hangs on:
 *  - Edit attachments renames anyone's file, Delete attachments removes anyone's;
 *  - without Delete attachments a person removes only the files they uploaded themselves, on any record they can open;
 *  - on a TASK the uploader may also rename their own file (visits-and-task-categories slice 12).
 * Then the completed-job lock wins over all of it: on a locked job, and on the invoices of a locked job, nobody changes
 * a file, their own upload included, without Change locked jobs. A lead's files never take the job lock.
 *
 * One exception (S06.9): while the job is in Office review, a person who holds Office review and can open the job is not
 * bound by the lock on these files, and the switches above still decide what they may do. The files are the review's own
 * edits ('file' in jobLock.ts); note deletes are not, and noteChange.ts names no review edit.
 */

/** The refusal for a delete of someone else's file by a person without Delete attachments. */
export const OWN_UPLOADS_ONLY_MESSAGE = 'You can only delete files you uploaded.';

export type AttachmentChange = 'update' | 'delete';

/** Do the person's switches (or the own-upload rule) let them change this file, before the lock is asked? */
export function mayChangeAttachment(
  req: Request,
  action: AttachmentChange,
  entityType: AttachmentEntity,
  uploadedBy: string,
): boolean {
  if (req.ability?.can(action, 'Attachment')) return true;
  if (uploadedBy !== req.user!.id) return false;
  return action === 'delete' || entityType === 'TASK';
}

/**
 * Does the completed-job lock bind the person on the files of this record? A job's own files and the files on its
 * invoices follow the job's status, read on every call. Everything else (a lead, a customer, a task, an invoice with no
 * job) is never locked: the closed-lead lock covers only the lead's contact entries.
 */
export async function fileLockBinds(req: Request, entityType: AttachmentEntity, entityId: string): Promise<boolean> {
  if (entityType === 'JOB') return lockBindsPerson(req, entityId, undefined, 'file');
  if (entityType !== 'INVOICE') return false;
  const invoice = await prisma.invoice.findFirst({ where: { id: entityId, ...tenantWhere(req) }, select: { job_id: true } });
  return invoice?.job_id ? lockBindsPerson(req, invoice.job_id, undefined, 'file') : false;
}

/** What one file allows the person: the final answer, and what only the lock took away. */
export interface FileChangeAnswer {
  can_delete: boolean;
  can_rename: boolean;
  /** Controls the person's switches allow but the lock withholds, so the page can show them disabled with the reason. */
  locked_actions: Array<'delete' | 'rename'>;
}

/** The per-file answer, given whether the lock binds the person on this record. */
export function fileChangeAnswer(
  req: Request,
  entityType: AttachmentEntity,
  uploadedBy: string,
  locked: boolean,
): FileChangeAnswer {
  const mayDelete = mayChangeAttachment(req, 'delete', entityType, uploadedBy);
  const mayRename = mayChangeAttachment(req, 'update', entityType, uploadedBy);
  const lockedActions: FileChangeAnswer['locked_actions'] = [];
  if (locked && mayDelete) lockedActions.push('delete');
  if (locked && mayRename) lockedActions.push('rename');
  return { can_delete: mayDelete && !locked, can_rename: mayRename && !locked, locked_actions: lockedActions };
}
