import { useParams } from 'react-router-dom';

import { findReport } from '@/lib/reports/report-catalog';
import { featureNotInPlanCopy } from '@/lib/entitlements/catalog';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Card } from '@/ui-kit/components/ui/card';

import { BackLink } from '../_shared/backLink';
import { v2Path } from '../uiV2';

interface Props {
  reason?: 'coming-soon' | 'not-in-plan';
}

/**
 * The landing for a `/reports/:slug` with nothing behind it yet.
 *
 * Three copies, chosen exactly as before: an unknown slug says the report does
 * not exist, a known one whose declared entitlement the org lacks gets
 * `featureNotInPlanCopy` (imported, never restated - it names the plan the
 * feature is on), and everything else says "coming soon".
 *
 * The hand-built centred panel is the kit's `EmptyState` inside a `Card`; the
 * report icon becomes the EmptyState's own icon medallion, which is the same
 * shape the legacy page drew by hand.
 */
export default function ReportStubPage({ reason = 'coming-soon' }: Props) {
  const { slug } = useParams<{ slug: string }>();
  const report = findReport(slug);
  const Icon = report?.icon;

  const notInPlanCopy = featureNotInPlanCopy(report?.feature);

  return (
    <div>
      {/* This page has no PageHeader to hang the back slot off, so it repeats
          the slot's own offset rather than inventing a second one. */}
      <div className="mb-3 -ml-3">
        <BackLink to={v2Path('/reports')}>Back to Reports</BackLink>
      </div>

      <Card>
        <EmptyState
          icon={Icon ? <Icon /> : undefined}
          title={report ? `${report.label} report` : 'Report not found'}
          description={
            !report
              ? 'No report matches this address. Head back to the Reports list.'
              : reason === 'not-in-plan'
                ? notInPlanCopy
                : 'This report is coming soon - we will build it out next.'
          }
        />
      </Card>
    </div>
  );
}
