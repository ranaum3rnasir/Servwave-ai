import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { canAccessRow } from '../lib/permissions/enforce';
import { canReadCustomerById } from '../lib/permissions/customerScope';
import { commVisibilityWhere } from '../lib/permissions/anchorVisibility';
import {
  getJobCommunications as aggregateJobCommunications,
  getCustomerCommunications as aggregateCustomerCommunications,
  getLeadCommunications as aggregateLeadCommunications,
} from '../lib/job-communications';

// Communication ↔ Jobs (spec §4): job/customer comm timelines.
// GET /api/jobs/:id/communications — everything attributed to this job, across channels.
export async function getJobCommunications(req: Request, res: Response) {
  try {
    const id = req.params.id as string;

    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // #106 P1: per-instance scope. The route guard is `read Communication` (UNCONDITIONAL for
    // SALES), but SALES is own-scoped on Jobs (OWN_JOB_VIA_ESTIMATE); without this a SALES rep
    // could read the full comms timeline of ANY job in the org. Mirror the job controller's
    // own-scoped reads (getNotes/getTimeline) via the grant-driven Job row check.
    if (!(await canAccessRow(req, 'Job', prisma.job, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const items = await aggregateJobCommunications(prisma, {
      jobId: id,
      organizationId: req.user!.organization_id,
      visibility: await commVisibilityWhere(req),
    });

    res.json({ items });
  } catch (err) {
    logger.error('Failed to get job communications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/leads/:id/communications — the lead timeline: strictly the rows
// attributed to THIS lead by lead_id, matching the job handler above exactly
// (full job-parity ruling, 2026-07-22 — no customer-history union).
export async function getLeadCommunications(req: Request, res: Response) {
  try {
    const id = req.params.id as string;

    const lead = await prisma.lead.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }

    // Per-instance scope (mirrors the job handler above): the route guard is
    // `read Communication` (UNCONDITIONAL for SALES), but SALES is own-scoped
    // on Leads (OWN_LEAD) — without this a SALES rep could read the full comms
    // timeline of ANY lead in the org.
    if (!(await canAccessRow(req, 'Lead', prisma.lead, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // The lead gate above is NOT sufficient on its own: a row can carry this
    // lead's lead_id AND a job the requester cannot see, and `job > lead`
    // precedence says the job decides. The row filter is what enforces that.
    const items = await aggregateLeadCommunications(prisma, {
      leadId: id,
      organizationId: req.user!.organization_id,
      visibility: await commVisibilityWhere(req),
    });

    res.json({ items });
  } catch (err) {
    logger.error('Failed to get lead communications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/customers/:id/communications — the customer roll-up across channels.
export async function getCustomerCommunications(req: Request, res: Response) {
  try {
    const id = req.params.id as string;

    // Subject-level probe: the fail-closed "may you read customers AT ALL" gate for a role
    // (e.g. TECHNICIAN) that holds `read Communication` (the route guard) but no `read Customer`
    // grant whatsoever. #2041 makes Customer a ScopeResource for a conditioned reader (SALES) -
    // a conditional grant still answers `true` here, which is correct; the row-level check below
    // is what narrows a conditioned reader to their associated customers.
    if (!req.ability?.can('read', 'Customer')) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    // Tenancy + existence FIRST, then the row-scope verdict - mirrors getSummary/addNote
    // (customer.controller.ts). An in-org customer the requester is not associated with gets the
    // SAME 404 body a nonexistent/cross-org id already gets, never a 403 (that would confirm
    // existence) and never a 200 (that was #2041's live enumeration-oracle regression).
    const customer = await prisma.customer.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!customer || !(await canReadCustomerById(req, id))) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // The row filter is the real fix for the hole this handler carried: the
    // roll-up unions every row stamped with this customer, INCLUDING rows that
    // also carry a job or lead the requester cannot see. persistTransactionalEmail
    // stamps customer_id, lead_id AND job_id on the same row, so that overlap is
    // the common case, not the exotic one.
    const items = await aggregateCustomerCommunications(prisma, {
      customerId: id,
      organizationId: req.user!.organization_id,
      visibility: await commVisibilityWhere(req),
    });

    res.json({ items });
  } catch (err) {
    logger.error('Failed to get customer communications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
