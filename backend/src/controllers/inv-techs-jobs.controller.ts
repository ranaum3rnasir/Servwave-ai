import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import { resolveSwitchesForPeople } from '../lib/permissions/switches/store';
import { jobCrewIds } from '../lib/job-crew';
import { isCompletedOrLater } from '../lib/job-status-order';
import { resolveJobScheduleWindow, type VisitForScheduleProjection } from '../lib/job-schedule-projection';

// ─── Mock-shape types (the frontend API contract) ──────────
// These mirror frontend/src/lib/api/_mock/inventory/{techs,jobs}.ts exactly.

// The inventory view a person's Inventory view switch names. The answer carries this and never a role name, so a
// screen places a person in the field roster from the switch alone.
type InventoryView = 'field' | 'counter';

type Tech = {
  id: string;
  name: string;
  email?: string;
  inventoryView: InventoryView;
  branch: string;
  vehicle?: string;
  primaryTrade?: 'locksmith' | 'door' | 'security' | 'hvac' | 'plumbing';
  certs?: string[];
};

type InventoryJobStatus = 'scheduled' | 'in_progress' | 'completed' | 'on_hold';

type InventoryJob = {
  id: string;
  jobNumber: string;
  customer: string;
  site: string;
  trade: 'locksmith' | 'door' | 'security' | 'hvac' | 'plumbing' | 'multi';
  scheduledFor?: string;
  assignedTechId?: string;
  status: InventoryJobStatus;
  notes?: string;
  /** Customer FK - lets "Create PO" send `customerId` alongside `jobId` when a job is linked (S3.1). */
  customerId?: string;
};

// ─── Mappers (snake_case Prisma row → mock camelCase shape) ─

// Field is the field roster (a person out on jobs with their own van), Counter is everyone at the shelves. The
// switch decides, never the person's role name (Roles & Permissions S01.9, S07.23).
function inventoryViewFor(inventoryView: unknown): InventoryView {
  return inventoryView === 'field' ? 'field' : 'counter';
}

function mapUserToTech(u: {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  department: { name: string } | null;
}, inventoryView: unknown, withEmail: boolean): Tech {
  return {
    id: u.id,
    name: `${u.first_name} ${u.last_name}`.trim(),
    // Real inbox from the user directory — the pickup-ticket composer sends here (replaces the old name-derived fake
    // address). Left out for everyone who cannot send that ticket (Edit stock, the check the send route makes): the
    // roster is a picker, and a picker carries a name and an id.
    ...(withEmail ? { email: u.email } : {}),
    inventoryView: inventoryViewFor(inventoryView),
    branch: u.department?.name ?? '',
    // vehicle / primaryTrade / certs have no source columns in the Alpha schema
    // (they live in the prototype seed only). Omit them — all optional in the type.
    certs: [],
  };
}

// JobStatus (Prisma) → the prototype's 4-state board status.
//
// S4 (D17): EN_ROUTE/ON_SITE retired from JobStatus; the two cases below are dead but harmless
// and are dropped here rather than left to rot.
// CANCELLED -> 'on_hold' and UNSCHEDULED -> 'scheduled' are deliberate mismatches, NOT left to
// widen: 'on_hold' is the closest of this board's four states to cancelled, and there is no
// board state for "unassigned". Documented here so the next reader does not re-litigate it.
function mapJobStatus(status: string): InventoryJobStatus {
  // PRD 6: a job in Office review, Ready to close or Done is finished work too - the board has no state of its own for them.
  if (isCompletedOrLater(status)) return 'completed';
  switch (status) {
    case 'IN_PROGRESS':
      return 'in_progress';
    case 'CANCELLED':
      return 'on_hold';
    case 'UNSCHEDULED':
    case 'SCHEDULED':
    default:
      return 'scheduled';
  }
}

