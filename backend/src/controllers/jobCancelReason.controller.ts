import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import {
  BUILT_IN_JOB_CANCEL_REASONS,
  BUILT_IN_JOB_CANCEL_REASON_CODES,
  JOB_CANCEL_REASON_CODE_PATTERN,
  JOB_CANCEL_REASON_LABEL_MAX,
  MAX_JOB_CANCEL_REASONS,
  UNDEACTIVATABLE_JOB_CANCEL_REASON_CODE,
  deriveJobCancelReasonCode,
} from '../lib/jobCancelReasons';

/**
 * The per-org job cancel-reasons list (Roles & Permissions, PRD 6, slice S06.14).
 *
 * The job twin of lostReasonOption.controller.ts and written the same way, on a table of its own: editing this list never
 * touches the estimate decline reasons, and the reverse. Its rows start out as built-ins the org has never customised,
 * addressed by their STABLE CODE rather than a row id, so an org with no rows can still rename one: the first write is the
 * materialisation, and it writes ALL SIX or none (the list resolves as "the org's rows if it has any, else the built-ins",
 * so one lone row would silently drop the other five). Every Prisma call carries the caller's organization_id, reads and
 * writes both. There is no DELETE handler by design: a cancelled job holds the code, so a reason is turned off instead.
 */

// ─── Schemas ────────────────────────────────────────────────────────────────

/** Trimmed BEFORE the length checks, so sixty spaces cannot become an empty label. */
const labelSchema = z.string().trim().min(1).max(JOB_CANCEL_REASON_LABEL_MAX);

const codeSchema = z.string().regex(JOB_CANCEL_REASON_CODE_PATTERN);

export const createJobCancelReasonSchema = z
  .object({
    label: labelSchema,
  })
  .strict();

