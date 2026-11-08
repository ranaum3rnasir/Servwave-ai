import { Request, Response } from 'express';
import { z } from 'zod';
import { JobStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';

/**
 * SRVW-112 - the per-org job sub-status catalog (Workiz parity): org-defined labels one level
 * under the FIXED JobStatus parents. Structurally a department.controller.ts /
 * org-tax-rate.controller.ts sibling, with ONE deliberate divergence.
 *
 * TENANCY: every Prisma call here - reads AND writes - spreads tenantWhere(req). Both template
 * controllers write `update({ where: { id }, data })` unscoped after a scoped read; that pattern
 * is deliberately NOT copied, because CLAUDE.md's multi-tenancy boundary is unconditional. The
 * extended-where-unique form used below is already proven in this repo on prisma.job.update.
 *
 * The compound unique key (organization_id, parent, label) is NEVER an upsert target with
 * user-supplied values - create() pre-checks and 409s instead, so a crafted body can never
 * resolve a row in another tenant.
 */

export const createJobSubStatusSchema = z.object({
  parent: z.nativeEnum(JobStatus),
  label: z.string().min(1).max(60).transform((s) => s.trim()),
  sort_order: z.number().int().min(0).optional(),
});

export const updateJobSubStatusSchema = z.object({
  label: z.string().min(1).max(60).transform((s) => s.trim()).optional(),
});

export const reorderJobSubStatusSchema = z.object({
  parent: z.nativeEnum(JobStatus),
  ordered_ids: z.array(z.string().uuid()).min(1).max(100),
});

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

/** GET /api/job-sub-statuses - this org's whole catalog, grouped client-side by parent. */
export async function list(req: Request, res: Response) {
  try {
    const job_sub_statuses = await prisma.jobSubStatus.findMany({
      where: tenantWhere(req),
      orderBy: [{ parent: 'asc' }, { sort_order: 'asc' }, { label: 'asc' }],
    });
    res.json({ job_sub_statuses });
  } catch (err) {
    logger.error('List job sub-statuses error:', err);
    res.status(500).json({ error: 'Failed to list job sub-statuses' });
  }
}

/** POST /api/job-sub-statuses - add a label under one parent. */
export async function create(req: Request, res: Response) {
  try {
    const { parent, label, sort_order } = req.body as z.infer<typeof createJobSubStatusSchema>;

    const existing = await prisma.jobSubStatus.findFirst({
      where: { parent, label, ...tenantWhere(req) },
    });
    if (existing) {
      res.status(409).json({ error: 'That sub-status already exists under this status' });
      return;
    }

    // Append index. The count races benignly: sort_order is not unique and list()'s orderBy
    // tie-breaks on label, so two concurrent creates just tie.
    const appendIndex = sort_order ?? (await prisma.jobSubStatus.count({
      where: { parent, ...tenantWhere(req) },
    }));

    const job_sub_status = await prisma.jobSubStatus.create({
      data: {
        parent,
        label,
        sort_order: appendIndex,
        // From the authenticated user, NEVER from the body.
        organization_id: req.user!.organization_id,
      },
    });
    res.status(201).json({ job_sub_status });
  } catch (err) {
    logger.error('Create job sub-status error:', err);
    res.status(500).json({ error: 'Failed to create job sub-status' });
  }
}

/** PATCH /api/job-sub-statuses/:id - rename. The parent is immutable (see the header note). */
export async function update(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { label } = req.body as z.infer<typeof updateJobSubStatusSchema>;

    const target = await prisma.jobSubStatus.findFirst({ where: { id, ...tenantWhere(req) } });
    if (!target) {
      res.status(404).json({ error: 'Sub-status not found' });
      return;
    }

    if (label !== undefined) {
      const collision = await prisma.jobSubStatus.findFirst({
        where: { label, parent: target.parent, NOT: { id }, ...tenantWhere(req) },
      });
      if (collision) {
        res.status(409).json({ error: 'Another sub-status under this status already has that name' });
        return;
      }
    }

    const job_sub_status = await prisma.jobSubStatus.update({
      // tenantWhere on the WRITE too, not just the read above - see the header note.
      where: { id, ...tenantWhere(req) },
      data: { label },
    });
    res.json({ job_sub_status });
  } catch (err) {
    logger.error('Update job sub-status error:', err);
    res.status(500).json({ error: 'Failed to update job sub-status' });
  }
}

/**
 * DELETE /api/job-sub-statuses/:id. Jobs still holding this label are SET NULL by the FK rather
 * than blocking the delete - RESTRICT would make a settings mistake unfixable.
 *
 * SRVW-113 - card AC "disables, not orphans": trigger_config is JSONB with no FK, so a
 * JOB_SUB_STATUS_ENTERED workflow pointing at this id would otherwise silently point at
 * nothing. Disabled in the SAME transaction as the delete, not deleted itself - a published
 * WorkflowVersion.definition also holds a frozen copy, and rewriting that history is wrong.
 */
export async function remove(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const orgId = req.user!.organization_id;
    const deletedCount = await prisma.$transaction(async (tx) => {
      const result = await tx.jobSubStatus.deleteMany({ where: { id, ...tenantWhere(req) } });
      if (result.count > 0) {
        await tx.workflow.updateMany({
          where: {
            organization_id: orgId,
            trigger_type: 'JOB_SUB_STATUS_ENTERED',
            trigger_config: { path: ['sub_status_id'], equals: id },
          },
          data: { is_enabled: false },
        });
      }
      return result.count;
    });
    if (deletedCount === 0) {
      res.status(404).json({ error: 'Sub-status not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    logger.error('Delete job sub-status error:', err);
    res.status(500).json({ error: 'Failed to delete job sub-status' });
  }
}

/** POST /api/job-sub-statuses/reorder - rewrite sort_order for one parent's whole list. */
export async function reorder(req: Request, res: Response) {
  try {
    const { parent, ordered_ids } = req.body as z.infer<typeof reorderJobSubStatusSchema>;

    // One resolving read catches foreign-org ids AND wrong-parent ids together, and writes
    // nothing when either is present - so a partial reorder is not reachable.
    const found = await prisma.jobSubStatus.findMany({
      where: { id: { in: ordered_ids }, parent, ...tenantWhere(req) },
      select: { id: true },
    });
    if (found.length !== ordered_ids.length) {
      res.status(400).json({ error: 'Unknown sub-status in reorder' });
      return;
    }

    await prisma.$transaction(
      ordered_ids.map((id, i) => prisma.jobSubStatus.update({
        where: { id, ...tenantWhere(req) },
        data: { sort_order: i },
      })),
    );
    res.status(204).send();
  } catch (err) {
    logger.error('Reorder job sub-statuses error:', err);
    res.status(500).json({ error: 'Failed to reorder job sub-statuses' });
  }
}
