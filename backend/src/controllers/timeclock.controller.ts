import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { getOrgTimezone } from '../lib/timezone';
import {
  sendClockOverrideRequestedEmail,
  sendClockOverrideDecisionEmail,
} from '../lib/email';
import { evaluate } from '../lib/timeclock/geofence';
import { resolve as resolveEnforcement } from '../lib/timeclock/enforcement';
import type { Zone, GeofenceVerdict } from '../lib/timeclock/types';
import { emit } from '../services/notifications/notificationService';

const DEFAULT_RADIUS_M = 150;

// ─── Zod schemas ───────────────────────────────────────

export const createPunchSchema = z.object({
  type: z.enum(['IN', 'OUT']),
  // Bound to valid WGS84 ranges (defense in depth; geofence already fails closed on bad
  // coords). accuracy_m bounded to a sane upper limit (F-49).
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_m: z.number().min(0).max(100000).optional(),
  override: z.boolean().optional(),
});

export const updateConfigSchema = z.object({
  radiusM: z.number().int().min(50).max(300),
});

export const createStoreSchema = z.object({
  label: z.string().min(1).max(120).transform((s) => s.trim()),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const updateStoreSchema = z.object({
  label: z.string().min(1).max(120).transform((s) => s.trim()).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const updateUserSettingsSchema = z.object({
  enforce_clock_in_location: z.boolean().optional(),
  can_approve_clock_overrides: z.boolean().optional(),
});

export const createOtReviewSchema = z.object({
  user_id: z.string().min(1),
  period_key: z.string().min(1).max(20),
  state: z.enum(['APPROVED', 'REJECTED']),
});

// ─── Helpers ───────────────────────────────────────────

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

function isAdmin(req: Request): boolean {
  return req.user!.role === 'ADMIN';
}

/**
 * Parse optional `from`/`to` query params into Date bounds. A present-but-invalid
 * bound (e.g. `?from=garbage` → Invalid Date) yields an `error` so the caller can
 * reply 400 instead of passing NaN into Prisma (→ 500).
 */
function parseDateRange(req: Request): { gte?: Date; lte?: Date; error?: string } {
  const out: { gte?: Date; lte?: Date; error?: string } = {};
  if (typeof req.query.from === 'string') {
    const d = new Date(req.query.from);
    if (isNaN(d.getTime())) return { error: 'Invalid from/to date' };
    out.gte = d;
  }
  if (typeof req.query.to === 'string') {
    const d = new Date(req.query.to);
    if (isNaN(d.getTime())) return { error: 'Invalid from/to date' };
    out.lte = d;
  }
  return out;
}

/** Map a TimeEntry row → the frontend `Punch` DTO (lowercased enums, epoch-ms ts). */
function toPunchDTO(row: any) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: `${row.user?.first_name ?? ''} ${row.user?.last_name ?? ''}`.trim(),
    type: row.type as 'IN' | 'OUT',
    ts: new Date(row.ts).getTime(),
    lat: row.lat,
    lng: row.lng,
    matchedZoneId: row.matched_zone_id ?? null,
    matchedZoneLabel: row.matched_zone_label ?? null,
    matchedZoneKind: row.matched_zone_kind
      ? (String(row.matched_zone_kind).toLowerCase() as 'store' | 'job')
      : null,
    matchedJobNumber: row.matched_job_number ?? null,
    distanceM: row.distance_m ?? null,
    status: String(row.status).toLowerCase() as 'in_zone' | 'override',
    review: String(row.review).toLowerCase() as 'none' | 'pending' | 'approved' | 'rejected',
  };
}

/** Load org radius + store zones as the pure-module `Zone[]`. */
async function loadZones(orgId: string): Promise<{ radiusM: number; zones: Zone[] }> {
  const [config, stores] = await Promise.all([
    prisma.geofenceConfig.findUnique({ where: { organization_id: orgId } }),
    prisma.geofenceStore.findMany({ where: { organization_id: orgId } }),
  ]);
  const radiusM = config?.radius_m ?? DEFAULT_RADIUS_M;
  const zones: Zone[] = stores.map((s: any) => ({
    id: `store:${s.id}`,
    kind: 'STORE' as const,
    label: s.label,
    lat: s.lat,
    lng: s.lng,
  }));
  return { radiusM, zones };
}

// ═══════════════════════════════════════════════════════
// POST /punches
// ═══════════════════════════════════════════════════════
export async function createPunch(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const userId = req.user!.id;
    const { type, lat, lng, accuracy_m, override } = req.body as z.infer<typeof createPunchSchema>;

    const actingUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { enforce_clock_in_location: true },
    });
    const enforceLocation = actingUser?.enforce_clock_in_location ?? true;
    const admin = isAdmin(req);

    const { radiusM, zones } = await loadZones(orgId);
    const verdict: GeofenceVerdict = evaluate({ lat, lng }, zones, radiusM);
    const decision = resolveEnforcement(
      { isAdmin: admin, enforceLocation, type },
      zones,
      verdict,
    );

    // Re-punch guard (best-effort, v1 known limitation): inspect the most recent
    // punch for this user and reject a same-type repeat. This is a read-then-write
    // check with no DB constraint, so a rare concurrent double-punch can still
    // record duplicate INs. Acceptable for v1: the append-only log is auditable and
    // correctable, and the frontend guards against double-taps.
    const last = await prisma.timeEntry.findFirst({
      where: { organization_id: orgId, user_id: userId },
      orderBy: { ts: 'desc' },
      select: { type: true },
    });
    if (type === 'IN' && last?.type === 'IN') {
      res.status(409).json({ error: 'Already clocked in' });
      return;
    }
    if (type === 'OUT' && (!last || last.type === 'OUT')) {
      res.status(409).json({ error: 'Not clocked in' });
      return;
    }

    const distanceM = Number.isFinite(verdict.distanceM) ? verdict.distanceM : null;

    // OUT always records IN_ZONE / NONE, stamping the matched zone if any.
    if (type === 'OUT') {
      const punch = await persistPunch({
        orgId,
        userId,
        type,
        lat,
        lng,
        accuracy_m,
        status: 'IN_ZONE',
        review: 'NONE',
        matched: verdict.matched,
        distanceM,
      });
      res.status(201).json({ punch });
      return;
    }

    // type === 'IN'
    if (decision === 'BLOCK_OVERRIDE_ELIGIBLE') {
      if (!override) {
        res.status(422).json({ requiresOverride: true, verdict });
        return;
      }
      // Override: record OVERRIDE / PENDING (no matched zone) and notify approvers.
      const punch = await persistPunch({
        orgId,
        userId,
        type,
        lat,
        lng,
        accuracy_m,
        status: 'OVERRIDE',
        review: 'PENDING',
        matched: null,
        distanceM,
      });
      await notifyApprovers(req, verdict, distanceM);
      emit({
        verb: 'team.ot_override_requested',
        organizationId: req.user!.organization_id,
        actorId: req.user?.id ?? null,
        object: { type: 'TIME_ENTRY', id: punch.id },
        entity: { user_id: req.user!.id },
        data: { punch_id: punch.id },
      });
      res.status(201).json({ punch });
      return;
    }

    // decision === 'ALLOW' (in-zone, admin, enforce-off, or no-zone)
    const punch = await persistPunch({
      orgId,
      userId,
      type,
      lat,
      lng,
      accuracy_m,
      status: 'IN_ZONE',
      review: 'NONE',
      matched: verdict.matched,
      distanceM,
    });
    res.status(201).json({ punch });
  } catch (err) {
    logger.error('Create punch error:', err);
    res.status(500).json({ error: 'Failed to record punch' });
  }
}

