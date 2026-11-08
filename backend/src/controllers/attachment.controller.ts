import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AttachmentEntity } from '@prisma/client';
import { prisma } from '../lib/prisma';
// Creator tracking (audit only) - stamped at every create, never read for authorization here.
import { createdByUser } from '../lib/created-by';
import { logger } from '../lib/logger';
import { supabaseAdmin } from '../lib/supabase';
import { tenantWhere } from '../lib/tenant';
import { canAccessTask } from '../lib/tasks/visibility';
import { sniffMatchesDeclared } from '../lib/file-sniff';
import {
  ATTACHMENTS_BUCKET as STORAGE_BUCKET,
  buildAccessUrl,
  attachmentObjectPath,
  buildAttachmentStoragePath,
} from '../lib/attachment-access';
import { sizeLimitLabel } from '../middleware/multerErrors';
import {
  createScopedUploadUrl,
  discardStoredObject,
  readStoredObjectHead,
  signUploadTicket,
  statStoredObject,
  verifyUploadTicket,
} from '../lib/attachment-direct-upload';

// ─── Constants ───────────────────────────────────────────

// Exported (email slice 7): the compose-window multipart upload reuses this
// EXACT list rather than declaring a parallel one that could drift.
export const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime',
  'application/pdf',
  // Office documents. Field-service paperwork is not only photos and PDFs: evaluations,
  // install sheets and parts lists arrive as Word/Excel, and rejecting them sent users
  // back to their old system. Macro-enabled variants (.docm/.xlsm) are deliberately
  // absent - they are the executable-content shape of these formats.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/csv', 'text/plain',
];

/** Human-readable form of ALLOWED_MIME_TYPES for the 400 body. Exported alongside the
 *  list itself so the email compose path cannot advertise a different set than it takes. */
export const ALLOWED_TYPES_LABEL = 'JPG, PNG, HEIC, MP4, PDF, Word, Excel, PowerPoint, CSV, TXT';

// Exported alongside the video caps so attachment.routes.ts can build its too-large message
// from the real caps instead of restating them as literals.
export const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB — images, HEIC/HEIF, PDF

/**
 * The video cap on the DIRECT-TO-STORAGE path (Ran, 2026-09-20).
 *
 * 512MB IS THE STORAGE BUCKET'S OWN `file_size_limit`, which Ran raised on production the
 * same day (the project-level global went to 1GB above it). So the app cap now EQUALS the
 * infrastructure ceiling with ZERO HEADROOM. That is a deliberate choice and it has a cost:
 * if the bucket is ever lowered, a file between the new bucket limit and this number fails
 * at storage with a 413 we neither wrote nor control, rather than at our own 400 with a
 * sentence naming the real limit. Lowering the bucket therefore means lowering this first.
 *
 * REACHABLE ONLY BECAUSE THE BYTES DO NOT PASS THROUGH THIS PROCESS. The browser sends them
 * straight at storage in resumable chunks; the app server mints a scoped URL and then
 * verifies the landed object, reading only its head. NEVER REUSE THIS CONSTANT ON A PATH
 * THAT BUFFERS — see MAX_PROXY_VIDEO_FILE_SIZE.
 */
export const MAX_VIDEO_FILE_SIZE = 512 * 1024 * 1024; // 512MB — video/mp4, video/quicktime

/**
 * The video cap on the MULTIPART PROXY path, which is a different number on purpose.
 *
 * `uploadAttachment` below is reached through `attachment.routes.ts`, whose multer uses
 * `memoryStorage()`: the whole file is held in this process before it is forwarded. The
 * deployment target is documented at 512MB of memory for a single instance, so a 512MB
 * multipart upload would be one request away from taking the process down, and two
 * concurrent ones would guarantee it.
 *
 * Unchanged at 50MB, which is what this path enforced before the raise: the change raises
 * what video CAN BE, not what the proxy can carry. No ServWave surface sends video this way
 * any more (`uploadAttachment.ts` routes both video types to the direct path), so this binds
 * only a caller talking to the API directly. It stays enforced rather than deleted because
 * removing it would hand that caller multer's abort in place of a sentence naming a real
 * limit.
 */
export const MAX_PROXY_VIDEO_FILE_SIZE = 50 * 1024 * 1024; // 50MB — proxy path only

/**
 * The per-entity total. 2GB.
 *
 * It has to be several times the per-file cap rather than close to it: at the old 200MB the
 * FIRST 512MB upload onto an empty job would be refused by a limit no surface ever showed
 * the user. 2GB lets a job hold a handful of videos.
 *
 * Exported so the caps can be held against each other, and against the copy that quotes
 * them, from the tests rather than by inspection.
 */
export const MAX_ENTITY_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

/**
 * The types the direct-to-storage path carries. Video only, deliberately.
 *
 * Video is the one thing the field routinely produces that cannot fit through the proxy path,
 * so it is where the direct path is forced. Everything else stays on the multipart handler
 * below, unchanged, until the images slice migrates it — one control on two code paths is how
 * a control drifts, and the way to avoid that is to finish the migration, not to half-do it.
 *
 * `text/csv` and `text/plain` are explicitly NOT here, and not by oversight. `looksLikeText()`
 * scans the WHOLE buffer for NUL bytes, so a head-only read is a genuinely weaker check for
 * those two: a file whose first 8KB is clean ASCII and whose tail is binary would pass. Text
 * files are small, the proxy path already reads them whole, and they gain nothing from going
 * direct — so they keep the strong check by staying where they are. If they ever move, they
 * must be read whole, not sniffed from a head.
 */