export const updateJobCancelReasonSchema = z
  .object({
    label: labelSchema.optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  // An empty body means nothing; answering 200 to it would report a change that never happened.
  .refine((d) => d.label !== undefined || d.is_active !== undefined, {
    message: 'Send a label, an is_active, or both',
  });

export const reorderJobCancelReasonsSchema = z
  .object({
    ordered_codes: z
      .array(codeSchema)
      .min(1)
      .max(MAX_JOB_CANCEL_REASONS)
      .refine((arr) => new Set(arr).size === arr.length, { message: 'Duplicate code in reorder list' }),
  })
  .strict();

// ─── Shapes ─────────────────────────────────────────────────────────────────

interface JobCancelReasonDto {
  code: string;
  label: string;
  is_active: boolean;
  sort_order: number;
  /** Derived from the code, never stored. */
  is_builtin: boolean;
}

/** The row's id is deliberately left out: an org with no rows has none, and `code` is the key everywhere. */
function toDto(row: { code: string; label: string; is_active: boolean; sort_order: number }): JobCancelReasonDto {
  return {
    code: row.code,
    label: row.label,
    is_active: row.is_active,
    sort_order: row.sort_order,
    is_builtin: BUILT_IN_JOB_CANCEL_REASON_CODES.has(row.code),
  };
}

/** The answer for an organisation that has never edited the list: the six built-ins, all active. */
function builtInDtos(): JobCancelReasonDto[] {
  return BUILT_IN_JOB_CANCEL_REASONS.map((r, i) => toDto({ ...r, is_active: true, sort_order: i }));
}

/** Rendered copy: it reaches the UI through `extractApiError`. Stated once because create() reports it from two places. */
const DUPLICATE_REASON_MSG = 'That cancel reason already exists';

// ─── Materialisation ────────────────────────────────────────────────────────

/** Write the six built-ins as real rows. Only called inside a write's transaction, and only when the org has none. */
async function materialiseBuiltIns(tx: Prisma.TransactionClient, orgId: string): Promise<void> {
  await tx.jobCancelReasonOption.createMany({
    data: BUILT_IN_JOB_CANCEL_REASONS.map((r, i) => ({
      organization_id: orgId,
      code: r.code,
      label: r.label,
      sort_order: i,
    })),
    // Two admins saving at once both arrive here with a count of zero; the unique key turns the loser's insert into a skip.
    skipDuplicates: true,
  });
}

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

/**
 * GET /api/job-cancel-reasons - this org's list, or the built-ins if it has never been edited.
 *
 * Turned-off rows are included: this is the management view, and an admin has to see a reason to switch it back on. The
 * cancel dialogs filter on `is_active`.
 */
export async function list(req: Request, res: Response) {
  try {
    const rows = await prisma.jobCancelReasonOption.findMany({
      where: tenantWhere(req),
      // `code` breaks ties so two identical GETs never reshuffle the list under a drag-to-reorder screen.
      orderBy: [{ sort_order: 'asc' }, { code: 'asc' }],
    });
    res.json({ job_cancel_reasons: rows.length > 0 ? rows.map(toDto) : builtInDtos() });
  } catch (err) {
    logger.error('List job cancel reasons error:', err);
    res.status(500).json({ error: 'Failed to list cancel reasons' });
  }
}

/** POST /api/job-cancel-reasons - add a reason of this organisation's own. */
export async function create(req: Request, res: Response) {
  try {
    const { label } = req.body as z.infer<typeof createJobCancelReasonSchema>;
    const orgId = req.user!.organization_id;

    const code = deriveJobCancelReasonCode(label);
    if (!code) {
      res.status(400).json({ error: 'Give this reason a name with at least one letter or number' });
      return;
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const stored = await tx.jobCancelReasonOption.count({ where: { organization_id: orgId } });
      if (stored === 0) {
        // A refused request must write nothing: the org resolves to the built-ins, so a colliding code is knowable first.
        if (BUILT_IN_JOB_CANCEL_REASON_CODES.has(code)) return { kind: 'duplicate' as const };
        await materialiseBuiltIns(tx, orgId);
      }

      // Re-counted: after materialisation the list is six long, and both the cap and the append index use what is there now.
      const current = await tx.jobCancelReasonOption.count({ where: { organization_id: orgId } });
      if (current >= MAX_JOB_CANCEL_REASONS) return { kind: 'full' as const };

      // Pre-check and 409, never an upsert on a user-supplied code: a turned-off reason with the same name is reported,
      // not silently revived under a new label.
      const collision = await tx.jobCancelReasonOption.findFirst({ where: { code, organization_id: orgId } });
      if (collision) return { kind: 'duplicate' as const };

      const row = await tx.jobCancelReasonOption.create({
        data: {
          code,
          label,
          sort_order: current,
          // From the authenticated user, NEVER from the body.
          organization_id: orgId,
        },
      });
      return { kind: 'created' as const, row };
    });

    if (outcome.kind === 'full') {
      res.status(400).json({ error: `A cancel reason list is capped at ${MAX_JOB_CANCEL_REASONS} reasons` });
      return;
    }
    if (outcome.kind === 'duplicate') {
      res.status(409).json({ error: DUPLICATE_REASON_MSG });
      return;
    }

    void logAudit({
      req,
      action: 'job.cancel_reason_created',
      resourceType: 'JobCancelReasonOption',
      resourceId: outcome.row.id,
      metadata: { code },
    });

    res.status(201).json({ job_cancel_reason: toDto(outcome.row) });
  } catch (err) {
    // Two requests arriving together (a double-click on Add) both read "no collision" and the loser comes back P2002 on
    // (organization_id, code), the only unique key bar the primary key. Answered with the same 409 as the pre-check.
    const prismaErr = err as { code?: string };
    if (prismaErr.code === 'P2002') {
      res.status(409).json({ error: DUPLICATE_REASON_MSG });
      return;
    }
    logger.error('Create job cancel reason error:', err);
    res.status(500).json({ error: 'Failed to add cancel reason' });
  }
}

/**
 * PATCH /api/job-cancel-reasons/:code - rename, turn off, or turn back on.
 *
 * The code is immutable: a cancelled job stores it. Only the label - the words - is renameable.
 */
export async function update(req: Request, res: Response) {
  try {
    const code = param(req, 'code');
    if (!JOB_CANCEL_REASON_CODE_PATTERN.test(code)) {
      res.status(404).json({ error: 'Cancel reason not found' });
      return;
    }
    const { label, is_active } = req.body as z.infer<typeof updateJobCancelReasonSchema>;
    const orgId = req.user!.organization_id;

    // Checked before anything is read or written, so refusing to turn "Other" off cannot materialise the list.
    if (is_active === false && code === UNDEACTIVATABLE_JOB_CANCEL_REASON_CODE) {
      res.status(400).json({ error: 'This reason has to stay available, so a cancelled job always has a reason that fits' });
      return;
    }

    const outcome = await prisma.$transaction(async (tx) => {
      const stored = await tx.jobCancelReasonOption.count({ where: { organization_id: orgId } });
      if (stored === 0) {
        // Answered BEFORE materialising: a 404 must not leave six rows behind it.
        if (!BUILT_IN_JOB_CANCEL_REASON_CODES.has(code)) return { kind: 'missing' as const };
        await materialiseBuiltIns(tx, orgId);
      }

      const data: { label?: string; is_active?: boolean } = {};
      if (label !== undefined) data.label = label;
      if (is_active !== undefined) data.is_active = is_active;

      // updateMany: the tenant clause belongs in the write's own where, and count === 0 is the 404.
      const result = await tx.jobCancelReasonOption.updateMany({ where: { code, organization_id: orgId }, data });
      if (result.count === 0) return { kind: 'missing' as const };

      const row = await tx.jobCancelReasonOption.findFirst({ where: { code, organization_id: orgId } });
      return { kind: 'updated' as const, row };
    });

    if (outcome.kind === 'missing' || !outcome.row) {
      res.status(404).json({ error: 'Cancel reason not found' });
      return;
    }

    void logAudit({
      req,
      action: 'job.cancel_reason_updated',
      resourceType: 'JobCancelReasonOption',
      resourceId: outcome.row.id,
      metadata: { code, ...(label !== undefined ? { label } : {}), ...(is_active !== undefined ? { is_active } : {}) },
    });

    res.json({ job_cancel_reason: toDto(outcome.row) });
  } catch (err) {
    logger.error('Update job cancel reason error:', err);
    res.status(500).json({ error: 'Failed to update cancel reason' });
  }
}

/**
 * POST /api/job-cancel-reasons/reorder - rewrite sort_order for the whole list.
 *
 * The body must name EVERY reason the org resolves to, exactly once, or the request is refused whole: a partial list would
 * leave unnamed rows on their old positions and collide with the renumbered ones. Every code must resolve inside this org
 * before anything is written, so one foreign or invented code writes nothing.
 */
export async function reorder(req: Request, res: Response) {
  try {
    const { ordered_codes } = req.body as z.infer<typeof reorderJobCancelReasonsSchema>;
    const orgId = req.user!.organization_id;

    const outcome = await prisma.$transaction(async (tx) => {
      const stored = await tx.jobCancelReasonOption.count({ where: { organization_id: orgId } });

      // Measured against the RESOLVED list and answered BEFORE materialising: a rejected reorder leaves the org exactly as
      // unconfigured as it was.
      const total = stored === 0 ? BUILT_IN_JOB_CANCEL_REASON_CODES.size : stored;
      if (ordered_codes.length !== total) return { kind: 'incomplete' as const, total };

      if (stored === 0) {
        if (!ordered_codes.every((c) => BUILT_IN_JOB_CANCEL_REASON_CODES.has(c))) return { kind: 'unknown' as const };
        await materialiseBuiltIns(tx, orgId);
      }

      // One resolving read catches foreign-org codes and invented codes together.
      const found = await tx.jobCancelReasonOption.findMany({
        where: { code: { in: ordered_codes }, organization_id: orgId },
        select: { code: true },
      });
      if (found.length !== ordered_codes.length) return { kind: 'unknown' as const };

      for (const [i, code] of ordered_codes.entries()) {
        await tx.jobCancelReasonOption.updateMany({
          where: { code, organization_id: orgId },
          data: { sort_order: i },
        });
      }
      return { kind: 'reordered' as const };
    });

    if (outcome.kind === 'incomplete') {
      res.status(400).json({
        error: `Send all ${outcome.total} cancel reasons when reordering, in the order you want them offered in`,
      });
      return;
    }
    if (outcome.kind === 'unknown') {
      res.status(400).json({ error: 'Unknown cancel reason in reorder' });
      return;
    }

    void logAudit({
      req,
      action: 'job.cancel_reasons_reordered',
      resourceType: 'JobCancelReasonOption',
      metadata: { ordered_codes },
    });

    res.status(204).send();
  } catch (err) {
    logger.error('Reorder job cancel reasons error:', err);
    res.status(500).json({ error: 'Failed to reorder cancel reasons' });
  }
}
