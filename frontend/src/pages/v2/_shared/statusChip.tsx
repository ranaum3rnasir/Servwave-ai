import { STATUS_REGISTRY, type StatusDomain, type StatusIntent } from '@/design-system/status-registry';
import { Badge } from '@/ui-kit/components/ui/badge';

/**
 * The v2 status chip.
 *
 * The legacy `components/data/status-badge.tsx` is an app component, so it
 * cannot be used here. What it wraps is not presentation, though: the
 * label/intent map in `design-system/status-registry` is the single source of
 * truth for "what does this state mean", and forking it would be a logic
 * change. So the registry is imported and only the painting moves onto the
 * kit's Badge variants.
 *
 * SOLID, not soft. The kit's locked decision is "status = solid badge,
 * qualifiers = soft": the status is the one value that defines a record, so it
 * is the one thing on the row allowed to carry a fill. The legacy leads pages
 * forced every lead status colourless via a `neutral` prop; that prop is gone,
 * because a colourless status column is exactly the thing the mockup fixes.
 */
type Variant = 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'purple' | 'teal' | 'indigo';

const INTENT_VARIANT: Record<StatusIntent, Variant> = {
  success: 'green',
  warning: 'amber',
  danger: 'red',
  info: 'blue',
  neutral: 'slate',
  brand: 'purple',
};

/**
 * Lifecycle palette - painting only, per domain.
 *
 * The registry's `intent` answers "what does this state MEAN" with six
 * semantic buckets, and a lifecycle needs more separation than that vocabulary
 * can express. Three lead states were all `warning`, so New, Contacted and
 * Estimate Sent painted identically amber and the column carried no
 * information at a glance - the exact problem a colour-coded status is for.
 * (Jobs is worse: five of its seven statuses are `warning`.)
 *
 * Widening `StatusIntent` is not the fix. Intent is shared meaning consumed
 * app-wide - it drives legacy badges, filter chips and summary tiles - and a
 * bucket named for a hue rather than a meaning would be a logic change wearing
 * a palette's clothes. So the registry keeps owning label + meaning, and the
 * v2 layer decides only how a state is painted. Anything not listed falls back
 * to its intent, so a status added to the registry tomorrow still renders.
 *
 * The hues follow the kit's own lifecycle grammar, so a stage means the same
 * thing in every module:
 *
 *   purple  arrived, nobody has worked it yet   (Lead New / Job Unscheduled)
 *   blue    we have acted, it is moving         (Lead Contacted / Job Scheduled)
 *   teal    a walkthrough is booked             (Lead Walkthrough Scheduled)
 *   indigo  the walkthrough is done             (Lead Walkthrough Completed)
 *   amber   waiting on someone else - chase it  (Lead Estimate Sent)
 *   green   won                                 red     lost
 *   slate   cancelled - stopped, not failed
 *
 * That leaves amber meaning one thing only: this row needs a human. A leads
 * list exists to surface exactly that, and it cannot when half the column is
 * already amber.
 */
const LIFECYCLE_VARIANT: Partial<Record<StatusDomain, Record<string, Variant>>> = {
  lead: {
    NEW: 'purple',
    CONTACTED: 'blue',
    WALKTHROUGH_SCHEDULED: 'teal',
    WALKTHROUGH_COMPLETED: 'indigo',
    ESTIMATED: 'amber',
    WON: 'green',
    LOST: 'red',
    CANCELLED: 'slate',
  },
};

/**
 * Which hue a status wears, by the rules above.
 *
 * Exported so surfaces that show a status WITHOUT a chip - the status picker's
 * dots, for one - resolve the same colour from the same place. Two mappings for
 * one lifecycle is how a state ends up amber in the table and blue in the menu.
 */
export function statusVariantFor(domain: StatusDomain, status: string): Variant {
  const entry = STATUS_REGISTRY[domain][status] ?? { label: status, intent: 'neutral' as const };
  return LIFECYCLE_VARIANT[domain]?.[status] ?? INTENT_VARIANT[entry.intent];
}

export interface StatusChipProps {
  domain: StatusDomain;
  status: string;
}

export function StatusChip({ domain, status }: StatusChipProps) {
  const entry = STATUS_REGISTRY[domain][status] ?? { label: status, intent: 'neutral' as const };
  return <Badge variant={statusVariantFor(domain, status)} size="sm">{entry.label}</Badge>;
}