const DIRECT_UPLOAD_MIME_TYPES = ['video/mp4', 'video/quicktime'];

/**
 * Single owner of the per-entity-total message, so both upload paths quote the same cap.
 *
 * DERIVED, not written out. It used to read "...would exceed 200MB limit" as a hand-typed
 * string beside a constant that was the thing actually enforced: the day the constant moves
 * — as it just did, from 200MB to 2GB — the sentence becomes a confident lie and nothing
 * fails. A message that misstates the limit is worse than no message, because the user
 * believes it and acts on it.
 */
const ENTITY_TOTAL_EXCEEDED =
  `Total attachments for this entity would exceed ${sizeLimitLabel(MAX_ENTITY_SIZE)} limit`;

// ESTIMATE is deliberately absent (2026-08-27). An attachment belongs to a lead or to a job;
// the estimate was never a third home for files, and the generic panel that offered it there
// uploaded under whichever context the user happened to click. The 412 production rows were
// re-pointed onto their leads by `20260827120000_estimate_attachments_to_lead`, so there is
// nothing left to serve. Dropping it here rejects reads AND writes (400 "Invalid entity type"),
// which is the point: leaving the route open would let the surface quietly come back and start
// stranding files again. A lead's files already reach its job through the `include_lead` fold
// in listAttachments below.
//
// TASK (visits-and-task-categories slice 12): a task's files belong to the task alone. They are
// never folded into the linked job, lead or customer, and their access is the task's own
// visibility rule (see `checkEntityAccess`), not the per-role switch.
const VALID_ENTITY_TYPES: AttachmentEntity[] = ['CUSTOMER', 'LEAD', 'JOB', 'INVOICE', 'TASK'];

// ─── Schemas ─────────────────────────────────────────────

export const updateAttachmentSchema = z.object({
  display_name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
});

/**
 * Direct upload, step 1. Everything here is a DECLARATION by the client and is treated as
 * such: the size is re-read off the stored object in step 2, the type is re-sniffed against
 * the real bytes, and the name only ever reaches a storage path through
 * `sanitizeAttachmentFilename`. Zod strips unknown keys, so a client that also sends a
 * `path` / `storage_path` of its own is not merely ignored downstream — it never arrives.
 */
export const directUploadRequestSchema = z.object({
  file_name: z.string().trim().min(1).max(255),
  content_type: z.string().trim().min(1).max(255),
  file_size: z.number().int().positive(),
});

/**
 * Direct upload, step 2. The object's identity comes from the signed `ticket` and from
 * nowhere else — see the note on `completeDirectUpload`.
 */
export const directUploadCompleteSchema = z.object({
  ticket: z.string().min(1),
  display_name: z.string().trim().min(1).max(255),
  description: z.string().max(2000),
});

// ─── Helpers ─────────────────────────────────────────────

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

function validateEntityType(type: string): type is AttachmentEntity {
  return VALID_ENTITY_TYPES.includes(type as AttachmentEntity);
}

/**
 * Would adding `addedBytes` push this entity past MAX_ENTITY_SIZE?
 *
 * Shared by both upload paths on purpose. The direct path has to run this check TWICE — once
 * against the declared size before minting a URL, and again against the object's real size
 * before the row exists — and a second hand-written copy of the same aggregate is exactly how
 * the two would end up enforcing different numbers.
 */
async function entityTotalWouldExceed(
  entityType: AttachmentEntity,
  entityId: string,
  req: Request,
  addedBytes: number,
): Promise<boolean> {
  const existing = await prisma.attachment.aggregate({
    where: { entity_type: entityType, entity_id: entityId, ...tenantWhere(req) },
    _sum: { file_size: true },
  });
  return (existing._sum.file_size || 0) + addedBytes > MAX_ENTITY_SIZE;
}

async function checkEntityExists(entityType: AttachmentEntity, entityId: string, req: Request): Promise<boolean> {
  const orgFilter = tenantWhere(req);
  switch (entityType) {
    case 'CUSTOMER': return !!(await prisma.customer.findUnique({ where: { id: entityId, ...orgFilter }, select: { id: true } }));
    case 'LEAD':     return !!(await prisma.lead.findUnique({ where: { id: entityId, ...orgFilter }, select: { id: true } }));
    case 'JOB':      return !!(await prisma.job.findUnique({ where: { id: entityId, ...orgFilter }, select: { id: true } }));
    case 'INVOICE':  return !!(await prisma.invoice.findUnique({ where: { id: entityId, ...orgFilter }, select: { id: true } }));
    case 'TASK':     return !!(await findTaskForAccess(entityId, req));
    default: return false;
  }
}

/**
 * Multi-visit S8 (D6): is this user on ANY of the record's visits?
 *
 * One flatten, shared by the three ownership checks below, so the job arm and the two lead arms
 * cannot drift on what "on the crew" means. The relation is one array level deeper than the join
 * tables it replaces, which is why each call site needed a real edit rather than a rename.
 */
function isOnAnyVisit(
  record: { visits?: Array<{ assignees?: Array<{ user_id: string }> | null }> | null } | null | undefined,
  userId: string,
): boolean {
  return (record?.visits ?? []).some((v) => (v.assignees ?? []).some((a) => a.user_id === userId));
}