async function persistPunch(args: {
  orgId: string;
  userId: string;
  type: 'IN' | 'OUT';
  lat: number;
  lng: number;
  accuracy_m?: number;
  status: 'IN_ZONE' | 'OVERRIDE';
  review: 'NONE' | 'PENDING';
  matched: Zone | null;
  distanceM: number | null;
}) {
  // Zone ids are namespaced (`store:<id>`); strip the prefix for the stored id.
  const matchedZoneId = args.matched ? args.matched.id : null;
  const created = await prisma.timeEntry.create({
    data: {
      organization_id: args.orgId,
      user_id: args.userId,
      type: args.type,
      ts: new Date(),
      lat: args.lat,
      lng: args.lng,
      accuracy_m: args.accuracy_m ?? null,
      matched_zone_id: matchedZoneId,
      matched_zone_label: args.matched ? args.matched.label : null,
      matched_zone_kind: args.matched ? args.matched.kind : null,
      matched_job_number: args.matched ? args.matched.jobNumber ?? null : null,
      distance_m: args.distanceM,
      status: args.status,
      review: args.review,
    },
    select: punchSelect,
  });
  return toPunchDTO(created);
}

const punchSelect = {
  id: true,
  user_id: true,
  type: true,
  ts: true,
  lat: true,
  lng: true,
  accuracy_m: true,
  matched_zone_id: true,
  matched_zone_label: true,
  matched_zone_kind: true,
  matched_job_number: true,
  distance_m: true,
  status: true,
  review: true,
  reviewed_by: true,
  reviewed_at: true,
  user: { select: { first_name: true, last_name: true } },
} as const;

