import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

/**
 * The pilot-or-demo org gate on the phone setup tabs (Call flows, Call groups, Training, Blocked callers): the "does
 * this surface exist for this org yet" axis, orthogonal to who may act (CASL, the tab switches) and what the org bought
 * (requireFeature). The Phone page has always drawn these tabs only for a demo org or the live pilot org; this puts the
 * same rule on the endpoints behind them, so a person who holds the tab's switch in any other org still gets no data.
 *
 * The pilot org id mirrors the browser's default (frontend/src/lib/useIsCommunicationPilotOrg.ts); the same id in
 * staging and prod. COMMUNICATION_ALLOWED_ORG_IDS replaces it, like VITE_COMMUNICATION_ALLOWED_ORG_IDS does there.
 *
 * Answers 404 FEATURE_DISABLED, as requireDemoOrg does and for the same reasons: a 403 would write an `access.denied`
 * audit row for what is a product-scope lock, not a denial of an actor. Mount it AFTER the canDo checks, so a person
 * without the switch is told 403 whatever the org. Fails closed: no user means no.
 */
const DEFAULT_PILOT_ORG_IDS = ['d40afcec-0ddf-471f-b99d-8e5f23cbdadf'];

export function phoneSetupPilotOrgIds(): string[] {
  const raw = env.COMMUNICATION_ALLOWED_ORG_IDS;
  if (raw && raw.trim()) {
    return raw.split(',').map((id) => id.trim()).filter(Boolean);
  }
  return DEFAULT_PILOT_ORG_IDS;
}

export function requirePhoneSetupOrg() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (req.user.org_is_demo === true || phoneSetupPilotOrgIds().includes(req.user.organization_id)) {
      next();
      return;
    }
    res.status(404).json({ error: 'FEATURE_DISABLED', feature: 'phone-setup' });
  };
}