/** The tenant-scoped task row, carrying exactly the fields the visibility rule reads. */
function findTaskForAccess(taskId: string, req: Request) {
  return prisma.task.findFirst({
    where: { id: taskId, ...tenantWhere(req) },
    select: { id: true, assignee_ids: true, watcher_ids: true, linked_entity_type: true, linked_entity_id: true },
  });
}

export async function checkEntityAccess(entityType: AttachmentEntity, entityId: string, req: Request): Promise<boolean> {
  const { role, id: userId } = req.user!;
  const orgFilter = tenantWhere(req);

  // TASK first, BEFORE the admin/dispatcher shortcut below: that shortcut is an existence check,
  // and a dispatcher who is neither on a task nor able to open its linked record must not read
  // its files. The rule is the task's own (`canAccessTask`), so a task's files are exactly as
  // private as the task: admin always; assignee or watcher always; anyone else only through the
  // linked record they can already open.
  if (entityType === 'TASK') {
    const task = await findTaskForAccess(entityId, req);
    return !!task && canAccessTask(req, task);
  }

  // For ADMIN/DISPATCHER, still enforce org isolation via existence check
  if (role === 'ADMIN' || role === 'DISPATCHER') {
    return checkEntityExists(entityType, entityId, req);
  }

  // Customers are org-shared reference data — any in-org role with an Attachment
  // grant may attach to a customer. Org isolation is enforced via existence.
  if (entityType === 'CUSTOMER') {
    return checkEntityExists(entityType, entityId, req);
  }

  if (role === 'SALES') {
    if (entityType === 'LEAD') {
      // S8 (D6): a lead's walkthrough crew is reached through its VISITS. `visit_assignees.lead_id`
      // is dropped, so the direct back-relation no longer exists - and this is an ACCESS decision,
      // which is why the S3 migration refused to drop that column until this moved.
      const lead = await prisma.lead.findUnique({ where: { id: entityId, ...orgFilter }, select: { lead_assignees: { select: { user_id: true } }, visits: { select: { assignees: { select: { user_id: true } } } } } });
      return (lead?.lead_assignees?.some((a) => a.user_id === userId) ?? false) || isOnAnyVisit(lead, userId);
    }
    return false;
  }

  if (role === 'TECHNICIAN') {
    if (entityType === 'JOB') {
      // S8 (D6): the job-assignee table is gone; "on this job" means "on one of its trips".
      // `...orgFilter` stays on the findUnique exactly as before - the relation moved, the
      // tenancy did not.
      const job = await prisma.job.findUnique({ where: { id: entityId, ...orgFilter }, select: { visits: { select: { assignees: { select: { user_id: true } } } } } });
      return isOnAnyVisit(job, userId);
    }
    if (entityType === 'LEAD') {
      const lead = await prisma.lead.findUnique({ where: { id: entityId, ...orgFilter }, select: { visits: { select: { assignees: { select: { user_id: true } } } } } });
      return isOnAnyVisit(lead, userId);
    }
    return false;
  }

  return false;
}

// ─── Rename / remove ─────────────────────────────────────

type AttachmentChange = 'update' | 'delete';

function isTaskEntityParam(req: Request): boolean {
  return param(req, 'entityType').toUpperCase() === 'TASK';
}

/**
 * May the caller rename (`update`) or remove (`delete`) this attachment?
 *
 * The grant decides everywhere, unchanged. On a TASK there is one more way in, and it is NOT a
 * grant (visits-and-task-categories slice 12, conductor ruling: no role grant is widened): the
 * person who uploaded a file may rename or remove it. A technician holds only create/read on
 * Attachment, so without this they could put a photo on a task and never fix its name or take
 * it back. It is enforced here in code, on the loaded row, and only after `checkEntityAccess`
 * has already said the caller can see the task - so it reaches exactly "my own file on a task I
 * can access" and nothing on a job, lead, customer or invoice.
 */
function mayChangeAttachment(
  req: Request,
  action: AttachmentChange,
  entityType: AttachmentEntity,
  uploadedBy: string,
): boolean {
  if (req.ability?.can(action, 'Attachment')) return true;
  return entityType === 'TASK' && uploadedBy === req.user!.id;
}

/**
 * Route guard for PATCH and DELETE. The grant passes as it always has. Without it, only a TASK
 * request goes on to the handler, which holds it to `mayChangeAttachment` once the row is in
 * hand - a route guard runs before the row exists, so it cannot test who uploaded it (the same
 * split `task.routes.ts` uses for a technician deleting their own to-do). Every other entity
 * keeps `canDo`'s exact 401/403 answer.
 */
export function attachmentChangeGuard(action: AttachmentChange) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.ability) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!req.ability.can(action, 'Attachment') && !isTaskEntityParam(req)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

// ─── Handlers ────────────────────────────────────────────