async function notifyApprovers(req: Request, verdict: GeofenceVerdict, distanceM: number | null) {
  const orgId = req.user!.organization_id;
  const approvers = await prisma.user.findMany({
    where: {
      organization_id: orgId,
      is_active: true,
      OR: [{ role: 'ADMIN' }, { can_approve_clock_overrides: true }],
    },
    select: { email: true },
  });
  const to = approvers.map((a: any) => a.email).filter(Boolean);
  if (to.length === 0) return;
  const timezone = await getOrgTimezone(orgId);
  const org = await loadOrgBranding(orgId);
  await sendClockOverrideRequestedEmail({
    org,
    to,
    technicianName: `${req.user!.first_name} ${req.user!.last_name}`.trim(),
    requestedAt: new Date(),
    distanceM: distanceM ?? 0,
    nearestLabel: verdict.nearest?.label ?? 'the nearest zone',
    timezone,
  });
}

async function loadOrgBranding(orgId: string) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { name: true, logo_url: true, brand_color: true },
  });
  return {
    id: orgId,
    name: org?.name ?? 'ServWave',
    logo_url: org?.logo_url ?? null,
    brand_color: org?.brand_color ?? '#0C2D3A',
  };
}

// ═══════════════════════════════════════════════════════
// GET /punches
// ═══════════════════════════════════════════════════════
export async function listPunches(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const canOrg = isAdmin(req) || req.user!.role === 'DISPATCHER';
    const scope = req.query.scope === 'org' && canOrg ? 'org' : 'me';

    const where: any = { organization_id: orgId };
    if (scope === 'me') where.user_id = req.user!.id;

    const range = parseDateRange(req);
    if (range.error) {
      res.status(400).json({ error: range.error });
      return;
    }
    if (range.gte || range.lte) {
      where.ts = { ...(range.gte ? { gte: range.gte } : {}), ...(range.lte ? { lte: range.lte } : {}) };
    }

    const rows = await prisma.timeEntry.findMany({
      where,
      select: punchSelect,
      orderBy: { ts: 'asc' },
    });
    res.json({ punches: rows.map(toPunchDTO) });
  } catch (err) {
    logger.error('List punches error:', err);
    res.status(500).json({ error: 'Failed to list punches' });
  }
}

// ═══════════════════════════════════════════════════════
// GET /config  ·  PUT /config
// ═══════════════════════════════════════════════════════
export async function getConfig(req: Request, res: Response) {
  try {
    const { radiusM, stores } = await readConfig(req.user!.organization_id);
    res.json({ radiusM, stores });
  } catch (err) {
    logger.error('Get timeclock config error:', err);
    res.status(500).json({ error: 'Failed to load config' });
  }
}

