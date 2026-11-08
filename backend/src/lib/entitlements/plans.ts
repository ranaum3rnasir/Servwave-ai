import type { FeatureKey, PlanTier } from './catalog';
import { FEATURE_CATALOG, PLAN_ORDER } from './catalog';

function featuresForPlan(plan: PlanTier): FeatureKey[] {
  const planIdx = PLAN_ORDER.indexOf(plan);
  return FEATURE_CATALOG
    .filter(e => e.built && PLAN_ORDER.indexOf(e.minPlan) <= planIdx)
    .map(e => e.key);
}

export const PLAN_FEATURES: Record<
  PlanTier,
  { features: FeatureKey[]; seats_included: number | null }
> = {
  STARTER:    { features: featuresForPlan('STARTER'),    seats_included: 2    },
  PRO:        { features: featuresForPlan('PRO'),        seats_included: 4    },
  SCALE:      { features: featuresForPlan('SCALE'),      seats_included: 6    },
  ENTERPRISE: { features: featuresForPlan('ENTERPRISE'), seats_included: null },
};
