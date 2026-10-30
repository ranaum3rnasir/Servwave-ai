import { useState } from 'react';
import { AlertTriangle, DollarSign, UserX, Briefcase, Home, Users, MailX, ChevronRight } from 'lucide-react';

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
  missing_lead_owner: UserX,
  job_past_start: Briefcase,
  walkthrough_needed: Home,
  // Booked visits in the next 7 days with nobody on them: a crew problem, so the crew icon.
  missing_crew: Users,
  // A visit within 48 hours whose customer the automation ledger never reached.
  customer_not_told: MailX,
  // Money ServWave Payments took that no invoice could carry (opens the Payments page).
  payments_attention: DollarSign,
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

/** How many items the list draws before "Show N more". The server sorts danger, warning, info, so the last ones to wait are the mildest. */
const ROWS_SHOWN = 6;

/**
 * The attention list.
 *
 * The header count is the FULL `items.length`, and it renders only when there is
 * at least one. The body draws the first six (the server's order: the payments
 * item first, then danger, warning, info) and a "Show N more" control reaches
 * every other item the answer holds; an expanded list scrolls inside the card
 * instead of stretching the page. Each row navigates to the link the SERVER
 * built, never one derived here.
 */
export default function NeedsAttention({
  items,
  navigate,
  isLoading,
}: {
  items: AttentionItem[];
  navigate: (to: string) => void;
  isLoading?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const displayed = expanded ? items : items.slice(0, ROWS_SHOWN);
  const hidden = items.length - ROWS_SHOWN;
  return (
    <WidgetCard
      title="Needs Attention"
      icon={<AlertTriangle className="h-4 w-4 text-muted-foreground" />}
      right={items.length > 0 ? <Badge variant="red" size="pill">{items.length}</Badge> : undefined}
      loading={isLoading}
    >
      {displayed.length === 0 ? (
        <EmptyState title="All clear - nothing needs attention" />
      ) : (
        <>
          <div className="max-h-96 overflow-y-auto overscroll-contain">
            {displayed.map((item) => {
              const s = STYLES[item.severity];
              const Icon = ICON[item.type] ?? AlertTriangle;
              const body = (
                <>
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${s.iconBg}`}>
                    <Icon className={`h-3.5 w-3.5 ${s.iconColor}`} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-foreground">{item.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{item.meta}</span>
                  </span>
                  <Badge variant={s.badge} size="sm">{item.badge}</Badge>
                </>
              );
              // A row the server sent with no address is one the person may not open: shown, never clickable.
              const { link } = item;
              if (link === null || link === '') {
                return <div key={item.id} className="flex w-full items-center gap-3 border-b px-5 py-3 text-left last:border-0">{body}</div>;
              }
              return (
                // Full-bleed list row: a kit Button carrying only layout, so the
                // element, focus ring and hover wash are the kit's.
                <Button
                  key={item.id}
                  type="button"
                  variant="ghost"
                  size={null}
                  onClick={() => navigate(link)}
                  className="group h-auto w-full justify-start gap-3 whitespace-normal rounded-none border-b px-5 py-3 text-left font-normal last:border-0"
                >
                  {body}
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </Button>
              );
            })}
          </div>
          {hidden > 0 && (
            <div className="border-t px-5 py-2">
              <Button type="button" variant="link" size={null} className="text-xs" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
                {expanded ? 'Show fewer' : `Show ${hidden} more`}
              </Button>
            </div>
          )}
        </>
      )}
    </WidgetCard>
  );
}