async function readConfig(orgId: string) {
  const [config, stores] = await Promise.all([
    prisma.geofenceConfig.findUnique({ where: { organization_id: orgId } }),
    prisma.geofenceStore.findMany({
      where: { organization_id: orgId },
      orderBy: { created_at: 'asc' },
    }),
  ]);
  return {
    radiusM: config?.radius_m ?? DEFAULT_RADIUS_M,
    stores: stores.map((s: any) => ({ id: s.id, label: s.label, lat: s.lat, lng: s.lng })),
  };
}

export async function updateConfig(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const { radiusM } = req.body as z.infer<typeof updateConfigSchema>;
    const config = await prisma.geofenceConfig.upsert({
      where: { organization_id: orgId },
      update: { radius_m: radiusM },
      create: { organization_id: orgId, radius_m: radiusM },
    });
    res.json({ radiusM: config.radius_m });
  } catch (err) {
    logger.error('Update timeclock config error:', err);
    res.status(500).json({ error: 'Failed to update config' });
  }
}

// ═══════════════════════════════════════════════════════
// Stores CRUD
// ═══════════════════════════════════════════════════════
export async function createStore(req: Request, res: Response) {
  try {
    const { label, lat, lng } = req.body as z.infer<typeof createStoreSchema>;
    const store = await prisma.geofenceStore.create({
      data: { organization_id: req.user!.organization_id, label, lat, lng },
      select: { id: true, label: true, lat: true, lng: true },
    });
    res.status(201).json({ store });
  } catch (err) {
    logger.error('Create store error:', err);
    res.status(500).json({ error: 'Failed to create store' });
  }
}

export async function updateStore(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const existing = await prisma.geofenceStore.findFirst({
      where: { id, ...tenantWhere(req) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Store not found' });
      return;
    }
    const body = req.body as z.infer<typeof updateStoreSchema>;
    const store = await prisma.geofenceStore.update({
      where: { id },
      data: {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.lat !== undefined ? { lat: body.lat } : {}),
        ...(body.lng !== undefined ? { lng: body.lng } : {}),
      },
      select: { id: true, label: true, lat: true, lng: true },
    });
    res.json({ store });
  } catch (err) {
    logger.error('Update store error:', err);
    res.status(500).json({ error: 'Failed to update store' });
  }
}

export async function deleteStore(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const result = await prisma.geofenceStore.deleteMany({
      where: { id, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Store not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    logger.error('Delete store error:', err);
    res.status(500).json({ error: 'Failed to delete store' });
  }
}

// ═══════════════════════════════════════════════════════
// PATCH /users/:id/timeclock-settings
// ═══════════════════════════════════════════════════════
export async function updateUserSettings(req: Request, res: Response) {
  try {
    const id = param(req, 'id');
    const target = await prisma.user.findFirst({ where: { id, ...tenantWhere(req) } });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const body = req.body as z.infer<typeof updateUserSettingsSchema>;
    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(body.enforce_clock_in_location !== undefined
          ? { enforce_clock_in_location: body.enforce_clock_in_location }
          : {}),
        ...(body.can_approve_clock_overrides !== undefined
          ? { can_approve_clock_overrides: body.can_approve_clock_overrides }
          : {}),
      },
      select: {
        id: true,
        enforce_clock_in_location: true,
        can_approve_clock_overrides: true,
      },
    });
    res.json({ user });
  } catch (err) {
    logger.error('Update user timeclock settings error:', err);
    res.status(500).json({ error: 'Failed to update user settings' });
  }
}

// ═══════════════════════════════════════════════════════
// Override approve / reject
// ═══════════════════════════════════════════════════════
async function canApprove(req: Request): Promise<{ ok: boolean; name: string }> {
  if (isAdmin(req)) return { ok: true, name: `${req.user!.first_name} ${req.user!.last_name}`.trim() };
  const u = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { can_approve_clock_overrides: true, first_name: true, last_name: true },
  });
  return {
    ok: !!u?.can_approve_clock_overrides,
    name: `${u?.first_name ?? req.user!.first_name} ${u?.last_name ?? req.user!.last_name}`.trim(),
  };
}