export async function listAttachments(req: Request, res: Response) {
  try {
    const entityType = param(req, 'entityType').toUpperCase();
    const entityId = param(req, 'entityId');

    if (!validateEntityType(entityType)) {
      res.status(400).json({ error: 'Invalid entity type' });
      return;
    }

    if (!(await checkEntityAccess(entityType, entityId, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const rows = await prisma.attachment.findMany({
      where: { entity_type: entityType, entity_id: entityId, ...tenantWhere(req) },
      select: {
        id: true,
        file_name: true,
        file_url: true,
        storage_path: true,
        file_type: true,
        file_size: true,
        display_name: true,
        description: true,
        created_at: true,
        uploader: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    // `include_lead` is the current name; `include_walkthrough` is kept as an alias so any
    // client still on the old query string keeps working. Both now mean the same thing: fold
    // the originating LEAD's attachments into this job's list.
    const includeLead = req.query.include_lead === 'true' || req.query.include_walkthrough === 'true';

    const signed = await Promise.all(
      rows.map(async (row) => {
        const { storage_path, ...rest } = row;
        return { ...rest, file_url: await buildAccessUrl(storage_path, row.file_url) };
      }),
    );

    if (!includeLead || entityType !== 'JOB') {
      res.json({ attachments: signed });
      return;
    }

    // Tag existing job rows with source
    const jobRows = signed.map((a) => ({ ...a, source: 'JOB' as const }));

    // Resolve the originating lead. Job.lead_id is the direct pointer, written at conversion;
    // the estimate hop is retained as a fallback for jobs created before that column existed
    // and never backfilled (and it costs nothing — the same row is already being read).
    const jobRow = await prisma.job.findFirst({
      where: { id: entityId, ...tenantWhere(req) },
      select: { lead_id: true, estimate: { select: { lead_id: true } } },
    });
    const leadId = jobRow?.lead_id ?? jobRow?.estimate?.lead_id ?? null;

    if (!leadId) {
      res.json({ attachments: jobRows });
      return;
    }

    // Access scope, deliberate: whoever can read the JOB reads its lead's files through it. A
    // technician assigned to the job but not to the lead is refused GET /attachments/LEAD/:id
    // (403) yet receives those same rows here — the job is authorised once, above, and the lead
    // is not re-checked. That asymmetry predates this change; widening the forward from the
    // walkthrough contexts to all of them widens what it exposes. Accepted as intended: a file
    // on the lead is job paperwork, and the crew doing the job needs it. Job notes have always
    // forwarded on exactly these terms (job.controller.ts getNotes). Tenant isolation is NOT
    // relaxed — tenantWhere below still scopes every row to the caller's org.
    //
    // NO context filter. This previously listed only the walkthrough/photo contexts, which
    // silently stranded everything uploaded on the lead's own Attachments tab (context OTHER)
    // — those files never reached the job they were converted into. A lead's attachments are
    // the lead's attachments; all of them travel with the job. Matches how job notes have
    // always forwarded (job.controller.ts getNotes takes every lead note, unfiltered).
    const leadRows = await prisma.attachment.findMany({
      where: {
        entity_type: 'LEAD',
        entity_id: leadId,
        ...tenantWhere(req),
      },
      select: {
        id: true,
        file_name: true,
        file_url: true,
        storage_path: true,
        file_type: true,
        file_size: true,
        display_name: true,
        description: true,
        created_at: true,
        uploader: { select: { id: true, first_name: true, last_name: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    const leadSigned = await Promise.all(
      leadRows.map(async (row) => {
        const { storage_path, ...rest } = row;
        return { ...rest, file_url: await buildAccessUrl(storage_path, row.file_url), source: 'LEAD' as const };
      }),
    );

    res.json({ attachments: [...jobRows, ...leadSigned] });
  } catch (err) {
    logger.error('List attachments error:', err);
    res.status(500).json({ error: 'Failed to list attachments' });
  }
}

/**
 * Supabase Storage rejections carry a real reason - a bucket-level mime rejection, an object
 * over the bucket's own size ceiling, a duplicate key - and the handler used to log it and send
 * a blanket 500 with "Failed to upload file". Winston is console-only, so on Render that reason
 * was unrecoverable: the .docx outage (#1605) had to be diagnosed from the Supabase dashboard's
 * storage logs. So the rejection is mapped to a status that says what happened, and the caller
 * LOGS storage's own message.
 *
 * The response carries ServWave copy only, never storage's sentence (CLAUDE.md: an error that
 * reaches the UI through extractApiError is user-visible copy). That sentence can name the
 * vendor, the bucket and the object path - the local stub's "not implemented" answer did all
 * three. The two cases a user can act on get their own sentence; everything else is a plain
 * "try again".
 */
const STORAGE_TYPE_REFUSED = "This file type couldn't be saved. Try saving it as a PDF, or contact support.";
const STORAGE_TOO_LARGE = 'This file is too large to save. Try a smaller file, or contact support to send it another way.';
const STORAGE_FAILED = "The file couldn't be saved. Please try again.";

function mapStorageError(err: { message?: string; statusCode?: string | number; error?: string }): {
  status: number;
  error: string;
} {
  const message = err?.message || err?.error || '';
  const code = Number.parseInt(String(err?.statusCode ?? ''), 10);

  // A bucket whose allowed_mime_types has drifted behind ALLOWED_MIME_TYPES answers 400 here.
  // 415 is the honest status for the client: the file is the problem, not the request shape.
  if (/mime type/i.test(message)) return { status: 415, error: STORAGE_TYPE_REFUSED };
  if (code === 413 || /maximum allowed size|too large/i.test(message)) return { status: 413, error: STORAGE_TOO_LARGE };
  if (code === 409 || /already exists|duplicate/i.test(message)) return { status: 409, error: STORAGE_FAILED };
  // Everything else is the upstream failing us, not the caller failing validation.
  return { status: 502, error: STORAGE_FAILED };
}

export async function uploadAttachment(req: Request, res: Response) {
  try {
    const entityType = param(req, 'entityType').toUpperCase();
    const entityId = param(req, 'entityId');

    if (!validateEntityType(entityType)) {
      res.status(400).json({ error: 'Invalid entity type' });
      return;
    }

    if (!(await checkEntityExists(entityType, entityId, req))) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    if (!(await checkEntityAccess(entityType, entityId, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      res.status(400).json({ error: `File type not allowed. Accepted: ${ALLOWED_TYPES_LABEL}` });
      return;
    }

    // Magic-byte content sniff: never trust the client-supplied Content-Type
    // header alone (multer derives file.mimetype from it). Reject when the
    // actual bytes are unrecognised or disagree with the declared type (F-35).
    if (!sniffMatchesDeclared(file.buffer, file.mimetype, ALLOWED_MIME_TYPES)) {
      res.status(400).json({ error: 'File content does not match its declared type' });
      return;
    }

    // Validate file size — video gets a higher cap than images/PDF.
    const isVideo = file.mimetype.startsWith('video/');
    // MAX_PROXY_VIDEO_FILE_SIZE, never MAX_VIDEO_FILE_SIZE: this handler is the one whose
    // bytes are already sitting in `file.buffer`, so it is held to what this process can hold.
    const maxSize = isVideo ? MAX_PROXY_VIDEO_FILE_SIZE : MAX_FILE_SIZE;
    if (file.size > maxSize) {
      res.status(400).json({ error: `File too large. Maximum: ${sizeLimitLabel(maxSize)}` });
      return;
    }

    // Validate entity total size
    if (await entityTotalWouldExceed(entityType, entityId, req, file.size)) {
      res.status(400).json({ error: ENTITY_TOTAL_EXCEEDED });
      return;
    }

    // Get metadata from form fields
    const displayName = req.body.display_name;
    const description = req.body.description;

    if (!displayName || !displayName.trim()) {
      res.status(400).json({ error: 'display_name is required' });
      return;
    }
    if (description === undefined || description === null) {
      res.status(400).json({ error: 'description is required' });
      return;
    }

    // Upload to Supabase Storage — namespace by org so files are isolated even if
    // bucket privacy is misconfigured. Storage path is the canonical reference.
    //
    // Built by the SHARED builder, not a second hand-copy of the same template. This used to
    // be spelled out here and again in the direct-upload lib, with a comment claiming the two
    // could not diverge — which is the shape of both scars the PRD names. One function now,
    // so the claim is enforced rather than asserted.
    const orgId = req.user!.organization_id;
    const storagePath = buildAttachmentStoragePath(orgId, entityType, entityId, file.originalname);

    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      const { status, error } = mapStorageError(uploadError);
      logger.error('Supabase storage upload error', {
        storagePath,
        mimetype: file.mimetype,
        size: file.size,
        status,
        storageMessage: uploadError.message,
      });
      res.status(status).json({ error });
      return;
    }

    // Mint a signed URL for the response — works on both public and private buckets.
    const fileUrl = await buildAccessUrl(storagePath, '');

    // Persist `file_url: ''` rather than the freshly-minted signed URL — the
    // URL expires in 1h and storage_path is the canonical source of truth.
    // listAttachments / deleteAttachment re-mint from storage_path. Avoids
    // stale dead data in the DB column.
    // The object is already in the bucket at this point. If the row insert fails the file is
    // orphaned - invisible to the app, still billed, and indistinguishable from a real
    // attachment when auditing the bucket. Best-effort sweep before the error propagates.
    const createRow = () => prisma.attachment.create({
      data: {
        entity_type: entityType as AttachmentEntity,
        entity_id: entityId,
        file_name: file.originalname,
        file_url: '',
        storage_path: storagePath,
        file_type: file.mimetype,
        file_size: file.size,
        display_name: displayName.trim(),
        description: (description || '').trim(),
        uploaded_by: req.user!.id,
        organization_id: orgId,
        // Audit: the uploading user. uploaded_by above already names them, but it is a required
        // relation, so it cannot survive DELETE /api/users/:id/permanent - created_by_name can.
        ...createdByUser(req),
      },
      select: {
        id: true,
        file_name: true,
        file_url: true,
        file_type: true,
        file_size: true,
        display_name: true,
        description: true,
        created_at: true,
        uploader: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    let created: Awaited<ReturnType<typeof createRow>>;
    try {
      created = await createRow();
    } catch (err) {
      await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([storagePath]).catch(() => undefined);
      throw err;
    }

    const attachment = { ...created, file_url: fileUrl };

    // Log timeline event
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: entityType,
        entity_id: entityId,
        event_type: 'ATTACHMENT_UPLOADED',
        description: `File uploaded: ${displayName.trim()}`,
        metadata: { attachment_id: attachment.id, file_type: file.mimetype },
        created_by: req.user!.id,
      },
    });

    res.status(201).json({ attachment });
  } catch (err) {
    logger.error('Upload attachment error:', err);
    res.status(500).json({ error: 'Failed to upload attachment' });
  }
}

// ─── Direct-to-storage upload (video) ────────────────────

/**
 * Step 1 — mint a scoped upload URL.
 *
 * Runs every gate `uploadAttachment` runs, in the same order, BEFORE any byte moves: the
 * entity is real and in the caller's org, the caller may create attachments here, the declared
 * type is on the allowlist AND is one the direct path carries, the declared size is inside the
 * cap, and the per-entity total still has room. Only then does storage issue a URL, and that
 * URL is scoped to ONE path — built here from the org id, the entity and a sanitised filename,
 * with nothing the client sent contributing to its prefix. A caller therefore cannot obtain a
 * URL that writes outside its own org's prefix; there is no input that would produce one.
 *
 * The declared size is a claim, not a fact. It is checked here so an obviously oversized upload
 * is refused before it wastes anyone's bandwidth, and it is re-checked against the object's real
 * metadata in step 2, which is the check that actually binds.
 */
export async function createDirectUploadUrl(req: Request, res: Response) {
  try {
    const entityType = param(req, 'entityType').toUpperCase();
    const entityId = param(req, 'entityId');

    if (!validateEntityType(entityType)) {
      res.status(400).json({ error: 'Invalid entity type' });
      return;
    }

    if (!(await checkEntityExists(entityType, entityId, req))) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }

    if (!(await checkEntityAccess(entityType, entityId, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const { file_name: fileName, content_type: contentType, file_size: declaredSize } = req.body as {
      file_name: string;
      content_type: string;
      file_size: number;
    };

    if (!ALLOWED_MIME_TYPES.includes(contentType)) {
      res.status(400).json({ error: `File type not allowed. Accepted: ${ALLOWED_TYPES_LABEL}` });
      return;
    }

    if (!DIRECT_UPLOAD_MIME_TYPES.includes(contentType)) {
      // Not a user-facing dead end: every other type still uploads through the normal path.
      // This endpoint simply is not the one that carries them.
      res.status(400).json({ error: 'Only video files can be uploaded this way.' });
      return;
    }

    if (declaredSize > MAX_VIDEO_FILE_SIZE) {
      res.status(400).json({ error: `File too large. Maximum: ${sizeLimitLabel(MAX_VIDEO_FILE_SIZE)}` });
      return;
    }

    if (await entityTotalWouldExceed(entityType, entityId, req, declaredSize)) {
      res.status(400).json({ error: ENTITY_TOTAL_EXCEEDED });
      return;
    }

    const orgId = req.user!.organization_id;
    const storagePath = buildAttachmentStoragePath(orgId, entityType, entityId, fileName);

    const { data, error } = await createScopedUploadUrl(storagePath);
    if (error || !data?.signedUrl) {
      // The status mapping, with a sentence of its own: nothing has been uploaded yet, so the
      // file-specific copy `mapStorageError` picks would describe a file storage never saw.
      // Storage's own detail goes to the log, as on every path.
      const mapped = mapStorageError(error ?? {});
      logger.error('Direct upload: could not mint an upload URL', {
        storagePath,
        contentType,
        status: mapped.status,
        storageMessage: error?.message,
      });
      res.status(mapped.status).json({ error: 'Could not start the upload. Please try again.' });
      return;
    }

    const ticket = signUploadTicket({
      org: orgId,
      et: entityType,
      eid: entityId,
      path: storagePath,
      mime: contentType,
      name: fileName,
      uid: req.user!.id,
    });

    // { bucket, path, token } is everything the client needs to PUT the bytes; it builds the
    // URL itself. Returning the signed URL as well would ship the storage host in a payload
    // nothing reads.
    res.status(201).json({
      upload: { bucket: STORAGE_BUCKET, path: storagePath, token: data.token, ticket },
    });
  } catch (err) {
    logger.error('Create direct upload URL error:', err);
    res.status(500).json({ error: 'Failed to start the upload' });
  }
}

/**
 * Step 2 — verify the landed object, then record it.
 *
 * The object's identity comes from the signed ticket ONLY. Nothing in the request body names a
 * storage path, an org or a size: the schema does not accept those fields, and this handler
 * does not read them. That is what makes "verify somebody else's object into my org" — or
 * "register my org's row against another org's object" — unreachable rather than merely
 * unlikely.
 *
 * The order below is load-bearing and matches the slice spec:
 *   1. real size from storage metadata (never the client's number);
 *   2. F-35 sniff against the real leading bytes;
 *   3. per-entity total re-checked with the real size;
 *   4. only then the row.
 * Any failure after the object exists deletes it — a file that failed the sniff must not
 * survive in the bucket, which is the whole difference between a rejected upload and a stored
 * one nobody can see.
 */
export async function completeDirectUpload(req: Request, res: Response) {
  try {
    const entityType = param(req, 'entityType').toUpperCase();
    const entityId = param(req, 'entityId');

    if (!validateEntityType(entityType)) {
      res.status(400).json({ error: 'Invalid entity type' });
      return;
    }

    const { ticket: rawTicket, display_name: displayName, description } = req.body as {
      ticket: string;
      display_name: string;
      description: string;
    };

    const ticket = verifyUploadTicket(rawTicket);
    if (!ticket) {
      // Bad signature, tampered, expired and wrong-version all land here and all share one
      // user-facing sentence, which is right — none of them should tell a caller which one it
      // was. The log is where they stop being indistinguishable.
      logger.warn('Direct upload: rejected an invalid or expired ticket', {
        organizationId: req.user!.organization_id,
        userId: req.user!.id,
        entityType,
        entityId,
      });
      res.status(400).json({ error: 'This upload has expired. Please try again.' });
      return;
    }

    // Org first, and BEFORE touching storage: a replayed cross-org ticket must not so much as
    // delete the object it names. It is not this caller's object to destroy.
    if (ticket.org !== req.user!.organization_id) {
      // A well-signed ticket for another org is not a mistake anyone makes by accident.
      logger.warn('Direct upload: cross-org ticket replay refused', {
        ticketOrganizationId: ticket.org,
        callerOrganizationId: req.user!.organization_id,
        userId: req.user!.id,
        storagePath: ticket.path,
      });
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    if (ticket.et !== entityType || ticket.eid !== entityId) {
      res.status(400).json({ error: 'This upload does not belong to this record.' });
      return;
    }

    // The ticket is bound to the user who minted it, not merely to their org. Low severity on
    // its own — a colleague completing it would be recorded as the uploader anyway, and they
    // could have minted their own — but every other field on this ticket is bound, and an
    // unbound one is an exception someone later has to reason about. The only caller that ever
    // holds this ticket is the browser tab that asked for it.
    if (ticket.uid !== req.user!.id) {
      logger.warn('Direct upload: ticket completed by a user other than the one who minted it', {
        organizationId: ticket.org,
        mintedBy: ticket.uid,
        callerId: req.user!.id,
        storagePath: ticket.path,
      });
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Re-run the entity gates. The ticket lives for hours; access can be revoked inside that
    // window, and the row must not appear for someone who can no longer attach here.
    if (!(await checkEntityExists(entityType, entityId, req))) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    if (!(await checkEntityAccess(entityType, entityId, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Has this object already been recorded? Answer BEFORE any verification runs.
    //
    // A live ticket is replayable for its whole two-hour window, and `storage_path` is
    // nullable so it carries no unique index to lean on. Two rows for one object is not a
    // cosmetic duplicate: deleting either removes the object unconditionally, leaving the
    // other pointing at nothing the user can repair. Today's client does not double-submit;
    // S2 wraps retries around exactly this call.
    //
    // The POSITION is load-bearing, not just the check. Downstream of the per-entity total
    // this is actively harmful: on a replay the existing row's bytes are already inside the
    // aggregate, so adding `realSize` again double-counts the same video, and near the cap
    // the overflow branch deletes the object while a valid row still points at it — the very
    // breakage this guard exists to prevent, arrived at from the other side. Placing it here
    // also means a replay re-runs none of the VERIFICATION calls — no stat, no head read, no
    // delete — because the row IS the proof the object was already verified. It is not free:
    // `buildAccessUrl` below still mints one read URL so the replay returns the same shape as
    // the original response.
    //
    // A replay answers 200 with the existing row — not 201, and no second timeline entry,
    // because nothing new happened.
    const already = await prisma.attachment.findFirst({
      where: { storage_path: ticket.path, ...tenantWhere(req) },
      select: {
        id: true,
        file_name: true,
        file_url: true,
        file_type: true,
        file_size: true,
        display_name: true,
        description: true,
        created_at: true,
        uploader: { select: { id: true, first_name: true, last_name: true } },
      },
    });
    if (already) {
      res.status(200).json({
        attachment: { ...already, file_url: await buildAccessUrl(ticket.path, '') },
      });
      return;
    }

    const stored = await statStoredObject(ticket.path);
    if (!stored) {
      res.status(404).json({ error: 'The uploaded file could not be found. Please try again.' });
      return;
    }

    const realSize = stored.size;
    if (realSize <= 0 || realSize > MAX_VIDEO_FILE_SIZE) {
      await discardStoredObject(ticket.path);
      res.status(400).json({ error: `File too large. Maximum: ${sizeLimitLabel(MAX_VIDEO_FILE_SIZE)}` });
      return;
    }

    // F-35 against the REAL bytes. `sniffMime()` needs at most 12 of them; the head read is
    // capped so a big video never lands in this process.
    //
    // The two failures are NOT the same failure. `null` means our read broke — no URL, fetch
    // threw, a non-OK response, storage ignoring the range — and the bytes are very likely
    // fine. Collapsing that into the sniff rejection told the user their file was malformed
    // during our outage and deleted it on the way out.
    const head = await readStoredObjectHead(ticket.path);
    if (!head) {
      logger.error('Direct upload: could not read the object head to verify it', {
        storagePath: ticket.path,
        organizationId: ticket.org,
      });
      res.status(502).json({ error: 'We could not check that file just now. Please try again.' });
      return;
    }
    if (!sniffMatchesDeclared(head, ticket.mime, ALLOWED_MIME_TYPES)) {
      await discardStoredObject(ticket.path);
      res.status(400).json({ error: 'File content does not match its declared type' });
      return;
    }

    if (await entityTotalWouldExceed(entityType, entityId, req, realSize)) {
      await discardStoredObject(ticket.path);
      res.status(400).json({ error: ENTITY_TOTAL_EXCEEDED });
      return;
    }

    const fileUrl = await buildAccessUrl(ticket.path, '');

    // Same persistence contract as the multipart path: `file_url: ''`, storage_path canonical.
    const createRow = () => prisma.attachment.create({
      data: {
        entity_type: entityType as AttachmentEntity,
        entity_id: entityId,
        file_name: ticket.name,
        file_url: '',
        storage_path: ticket.path,
        file_type: ticket.mime,
        file_size: realSize,
        display_name: displayName.trim(),
        description: (description || '').trim(),
        uploaded_by: req.user!.id,
        // `req.user`, not `ticket.org`. They are equal — the check above refuses anything
        // else — but the row should have ONE provenance, and it is the same one
        // `tenantWhere` uses for every read on this request.
        organization_id: req.user!.organization_id,
        ...createdByUser(req),
      },
      select: {
        id: true,
        file_name: true,
        file_url: true,
        file_type: true,
        file_size: true,
        display_name: true,
        description: true,
        created_at: true,
        uploader: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    let created: Awaited<ReturnType<typeof createRow>>;
    try {
      created = await createRow();
    } catch (err) {
      await discardStoredObject(ticket.path);
      throw err;
    }

    const attachment = { ...created, file_url: fileUrl };

    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: entityType,
        entity_id: entityId,
        event_type: 'ATTACHMENT_UPLOADED',
        description: `File uploaded: ${displayName.trim()}`,
        metadata: { attachment_id: attachment.id, file_type: ticket.mime },
        created_by: req.user!.id,
      },
    });

    res.status(201).json({ attachment });
  } catch (err) {
    logger.error('Complete direct upload error:', err);
    res.status(500).json({ error: 'Failed to save the uploaded file' });
  }
}

export async function updateAttachment(req: Request, res: Response) {
  try {
    const entityType = param(req, 'entityType').toUpperCase();
    const entityId = param(req, 'entityId');
    const attachmentId = param(req, 'attachmentId');

    if (!validateEntityType(entityType)) {
      res.status(400).json({ error: 'Invalid entity type' });
      return;
    }

    if (!(await checkEntityAccess(entityType, entityId, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // `select` is not optional here. Without one Prisma enumerates EVERY column of the model in
    // the generated SQL, using the client built from that deploy's schema.prisma -- so a build
    // that predates a column drop keeps asking for the dropped column and 500s. This row is only
    // tested for existence, so ask for the one field that proves it.
    const existing = await prisma.attachment.findFirst({
      where: { id: attachmentId, entity_type: entityType as AttachmentEntity, entity_id: entityId, ...tenantWhere(req) },
      select: { id: true, uploaded_by: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }
    if (!mayChangeAttachment(req, 'update', entityType, existing.uploaded_by)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const { display_name, description } = req.body;
    const attachment = await prisma.attachment.update({
      where: { id: attachmentId },
      data: {
        ...(display_name !== undefined ? { display_name: display_name.trim() } : {}),
        ...(description !== undefined ? { description: description.trim() } : {}),
      },
      select: {
        id: true,
        file_name: true,
        file_url: true,
        file_type: true,
        file_size: true,
        display_name: true,
        description: true,
        created_at: true,
        uploader: { select: { id: true, first_name: true, last_name: true } },
      },
    });

    // Log timeline event
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: entityType,
        entity_id: entityId,
        event_type: 'ATTACHMENT_UPDATED',
        description: `Attachment updated: ${attachment.display_name}`,
        metadata: { attachment_id: attachmentId },
        created_by: req.user!.id,
      },
    });

    res.json({ attachment });
  } catch (err) {
    logger.error('Update attachment error:', err);
    res.status(500).json({ error: 'Failed to update attachment' });
  }
}

export async function deleteAttachment(req: Request, res: Response) {
  try {
    const entityType = param(req, 'entityType').toUpperCase();
    const entityId = param(req, 'entityId');
    const attachmentId = param(req, 'attachmentId');

    if (!validateEntityType(entityType)) {
      res.status(400).json({ error: 'Invalid entity type' });
      return;
    }

    if (!(await checkEntityAccess(entityType, entityId, req))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Explicit `select` for the same reason as the PATCH handler above: no `select` means Prisma
    // asks for every column the generated client knows about. These five are the ones read below.
    const existing = await prisma.attachment.findFirst({
      where: { id: attachmentId, entity_type: entityType as AttachmentEntity, entity_id: entityId, ...tenantWhere(req) },
      select: { storage_path: true, file_url: true, display_name: true, file_name: true, uploaded_by: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Attachment not found' });
      return;
    }
    if (!mayChangeAttachment(req, 'delete', entityType, existing.uploaded_by)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Prefer canonical storage_path. Legacy rows: parse from the (now obsolete) public URL.
    // The parser moved to attachment-access.ts when the orphan sweep (S3) grew a second need
    // for it — the sweep asks the same question to decide an object is NOT an orphan, and the
    // two answers have to be the same string or the sweep deletes what this handler can find.
    // `||`, not `??`: the code this replaced tested `!storagePath`, so an EMPTY storage_path
    // fell through to the URL parser. `??` would have kept the empty string and skipped the
    // storage delete, leaking the object. No such row exists on staging, but the point of an
    // extraction is that behaviour does not move, and this keeps it exactly.
    const storagePath = attachmentObjectPath(existing);

    if (storagePath) {
      const { error: deleteError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET)
        .remove([storagePath]);

      if (deleteError) {
        logger.warn(`Failed to delete file from storage (continuing): ${deleteError.message}`);
      }
    }

    // Delete record
    // deleteMany, not delete: `delete` returns the deleted row, so Prisma emits RETURNING with
    // every column. The return value is unused here and a count enumerates nothing.
    await prisma.attachment.deleteMany({ where: { id: attachmentId } });

    // Log timeline event
    await prisma.timelineEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        entity_type: entityType,
        entity_id: entityId,
        event_type: 'ATTACHMENT_DELETED',
        description: `Attachment deleted: ${existing.display_name}`,
        metadata: { attachment_id: attachmentId, file_name: existing.file_name },
        created_by: req.user!.id,
      },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error('Delete attachment error:', err);
    res.status(500).json({ error: 'Failed to delete attachment' });
  }
}
