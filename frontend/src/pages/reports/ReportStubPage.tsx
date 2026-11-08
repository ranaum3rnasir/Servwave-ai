import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Heading } from '@/components/ui/heading';
import { findReport } from '@/lib/reports/report-catalog';
import { featureNotInPlanCopy } from '@/lib/entitlements/catalog';

interface Props {
  reason?: 'coming-soon' | 'not-in-plan';
}

/**
 * Generic landing for any /reports/:slug. Each report gets fleshed out
 * one-by-one later; for now this confirms the card routed correctly. When
 * `reason` is 'not-in-plan', the report is fully built but the org's plan
 * lacks its declared feature - the copy says so instead of "coming soon".
 */
export default function ReportStubPage({ reason = 'coming-soon' }: Props) {
  const { slug } = useParams<{ slug: string }>();
  const report = findReport(slug);
  const Icon = report?.icon;

  const notInPlanCopy = featureNotInPlanCopy(report?.feature);

  return (
    <div className="space-y-6">
      <Link
        to="/reports"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Reports
      </Link>

      <div className="rounded-xl border border-border bg-surface-light p-10 text-center shadow-card">
        {Icon && (
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-background-light">
            <Icon className="h-6 w-6 text-text-primary" />
          </div>
        )}
        <Heading level={1}>
          {report ? `${report.label} report` : 'Report not found'}
        </Heading>
        <p className="mt-2 text-sm text-text-secondary">
          {!report
            ? 'No report matches this address. Head back to the Reports list.'
            : reason === 'not-in-plan'
              ? notInPlanCopy
              : 'This report is coming soon — we’ll build it out next.'}
        </p>
      </div>
    </div>
  );
}
