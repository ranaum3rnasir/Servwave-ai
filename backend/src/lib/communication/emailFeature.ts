import type { Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { hasFeature as requestHasFeature } from '../../middleware/requireFeature';
import { hasFeature as orgHasFeature } from '../entitlements/resolve';

/**
 * The company's Email plan feature, as everything that reads or announces received mail asks it (Roles & Permissions PRD
 * 10, S10.6). It is the "Email" entitlement ServWave turns on or off for a company, NOT the company's own "Send emails to
 * customers and staff" switch, which stops sending only and never receiving.
 *
 * While it is off the mail a company receives is still stored exactly as with it on, but hidden from every list, tab,
 * count and read, and it rings nobody. Nothing marks the stored rows and nothing is backfilled when the feature returns:
 * every reader asks this, and the inbound writer asks it before it announces.
 *
 * There is ONE entitlement rule (`orgFeatures`, lib/entitlements/resolve.ts). A request already carries its answer, resolved
 * by `authenticate` from the same query that loads the person, so asking it costs no database read; the inbound webhook has
 * no request, so it reads the company's plan columns, once for each delivery that would ring (a token reply or mail to a user or main address alike, S10.16).
 */

/** Whether the signed-in person's company has the Email plan feature (fails closed with no person). */
export function emailFeatureOn(req: Request): boolean {
  return requestHasFeature(req, 'email');
}

/** Whether a company has the Email plan feature, read from its plan columns on the client it is given. */
export async function orgEmailFeatureOn(db: Pick<PrismaClient, 'organization'>, organizationId: string): Promise<boolean> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { plan: true, trial_ends_at: true, feature_overrides: true },
  });
  // A company that cannot be found has nothing to announce to.
  if (!org) return false;
  return orgHasFeature(
    { plan: org.plan, trial_ends_at: org.trial_ends_at, feature_overrides: org.feature_overrides as Record<string, unknown> | null },
    'email',
  );
}
