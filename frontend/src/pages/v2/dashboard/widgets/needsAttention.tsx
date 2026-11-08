import { AlertTriangle, DollarSign, Phone, Briefcase, Home, Users, MailX, ChevronRight } from 'lucide-react';

import type { AttentionItem } from '@/lib/api/dashboard';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { WidgetCard } from '../components/widgetCard';

// D16 (2026-07-21) - expiring_estimate retired; the backend no longer emits it
// (the internal expiry sweep is gone), so there is nothing left to map an icon
// for. Carried across unchanged: the server decides the type, this only paints
// it, and an unknown type still falls back to the triangle.
const ICON: Record<string, React.ElementType> = {
  overdue_invoice: DollarSign,
  unassigned_leads: Phone,
  job_past_start: Briefcase,
  walkthrough_needed: Home,
  // A visit inside 48 hours with nobody performing it: a crew problem, so the crew icon.
  job_unstaffed: Users,
  // A visit within 48 hours whose customer the automation ledger never reached.
  customer_not_told: MailX,
};

/**
 * Severity treatment, one row per the three values the server emits. The icon
 * chip is painted with the kit's status subtles and the trailing count chip is
 * a kit Badge variant, so the row names a MEANING and the kit decides what that
 * meaning looks like - the legacy version spelled out five classes per severity
 * at the call site.
 */
const STYLES = {
  danger: { iconBg: 'bg-status-red-subtle', iconColor: 'text-status-red', badge: 'softRed' },
  warning: { iconBg: 'bg-status-amber-subtle', iconColor: 'text-status-amber', badge: 'softAmber' },
  info: { iconBg: 'bg-status-blue-subtle', iconColor: 'text-status-blue', badge: 'softBlue' },
} as const;

/**
 * The attention list.
 *
 * Every rule the legacy widget had is preserved: the header count is the FULL
 * `items.length`, not the truncated six, and it renders only when there is at
 * least one; the body shows `slice(0, 6)` with no "show more"; and each row
 * navigates to the link the SERVER built, never one derived here.
 */
export default function NeedsAttention({
  items,
  navigate,
}: {
  items: AttentionItem[];
  navigate: (to: string) => void;
}) {
  const displayed = items.slice(0, 6);
  return (
    <WidgetCard
      title="Needs Attention"
      icon={<AlertTriangle className="h-4 w-4 text-muted-foreground" />}
      right={items.length > 0 ? <Badge variant="red" size="pill">{items.length}</Badge> : undefined}
    >
      {displayed.length === 0 ? (
        <EmptyState title="All clear - nothing needs attention" />
      ) : (
        <div>
          {displayed.map((item) => {
            const s = STYLES[item.severity];
            const Icon = ICON[item.type] ?? AlertTriangle;
            return (
              // Full-bleed list row: a kit Button carrying only layout, so the
              // element, focus ring and hover wash are the kit's.
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                size={null}
                onClick={() => navigate(item.link)}
                className="group h-auto w-full justify-start gap-3 whitespace-normal rounded-none border-b px-5 py-3 text-left font-normal last:border-0"
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${s.iconBg}`}>
                  <Icon className={`h-3.5 w-3.5 ${s.iconColor}`} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-foreground">{item.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{item.meta}</span>
                </span>
                <Badge variant={s.badge} size="sm">{item.badge}</Badge>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </Button>
            );
          })}
        </div>
      )}
    </WidgetCard>
  );
}
