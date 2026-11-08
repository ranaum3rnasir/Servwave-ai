import { AlertTriangle, DollarSign, Phone, Briefcase, Home, Users, MailX, ChevronRight } from 'lucide-react';
import type { AttentionItem } from '@/lib/api/dashboard';
import { WidgetCard } from './_shared';

// D16 (2026-07-21) — expiring_estimate retired; the backend no longer emits it (the internal
// expiry sweep is gone), so there's nothing left to map an icon for.
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

const STYLES = {
  danger: { iconBg: 'bg-danger/10', iconColor: 'text-danger', badgeBg: 'bg-danger/15', badgeText: 'text-danger', dot: 'bg-danger' },
  // warning token is now a readable dark amber (#B45309) → use it directly for badge text.
  warning: { iconBg: 'bg-warning/10', iconColor: 'text-warning', badgeBg: 'bg-warning/20', badgeText: 'text-warning', dot: 'bg-warning' },
  info: { iconBg: 'bg-info/10', iconColor: 'text-info', badgeBg: 'bg-info/15', badgeText: 'text-info', dot: 'bg-info' },
} as const;

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
      icon={<AlertTriangle className="h-4 w-4 text-text-secondary" />}
      right={items.length > 0 ? (
        <span className="inline-flex items-center justify-center h-[18px] min-w-[18px] rounded-full bg-danger px-1 text-[10px] font-bold text-on-fill">{items.length}</span>
      ) : undefined}
    >
      {displayed.length === 0 ? (
        <div className="flex items-center justify-center py-10 text-xs text-text-secondary">All clear — nothing needs attention</div>
      ) : (
        <div>
          {displayed.map((item) => {
            const s = STYLES[item.severity];
            const Icon = ICON[item.type] ?? AlertTriangle;
            return (
              // Full-width list-row click target (icon chip + title/meta stack + severity
              // badge + chevron), not a Button-shaped control - left raw per the program's
              // non-Button-shape carve-out.
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.link)}
                className="flex items-center gap-3 px-5 py-3 w-full text-left hover:bg-background-light transition-colors border-b border-border last:border-0 group"
              >
                <div className={`h-[32px] w-[32px] rounded-lg flex items-center justify-center shrink-0 ${s.iconBg}`}>
                  <Icon className={`h-3.5 w-3.5 ${s.iconColor}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12.5px] font-medium text-text-primary truncate">{item.title}</p>
                  <p className="text-[11px] text-text-secondary truncate">{item.meta}</p>
                </div>
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded-[4px] text-[10.5px] font-bold ${s.badgeBg} ${s.badgeText}`}>{item.badge}</span>
                <ChevronRight className="h-3.5 w-3.5 text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            );
          })}
        </div>
      )}
    </WidgetCard>
  );
}
