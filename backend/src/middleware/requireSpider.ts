import type { Request, Response, NextFunction } from 'express';
import { spiderAvailable } from '../services/spider/gate';
import { isSuperUser } from '../lib/permissions/effectiveRole';

/**
 * The Spider gate on every Spider endpoint (#2619): the `spider` feature AND, while the launch is
 * demo-only, a demo company. Both misses answer 404 FEATURE_DISABLED - the requireDemoOrg shape,
 * not requireFeature's 402: no plan can be bought today that unlocks Spider for a real company,
 * so an "upgrade" answer would offer something that does not exist.
 *
 * Fails closed: no user, or an org payload without the flags, denies.
 */
export function requireSpider(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (spiderAvailable({ features: req.user.org_features ?? [], isDemo: req.user.org_is_demo })) {
    next();
    return;
  }
  res.status(404).json({ error: 'FEATURE_DISABLED', feature: 'spider' });
}

/**
 * Spider's settings and History are Admin-only (decided 28 Sep), enforced here on the server.
 * Every other role still receives the alerts it is a recipient of (the unread-alerts endpoint is
 * NOT behind this).
 */
export function requireSpiderAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user && isSuperUser(req.user)) {
    next();
    return;
  }
  res.status(403).json({ error: 'Only Admins can manage Spider' });
}
