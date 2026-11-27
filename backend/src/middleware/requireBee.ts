import type { Request, Response, NextFunction } from 'express';
import { beeAvailable } from '../services/bee/gate';
import { isSuperUser } from '../lib/permissions/effectiveRole';
import { markRouteCheck } from './routeCheck';
import { markReadsNoRecord } from '../lib/ids/canonicalId';

/**
 * Bee access gate: checks whether the caller's organization has access to Bee
 * (demo org, `bee` feature, or `BEE_ALLOWED_ORG_IDS`). Fails closed with 404 FEATURE_DISABLED.
 */
export function requireBee(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (
    beeAvailable({
      features: req.user.org_features ?? [],
      isDemo: req.user.org_is_demo,
      orgId: req.user.organization_id,
    })
  ) {
    next();
    return;
  }
  res.status(404).json({ error: 'FEATURE_DISABLED', feature: 'bee' });
}
markReadsNoRecord(requireBee);

/**
 * Bee management routes (activating, deactivating, settings, agents, plans, DNC, queue actions)
 * are Admin-only (`is_admin === true`), matching `requireSpiderAdmin`.
 */
export function requireBeeAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user && isSuperUser(req.user)) {
    next();
    return;
  }
  res.status(403).json({ error: 'Only Admins can manage Bee' });
}
markRouteCheck('permission', requireBeeAdmin);
