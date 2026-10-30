/**
 * Who has Spider (#2619). Two checks, applied in three places - every Spider endpoint
 * (middleware/requireSpider.ts), the sweep (per company) and the frontend (before any Spider code
 * loads):
 *
 *   1. the `spider` catalog feature (minimum plan Scale), granted through the normal plan and
 *      feature tooling; and
 *   2. WHILE THE LAUNCH IS LIMITED, a demo company, or a company on the Spider pilot list
 *      (`SPIDER_PILOT_ORG_IDS`, SPEC-5). The list holds company ids only and has no default here.
 *
 * Opening Spider to Scale customers later means deleting the demo/pilot half of
 * `passesSpiderGate` - nothing else.
 */
import { env } from '../../config/env';
import { hasFeature, type OrgEntitlementSource } from '../../lib/entitlements/resolve';

/** The ids on the Spider pilot list, trimmed and lowercased. Unset or blank: none. */
export function spiderPilotOrgIds(): string[] {
  return (env.SPIDER_PILOT_ORG_IDS ?? '')
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);
}

/**
 * The boot log line for the pilot list: how many companies are on it, never which. The list is
 * read per process, so the count lets each server show it has the same list as the others.
 */
export function spiderPilotListBootLine(): string {
  const n = spiderPilotOrgIds().length;
  return `Spider pilot list: ${n} ${n === 1 ? 'company' : 'companies'}`;
}

/** Whether this company is on the Spider pilot list. The gate also needs the feature. */
export function isSpiderPilotOrg(orgId: string | null | undefined): boolean {
  if (!orgId) return false;
  return spiderPilotOrgIds().includes(orgId.toLowerCase());
}

function passesSpiderGate(hasSpider: boolean, isDemo: boolean | undefined, orgId: string | null | undefined): boolean {
  return hasSpider && (isDemo === true || isSpiderPilotOrg(orgId));
}

export interface SpiderGateInput {
  features: readonly string[];
  isDemo: boolean | undefined;
  orgId: string | undefined;
}

export function spiderAvailable({ features, isDemo, orgId }: SpiderGateInput): boolean {
  return passesSpiderGate(features.includes('spider'), isDemo, orgId);
}

/** The same gate for a company row read without a request (the sweep). */
export function spiderAvailableForOrg(org: {
  id: string;
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
  return passesSpiderGate(hasFeature(source, 'spider'), org.is_demo, org.id);
}
