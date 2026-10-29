import type { Request, Response, NextFunction } from 'express';

/**
 * Demo-only lock - the "does this surface exist for a paying org yet" axis.
 *
 * Orthogonal to both CASL (who may act) and requireFeature (what the org
 * bought). WhatsApp is the first user: the code and the demo showcase exist,
 * but there is no WhatsApp Business connection model in schema.prisma, so for
 * a real org the surface is not merely forbidden - it is not there.
 *
 * Answers 404 FEATURE_DISABLED, deliberately:
 *   - NOT 403. `auditAccessDenied` (app.ts) writes an `access.denied` audit row
 *     for EVERY 403 response. A product-scope lock is not a permission denial
 *     by the actor, and logging it as one would salt the security audit trail
 *     with false positives on ordinary traffic.
 *   - NOT 402. requireFeature owns 402 and it means "upgrade and you get this".
 *     No plan sells WhatsApp, so 402 would offer an upgrade that does not exist.
 *   - 404 matches `featureDisabled.ts`, the existing precedent for a route that
 *     stays mounted (so unlocking is a one-line revert) while answering as if
 *     the surface were absent. Same body shape, so clients need no new branch.
 *
 * Fails closed: no user, or org_is_demo absent (a JWT cached before the flag
 * shipped), denies.
 */
export function requireDemoOrg(feature: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (req.user.org_is_demo === true) {
      next();
      return;
    }
    res.status(404).json({ error: 'FEATURE_DISABLED', feature });
  };
}
