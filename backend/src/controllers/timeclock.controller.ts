import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { isSuperUser } from '../lib/permissions/effectiveRole';

// ─── Zod schemas ───────────────────────────────────────

export const createPunchSchema = z.object({
  type: z.enum(['IN', 'OUT']),
  // Bound to valid WGS84 ranges (defense in depth). accuracy_m bounded to a sane upper limit (F-49).
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_m: z.number().min(0).max(100000).optional(),
});

export const createOtReviewSchema = z.object({
  user_id: z.string().min(1),
  period_key: z.string().min(1).max(20),
  state: z.enum(['APPROVED', 'REJECTED']),
});

// ─── Helpers ───────────────────────────────────────────

/** The Admin box (built-in Admin, no custom role). A custom role copied from Admin is held to its switches. */
function isAdminBox(req: Request): boolean {
  return isSuperUser(req.user!);
}

/**
 * Does the caller see everyone's timesheets (the "See everyone's timesheets" switch)? The one question both org
 * views ask, so a custom role copied from Admin is held to its switch like any other role. Fails closed with no
 * ability attached.
 */
function seesAllTimesheets(req: Request): boolean {
  return req.ability?.can('see_all', 'Timeclock') ?? false;
}

/**
 * Which timesheet the request asks for. `?scope=org` is everyone's and needs See everyone's timesheets (a refusal
 * is a 403, written here); anything else is the caller's own, open to every signed-in person.
 */
function timesheetScope(req: Request, res: Response): 'org' | 'me' | null {
  if (req.query.scope !== 'org') return 'me';
  if (seesAllTimesheets(req)) return 'org';
  res.status(403).json({ error: 'Insufficient permissions' });
  return null;
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

/** Map a TimeEntry row → the frontend `Punch` DTO (epoch-ms ts). Where it happened is `lat` / `lng`. */
function toPunchDTO(row: any) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: `${row.user?.first_name ?? ''} ${row.user?.last_name ?? ''}`.trim(),
    type: row.type as 'IN' | 'OUT',
    ts: new Date(row.ts).getTime(),
    lat: row.lat,
    lng: row.lng,
    accuracyM: row.accuracy_m ?? null,
  };
}

// ═══════════════════════════════════════════════════════
// POST /punches
// ═══════════════════════════════════════════════════════
export async function createPunch(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const userId = req.user!.id;
    const { type, lat, lng, accuracy_m } = req.body as z.infer<typeof createPunchSchema>;

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

    // Nobody is held to a place: a clock-in or clock-out is always recorded, with where it happened. The status
    // and review columns and the zone columns are kept for the rows already written and left at their quiet values.
    const created = await prisma.timeEntry.create({
      data: {
        organization_id: orgId,
        user_id: userId,
        type,
        ts: new Date(),
        lat,
        lng,
        accuracy_m: accuracy_m ?? null,
        status: 'IN_ZONE',
        review: 'NONE',
      },
      select: punchSelect,
    });
    res.status(201).json({ punch: toPunchDTO(created) });
  } catch (err) {
    logger.error('Create punch error:', err);
    res.status(500).json({ error: 'Failed to record punch' });
  }
}

const punchSelect = {
  id: true,
  user_id: true,
  type: true,
  ts: true,
  lat: true,
  lng: true,
  accuracy_m: true,
  user: { select: { first_name: true, last_name: true } },
} as const;

// ═══════════════════════════════════════════════════════
// GET /punches
// ═══════════════════════════════════════════════════════
export async function listPunches(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const scope = timesheetScope(req, res);
    if (!scope) return;

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
// OT reviews
// ═══════════════════════════════════════════════════════
// Weekly overtime review is unchanged by the removal of the clock-in location checks.
async function canApprove(req: Request): Promise<{ ok: boolean }> {
  if (isAdminBox(req)) return { ok: true };
  const u = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { can_approve_clock_overrides: true },
  });
  return { ok: !!u?.can_approve_clock_overrides };
}

export async function listOtReviews(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const scope = timesheetScope(req, res);
    if (!scope) return;

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
