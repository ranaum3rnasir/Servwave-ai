import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { equalsIgnoringCase } from '../lib/name-match';

// Purchasing Audit Verdict (2026-09-02, PR 4 / S4.1): vendor categories are a
// real per-company list (`vendor_categories`, shipped by PR 2's migration
// together with `vendors.category_id`). This controller owns the list; the
// vendor upsert in inv-vendors.controller.ts resolves a vendor onto a row.
//
// Contract:
//   GET    /vendor-categories       -> { categories: [{ id, name, vendorCount }] }  (name asc)
//   POST   /vendor-categories       -> 201 { category }   409 CATEGORY_EXISTS
//   PATCH  /vendor-categories/:id   -> 200 { category }   409 CATEGORY_EXISTS, 404
//   DELETE /vendor-categories/:id   -> 200                409 CATEGORY_IN_USE { vendor_count }, 404
//
// Every handler is tenant-scoped through tenantWhere(); the routes gate on the
// existing Vendor CASL actions (read/create/update/delete Vendor).

export const vendorCategorySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
});

type CategoryRow = {
  id: string;
  name: string;
  _count?: { vendors?: number };
};

function toCategoryDto(row: CategoryRow, vendorCount?: number) {
  return {
    id: row.id,
    name: row.name,
    vendorCount: vendorCount ?? row._count?.vendors ?? 0,
  };
}

const categoryInclude = { _count: { select: { vendors: true } } } as const;

const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

/**
 * The duplicate check is case-insensitive on purpose: the unique index is
 * exact-match, so "Plumbing" and "plumbing" would otherwise become two rows
 * that every picker shows side by side. `excludeId` lets a rename keep its
 * own row out of the comparison.
 */
async function findDuplicate(req: Request, name: string, excludeId?: string) {
  return prisma.vendorCategory.findFirst({
    where: {
      ...tenantWhere(req),
      // Exact text, any case - never a LIKE pattern (a name may contain % or _).
      name: equalsIgnoringCase(name),
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

function conflictExists(res: Response, name: string) {
  res.status(409).json({
    error: 'CATEGORY_EXISTS',
    message: `A category named "${name}" already exists.`,
  });
}

export async function listVendorCategories(req: Request, res: Response) {
  try {
    const rows: CategoryRow[] = await prisma.vendorCategory.findMany({
      where: tenantWhere(req),
      orderBy: [{ name: 'asc' }],
      include: categoryInclude,
    });
    res.json({ categories: rows.map((r) => toCategoryDto(r)) });
  } catch (err) {
    logger.error('Failed to list vendor categories:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createVendorCategory(req: Request, res: Response) {
  try {
    const name: string = req.body.name;
    if (await findDuplicate(req, name)) {
      conflictExists(res, name);
      return;
    }

    const row: CategoryRow = await prisma.vendorCategory.create({
      data: { name, organization_id: req.user!.organization_id },
    });

    void logAudit({
      req,
      action: 'inventory.vendor_category_created',
      resourceType: 'VendorCategory',
      resourceId: row.id,
      metadata: { name: row.name },
    });

    res.status(201).json({ category: toCategoryDto(row, 0) });
  } catch (err: any) {
    // The unique index is the last line of defence against a concurrent create
    // with the same name - answer the same 409 the pre-check would have.
    if (err?.code === 'P2002') {
      conflictExists(res, req.body.name);
      return;
    }
    logger.error('Failed to create vendor category:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function renameVendorCategory(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    if (!isUuid(id)) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    const name: string = req.body.name;

    const existing: CategoryRow | null = await prisma.vendorCategory.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    if (await findDuplicate(req, name, id)) {
      conflictExists(res, name);
      return;
    }

    // The legacy `vendors.category` string is still what older readers show,
    // so a rename carries it along in the same transaction: every vendor in
    // the category follows the new name at once.
    const row: CategoryRow = await prisma.$transaction(async (tx) => {
      const updated = await tx.vendorCategory.update({
        where: { id },
        data: { name },
        include: categoryInclude,
      });
      await tx.vendor.updateMany({
        where: { category_id: id, ...tenantWhere(req) },
        data: { category: name },
      });
      return updated;
    });

    void logAudit({
      req,
      action: 'inventory.vendor_category_renamed',
      resourceType: 'VendorCategory',
      resourceId: id,
      metadata: { from: existing.name, to: name },
    });

    res.json({ category: toCategoryDto(row) });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      conflictExists(res, req.body.name);
      return;
    }
    logger.error('Failed to rename vendor category:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteVendorCategory(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    if (!isUuid(id)) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    // Refused while any vendor sits in the category: the FK is SET NULL, so a
    // bare delete would silently make those vendors Uncategorized. The count
    // is in the body so the client can say how many are blocking.
    const vendorCount = await prisma.vendor.count({
      where: { category_id: id, ...tenantWhere(req) },
    });
    if (vendorCount > 0) {
      res.status(409).json({
        error: 'CATEGORY_IN_USE',
        message: vendorCount === 1
          ? '1 vendor still uses this category. Move it to another category first.'
          : `${vendorCount} vendors still use this category. Move them to another category first.`,
        vendor_count: vendorCount,
      });
      return;
    }

    const result = await prisma.vendorCategory.deleteMany({
      where: { id, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    void logAudit({
      req,
      action: 'inventory.vendor_category_deleted',
      resourceType: 'VendorCategory',
      resourceId: id,
    });

    res.json({ message: 'Category deleted' });
  } catch (err) {
    logger.error('Failed to delete vendor category:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