function mapJobToInventoryJob(j: {
  id: string;
  job_number: string;
  status: string;
  customer_id: string | null;
  // S8 (D6): crew reached through the trips.
  // S8 (A5, RATIFIED): `scheduledFor` below is the SAME "next upcoming live visit, fallback to
  // earliest non-cancelled" projection the job detail/list payloads serve as `scheduled_start` -
  // not `first_visit_start` (the span start). Decision (contract 11, Step 3a): this board shows
  // "when is this job coming up", the exact question the old forward mirror answered; the span
  // start would show a job's FIRST-ever trip date forever, including long after it was worked.
  visits: (VisitForScheduleProjection & { assignees: { user_id: string }[] })[];
  scope_notes: string | null;
  customer: { company_name: string | null; first_name: string | null; last_name: string | null };
  service_location: {
    address_line1: string;
    address_line2: string | null;
    city: string;
    state: string;
    zip: string;
  };
}): InventoryJob {
  const customerName =
    j.customer.company_name ||
    `${j.customer.first_name ?? ''} ${j.customer.last_name ?? ''}`.trim() ||
    '';

  const loc = j.service_location;
  const site = [
    loc.address_line1,
    loc.address_line2,
    `${loc.city}, ${loc.state} ${loc.zip}`.trim(),
  ]
    .filter(Boolean)
    .join(', ');

  const out: InventoryJob = {
    id: j.id,
    jobNumber: j.job_number,
    customer: customerName,
    site,
    // The Alpha Job model has no trade column; the prototype defaults cross-trade
    // jobs to "multi". Surface every job as multi until a trade field exists.
    trade: 'multi',
    status: mapJobStatus(j.status),
  };

  const { scheduled_start } = resolveJobScheduleWindow(j.visits);
  if (scheduled_start) out.scheduledFor = scheduled_start.toISOString();
  // The prototype's single-tech board contract: surface the first crew member.
  const crew = jobCrewIds(j);
  if (crew.length) out.assignedTechId = crew[0];
  if (j.scope_notes) out.notes = j.scope_notes;
  if (j.customer_id) out.customerId = j.customer_id;

  return out;
}

// ─── Handlers ──────────────────────────────────────────────

// GET /api/inventory/techs — active staff/users mapped to the Tech shape.
export async function listTechs(req: Request, res: Response) {
  try {
    const users = await prisma.user.findMany({
      where: { ...tenantWhere(req), is_active: true },
      orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }],
      include: { department: { select: { name: true } }, custom_role: { select: { key: true } } },
    });

    // Each person's own Inventory view (their switches, resolved the way every other check resolves them).
    const switches = await resolveSwitchesForPeople(users, ['inventory_view']);
    const withEmail = Boolean(req.ability?.can('update', 'Inventory'));
    const techs = users.map((u) => mapUserToTech(u, switches.get(u.id)!.inventory_view, withEmail));

    res.json({ techs });
  } catch (err) {
    logger.error('Failed to list techs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/inventory/jobs — jobs mapped to the InventoryJob shape.
// Roles & Permissions (PRD 7): only the jobs the person can open, the Jobs list's own row scope. A
// person with View jobs off, or a Jobs scope that reaches nothing, gets an empty list.
export async function listInventoryJobs(req: Request, res: Response) {
  try {
    const rows = await prisma.job.findMany({
      where: { ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Job')) },
      // S8 (RATIFIED, A1's precedent): scheduled_start is DROPPED. Prisma cannot ORDER BY a
      // to-many relation's aggregate, so this orders on first_visit_start (S8 §4, stored and
      // maintained) - the render-side `scheduledFor` still projects the next upcoming live visit
      // (see mapJobToInventoryJob), so sort and render can disagree on a multi-visit job exactly
      // as A1 accepted for the Jobs list.
      orderBy: [{ first_visit_start: 'asc' }, { job_number: 'asc' }],
      include: {
        customer: { select: { company_name: true, first_name: true, last_name: true } },
        visits: {
          select: {
            status: true, scheduled_at: true, scheduled_end: true, is_all_day: true, created_at: true,
            assignees: { select: { user_id: true } },
          },
        },
        service_location: {
          select: {
            address_line1: true,
            address_line2: true,
            city: true,
            state: true,
            zip: true,
          },
        },
      },
    });

    const jobs = rows.map(mapJobToInventoryJob);

    res.json({ jobs });
  } catch (err) {
    logger.error('Failed to list inventory jobs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/inventory/jobs/:id — single job in the InventoryJob shape. A job outside the person's
// Jobs scope answers "not found", the same as a job that does not exist.
export async function getInventoryJob(req: Request, res: Response) {
  try {
    const row = await prisma.job.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req), ...(await scopeWhereForReq(req, 'Job')) },
      include: {
        customer: { select: { company_name: true, first_name: true, last_name: true } },
        visits: {
          select: {
            status: true, scheduled_at: true, scheduled_end: true, is_all_day: true, created_at: true,
            assignees: { select: { user_id: true } },
          },
        },
        service_location: {
          select: {
            address_line1: true,
            address_line2: true,
            city: true,
            state: true,
            zip: true,
          },
        },
      },
    });

    if (!row) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.json({ job: mapJobToInventoryJob(row) });
  } catch (err) {
    logger.error('Failed to get inventory job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
