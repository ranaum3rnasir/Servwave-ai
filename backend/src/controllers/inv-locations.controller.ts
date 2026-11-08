import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { resolveRestrictedVan } from './inv-stock.controller';

// A job stage that has reached `delivered` has had its parts collected by the
// technician, so the location it names is a historical record and deleting that
// location takes nothing away. Every other status - including one this build has
// never heard of - still describes parts that are meant to be sitting there.
// JobStage.status is a free-form String (validated only as z.string().max(50) in
// inv-stages.controller.ts), never a Prisma enum, so this is deliberately a
// terminal-status DENYLIST: an unrecognised status blocks the delete rather than
// slipping past an allowlist that was written before it existed.
const TERMINAL_STAGE_STATUSES = ['delivered'];

// ─── Zod Schemas ───────────────────────────────────────

export const createBranchSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  code: z.string().max(50).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  managerName: z.string().max(200).nullable().optional(),
  timezone: z.string().max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const updateBranchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  code: z.string().max(50).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  managerName: z.string().max(200).nullable().optional(),
  timezone: z.string().max(100).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const createLocationSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  type: z.enum(['warehouse', 'truck', 'counter', 'staging']),
  branch_id: z.string().uuid().nullable().optional(),
  primary_tech_id: z.string().uuid().nullable().optional(),
  vehicle: z.string().max(200).nullable().optional(),
  stagingAreas: z.array(z.string().max(200)).nullable().optional(),
});

export const updateLocationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.enum(['warehouse', 'truck', 'counter', 'staging']).optional(),
  branch_id: z.string().uuid().nullable().optional(),
  primary_tech_id: z.string().uuid().nullable().optional(),
  vehicle: z.string().max(200).nullable().optional(),
  stagingAreas: z.array(z.string().max(200)).nullable().optional(),
});

// ─── Mappers (snake_case Prisma row → camelCase mock shape) ──

// Matches the `Branch` mock type in
// frontend/src/lib/api/_mock/inventory/inventory.ts
function mapBranch(row: any) {
  return {
    id: row.id,
    name: row.name,
    code: row.code ?? undefined,
    address: row.address ?? undefined,
    phone: row.phone ?? undefined,
    managerName: row.manager_name ?? undefined,
    timezone: row.timezone ?? undefined,
    notes: row.notes ?? undefined,
  };
}

// Matches the `Location` mock type. Note: the mock carries `branch` and
// `primaryTech` as display-name strings, not FK ids — we surface the related
// row's name (falling back to the stored id when the relation isn't loaded).
function mapLocation(row: any) {
  const techName = row.primary_tech
    ? [row.primary_tech.first_name, row.primary_tech.last_name].filter(Boolean).join(' ').trim()
    : '';
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    branch: row.branch?.name ?? '',
    primaryTech: techName || undefined,
    vehicle: row.vehicle ?? undefined,
    stagingAreas: Array.isArray(row.staging_areas) ? (row.staging_areas as string[]) : undefined,
  };
}

const locationInclude = {
  branch: { select: { id: true, name: true } },
  primary_tech: { select: { id: true, first_name: true, last_name: true } },
};

// ─── Branch Handlers ───────────────────────────────────

