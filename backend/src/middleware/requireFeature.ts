import type { Request, Response, NextFunction } from 'express';
import type { FeatureKey } from '../lib/entitlements/catalog';
import { catalogEntry } from '../lib/entitlements/catalog';

/**
 * Entitlement gate — the "did this company pay for it" axis, orthogonal to CASL.
 *
 * It CANNOT be a CASL grant: defineAbilityFor short-circuits on role
 * (`if (user.role === 'ADMIN') { can('manage','all'); return build(); }`), so
 * every tenant's own admin is a CASL superuser and would bypass the exact gate
 * meant to apply to them. Entitlement is keyed on the ORGANIZATION and resolved
 * before CASL.
 *
 * Answers 402 Payment Required, never 403 — so a plan block can never be
 * misread as a permissions bug in support.
 *
 * Fails closed: no user, or org_features absent (a JWT cached before this
 * shipped), denies.
 */
export function hasFeature(req: Request, feature: FeatureKey): boolean {
  return (req.user?.org_features ?? []).includes(feature);
}

export function requireFeature(feature: FeatureKey) {
  const required_plan = catalogEntry(feature)?.minPlan ?? 'SCALE';

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (hasFeature(req, feature)) {
      next();
      return;
    }
    res.status(402).json({
      error: 'FEATURE_NOT_IN_PLAN',
      feature,
      current_plan: req.user.org_plan ?? 'STARTER',
      required_plan,
    });
  };
}
