import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { getCommUsage } from '../lib/comm-usage';
import { DEFAULT_TIMEZONE } from '../lib/timezone';
import { tenantWhere } from '../lib/tenant';

/**
 * GET /api/communication/usage — current-cycle calling/texting usage against
 * the plan-included allowance, for the Phone header meters.
 *
 * Read-only and derived (see lib/comm-usage.ts): nothing here debits a counter,
 * so calling it repeatedly is free of side effects. The org is taken from the
 * authenticated request via tenantWhere, never from the client.
 */
export async function getUsage(req: Request, res: Response) {
  try {
    const { organization_id } = tenantWhere(req);
    // One read for both knobs. getOrgTimezone would be a second round trip for a
    // column this query already has to load.
    const org = await prisma.organization.findUnique({
      where: { id: organization_id },
      select: { timezone: true, comm_usage_uncapped: true },
    });
    const usage = await getCommUsage(organization_id, {
      timeZone: org?.timezone || DEFAULT_TIMEZONE,
      uncapped: org?.comm_usage_uncapped ?? false,
    });
    res.json(usage);
  } catch (err) {
    logger.error('Failed to load communication usage:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
