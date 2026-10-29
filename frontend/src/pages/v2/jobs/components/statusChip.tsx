import { STATUS_REGISTRY, type StatusDomain, type StatusIntent } from '@/design-system/status-registry';
import { Badge } from '@/ui-kit/components/ui/badge';

/**
 * The v2 status chip for the jobs module.
 *
 * The legacy `components/data/status-badge.tsx` is an app component, so it
 * cannot be used here. What it wraps is not presentation, though: the
 * label/intent map in `design-system/status-registry` is the single source of
 * truth for "what does this state mean", and forking it would be a logic
 * change. So the registry is imported - including the ratified rename that
 * displays the `UNSCHEDULED` enum value as "Unscheduled" - and only the painting
 * moves onto the kit's Badge variants.
 *
 * A SEPARATE FILE from `pages/v2/_shared/statusChip.tsx` on purpose, and it
 * stays that way after the _shared consolidation pass. The shared chip carries a
 * `lead` lifecycle palette and paints every other domain straight off intent;
 * this one adds the job palette below. Folding the job map into the shared chip
 * would repaint `domain="job"` for its OTHER callers - `customers/components/
 * detailTabs.tsx` renders job rows through it today and gets the intent
 * painting - which is a behaviour change, not a consolidation.
 *
 * WHY A LIFECYCLE MAP HERE. The shared chip's own comment names this module as
 * the worst case: five of the seven job statuses carry the `warning` intent, so
 * painting straight off intent renders Unscheduled, Scheduled, En Route, On Site
 * and In Progress identically amber and the Status column carries almost nothing
 * at a glance. Intent stays the shared cross-app meaning; only the painting is
 * decided here.
 *
 * Multi-visit S4 (D17): EN_ROUTE and ON_SITE retired from JobStatus, so a JOB now only ever hits
 * five of these keys. The two are KEPT below on purpose - the same map renders a VISIT's status
 * chip, where both values are live - and the map is keyed by string with an intent fallback, so
 * carrying them costs nothing and dropping them would blank the visit chips.
 *
 * The hues do not fit one badge colour each, so two pairs deliberately share, chosen so the
 * buckets a dispatcher actually acts on stay separate:
 *
 *   purple  arrived, nobody has worked it     UNSCHEDULED (the kit's own example)
 *   blue    booked and moving toward the job  SCHEDULED, EN_ROUTE
 *   amber   a crew is engaged right now       ON_SITE, IN_PROGRESS
 *   green   done                              COMPLETED
 *   slate   stopped, not failed               CANCELLED
 *
 * Anything absent falls back to its intent, so a status added to the registry
 * tomorrow still renders.
 *
 * SOLID, not soft: the kit's locked rule is "status = solid badge, qualifiers =
 * soft". The status is the one value that defines a row, so it is the one thing
 * on the row allowed to carry a fill.
 */
type Variant = 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'purple';

const INTENT_VARIANT: Record<StatusIntent, Variant> = {
  success: 'green',
  warning: 'amber',
  danger: 'red',
  info: 'blue',
  neutral: 'slate',
  brand: 'purple',
};

const JOB_LIFECYCLE_VARIANT: Record<string, Variant> = {
  UNSCHEDULED: 'purple',
  SCHEDULED: 'blue',
  EN_ROUTE: 'blue',
  ON_SITE: 'amber',
  IN_PROGRESS: 'amber',
  COMPLETED: 'green',
  CANCELLED: 'slate',
};

export interface StatusChipProps {
  /** `job` here; `invoice`/`estimate`/`deposit` on the detail page's linked records. */
  domain: StatusDomain;
  status: string;
  size?: 'default' | 'sm' | 'pill';
}

export function StatusChip({ domain, status, size = 'sm' }: StatusChipProps) {
  // Unknown status falls back to the raw value in neutral rather than throwing -
  // the same tolerance `components/data/status-badge.tsx` has.
  const entry = STATUS_REGISTRY[domain][status] ?? { label: status, intent: 'neutral' as const };
  const variant = (domain === 'job' ? JOB_LIFECYCLE_VARIANT[status] : undefined) ?? INTENT_VARIANT[entry.intent];
  return <Badge variant={variant} size={size}>{entry.label}</Badge>;
}
