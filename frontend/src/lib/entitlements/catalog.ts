// Frontend mirror of the gated entries in backend/src/lib/entitlements/catalog.ts.
// Keep in sync by hand — same idiom as the (now retired) communicationAccess pair.
// Only feature-gated modules need to appear here; Starter core is never gated.
export interface CatalogEntry {
  key: string;
  label: string;
  minPlan: 'STARTER' | 'PRO' | 'SCALE' | 'ENTERPRISE';
}

export const FEATURE_CATALOG: CatalogEntry[] = [
  { key: 'leads',            label: 'Leads',             minPlan: 'PRO'        },
  { key: 'service_plans',    label: 'Service Plans',     minPlan: 'PRO'        },
  // No advanced_reports entry: it is built:false backend-side (#1021) - nothing gates it,
  // so no consumer here can ever look it up. Re-add when a real reports gate lands.
  { key: 'phone',            label: 'Phone & Messaging', minPlan: 'PRO'        },
  // Email is its own entitlement, NOT part of `phone`. It lives in the
  // Communication module but every plan may send email, so `phone` (Pro+) can
  // never be its gate - see the backend catalog entry of the same key.
  { key: 'email',            label: 'Email',             minPlan: 'STARTER'    },
  { key: 'automations',      label: 'Automations',       minPlan: 'PRO'        },
  { key: 'inventory',        label: 'Inventory',         minPlan: 'SCALE'      },
  { key: 'multi_location',   label: 'Multi-Location',    minPlan: 'ENTERPRISE' },
];

export const PLAN_LABELS: Record<string, string> = {
  STARTER: 'Starter',
  PRO: 'Pro',
  SCALE: 'Scale',
  ENTERPRISE: 'Enterprise',
};

export function catalogEntry(key: string | undefined): CatalogEntry | undefined {
  return key ? FEATURE_CATALOG.find(e => e.key === key) : undefined;
}

/** Cheapest-first plan order, used to reduce a multi-key gate to one badge. */
const PLAN_RANK: Record<CatalogEntry['minPlan'], number> = {
  STARTER: 0,
  PRO: 1,
  SCALE: 2,
  ENTERPRISE: 3,
};

/**
 * The plan a locked row should name, for a gate that may hold MORE THAN ONE
 * feature key. An array of keys means OR (any one of them unlocks the row), so
 * the honest badge is the CHEAPEST plan that would unlock it - naming the most
 * expensive one would over-sell the upgrade.
 *
 * Returns undefined when no key is in this (partial) mirror, which is the
 * caller's cue to fall back to its "coming soon" treatment.
 */
export function requiredPlanFor(
  feature: string | string[] | undefined,
): CatalogEntry['minPlan'] | undefined {
  const keys = feature === undefined ? [] : Array.isArray(feature) ? feature : [feature];
  const plans = keys
    .map((key) => catalogEntry(key)?.minPlan)
    .filter((plan): plan is CatalogEntry['minPlan'] => !!plan);
  if (plans.length === 0) return undefined;
  return plans.reduce((cheapest, plan) =>
    PLAN_RANK[plan] < PLAN_RANK[cheapest] ? plan : cheapest,
  );
}

/**
 * The upgrade-nudge sentence for a gated feature - shared by every surface that tells a user
 * "this isn't in your plan" (402 toast, report stub) so the wording lives in one place.
 */
export function featureNotInPlanCopy(key: string | undefined): string {
  const entry = catalogEntry(key);
  if (!entry) return 'This feature is not included in your plan.';
  return `${entry.label} is available on the ${PLAN_LABELS[entry.minPlan]} plan.`;
}
