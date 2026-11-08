import { Link } from 'react-router-dom';
import type { ReportDef } from '@/lib/reports/report-catalog';

/**
 * One report tile in the Reports landing grid. Routes to its stub page.
 * Left accent bar + hover lift, styled to the Servwave design system.
 * Deferred reports render muted with a "Deferred" badge and still route.
 */
export function ReportCard({ report }: { report: ReportDef }) {
  const Icon = report.icon;
  return (
    <Link
      to={`/reports/${report.slug}`}
      className={`group flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-light py-4 pl-5 pr-4 shadow-card
                 border-l-[3px] border-l-border transition-all
                 hover:-translate-y-0.5 hover:border-l-text-primary hover:shadow-md
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-text-primary/30
                 ${report.deferred ? 'opacity-60' : ''}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        {report.code && (
          <span className="shrink-0 rounded-md bg-background-light px-1.5 py-0.5 text-xs font-semibold tabular-nums text-text-secondary">
            {report.code}
          </span>
        )}
        <span className="truncate text-base font-semibold text-text-primary">{report.label}</span>
        {report.deferred && (
          <span className="shrink-0 rounded-full bg-background-light px-2 py-0.5 text-xs font-medium text-text-secondary">
            Deferred
          </span>
        )}
      </div>
      <Icon className="h-5 w-5 shrink-0 text-text-secondary transition-colors group-hover:text-text-primary" />
    </Link>
  );
}
