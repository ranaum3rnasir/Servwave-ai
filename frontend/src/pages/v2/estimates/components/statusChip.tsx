import { STATUS_REGISTRY, type StatusDomain, type StatusIntent } from '@/design-system/status-registry';
import { Badge } from '@/ui-kit/components/ui/badge';

/**
 * The v2 status chip for the estimates module.
 *
 * The legacy `components/data/status-badge.tsx` is an app component, so it
 * cannot be used here. What it wraps is not presentation, though: the
 * label/intent map in `design-system/status-registry` is the single source of
 * truth for "what does this state mean", and forking it would be a logic
 * change. So the registry is imported and only the painting moves onto the
 * kit's Badge variants - exactly the split `pages/v2/_shared/statusChip.tsx`
 * made.
 *
 * A SEPARATE FILE from the shared chip on purpose, and it stays that way after
 * the _shared consolidation pass. That component carries a `lead` lifecycle
 * palette; this one paints straight off intent (see below). Folding the two
 * together would mean a per-caller branch inside a shared file, which is the
 * thing `pages/v2/_shared/README.md` exists to keep out.
 *
 * NO LIFECYCLE OVERRIDE MAP. Leads needed one because three of its statuses
 * share the `warning` intent and the column carried no information at a glance.
 * The estimate lifecycle is already one-intent-per-stage - neutral Draft, info
 * Sent, warning Pending, success Won, danger Declined - and so is the deposit
 * vocabulary, so painting straight off the intent separates every stage without
 * inventing a second status-to-appearance map.
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

export interface StatusChipProps {
  /** `estimate` or `deposit` here; typed wide so the registry stays the authority. */
  domain: StatusDomain;
  status: string;
  size?: 'default' | 'sm' | 'pill';
}

export function StatusChip({ domain, status, size = 'sm' }: StatusChipProps) {
  // Unknown status falls back to the raw value in neutral rather than throwing -
  // same tolerance `components/data/status-badge.tsx` has, and the reason a
  // status added to the registry tomorrow still renders here.
  const entry = STATUS_REGISTRY[domain][status] ?? { label: status, intent: 'neutral' as const };
  return <Badge variant={INTENT_VARIANT[entry.intent]} size={size}>{entry.label}</Badge>;
}
