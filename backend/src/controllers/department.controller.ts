import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';

export const createDepartmentSchema = z.object({
  name: z.string().min(1).max(50).transform((s) => s.trim()),
});

export const updateDepartmentSchema = z.object({
  name: z.string().min(1).max(50).transform((s) => s.trim()).optional(),
  head_id: z.string().uuid().nullable().optional(),
});

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

/** GET /api/departments — list this org's departments */
export async function list(req: Request, res: Response) {
  try {
    const departments = await prisma.department.findMany({
      where: tenantWhere(req),
      select: {
        id: true,
        name: true,
        created_at: true,
        head_id: true,
        head: { select: { id: true, first_name: true, last_name: true } },
        _count: { select: { users: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json({ departments });
  } catch (err) {
    logger.error('List departments error:', err);
    res.status(500).json({ error: 'Failed to list departments' });
  }
}

/** POST /api/departments — create (ADMIN only, per-org) */
export async function create(req: Request, res: Response) {
  try {
    const { name } = req.body;
    const orgId = req.user!.organization_id;

    const existing = await prisma.department.findUnique({
      where: { organization_id_name: { organization_id: orgId, name } },
    });
    if (existing) {
      res.status(409).json({ error: 'Department already exists', department: existing });
      return;
    }
    const department = await prisma.department.create({
      data: { name, organization_id: orgId },
      select: { id: true, name: true, created_at: true },
    });
    res.status(201).json({ department });
  } catch (err) {
    logger.error('Create department error:', err);
    res.status(500).json({ error: 'Failed to create department' });
  }
}

/** PATCH /api/departments/:id — rename (ADMIN only) */
export async function update(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const { name, head_id } = req.body;
    const orgId = req.user!.organization_id;

    const target = await prisma.department.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!target) {
      res.status(404).json({ error: 'Department not found' });
      return;
    }

    if (name !== undefined) {
      const collision = await prisma.department.findFirst({
        where: { name, organization_id: orgId, NOT: { id } },
      });
      if (collision) {
        res.status(409).json({ error: 'Another department with that name already exists' });
        return;
      }
    }

    // Display-only head: must be a user in the same org (grants NO powers). null clears it.
    if (head_id) {
      const head = await prisma.user.findFirst({
        where: { id: head_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!head) {
        res.status(400).json({ error: 'Head user not found in this organization' });
        return;
      }
    }

    const data: { name?: string; head_id?: string | null } = {};
    if (name !== undefined) data.name = name;
    if (head_id !== undefined) data.head_id = head_id;

    const department = await prisma.department.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        created_at: true,
        head_id: true,
        head: { select: { id: true, first_name: true, last_name: true } },
      },
    });
    res.json({ department });
  } catch (err) {
    logger.error('Update department error:', err);
    res.status(500).json({ error: 'Failed to update department' });
  }
}

/** DELETE /api/departments/:id — delete (ADMIN only). Users assigned to it become department-less. */
export async function remove(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const result = await prisma.department.deleteMany({
      where: { id, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Department not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    logger.error('Delete department error:', err);
    res.status(500).json({ error: 'Failed to delete department' });
  }
}
