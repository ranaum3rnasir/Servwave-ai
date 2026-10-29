import type { FeatureKey, PlanTier } from './catalog';
import { PLAN_ORDER, isGrantableFeature } from './catalog';
import { PLAN_FEATURES } from './plans';

export { isKnownFeature, isGrantableFeature, catalogEntry } from './catalog';

export interface OrgEntitlementSource {
  /** Typed as string, not PlanTier: this value comes from the DB and may drift ahead of the code. */
  plan: string;
  trial_ends_at: Date | null;
  /** Raw JSONB — may be null, may hold non-boolean values, may hold unknown keys. */
  feature_overrides: Record<string, unknown> | null;
}

const DEFAULT_PLAN: PlanTier = 'STARTER';

function coercePlan(plan: string): PlanTier {
  return (PLAN_ORDER as string[]).includes(plan) ? (plan as PlanTier) : DEFAULT_PLAN;
}

/**
 * Trial resolution is lazy — no cron, no downgrade job. A non-null trial_ends_at
 * in the future means the org is on SCALE; when it lapses, `plan` simply applies
 * again. `plan` always holds the tier they land on.
 *
 * Never throws: an unrecognized plan string degrades to STARTER rather than
 * 500-ing every route for that org (this runs inside `authenticate`).
 */
export function effectivePlan(org: OrgEntitlementSource): PlanTier {
  if (org.trial_ends_at && org.trial_ends_at > new Date()) return 'SCALE';
  return coercePlan(org.plan);
}

/**
 * Resolution order: plan features → apply overrides → FeatureKey[].
 *
 * Overrides are validated against the catalog. An unknown key (operator typo) or
 * a built:false key is IGNORED, never granted — otherwise `set-plan.ts --feature
 * phonee --enable` would report success while the gate kept returning 402.
 * Non-boolean values are ignored too; JSONB can hold anything.
 */
export function orgFeatures(org: OrgEntitlementSource): FeatureKey[] {
  const base = PLAN_FEATURES[effectivePlan(org)].features;
  const overrides = org.feature_overrides ?? {};

  const added: FeatureKey[] = [];
  const removed = new Set<string>();
  for (const [key, value] of Object.entries(overrides)) {
    if (!isGrantableFeature(key)) continue; // unknown or built:false — ignore
    if (value === true) added.push(key);
    else if (value === false) removed.add(key);
  }

  return [...new Set([...base, ...added])].filter(k => !removed.has(k));
}

export function hasFeature(org: OrgEntitlementSource, key: FeatureKey): boolean {
  return orgFeatures(org).includes(key);
}
