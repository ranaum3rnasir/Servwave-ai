/**
 * Spider's lead picker endpoints (#3435), mounted under /api/ai-farm/spider behind the Spider gate and Admin-only, like
 * Spider's settings: the overview counts, the customers with open leads, one customer's open leads, the excluded leads,
 * and the one request a Save sends (PATCH /spider/exclusions). services/spider/picker.ts holds the reads.
 */
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { zodValidationFailure } from '../middleware/validate';
import { isCanonicalId } from '../lib/ids/canonicalId';
import {
  applyExclusionChanges,
  openLeadIdsAmong,
  parsePickerListQuery,
  pickerCustomerLeads,
  pickerCustomers,
  pickerExcludedLeads,
  pickerOverview,
  type UpdateSpiderExclusionsBody,
} from '../services/spider/picker';
import { settingsTriggerKind } from '../services/spider/summary';
import { triggerData } from './spider.controller';

export { updateSpiderExclusionsSchema } from '../services/spider/picker';

/** "Watching N open leads · M excluded". */
export async function getSpiderOverview(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  try {
    res.json(await pickerOverview(orgId));
  } catch (err) {
    logger.error(`[spider] picker overview failed for org ${orgId}`, err);
    res.status(500).json({ error: 'Could not load Spider leads' });
  }
}

/** One page of the customers with open leads, searched on the server. */
export async function getSpiderPickerCustomers(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  const query = parsePickerListQuery(req.query);
  if (!query.ok) {
    res.status(400).json(zodValidationFailure(query.error));
    return;
  }
  try {
    res.json(await pickerCustomers(orgId, query.value));
  } catch (err) {
    logger.error(`[spider] picker customers failed for org ${orgId}`, err);
    res.status(500).json({ error: 'Could not load customers' });
  }
}

/** One page of one customer's open leads. Another company's customer answers like a missing one. */
export async function getSpiderPickerCustomerLeads(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  const query = parsePickerListQuery(req.query);
  if (!query.ok) {
    res.status(400).json(zodValidationFailure(query.error));
    return;
  }
  try {
    // An id that is no uuid names no customer: the same answer as a missing one (never a database error).
    const id = String(req.params.id);
    const page = isCanonicalId(id) ? await pickerCustomerLeads(orgId, id, query.value) : null;
    if (!page) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    res.json(page);
  } catch (err) {
    logger.error(`[spider] picker customer leads failed for org ${orgId}`, err);
    res.status(500).json({ error: "Could not load this customer's leads" });
  }
}

/** One page of the excluded open leads, searched on the server. */
export async function getSpiderExcludedLeads(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  const query = parsePickerListQuery(req.query);
  if (!query.ok) {
    res.status(400).json(zodValidationFailure(query.error));
    return;
  }
  try {
    res.json(await pickerExcludedLeads(orgId, query.value));
  } catch (err) {
    logger.error(`[spider] picker excluded leads failed for org ${orgId}`, err);
    res.status(500).json({ error: 'Could not load excluded leads' });
  }
}

interface LockedSettings {
  is_active: boolean;
  status_limits: Prisma.JsonValue;
  excluded_lead_ids: string[];
  summary_trigger_at: Date | null;
  summary_trigger_kind: string | null;
  summary_trigger_since: Date | null;
}

/**
 * Applies one Save of the picker (Ran, 10 Nov, Q4 A: ticks wait for Save): the leads to exclude and the leads to include
 * again. Only this company's open leads count; any other id (another company's lead, a closed lead, an unknown id) is
 * dropped without a word. Writing the list also drops any id already on it that is not one of this company's leads.
 * Saving the same changes twice stores the same list.
 *
 * Active or Not active (like an integration, Spider is set up before it runs): a company with no settings row gets one,
 * Not active. While Active, a Save that takes a lead off the exclusion list watches more leads, so it records the
 * SCOPE_WIDENED starting trigger (#2794), folded into one still waiting; excluding records none, nor does including a
 * lead that was not excluded. While Not active it records none: Activate does.
 *
 * The settings row is locked for the read-and-write, so two Saves at once never lose one another's changes, and an
 * Activate or Deactivate at the same moment waits for it (or it for them): the trigger always follows the state stored.
 * Answers the overview counts after the Save.
 */
export async function updateSpiderExclusions(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  const body = req.body as UpdateSpiderExclusionsBody;
  try {
    const known = await openLeadIdsAmong(orgId, [...body.exclude, ...body.include]);
    const change = { exclude: body.exclude.filter((id) => known.has(id)), include: body.include.filter((id) => known.has(id)) };
    const excludedLeadIds = await prisma.$transaction(async (tx) => {
      await tx.spiderSettings.createMany({ data: [{ organization_id: orgId }], skipDuplicates: true });
      const [row] = await tx.$queryRaw<LockedSettings[]>`
        SELECT is_active, status_limits, excluded_lead_ids::text[] AS excluded_lead_ids,
               summary_trigger_at, summary_trigger_kind, summary_trigger_since
          FROM spider_settings WHERE organization_id = ${orgId}::uuid FOR UPDATE`;
      // Only this company's leads stay on the list: an id of another company's lead or of no lead at all, however it got
      // there, is dropped as the list is written. Its own closed leads stay (a reopened lead is still excluded, #3434).
      const stored = row!.excluded_lead_ids ?? [];
      const merged = applyExclusionChanges(stored, change);
      const own = await tx.lead.findMany({
        where: { organization_id: orgId, id: { in: [...new Set([...stored, ...merged])] } },
        select: { id: true },
      });
      const isOwn = new Set(own.map((l) => l.id));
      const before = stored.filter((id) => isOwn.has(id));
      const after = merged.filter((id) => isOwn.has(id));
      const trigger = row!.is_active
        ? settingsTriggerKind(
            { status_limits: row!.status_limits, excluded_lead_ids: before },
            { status_limits: row!.status_limits, excluded_lead_ids: after },
          )
        : null;
      await tx.spiderSettings.update({
        where: { organization_id: orgId },
        data: { excluded_lead_ids: after, ...(trigger ? triggerData(row!, trigger, new Date()) : {}) },
      });
      return after;
    });
    res.json(await pickerOverview(orgId, excludedLeadIds));
  } catch (err) {
    logger.error(`[spider] exclusions save failed for org ${orgId}`, err);
    res.status(500).json({ error: 'Could not save the excluded leads' });
  }
}
