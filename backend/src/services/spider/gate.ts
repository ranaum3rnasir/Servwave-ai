/**
 * Who has Spider (#2619). Two checks, applied in three places - every Spider endpoint
 * (middleware/requireSpider.ts), the sweep (per company) and the frontend (before any Spider code
 * loads):
 *
 *   1. the `spider` catalog feature (minimum plan Scale), granted through the normal plan and
 *      feature tooling; and
 *   2. WHILE THE LAUNCH IS DEMO-ONLY, a demo company.
 *
 * Opening Spider to Scale customers later means deleting the `is_demo` half of
 * `spiderAvailable` - nothing else.
 */
import { hasFeature, type OrgEntitlementSource } from '../../lib/entitlements/resolve';

export interface SpiderGateInput {
  features: readonly string[];
  isDemo: boolean | undefined;
}

export function spiderAvailable({ features, isDemo }: SpiderGateInput): boolean {
  return features.includes('spider') && isDemo === true;
}

/** The same gate for a company row read without a request (the sweep). */
export function spiderAvailableForOrg(org: {
  is_demo: boolean;
  plan: string;
  trial_ends_at: Date | null;
  feature_overrides: unknown;
}): boolean {
  const source: OrgEntitlementSource = {
    plan: org.plan,
    trial_ends_at: org.trial_ends_at,
    feature_overrides: (org.feature_overrides as Record<string, unknown> | null) ?? null,
  };
  return org.is_demo === true && hasFeature(source, 'spider');
}