export async function listBranches(req: Request, res: Response) {
  try {
    const branches = await prisma.branch.findMany({
      where: tenantWhere(req),
      orderBy: { name: 'asc' },
    });

    res.json({ branches: branches.map(mapBranch) });
  } catch (err) {
    logger.error('Failed to list branches:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getBranch(req: Request, res: Response) {
  try {
    const branch = await prisma.branch.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    if (!branch) {
      res.status(404).json({ error: 'Branch not found' });
      return;
    }

    res.json({ branch: mapBranch(branch) });
  } catch (err) {
    logger.error('Failed to get branch:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createBranch(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    const branch = await prisma.branch.create({
      data: {
        name: req.body.name,
        code: req.body.code ?? null,
        address: req.body.address ?? null,
        phone: req.body.phone ?? null,
        manager_name: req.body.managerName ?? null,
        timezone: req.body.timezone ?? null,
        notes: req.body.notes ?? null,
        organization_id: orgId,
      },
    });

    void logAudit({
      req,
      action: 'inventory.branch_created',
      resourceType: 'Branch',
      resourceId: branch.id,
      metadata: { name: branch.name },
    });

    res.status(201).json({ branch: mapBranch(branch) });
  } catch (err) {
    logger.error('Failed to create branch:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateBranch(req: Request, res: Response) {
  try {
    const data: Record<string, unknown> = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.code !== undefined) data.code = req.body.code;
    if (req.body.address !== undefined) data.address = req.body.address;
    if (req.body.phone !== undefined) data.phone = req.body.phone;
    if (req.body.managerName !== undefined) data.manager_name = req.body.managerName;
    if (req.body.timezone !== undefined) data.timezone = req.body.timezone;
    if (req.body.notes !== undefined) data.notes = req.body.notes;

    // updateMany with id+org filter is atomic (single query) — no TOCTOU window.
    const updateResult = await prisma.branch.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      data,
    });
    if (updateResult.count === 0) {
      res.status(404).json({ error: 'Branch not found' });
      return;
    }
    const branch = await prisma.branch.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    void logAudit({
      req,
      action: 'inventory.branch_updated',
      resourceType: 'Branch',
      resourceId: req.params.id as string,
      metadata: { fields: Object.keys(req.body) },
    });

    res.json({ branch: mapBranch(branch) });
  } catch (err) {
    logger.error('Failed to update branch:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteBranch(req: Request, res: Response) {
  try {
    const existing: any = await prisma.branch.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: { _count: { select: { locations: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Branch not found' });
      return;
    }

    if (existing._count.locations > 0) {
      res.status(400).json({ error: 'Cannot delete branch with locations' });
      return;
    }

    // deleteMany with id+org filter is atomic — no TOCTOU window between the
    // existence/_count check and the delete.
    await prisma.branch.deleteMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    void logAudit({
      req,
      action: 'inventory.branch_deleted',
      resourceType: 'Branch',
      resourceId: req.params.id as string,
    });

    res.json({ message: 'Branch deleted' });
  } catch (err) {
    logger.error('Failed to delete branch:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── My-van (P3 — tech truck-stock view) ────────────────
//
// GET /api/inventory/my-van — the requester's OWN van (InventoryLocation.primary_tech_id =
// req.user.id) + its StockBalances joined to picker-safe item fields. Own-scope endpoint on the
// /my-today pattern: the route gate is the broad-ish `read PriceBook` (every role passes after
// P3's grant), the REAL boundary is structural (primary_tech_id + tenantWhere) — it never
// consults the `Inventory` subject, so it widens nothing.
export async function myVan(req: Request, res: Response) {
  try {
    const van = await prisma.inventoryLocation.findFirst({
      where: { ...tenantWhere(req), primary_tech_id: req.user!.id },
      orderBy: { created_at: 'asc' },          // one-van convention; deterministic if violated
      select: { id: true, name: true, type: true, vehicle: true },
    });
    if (!van) {
      res.status(404).json({ error: 'NO_VAN_ASSIGNED' });
      return;
    }
    const rows = await prisma.stockBalance.findMany({
      where: { ...tenantWhere(req), location_id: van.id },
      // Cost-strip BY PROJECTION — unit_cost / list_price are never selected, which is strictly
      // stronger than delete-after-read (stripItemCost). Picker-safe item fields only
      // (unit_price = customer-facing selling price, never stripped).
      select: {
        on_hand: true,
        min: true,
        max: true,
        item: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
            uom: true,
            unit_price: true,
            track_inventory: true,
            is_active: true,
            image_url: true,
          },
        },
      },
      orderBy: { item: { name: 'asc' } },
    });
    // FE lock signal — server-computed (role-gated), so the FE never re-derives it.
    const { restricted } = await resolveRestrictedVan(req);
    res.json({
      location: { id: van.id, name: van.name, type: van.type, vehicle: van.vehicle ?? undefined },
      restricted,
      balances: rows.map((b) => ({
        item: b.item,
        on_hand: Number(b.on_hand),               // Decimal → number (P1 on_hand_after convention)
        min: b.min != null ? Number(b.min) : undefined,
        max: b.max != null ? Number(b.max) : undefined,
      })),
    });
  } catch (err) {
    logger.error('Failed to load my-van:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Location Handlers ─────────────────────────────────

export async function listLocations(req: Request, res: Response) {
  try {
    const locations = await prisma.inventoryLocation.findMany({
      where: tenantWhere(req),
      orderBy: { name: 'asc' },
      include: locationInclude,
    });

    res.json({ locations: locations.map(mapLocation) });
  } catch (err) {
    logger.error('Failed to list locations:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getLocation(req: Request, res: Response) {
  try {
    const location = await prisma.inventoryLocation.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: locationInclude,
    });

    if (!location) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }

    res.json({ location: mapLocation(location) });
  } catch (err) {
    logger.error('Failed to get location:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createLocation(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    if (req.body.branch_id) {
      const branch = await prisma.branch.findFirst({
        where: { id: req.body.branch_id, ...tenantWhere(req) },
      });
      if (!branch) {
        res.status(404).json({ error: 'Branch not found' });
        return;
      }
    }

    const location = await prisma.inventoryLocation.create({
      data: {
        name: req.body.name,
        type: req.body.type,
        branch_id: req.body.branch_id ?? null,
        primary_tech_id: req.body.primary_tech_id ?? null,
        vehicle: req.body.vehicle ?? null,
        staging_areas: req.body.stagingAreas ?? null,
        organization_id: orgId,
      },
      include: locationInclude,
    });

    void logAudit({
      req,
      action: 'inventory.location_created',
      resourceType: 'InventoryLocation',
      resourceId: location.id,
      metadata: { name: location.name, type: location.type },
    });

    res.status(201).json({ location: mapLocation(location) });
  } catch (err) {
    logger.error('Failed to create location:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateLocation(req: Request, res: Response) {
  try {
    if (req.body.branch_id) {
      const branch = await prisma.branch.findFirst({
        where: { id: req.body.branch_id, ...tenantWhere(req) },
      });
      if (!branch) {
        res.status(404).json({ error: 'Branch not found' });
        return;
      }
    }

    const data: Record<string, unknown> = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.type !== undefined) data.type = req.body.type;
    if (req.body.branch_id !== undefined) data.branch_id = req.body.branch_id;
    if (req.body.primary_tech_id !== undefined) data.primary_tech_id = req.body.primary_tech_id;
    if (req.body.vehicle !== undefined) data.vehicle = req.body.vehicle;
    if (req.body.stagingAreas !== undefined) data.staging_areas = req.body.stagingAreas;

    // updateMany with id+org filter is atomic — no TOCTOU window.
    const updateResult = await prisma.inventoryLocation.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      data,
    });
    if (updateResult.count === 0) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }
    const location = await prisma.inventoryLocation.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: locationInclude,
    });

    void logAudit({
      req,
      action: 'inventory.location_updated',
      resourceType: 'InventoryLocation',
      resourceId: req.params.id as string,
      metadata: { fields: Object.keys(req.body) },
    });

    res.json({ location: mapLocation(location) });
  } catch (err) {
    logger.error('Failed to update location:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteLocation(req: Request, res: Response) {
  try {
    const id = req.params.id as string;
    const orgId = req.user!.organization_id;

    const existing = await prisma.inventoryLocation.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }

    // `stock_balances.location_id` is ON DELETE RESTRICT, so without this check a
    // location that ever held stock raises P2003 and falls into the generic catch
    // as an opaque 500. Only non-zero balances are real stock - zero rows are
    // bookkeeping left behind by past movements and are cleared below.
    const stocked = await prisma.stockBalance.count({
      where: {
        location_id: id,
        ...tenantWhere(req),
        OR: [{ on_hand: { not: 0 } }, { reserved: { not: 0 } }],
      },
    });
    if (stocked > 0) {
      res.status(409).json({
        error: `Cannot delete: this location still holds stock for ${stocked} item(s). Transfer or zero out the stock first.`,
      });
      return;
    }

    // organizations.default_inventory_location_id is ON DELETE SET NULL, so the
    // delete would silently strip the org default rather than fail. Block instead.
    const isDefault = await prisma.organization.count({
      where: { id: orgId, default_inventory_location_id: id },
    });
    if (isDefault > 0) {
      res.status(409).json({
        error: 'Cannot delete: this is the default inventory location for the organization. Choose a different default first.',
      });
      return;
    }

    // `job_stages.staged_location_id` is a bare `String? @db.Uuid` with NO Prisma
    // relation and therefore NO foreign key, so - unlike the two checks above -
    // nothing in the database stops this delete or even notices it. The column is
    // read as the DESTINATION of a stock receive (inv-stages.controller.ts
    // receiveStageLine), and the stock_balances / stock_movements location FKs
    // ARE real, so a stage left pointing at a deleted location cannot be received
    // against again: the write is rejected and the operator gets an opaque 500.
    // Refuse the delete while any stage still expects its parts to be here.
    const stagedAtLocation = await prisma.jobStage.count({
      where: {
        staged_location_id: id,
        ...tenantWhere(req),
        status: { notIn: TERMINAL_STAGE_STATUSES },
      },
    });
    if (stagedAtLocation > 0) {
      res.status(409).json({
        error: `Cannot delete: ${stagedAtLocation} active job stage(s) still have parts staged at this location. Move them to another location first.`,
      });
      return;
    }

    // Clearing the zero-quantity balances in the same transaction keeps the
    // RESTRICT constraint satisfied without leaving orphans if the delete fails.
    // Movement history survives: its location FKs are ON DELETE SET NULL.
    //
    // MUST be the interactive form. Under DB_TENANT_GUARD (lib/tenant-guard.ts)
    // `prisma` is a Proxy whose model delegates run each op in its own
    // transaction and return a plain Promise, not a PrismaPromise. Building a
    // batch `$transaction([...])` out of those fires both deletes eagerly and
    // un-atomically, then throws when Prisma is handed non-PrismaPromises - the
    // rows are gone and the caller still gets a 500.
    await prisma.$transaction(async (tx) => {
      await tx.stockBalance.deleteMany({ where: { location_id: id, ...tenantWhere(req) } });
      await tx.inventoryLocation.deleteMany({ where: { id, ...tenantWhere(req) } });
    });

    void logAudit({
      req,
      action: 'inventory.location_deleted',
      resourceType: 'InventoryLocation',
      resourceId: req.params.id as string,
    });

    res.json({ message: 'Location deleted' });
  } catch (err) {
    logger.error('Failed to delete location:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
