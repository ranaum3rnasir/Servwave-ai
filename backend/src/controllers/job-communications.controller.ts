import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { canAccessRow } from '../lib/permissions/enforce';
import { canReadCustomerById, resolveCustomerScope } from '../lib/permissions/customerScope';
import { mayReadTranscript } from './comm-calls.controller';
import { heldMailboxesFor, recordNumbersOpenedForReq, recordTabVisibilityForReq } from '../lib/communication/communicationScope';
import { recordOpenersForReq, tiedRecordConversations } from '../lib/communication/recordConversations';
import { numbersCustomerCarries } from '../lib/comms-identity';
import { recordTextWindow } from '../lib/communication/recordTextWindow';
import {
  emailHiddenFrom,
  getJobCommunications as aggregateJobCommunications,
  getCustomerCommunications as aggregateCustomerCommunications,
  getLeadCommunications as aggregateLeadCommunications,
} from '../lib/job-communications';

// Communication ↔ Jobs (spec §4): job/customer comm timelines.
// GET /api/jobs/:id/communications — everything attributed to this job, across channels, and the texts with the job's
// numbers from its creation until it closes (#3022).
export async function getJobCommunications(req: Request, res: Response) {
  try {
    const id = req.params.id as string;

    const job = await prisma.job.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, customer_id: true },
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

    const organizationId = req.user!.organization_id;
    // #3022: the texts with the job's numbers from its creation until it closes, beside the ones tied to it. Its customer
    // carries each of those numbers, so its untied texts are read, wherever their conversation is filed, by a person who can
    // open that customer or holds Communication "All" (#3013 decision 4); opening the job alone does not open its customer.
    const textWindow = await recordTextWindow(prisma, organizationId, { kind: 'job', id });
    const windowTexts = textWindow?.texts;
    const carriedNumbers = await recordNumbersOpenedForReq(req, { customerId: job.customer_id, numbers: textWindow?.numbers ?? [] });
    const visibility = await recordTabVisibilityForReq(req, { carriedNumbers });
    const items = await aggregateJobCommunications(prisma, {
      jobId: id,
      organizationId,
      visibility,
      windowTexts,
      // A text names only a customer the person can open (#3021 ruling).
      naming: { recordCustomerId: job.customer_id, customerScope: await resolveCustomerScope(req) },
      withCallSummary: mayReadTranscript(req),
      // The record conversations tied to this job (its lead's too), for the estimates and invoices the person can open. None
      // are read while the tab shows no email.
      tied: emailHiddenFrom(visibility)
        ? undefined
        : await tiedRecordConversations(prisma, { organizationId, anchor: { kind: 'job', id }, openers: await recordOpenersForReq(req) }),
    });

    res.json({ items });
  } catch (err) {
    logger.error('Failed to get job communications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// GET /api/leads/:id/communications — the lead timeline: the rows attributed to
// THIS lead by lead_id, matching the job handler above exactly (full job-parity
// ruling, 2026-07-22 — no customer-history union), plus, on both, the texts with
// the record's numbers from its creation until it closes (#3022).
export async function getLeadCommunications(req: Request, res: Response) {
  try {
    const id = req.params.id as string;

    const lead = await prisma.lead.findUnique({
      where: { id, ...tenantWhere(req) },
      select: { id: true, customer_id: true },
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
    const organizationId = req.user!.organization_id;
    // #3022: the texts with the lead's numbers from its creation until it closes, beside the ones tied to it. Its customer
    // carries each of those numbers, so its untied texts are read, wherever their conversation is filed, by a person who can
    // open that customer or holds Communication "All" (#3013 decision 4); opening the lead alone does not open its customer.
    const textWindow = await recordTextWindow(prisma, organizationId, { kind: 'lead', id });
    const windowTexts = textWindow?.texts;
    const carriedNumbers = await recordNumbersOpenedForReq(req, { customerId: lead.customer_id, numbers: textWindow?.numbers ?? [] });
    const visibility = await recordTabVisibilityForReq(req, { carriedNumbers });
    const items = await aggregateLeadCommunications(prisma, {
      leadId: id,
      organizationId,
      visibility,
      windowTexts,
      // A text names only a customer the person can open (#3021 ruling).
      naming: { recordCustomerId: lead.customer_id, customerScope: await resolveCustomerScope(req) },
      withCallSummary: mayReadTranscript(req),
      // The record conversations tied to this lead (its jobs' too), for the estimates and invoices the person can open. None
      // are read while the tab shows no email.
      tied: emailHiddenFrom(visibility)
        ? undefined
        : await tiedRecordConversations(prisma, { organizationId, anchor: { kind: 'lead', id }, openers: await recordOpenersForReq(req) }),
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
      select: { id: true, first_name: true, last_name: true, company_name: true },
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
    const mailboxes = await heldMailboxesFor(req);
    const organizationId = req.user!.organization_id;
    // #3021: the conversations on the customer's numbers, worked out now (#3013 decision 5). The person can open this
    // customer, who carries every one of these numbers, so the texts of them tied to no lead or job are theirs to read
    // (decision 4); a text tied to a lead or job still needs that record.
    const carriedNumbers = await numbersCustomerCarries(prisma, organizationId, id);
    const items = await aggregateCustomerCommunications(prisma, {
      customerId: id,
      organizationId,
      readMailboxIds: [...mailboxes.held, ...(mailboxes.main ? [mailboxes.main] : [])],
      visibility: await recordTabVisibilityForReq(req, { carriedNumbers }),
      withCallSummary: mayReadTranscript(req),
      carriedNumbers,
      customer,
    });

    res.json({ items });
  } catch (err) {
    logger.error('Failed to get customer communications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
