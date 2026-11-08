import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Heading } from '@/components/ui/heading';
import type { ReportDef } from '@/lib/reports/report-catalog';

/**
 * Shared chrome for every built report: back link + header (icon, S-code, title)
 * with an optional actions slot on the right (date range, export, etc.). Keeps
 * all report pages visually consistent.
 */
export function ReportShell({
  report,
  actions,
  subtitle,
  children,
}: {
  report: ReportDef;
  actions?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const Icon = report.icon;
  return (
    <div className="space-y-6">
      <Link
        to="/reports"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Reports
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-background-light">
          <Icon className="h-5 w-5 text-text-primary" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            {report.code && (
              <span className="rounded-md bg-background-light px-1.5 py-0.5 text-xs font-semibold tabular-nums text-text-secondary">
                {report.code}
              </span>
            )}
            <Heading level={1} scale="2xl">{report.label}</Heading>
          </div>
          {subtitle && <p className="mt-0.5 text-sm text-text-secondary">{subtitle}</p>}
        </div>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>

      {children}
    </div>
  );
}