function decideOverride(decision: 'APPROVED' | 'REJECTED') {
  return async (req: Request, res: Response) => {
    try {
      const orgId = req.user!.organization_id;
      const { ok, name } = await canApprove(req);
      if (!ok) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
      const id = param(req, 'id');
      const punch = await prisma.timeEntry.findFirst({
        where: { id, organization_id: orgId },
        select: {
          id: true,
          review: true,
          user: { select: { first_name: true, last_name: true, email: true } },
        },
      });
      if (!punch) {
        res.status(404).json({ error: 'Punch not found' });
        return;
      }
      if (punch.review !== 'PENDING') {
        res.status(409).json({ error: 'Override is not pending' });
        return;
      }
      const updated = await prisma.timeEntry.update({
        where: { id },
        data: {
          review: decision,
          reviewed_by: req.user!.id,
          reviewed_at: new Date(),
        },
        select: punchSelect,
      });

      const techEmail = (punch as any).user?.email;
      if (techEmail) {
        const org = await loadOrgBranding(orgId);
        await sendClockOverrideDecisionEmail({
          org,
          to: techEmail,
          technicianName: `${(punch as any).user?.first_name ?? ''} ${(punch as any).user?.last_name ?? ''}`.trim(),
          decision: decision === 'APPROVED' ? 'approved' : 'rejected',
          decidedByName: name,
        });
      }
      res.json({ punch: toPunchDTO(updated) });
    } catch (err) {
      logger.error('Override decision error:', err);
      res.status(500).json({ error: 'Failed to record decision' });
    }
  };
}

export const approveOverride = decideOverride('APPROVED');
export const rejectOverride = decideOverride('REJECTED');

// ═══════════════════════════════════════════════════════
// OT reviews
// ═══════════════════════════════════════════════════════
export async function listOtReviews(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const canOrg = isAdmin(req) || req.user!.role === 'DISPATCHER';
    const scope = req.query.scope === 'org' && canOrg ? 'org' : 'me';

    const where: any = { organization_id: orgId };
    if (scope === 'me') where.user_id = req.user!.id;

    const range = parseDateRange(req);
    if (range.error) {
      res.status(400).json({ error: range.error });
      return;
    }
    if (range.gte || range.lte) {
      where.reviewed_at = { ...(range.gte ? { gte: range.gte } : {}), ...(range.lte ? { lte: range.lte } : {}) };
    }

    const rows = await prisma.timeClockOtReview.findMany({
      where,
      select: {
        user_id: true,
        period_key: true,
        state: true,
        reviewed_by: true,
        reviewed_at: true,
      },
      orderBy: { reviewed_at: 'desc' },
    });
    res.json({ reviews: rows });
  } catch (err) {
    logger.error('List OT reviews error:', err);
    res.status(500).json({ error: 'Failed to list OT reviews' });
  }
}

export async function createOtReview(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const { ok } = await canApprove(req);
    if (!ok) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    const { user_id, period_key, state } = req.body as z.infer<typeof createOtReviewSchema>;
    // The user_id FK references users globally; verify it belongs to this org so
    // an approver can't write a review naming a foreign-org user into their own org.
    const target = await prisma.user.findFirst({ where: { id: user_id, ...tenantWhere(req) } });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const review = await prisma.timeClockOtReview.upsert({
      where: {
        organization_id_user_id_period_key: {
          organization_id: orgId,
          user_id,
          period_key,
        },
      },
      update: { state, reviewed_by: req.user!.id, reviewed_at: new Date() },
      create: {
        organization_id: orgId,
        user_id,
        period_key,
        state,
        reviewed_by: req.user!.id,
        reviewed_at: new Date(),
      },
      select: {
        user_id: true,
        period_key: true,
        state: true,
        reviewed_by: true,
        reviewed_at: true,
      },
    });
    res.json({ review });
  } catch (err) {
    logger.error('Create OT review error:', err);
    res.status(500).json({ error: 'Failed to record OT review' });
  }
}
