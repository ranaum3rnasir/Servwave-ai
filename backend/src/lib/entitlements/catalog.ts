export type FeatureKey =
  // Starter core - built, included from STARTER up. Most carry no gate at all;
  // `email` does (requireFeature('email') on comm-email.routes.ts), because it
  // lives inside the Communication module whose other channels are PRO `phone`.
  | 'customers' | 'jobs' | 'estimates' | 'invoices' | 'payments'
  | 'scheduling' | 'basic_reports' | 'online_payments'
  | 'mobile_field_app' | 'ai_center_view' | 'email'
  // Pro — built
  | 'leads' | 'service_plans' | 'advanced_reports' | 'phone' | 'automations'
  // Pro — declared but not built (documented, never gated)
  | 'quickbooks' | 'marketing_campaigns' | 'ai_agents_foundation'
  // Scale — built
  | 'inventory'
  // Scale — not built
  | 'ai_agents_advanced' | 'custom_reports' | 'api_access'
  // Enterprise
  | 'multi_location' | 'sso';

export type PlanTier = 'STARTER' | 'PRO' | 'SCALE' | 'ENTERPRISE';

export const PLAN_ORDER: PlanTier[] = ['STARTER', 'PRO', 'SCALE', 'ENTERPRISE'];

export interface CatalogEntry {
  key: FeatureKey;
  label: string;
  minPlan: PlanTier;
  /**
   * false = the plan line item is sold/declared but no software exists behind it.
   * Declared entries are reported by the audit script and shown in upgrade copy,
   * but NO gate is wired and they are never granted — not even by an explicit
   * feature_overrides entry. Shipping one later means flipping this boolean.
   */
  built: boolean;
}

export const FEATURE_CATALOG: CatalogEntry[] = [
  // Starter core
  { key: 'customers',            label: 'Customers',              minPlan: 'STARTER',    built: true  },
  { key: 'jobs',                 label: 'Jobs',                   minPlan: 'STARTER',    built: true  },
  { key: 'estimates',            label: 'Estimates',              minPlan: 'STARTER',    built: true  },
  { key: 'invoices',             label: 'Invoices',               minPlan: 'STARTER',    built: true  },
  { key: 'payments',             label: 'Payments',               minPlan: 'STARTER',    built: true  },
  { key: 'scheduling',           label: 'Scheduling',             minPlan: 'STARTER',    built: true  },
  { key: 'basic_reports',        label: 'Basic Reports',          minPlan: 'STARTER',    built: true  },
  { key: 'online_payments',      label: 'Online Payments',        minPlan: 'STARTER',    built: true  },
  { key: 'mobile_field_app',     label: 'Mobile Field App',       minPlan: 'STARTER',    built: true  },
  { key: 'ai_center_view',       label: 'AI Center',              minPlan: 'STARTER',    built: true  },
  // Every plan may send email, so this is STARTER even though it is reached
  // through the Communication module (whose other channels sit behind PRO
  // `phone`). built:true + minPlan STARTER means PLAN_FEATURES grants it to
  // every existing org on deploy - no migration, no backfill. The standing
  // `{"phone": false}` onboarding override is keyed on 'phone' and does not
  // touch it.
  { key: 'email',                label: 'Email',                  minPlan: 'STARTER',    built: true  },
  // Pro — built
  { key: 'leads',                label: 'Leads',                  minPlan: 'PRO',        built: true  },
  { key: 'service_plans',        label: 'Service Plans',          minPlan: 'PRO',        built: true  },
  { key: 'phone',                label: 'Phone & Messaging',      minPlan: 'PRO',        built: true  },
  { key: 'automations',          label: 'Automations',            minPlan: 'PRO',        built: true  },
  // Pro — not built
  // advanced_reports: no gate exists. /api/reports/* is ungated and no surface calls
  // useFeature('advanced_reports'), so a Starter org already sees every report. Marked
  // built:false until the basic/advanced split is defined and actually enforced (#1021).
  { key: 'advanced_reports',     label: 'Advanced Reports',       minPlan: 'PRO',        built: false },
  { key: 'quickbooks',           label: 'QuickBooks Integration', minPlan: 'PRO',        built: false },
  { key: 'marketing_campaigns',  label: 'Marketing Campaigns',    minPlan: 'PRO',        built: false },
  { key: 'ai_agents_foundation', label: 'AI Agents (Foundation)', minPlan: 'PRO',        built: false },
  // Scale — built
  { key: 'inventory',            label: 'Inventory',              minPlan: 'SCALE',      built: true  },
  // Scale — not built
  { key: 'ai_agents_advanced',   label: 'AI Agents (Advanced)',   minPlan: 'SCALE',      built: false },
  { key: 'custom_reports',       label: 'Custom Reports',         minPlan: 'SCALE',      built: false },
  { key: 'api_access',           label: 'API Access',             minPlan: 'SCALE',      built: false },
  // Enterprise
  { key: 'multi_location',       label: 'Multi-Location',         minPlan: 'ENTERPRISE', built: true  },
  { key: 'sso',                  label: 'Single Sign-On',         minPlan: 'ENTERPRISE', built: false },
];

const BUILT_KEYS = new Set<string>(FEATURE_CATALOG.filter(e => e.built).map(e => e.key));
const ALL_KEYS = new Set<string>(FEATURE_CATALOG.map(e => e.key));

/** True when the key exists in the catalog at all (built or not). For operator input validation. */
export function isKnownFeature(key: string): key is FeatureKey {
  return ALL_KEYS.has(key);
}

/** True when the key exists AND has software behind it. Only these can ever be granted. */
export function isGrantableFeature(key: string): key is FeatureKey {
  return BUILT_KEYS.has(key);
}

export function catalogEntry(key: string): CatalogEntry | undefined {
  return FEATURE_CATALOG.find(e => e.key === key);
}
