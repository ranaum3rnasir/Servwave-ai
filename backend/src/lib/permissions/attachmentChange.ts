import type { Request } from 'express';
import type { AttachmentEntity } from '@prisma/client';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { lockBindsPerson } from './jobLock';

/**
 * Who may rename or remove a file (Roles & Permissions P10, A8d): uploads are the record's own data. Anyone who can open
 * the record sees its files, and anyone with the record's Edit adds, renames and removes them, another person's included.
 * There is no attachments switch: the caller has already opened the record the file hangs on and asks the record's Edit
 * (`checkEntityEdit` in the attachment controller), and this module answers what the completed-job lock leaves of it.
 *
 * The completed-job lock wins over all of it: on a locked job, and on the invoices of a locked job, nobody changes a file,
 * their own upload included, without Change locked jobs. A lead's files never take the job lock.
 *
 * One exception (S06.9): while the job is in Office review, a person who holds Office review and can open the job is not
 * bound by the lock on these files, and the record's Edit still decides what they may do. The files are the review's own
 * edits ('file' in jobLock.ts); note deletes are not, and noteChange.ts names no review edit.
 */

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
  /** Controls the person's Edit allows but the lock withholds, so the page can show them disabled with the reason. */
  locked_actions: Array<'delete' | 'rename'>;
}

/** The per-file answer, given whether the person holds the record's Edit and whether the lock binds them on this record. */
export function fileChangeAnswer(canEditRecord: boolean, locked: boolean): FileChangeAnswer {
  const lockedActions: FileChangeAnswer['locked_actions'] = locked && canEditRecord ? ['delete', 'rename'] : [];
  return { can_delete: canEditRecord && !locked, can_rename: canEditRecord && !locked, locked_actions: lockedActions };
}
