import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { STATUS_REGISTRY, STATUS_INTENT_CLASSES, type StatusDomain } from '@/design-system/status-registry';

interface StatusBadgeProps {
  /** Which domain's status this is — resolves the label/color per-domain, never shared. */
  domain: StatusDomain;
  status: string;
  className?: string;
  /** 'lg' = prominent title-adjacent pill (estimate workspace); default = compact table/list pill. */
  size?: 'sm' | 'lg';
  /** Force the colorless neutral token — used for lead status chips. */
  neutral?: boolean;
  /** SRVW-111 (label-override shape) - a caller-supplied display label for this status (no caller
   *  passes one today; lead statuses are fixed). Replaces the rendered text only - color/intent
   *  still come from the registry, since a relabel never changes what the underlying enum value means. Falsy (undefined
   *  or '') falls back to the registry's own label. */
  labelOverride?: string;
}

export function StatusBadge({ domain, status, className, size = 'sm', neutral, labelOverride }: StatusBadgeProps) {
  const entry = STATUS_REGISTRY[domain][status] ?? { label: status, intent: 'neutral' as const };
  const Icon = entry.icon;
  const intentClass = neutral ? STATUS_INTENT_CLASSES.neutral : STATUS_INTENT_CLASSES[entry.intent];

  return (
    <Badge
      variant="outline"
      className={cn(
        'font-bold gap-1',
        size === 'lg' ? 'text-sm px-3 py-1' : 'text-xs',
        intentClass,
        className,
      )}
    >
      {Icon && <Icon className={size === 'lg' ? 'h-4 w-4' : 'h-3 w-3'} />}
      {labelOverride || entry.label}
    </Badge>
  );
}
